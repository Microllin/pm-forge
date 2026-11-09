import { useRef, useState } from "react";
import {
  Boxes,
  DownloadCloud,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  FolderUp,
  GitBranch,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { NameDialog } from "../files/dialogs";
import { FilesPage } from "../files/FilesPage";
import { formatSize, formatTime } from "../files/api";
import { CODE_HOME, CODE_ROOT, type FilesLocation } from "../files/location";
import {
  describeSummary,
  fromInput,
  uploadAll,
  type UploadItem,
} from "../files/upload";
import {
  cloneRepo,
  createRepo,
  deleteRepo,
  listRepos,
  pullRepo,
  renameRepo,
  resetRepo,
  type CodeRepo,
} from "./api";
import { CloneDialog } from "./CloneDialog";
import "./code.css";

/**
 * 依赖与构建产物：上传整个仓库时跳过。它们不是「代码事实」（AI 读代码时也不该读），
 * 却往往占了仓库体积的大头——RouteHub 带 node_modules 是 673 MB，去掉后不到 400 MB。
 */
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);

/** 选中的文件夹 → 去掉顶层目录名后的待上传项（仓库内容直接放进仓库根），并剔除依赖目录。 */
function prepare(files: FileList): {
  top: string;
  items: UploadItem[];
  skipped: number;
} {
  const all = fromInput(files);
  const top = all[0]?.relPath.split("/")[0] ?? "";
  let skipped = 0;
  const items: UploadItem[] = [];
  for (const item of all) {
    const parts = item.relPath.split("/").slice(1);
    if (parts.length === 0) continue;
    if (parts.slice(0, -1).some((p) => SKIP_DIRS.has(p))) {
      skipped += 1;
      continue;
    }
    items.push({ file: item.file, relPath: parts.join("/") });
  }
  return { top, items, skipped };
}

type Dialog =
  | { kind: "new" }
  | { kind: "rename"; repo: CodeRepo }
  | { kind: "clone" }
  | null;
type Notice = { ok: boolean; text: string } | null;

/**
 * 事实底座 → 代码库：按「仓库」管理代码。
 *
 * 首页是仓库清单（体量、最近更新、绑定了哪些产品）；点「浏览」进入某个仓库，
 * 那一层复用文件模块（树 + 列表 + 预览 + 代码高亮），根就定在这个仓库上。
 * 位置记在外壳的 codeLocation 里：停在 /代码库 = 清单，再往下 = 浏览某个仓库。
 */
export function CodeReposPage({
  location,
  onLocation,
  onDirtyChange,
}: {
  location: FilesLocation;
  onLocation: (next: FilesLocation) => void;
  onDirtyChange?: ((dirty: boolean) => void) | undefined;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const repos = useQuery({ queryKey: ["code-repos"], queryFn: listRepos });
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [progress, setProgress] = useState<{
    repo: string;
    done: number;
    total: number;
  } | null>(null);
  /** 克隆 / 拉取的实时输出（git 自己的话，逐行追加）。null = 没在跑。 */
  const [git, setGit] = useState<{
    title: string;
    lines: string[];
    error: string | null;
  } | null>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  /** 文件夹选择器选完之后要干什么：新建仓库，还是覆盖某个已有仓库。 */
  const target = useRef<{ kind: "new" } | { kind: "replace"; name: string }>({
    kind: "new",
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["code-repos"] }),
      queryClient.invalidateQueries({ queryKey: ["files-list"] }),
      queryClient.invalidateQueries({ queryKey: ["files-search"] }),
      // 改名 / 删除会改产品的代码目录绑定。
      queryClient.invalidateQueries({ queryKey: ["lines"] }),
    ]);

  // 正在浏览某个仓库：/代码库/<仓库>/…
  const inside = location.folder.startsWith(`${CODE_ROOT}/`);
  if (inside) {
    const name = location.folder.slice(CODE_ROOT.length + 1).split("/")[0];
    const root = `${CODE_ROOT}/${name ?? ""}`;
    return (
      <FilesPage
        key={root}
        location={location}
        onLocation={onLocation}
        root={root}
        rootName={name ?? "仓库"}
        onDirtyChange={onDirtyChange}
        onBack={() => {
          onLocation(CODE_HOME);
          void refresh();
        }}
      />
    );
  }

  const fail = (cause: unknown) =>
    setNotice({
      ok: false,
      text: cause instanceof Error ? cause.message : "操作失败",
    });

  const pickFolder = (next: typeof target.current) => {
    target.current = next;
    folderInput.current?.click();
  };

  const onPicked = async (files: FileList) => {
    const { top, items, skipped } = prepare(files);
    if (items.length === 0) {
      setNotice({ ok: false, text: "这个文件夹里没有可上传的文件" });
      return;
    }
    setNotice(null);
    const plan = target.current;
    const name = plan.kind === "new" ? top : plan.name;
    try {
      if (plan.kind === "new") await createRepo(name);
      else await resetRepo(name);
      await refresh();
      setProgress({ repo: name, done: 0, total: items.length });
      const summary = await uploadAll(
        `${CODE_ROOT}/${name}`,
        items,
        (done, total) => setProgress({ repo: name, done, total }),
      );
      const text = describeSummary(summary);
      setNotice({
        ok: text.ok,
        text: `「${name}」${plan.kind === "new" ? "已上传" : "已重新上传"}：${text.text}${
          skipped > 0
            ? `；跳过依赖与构建目录里的 ${String(skipped)} 个文件`
            : ""
        }`,
      });
    } catch (cause) {
      fail(cause);
    } finally {
      setProgress(null);
      await refresh();
    }
  };

  const replace = (repo: CodeRepo) => {
    if (
      !window.confirm(
        `用新选的文件夹覆盖「${repo.name}」？现有 ${String(repo.files)} 个文件会先清空，绑定的产品保持不变。`,
      )
    )
      return;
    pickFolder({ kind: "replace", name: repo.name });
  };

  const remove = (repo: CodeRepo) => {
    const bound =
      repo.products.length > 0
        ? `\n\n以下产品的代码目录绑在它上面，删除后会自动解绑：${repo.products.map((p) => p.name).join("、")}`
        : "";
    if (
      !window.confirm(
        `删除仓库「${repo.name}」和里面的 ${String(repo.files)} 个文件？此操作不能撤销。${bound}`,
      )
    )
      return;
    void deleteRepo(repo.name)
      .then((r) =>
        setNotice({
          ok: true,
          text:
            r.unbound.length > 0
              ? `已删除「${repo.name}」，并解绑了 ${r.unbound.map((p) => p.name).join("、")}`
              : `已删除「${repo.name}」`,
        }),
      )
      .catch(fail)
      .finally(() => void refresh());
  };

  /** 拉取更新：有本地改动时服务端会回 dirty，问一次要不要丢弃再来。 */
  const pull = async (
    repo: CodeRepo,
    discardsChanges = false,
  ): Promise<void> => {
    setNotice(null);
    setGit({ title: `拉取更新 · ${repo.name}`, lines: [], error: null });
    let dirty = 0;
    let failure: string | null = null;
    try {
      await pullRepo(repo.name, { discardsChanges }, (event) => {
        if (event.type === "line")
          setGit((g) =>
            g === null
              ? g
              : { ...g, lines: [...g.lines.slice(-200), event.line] },
          );
        else if (event.type === "dirty") dirty = event.files;
        else if (event.type === "done") {
          if (event.ok) {
            setNotice({ ok: true, text: `「${repo.name}」已更新到远端最新` });
            setGit(null);
          } else failure = event.error ?? "拉取失败";
        }
      });
    } catch (cause) {
      failure = cause instanceof Error ? cause.message : "拉取失败";
    }
    if (failure !== null) {
      setGit((g) =>
        g === null ? g : { ...g, error: failure, lines: g.lines.slice(-200) },
      );
      if (
        dirty > 0 &&
        window.confirm(
          `仓库里有 ${String(dirty)} 处本地改动，拉取会覆盖它们。\n\n确定丢弃这些改动、用远端最新覆盖吗？`,
        )
      ) {
        await pull(repo, true);
        return;
      }
    }
    await refresh();
  };

  /** 克隆：对话框收 url / 名字 / 分支，流式输出在同一个输出面板里。 */
  const clone = async (input: {
    url: string;
    name?: string;
    branch?: string;
  }): Promise<void> => {
    setDialog(null);
    setNotice(null);
    setGit({
      title: `克隆 · ${input.name ?? input.url}`,
      lines: [],
      error: null,
    });
    try {
      await cloneRepo(input, (event) => {
        if (event.type === "line")
          setGit((g) =>
            g === null
              ? g
              : { ...g, lines: [...g.lines.slice(-200), event.line] },
          );
        else if (event.type === "done") {
          if (event.ok && event.repo !== undefined) {
            setNotice({ ok: true, text: `「${event.repo.name}」已克隆` });
            setGit(null);
          } else {
            setGit((g) =>
              g === null ? g : { ...g, error: event.error ?? "克隆失败" },
            );
          }
        }
      });
    } catch (cause) {
      setGit((g) =>
        g === null
          ? g
          : {
              ...g,
              error: cause instanceof Error ? cause.message : "克隆失败",
            },
      );
    }
    await refresh();
  };

  const browse = (repo: CodeRepo) =>
    onLocation({ folder: repo.path, file: null });

  const list = repos.data ?? [];
  const busy = progress !== null;

  return (
    <div className="code-page">
      <div className="code-inner">
        <header className="code-head">
          <div className="code-titles">
            {/* 页面标题在顶栏，正文不再重复一遍。 */}
            <p className="muted">
              一个仓库对应一份上传的源码。产品绑定「代码目录」后，AI
              分析功能架构、写 Wiki 时读的就是这里。上传时会自动跳过
              node_modules、dist 等依赖与构建目录。
            </p>
          </div>
          <div className="code-actions">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => setDialog({ kind: "new" })}
            >
              <FolderPlus size={14} /> 新建空仓库
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => pickFolder({ kind: "new" })}
            >
              <FolderUp size={14} /> 上传文件夹
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => setDialog({ kind: "clone" })}
            >
              <GitBranch size={14} /> 从 Git 克隆
            </button>
            <input
              ref={(el) => {
                folderInput.current = el;
                // React 的类型里没有 webkitdirectory，用属性设置（各浏览器都支持）。
                el?.setAttribute("webkitdirectory", "");
              }}
              type="file"
              hidden
              aria-label="选择仓库文件夹"
              onChange={(e) => {
                const picked = e.target.files;
                if (picked && picked.length > 0) void onPicked(picked);
                e.target.value = "";
              }}
            />
          </div>
        </header>

        {progress !== null && (
          <div className="code-progress" role="status">
            <Loader2 size={14} className="spin" />
            <span>
              正在上传「{progress.repo}」：{progress.done} / {progress.total}
            </span>
            <span className="code-bar" aria-hidden="true">
              <i
                style={{
                  width: `${String(progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100))}%`,
                }}
              />
            </span>
          </div>
        )}
        {git !== null && (
          <div className={`code-terminal${git.error === null ? "" : " bad"}`}>
            <div className="code-terminal-head">
              {git.error === null ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <span className="err-text">{git.error}</span>
              )}
              <b>{git.title}</b>
              {git.error === null && <span className="muted">进行中…</span>}
              <button
                type="button"
                className="icon-btn"
                aria-label="收起输出"
                title="收起"
                onClick={() => setGit(null)}
              >
                <X size={14} />
              </button>
            </div>
            <pre className="code-terminal-body" aria-live="polite">
              {git.lines.length === 0 ? "等待 git 输出…" : git.lines.join("\n")}
            </pre>
          </div>
        )}
        {notice !== null && (
          <p
            className={`code-notice ${notice.ok ? "ok-text" : "err-text"}`}
            role={notice.ok ? "status" : "alert"}
          >
            {notice.text}
          </p>
        )}

        <section className="code-card" aria-label="仓库清单">
          {repos.isLoading && (
            <p className="muted code-empty">
              <Loader2 size={14} className="spin" /> 载入中…
            </p>
          )}
          {repos.isError && (
            <p className="err-text code-empty">
              读不到仓库清单：{repos.error.message}
            </p>
          )}
          {repos.isSuccess && list.length === 0 && (
            <div className="code-empty">
              <FolderGit2 size={28} />
              <p>还没有仓库。点「上传仓库」选一个项目文件夹，整个传上来。</p>
            </div>
          )}
          {list.length > 0 && (
            <div className="code-table-wrap">
              <table className="code-table">
                <thead>
                  <tr>
                    <th>仓库</th>
                    <th className="num">文件</th>
                    <th className="num">大小</th>
                    <th>最近更新</th>
                    <th>绑定的产品</th>
                    <th aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {list.map((repo) => (
                    <tr key={repo.path}>
                      <td>
                        <button
                          type="button"
                          className="code-name"
                          onClick={() => browse(repo)}
                        >
                          <FolderGit2 size={16} />
                          <span>{repo.name}</span>
                        </button>
                      </td>
                      <td className="num mono">
                        {repo.files.toLocaleString("zh-CN")}
                      </td>
                      <td className="num mono">{formatSize(repo.bytes)}</td>
                      <td className="code-when">
                        <span className="mono">
                          {repo.modifiedAt === null
                            ? "空仓库"
                            : formatTime(repo.modifiedAt)}
                        </span>
                        {repo.git === null ? (
                          <span className="code-origin">上传的文件夹</span>
                        ) : (
                          <span
                            className="code-origin"
                            title={repo.git.remote ?? ""}
                          >
                            <GitBranch size={11} />
                            {repo.git.branch ?? "detached"}
                          </span>
                        )}
                      </td>
                      <td>
                        {repo.products.length === 0 ? (
                          <span className="muted">未绑定</span>
                        ) : (
                          <span className="code-products">
                            {repo.products.map((p) => (
                              <span key={p.id} className="code-chip">
                                <Boxes size={12} />
                                {p.name}
                              </span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td className="code-ops">
                        <button
                          type="button"
                          className="icon-btn"
                          title="浏览"
                          aria-label={`浏览 ${repo.name}`}
                          onClick={() => browse(repo)}
                        >
                          <FolderOpen size={15} />
                        </button>
                        {repo.git !== null && (
                          <button
                            type="button"
                            className="icon-btn"
                            title="拉取更新（git pull，只做快进）"
                            aria-label={`拉取 ${repo.name}`}
                            disabled={busy}
                            onClick={() => void pull(repo)}
                          >
                            <DownloadCloud size={15} />
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-btn"
                          title="重新上传（覆盖）"
                          aria-label={`重新上传 ${repo.name}`}
                          disabled={busy}
                          onClick={() => replace(repo)}
                        >
                          <RefreshCw size={15} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn"
                          title="改名"
                          aria-label={`改名 ${repo.name}`}
                          disabled={busy}
                          onClick={() => setDialog({ kind: "rename", repo })}
                        >
                          <Pencil size={15} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn danger"
                          title="删除"
                          aria-label={`删除 ${repo.name}`}
                          disabled={busy}
                          onClick={() => remove(repo)}
                        >
                          <Trash2 size={15} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {dialog?.kind === "clone" && (
        <CloneDialog
          onClose={() => setDialog(null)}
          onSubmit={(input) => void clone(input)}
        />
      )}
      {dialog?.kind === "new" && (
        <NameDialog
          title="新建空仓库"
          label="仓库名"
          submitLabel="新建"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const repo = await createRepo(name);
            await refresh();
            setDialog(null);
            browse(repo);
          }}
        />
      )}
      {dialog?.kind === "rename" && (
        <NameDialog
          title={`给「${dialog.repo.name}」改名`}
          label="仓库名"
          initial={dialog.repo.name}
          submitLabel="改名"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await renameRepo(dialog.repo.name, name);
            await refresh();
            setDialog(null);
            setNotice({
              ok: true,
              text:
                dialog.repo.products.length > 0
                  ? `已改名为「${name}」，${dialog.repo.products.map((p) => p.name).join("、")} 的代码目录已同步`
                  : `已改名为「${name}」`,
            });
          }}
        />
      )}
    </div>
  );
}
