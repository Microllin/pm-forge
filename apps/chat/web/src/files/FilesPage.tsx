import { useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  File,
  FileCode,
  FileImage,
  FilePlus,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  FolderUp,
  Loader2,
  Pencil,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  ApiError,
  batch,
  childOf,
  copyEntry,
  createFolder,
  crumbsOf,
  downloadZip,
  formatSize,
  formatTime,
  listFolder,
  moveEntry,
  nameOf,
  parentOf,
  putContent,
  rawUrl,
  removeEntry,
  searchFiles,
  type BatchResult,
  type FileEntry,
  type SearchHit,
} from "./api";
import { NameDialog, TargetDialog } from "./dialogs";
import { FileViewer } from "./FileViewer";
import { FolderTree } from "./FolderTree";
import type { FilesLocation } from "./location";
import {
  collectDropEntries,
  describeSummary,
  fromEntries,
  fromInput,
  runUploads,
  uploadAll,
  type UploadItem,
  type UploadSummary,
  type UploadTask,
} from "./upload";
import "./files.css";

type Dialog =
  | { kind: "new-folder" }
  | { kind: "new-markdown" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "target"; action: "move" | "copy"; entries: FileEntry[] };

/** 页面提示。上传有失败项时带上可重试的那些。 */
type Notice = { ok: boolean; text: string; retry?: UploadTask[] } | null;

/** 批量结果的一句话：「已移动 2 项；失败 1 项：b.md（目标位置已有「b.md」）」 */
function describeBatch(verb: string, result: BatchResult): Notice {
  const parts = [`已${verb} ${String(result.succeeded.length)} 项`];
  if (result.failed.length > 0) {
    parts.push(
      `失败 ${String(result.failed.length)} 项：${result.failed.map((f) => `${nameOf(f.path)}（${f.message}）`).join("、")}`,
    );
  }
  return { ok: result.failed.length === 0, text: parts.join("；") };
}

/**
 * 一级菜单「文件」：左侧文件夹树，右侧当前文件夹的列表；点文件进入查看器。
 * 数据以磁盘为准（见 server/files/store.ts），这里每次改动后让相关查询重取。
 */
export function FilesPage({
  location,
  onLocation,
  root = "/",
  rootName = "文件",
  hide = [],
  onDirtyChange,
  onBack,
}: {
  location: FilesLocation;
  onLocation: (next: FilesLocation) => void;
  /**
   * 有未保存的编辑时上报给外壳。
   *
   * 原来 dirty 只在 FilesPage 自己的 go() 里查——而切「文件 ↔ 代码」标签、
   * 切一级菜单走的是外壳的 go()，它不认识 dirty，FilesPage 直接卸载；
   * FileViewer 的 beforeunload 在 SPA 内部导航不触发。于是在代码编辑器里改了一半，
   * 点一下「产品」，改动无提示消失。这个口子是外壳改造新开的。
   */
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
  /**
   * 这个入口的根。「事实底座」下有两个入口共用同一个库：
   * 「文件」从 `/` 起，「代码」从 `/代码库` 起。
   */
  root?: string;
  rootName?: string;
  /**
   * 这个入口里看不到的文件夹。文件库传 ["/代码库"]：代码归代码库管，文件库里既不列、
   * 不搜，也不能把文件挪进去。
   */
  hide?: readonly string[];
  /** 侧栏标题旁的「返回」：代码库里浏览某个仓库时，回到仓库清单。 */
  onBack?: (() => void) | undefined;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const isHidden = (path: string) =>
    hide.some((h) => path === h || path.startsWith(`${h}/`));
  // 记住的位置落在被藏起的文件夹里（拆分前停在 /代码库 下）：退回根。
  const folder = isHidden(location.folder) ? root : location.folder;
  const file =
    location.file !== null && isHidden(location.file) ? null : location.file;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  /** 多选（按路径）。换文件夹、开始搜索时清空。 */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const lastClicked = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  /** 查看器里有未保存的修改。离开文件前要确认。 */
  const dirty = useRef(false);

  const listing = useQuery({
    queryKey: ["files-list", folder],
    queryFn: () => listFolder(folder),
  });
  const searching = query.trim() !== "";
  const search = useQuery({
    queryKey: ["files-search", query.trim()],
    queryFn: () => searchFiles(query.trim()),
    enabled: searching,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["files-list"] }),
      queryClient.invalidateQueries({ queryKey: ["files-search"] }),
      queryClient.invalidateQueries({ queryKey: ["files-item"] }),
    ]);
  const clearSelection = () => {
    setSelected(new Set());
    lastClicked.current = null;
  };

  const go = (next: FilesLocation) => {
    if (dirty.current && !window.confirm("有未保存的修改，放弃吗？")) return;
    dirty.current = false;
    onDirtyChange?.(false);
    onLocation(next);
  };
  const openFolder = (path: string) => {
    setQuery("");
    setNotice(null);
    clearSelection();
    go({ folder: path, file: null });
  };
  const open = (entry: FileEntry) => {
    if (entry.isDir) openFolder(entry.path);
    else go({ folder: parentOf(entry.path), file: entry.path });
  };

  const run = async (action: () => Promise<Notice | undefined>) => {
    setNotice(null);
    try {
      const result = await action();
      if (result) setNotice(result);
    } catch (cause) {
      setNotice({
        ok: false,
        text: cause instanceof Error ? cause.message : "操作失败",
      });
    }
    await refresh();
  };

  const remove = (entry: FileEntry) => {
    if (!window.confirm(`删除「${entry.name}」？`)) return;
    void run(async () => {
      try {
        await removeEntry(entry.path);
      } catch (cause) {
        // 非空文件夹：服务端告诉我们里面有多少东西，再确认一次才连同内容删除。
        if (cause instanceof ApiError && cause.code === "FOLDER_NOT_EMPTY") {
          if (!window.confirm(`${cause.message}，连同里面的内容一起删除？`))
            return undefined;
          await removeEntry(entry.path, true);
          return undefined;
        }
        throw cause;
      }
      return undefined;
    });
  };

  /** 上传 / 重试结束后的统一收尾：刷新列表、给出结果；有失败项就带上「重试」。 */
  const finishUpload = async (summary: UploadSummary) => {
    setProgress(null);
    await refresh();
    const text = describeSummary(summary);
    setNotice(
      summary.retry.length > 0 ? { ...text, retry: summary.retry } : text,
    );
  };
  const onProgress = (done: number, total: number) =>
    setProgress({ done, total });

  const upload = async (items: UploadItem[]) => {
    if (items.length === 0) return;
    setNotice(null);
    setProgress({ done: 0, total: items.length });
    await finishUpload(await uploadAll(folder, items, onProgress));
  };

  const retryUploads = async (tasks: UploadTask[]) => {
    setNotice(null);
    setProgress({ done: 0, total: tasks.length });
    await finishUpload(await runUploads(tasks, onProgress));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    // 目录项必须在事件里同步取出，之后再异步遍历（事件结束后就失效了）。
    const entries = collectDropEntries(e.dataTransfer);
    const plain = [...e.dataTransfer.files];
    void (async () => {
      const items =
        entries.length > 0 ? await fromEntries(entries) : fromInput(plain);
      await upload(items);
    })();
  };

  /**
   * 搜索接口是整库搜的。「代码」入口里不该搜出文档库的东西——那是另一个入口的内容，
   * 搜出来既意外又点不回去（面包屑已经裁到这个入口的根）。所以按根过滤一次。
   */
  const hits: SearchHit[] = searching
    ? (search.data ?? []).filter(
        (h) =>
          (root === "/" || h.path.startsWith(`${root}/`)) && !isHidden(h.path),
      )
    : [];
  const entries: FileEntry[] = searching
    ? hits
    : (listing.data?.entries ?? []).filter((e) => !isHidden(e.path));
  const selectedEntries = entries.filter((e) => selected.has(e.path));
  const allSelected =
    entries.length > 0 && selectedEntries.length === entries.length;

  /** 勾选一行；按住 Shift 时选中上次点击与这次之间的整段。 */
  const toggle = (index: number, shift: boolean) => {
    const entry = entries[index];
    if (!entry) return;
    // 先取出「上次点的是哪一行」：下面的更新函数在之后的渲染里才执行，
    // 那时 lastClicked 已经被改成这一行了。
    const anchor = shift ? lastClicked.current : null;
    lastClicked.current = index;
    setSelected((prev) => {
      const next = new Set(prev);
      const on = !prev.has(entry.path);
      const [a, b] =
        anchor === null
          ? [index, index]
          : [Math.min(anchor, index), Math.max(anchor, index)];
      for (const e of entries.slice(a, b + 1)) {
        if (on) next.add(e.path);
        else next.delete(e.path);
      }
      return next;
    });
  };

  const batchDelete = () => {
    const n = selectedEntries.length;
    const folders = selectedEntries.filter((e) => e.isDir).length;
    const warn =
      folders > 0
        ? `其中 ${String(folders)} 个文件夹会连同里面的内容一起删除。`
        : "";
    if (!window.confirm(`删除选中的 ${String(n)} 项？${warn}`)) return;
    void run(async () => {
      const result = await batch(
        "delete",
        selectedEntries.map((e) => e.path),
      );
      clearSelection();
      return describeBatch("删除", result);
    });
  };

  return (
    <div className="files-page">
      <aside className="files-side">
        <h1 className="files-side-title">
          {onBack !== undefined && (
            <button
              type="button"
              className="icon-btn files-back"
              aria-label="返回仓库清单"
              title="返回仓库清单"
              onClick={() => {
                if (
                  dirty.current &&
                  !window.confirm("有未保存的修改，放弃吗？")
                )
                  return;
                dirty.current = false;
                onDirtyChange?.(false);
                onBack();
              }}
            >
              <ChevronLeft size={16} />
            </button>
          )}
          {rootName}
        </h1>
        <FolderTree
          selected={folder}
          onSelect={openFolder}
          root={root}
          rootName={rootName}
          hide={hide}
        />
      </aside>

      <section className="files-main" aria-label="文件列表区">
        {file !== null ? (
          <FileViewer
            key={file}
            path={file}
            editOnOpen={location.edit === true}
            onClose={() => go({ folder, file: null })}
            onDirtyChange={(d) => {
              dirty.current = d;
              onDirtyChange?.(d);
            }}
          />
        ) : (
          <div
            className={`files-listing${dragging ? " dragging" : ""}`}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes("Files")) {
                e.preventDefault();
                setDragging(true);
              }
            }}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDragging(false);
            }}
            onDrop={onDrop}
          >
            <header className="files-toolbar">
              <nav className="files-crumbs" aria-label="当前位置">
                {/* 面包屑裁到这个入口的根为止——「代码」入口里不该有回到 / 的路 */}
                {crumbsOf(folder)
                  .filter(
                    (c) =>
                      c.path === root ||
                      c.path.startsWith(root === "/" ? "/" : `${root}/`),
                  )
                  // 根那一级显示本入口的名字（文件库 / 仓库名），而不是通用的「文件」。
                  .map((c) => (c.path === root ? { ...c, name: rootName } : c))
                  .map((c, i, all) => (
                    <span key={c.path} className="files-crumb">
                      {i > 0 && <ChevronRight size={13} className="muted" />}
                      {i === all.length - 1 ? (
                        <strong>{c.name}</strong>
                      ) : (
                        <button
                          type="button"
                          className="files-crumb-link"
                          onClick={() => openFolder(c.path)}
                        >
                          {c.name}
                        </button>
                      )}
                    </span>
                  ))}
              </nav>
              <span className="files-spacer" />
              <label className="files-search">
                <Search size={14} className="muted" />
                <input
                  aria-label="搜索文件"
                  placeholder={`按名称或内容搜索${rootName}`}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    clearSelection();
                  }}
                />
                {searching && (
                  <button
                    type="button"
                    className="icon-btn ghost"
                    aria-label="清除搜索"
                    onClick={() => setQuery("")}
                  >
                    <X size={13} />
                  </button>
                )}
              </label>
            </header>

            {selectedEntries.length > 0 ? (
              <div
                className="files-actions files-batchbar"
                role="toolbar"
                aria-label="批量操作"
              >
                <strong>已选 {selectedEntries.length} 项</strong>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setDialog({
                      kind: "target",
                      action: "move",
                      entries: selectedEntries,
                    })
                  }
                >
                  <FolderInput size={14} /> 移动到…
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setDialog({
                      kind: "target",
                      action: "copy",
                      entries: selectedEntries,
                    })
                  }
                >
                  <Copy size={14} /> 复制到…
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    void run(async () => {
                      await downloadZip(selectedEntries.map((e) => e.path));
                      return undefined;
                    });
                  }}
                >
                  <Download size={14} /> 下载
                </button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={batchDelete}
                >
                  <Trash2 size={14} /> 删除
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={clearSelection}
                >
                  取消选择
                </button>
              </div>
            ) : (
              <div
                className="files-actions"
                role="toolbar"
                aria-label="文件操作"
              >
                <button
                  type="button"
                  className="btn"
                  onClick={() => setDialog({ kind: "new-folder" })}
                >
                  <FolderPlus size={14} /> 新建文件夹
                </button>
                {/*
                  「新建 Markdown」只给文件入口。
                  代码入口下它是错的：代码仓的内容来自上传或 clone，不是在网页里一个一个
                  新建出来的；摆这个按钮等于暗示「可以在这儿攒一个仓库」。
                  （这是整体复用 FilesPage 带来的语义泄漏，用户直接指出来过。）
                */}
                {root === "/" && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setDialog({ kind: "new-markdown" })}
                  >
                    <FilePlus size={14} /> 新建 Markdown
                  </button>
                )}
                <button
                  type="button"
                  className="btn primary"
                  disabled={progress !== null}
                  onClick={() => fileInput.current?.click()}
                >
                  {progress ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Upload size={14} />
                  )}
                  {progress
                    ? `上传中 ${String(progress.done)}/${String(progress.total)}`
                    : "上传文件"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={progress !== null}
                  onClick={() => folderInput.current?.click()}
                >
                  <FolderUp size={14} /> 上传文件夹
                </button>
                <input
                  ref={fileInput}
                  type="file"
                  multiple
                  hidden
                  aria-label="选择要上传的文件"
                  onChange={(e) => {
                    void upload(fromInput(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                <input
                  ref={(el) => {
                    folderInput.current = el;
                    // React 的类型里没有 webkitdirectory，用属性设置（各浏览器都支持）。
                    el?.setAttribute("webkitdirectory", "");
                  }}
                  type="file"
                  multiple
                  hidden
                  aria-label="选择要上传的文件夹"
                  onChange={(e) => {
                    void upload(fromInput(e.target.files ?? []));
                    e.target.value = "";
                  }}
                />
                <span className="muted small">也可以把文件或文件夹拖进来</span>
              </div>
            )}

            {notice && (
              <div
                className={`files-notice${notice.ok ? " ok" : ""}`}
                role="alert"
              >
                <span>{notice.text}</span>
                {notice.retry && notice.retry.length > 0 && (
                  <button
                    type="button"
                    className="btn files-retry"
                    disabled={progress !== null}
                    onClick={() => {
                      if (notice.retry) void retryUploads(notice.retry);
                    }}
                  >
                    重试失败的 {notice.retry.length} 个
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn ghost"
                  aria-label="关闭提示"
                  onClick={() => setNotice(null)}
                >
                  <X size={13} />
                </button>
              </div>
            )}

            {(searching ? search.isPending : listing.isPending) && (
              <p className="muted files-pad">
                <Loader2 size={14} className="spin" /> 读取中…
              </p>
            )}
            {!searching && listing.isError && (
              <p className="err-text files-pad">
                读取失败：{listing.error.message}
              </p>
            )}

            {entries.length > 0 ? (
              <table
                className="files-table"
                aria-label={searching ? "搜索结果" : "文件"}
              >
                <thead>
                  <tr>
                    {!searching && (
                      <th className="files-check">
                        <input
                          type="checkbox"
                          aria-label="全选"
                          checked={allSelected}
                          onChange={() => {
                            if (allSelected) clearSelection();
                            else
                              setSelected(new Set(entries.map((e) => e.path)));
                          }}
                        />
                      </th>
                    )}
                    <th>名称</th>
                    {searching && <th>位置</th>}
                    <th className="num">大小</th>
                    <th>修改时间</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, index) => {
                    const hit = searching ? (entry as SearchHit) : undefined;
                    const isSelected = selected.has(entry.path);
                    return (
                      <tr
                        key={entry.path}
                        className={isSelected ? "selected" : undefined}
                      >
                        {!searching && (
                          <td className="files-check">
                            <input
                              type="checkbox"
                              aria-label={`选择 ${entry.name}`}
                              checked={isSelected}
                              onClick={(e) => {
                                toggle(index, e.shiftKey);
                              }}
                              onChange={() => {
                                // 状态在 onClick 里改（要读 Shift）；这里只为满足受控组件。
                              }}
                            />
                          </td>
                        )}
                        <td>
                          <button
                            type="button"
                            className="files-name"
                            onClick={() => open(entry)}
                          >
                            <KindIcon entry={entry} />
                            <span>{entry.name}</span>
                            {hit?.match === "content" && (
                              <span className="files-tag">内容</span>
                            )}
                          </button>
                          {hit?.snippet !== undefined && (
                            <div className="files-snippet">{hit.snippet}</div>
                          )}
                        </td>
                        {searching && (
                          <td className="muted small">
                            {parentOf(entry.path)}
                          </td>
                        )}
                        <td className="num muted">
                          {entry.isDir ? "—" : formatSize(entry.size)}
                        </td>
                        <td className="muted">
                          {formatTime(entry.modifiedAt)}
                        </td>
                        <td className="files-row-actions">
                          <button
                            type="button"
                            className="icon-btn ghost"
                            aria-label={`重命名 ${entry.name}`}
                            title="重命名"
                            onClick={() => setDialog({ kind: "rename", entry })}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn ghost"
                            aria-label={`移动 ${entry.name}`}
                            title="移动到…"
                            onClick={() =>
                              setDialog({
                                kind: "target",
                                action: "move",
                                entries: [entry],
                              })
                            }
                          >
                            <FolderInput size={13} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn ghost"
                            aria-label={`复制 ${entry.name}`}
                            title="复制到…"
                            onClick={() =>
                              setDialog({
                                kind: "target",
                                action: "copy",
                                entries: [entry],
                              })
                            }
                          >
                            <Copy size={13} />
                          </button>
                          {!entry.isDir && (
                            <a
                              className="icon-btn ghost"
                              aria-label={`下载 ${entry.name}`}
                              title="下载"
                              href={rawUrl(entry, true)}
                              download={entry.name}
                            >
                              <Download size={13} />
                            </a>
                          )}
                          <button
                            type="button"
                            className="icon-btn ghost"
                            aria-label={`删除 ${entry.name}`}
                            title="删除"
                            onClick={() => remove(entry)}
                          >
                            <Trash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              ((searching && search.isSuccess) ||
                (!searching && listing.isSuccess)) && (
                <div className="files-empty">
                  {searching ? (
                    <p>没有名称或内容包含「{query.trim()}」的文件</p>
                  ) : (
                    <p>这个文件夹是空的，上传或新建一个吧</p>
                  )}
                </div>
              )
            )}
            {dragging && (
              <div className="files-dropzone">
                松开即上传到「{crumbsOf(folder).at(-1)?.name}」
              </div>
            )}
          </div>
        )}
      </section>

      {dialog?.kind === "new-folder" && (
        <NameDialog
          title="新建文件夹"
          submitLabel="创建"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await createFolder(childOf(folder, name));
            await refresh();
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "new-markdown" && (
        <NameDialog
          title="新建 Markdown"
          initial="未命名.md"
          submitLabel="创建并编辑"
          onClose={() => setDialog(null)}
          onSubmit={async (raw) => {
            const name = /\.[^.]+$/.test(raw) ? raw : `${raw}.md`;
            const { entry } = await putContent(
              childOf(folder, name),
              "",
              "create",
            );
            await refresh();
            setDialog(null);
            go({ folder, file: entry.path, edit: true });
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title={`重命名「${dialog.entry.name}」`}
          initial={dialog.entry.name}
          submitLabel="保存"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await moveEntry(
              dialog.entry.path,
              childOf(parentOf(dialog.entry.path), name),
            );
            await refresh();
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "target" && (
        <TargetDialog
          title={
            dialog.entries.length === 1
              ? `把「${dialog.entries[0]?.name ?? ""}」${dialog.action === "move" ? "移动" : "复制"}到…`
              : `把选中的 ${String(dialog.entries.length)} 项${dialog.action === "move" ? "移动" : "复制"}到…`
          }
          submitLabel={dialog.action === "move" ? "移动到这里" : "复制到这里"}
          initial={folder}
          // 移动到原位置等于没动；复制到原位置是合法的（自动改名为「名称 (1)」）。
          {...(dialog.action === "move"
            ? { unchanged: parentOf(dialog.entries[0]?.path ?? "/") }
            : {})}
          folders={dialog.entries.filter((e) => e.isDir).map((e) => e.path)}
          root={root}
          rootName={rootName}
          hide={hide}
          onClose={() => setDialog(null)}
          onSubmit={async (target) => {
            const { action, entries: picked } = dialog;
            const where = crumbsOf(target).at(-1)?.name ?? "文件";
            let result: Notice;
            if (picked.length === 1 && picked[0]) {
              const only = picked[0];
              const to = childOf(target, nameOf(only.path));
              const entry =
                action === "move"
                  ? await moveEntry(only.path, to)
                  : await copyEntry(only.path, to);
              const renamed =
                entry.name !== only.name
                  ? `（同名已改为「${entry.name}」）`
                  : "";
              result = {
                ok: true,
                text: `已${action === "move" ? "移动" : "复制"}到「${where}」${renamed}`,
              };
            } else {
              const r = await batch(
                action,
                picked.map((e) => e.path),
                target,
              );
              result = describeBatch(
                `${action === "move" ? "移动" : "复制"}到「${where}」`,
                r,
              );
            }
            await refresh();
            setDialog(null);
            clearSelection();
            setNotice(result);
          }}
        />
      )}
    </div>
  );
}

function KindIcon({ entry }: { entry: FileEntry }): React.JSX.Element {
  switch (entry.kind) {
    case "folder":
      return <Folder size={15} className="files-icon folder" />;
    case "markdown":
      return <FileText size={15} className="files-icon md" />;
    case "html":
    case "text":
      return <FileCode size={15} className="files-icon" />;
    case "image":
      return <FileImage size={15} className="files-icon img" />;
    case "pdf":
      return <FileText size={15} className="files-icon pdf" />;
    default:
      return <File size={15} className="files-icon" />;
  }
}
