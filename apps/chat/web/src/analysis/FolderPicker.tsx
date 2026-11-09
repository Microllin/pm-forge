import { useEffect, useState } from "react";
import {
  ChevronRight,
  FileText,
  Folder,
  Loader2,
  Sparkles,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { crumbsOf, childOf, listFolder } from "../files/api";
import "./analysis.css";

/**
 * 文件夹选择器。AI 分析的事实源就是文件模块里的某个目录，所以这里只让选文件夹，
 * 不让填本机绝对路径——绝对路径等于绕开 files/paths.ts 那套软链与越界闸。
 *
 * 交互上刻意做成「逐层点进去 + 随时可以就地选中当前这层」：产品库的层级深浅不一，
 * 有的在根下一层（`/product-docs`），有的在两层（`/product-docs/products`），
 * 强迫选到叶子或只能选根都不对。
 */
export function FolderPicker({
  title,
  hint,
  initialPath = "/",
  root = "/",
  submitLabel = "就选这个",
  allowFiles = false,
  onPick,
  onClose,
}: {
  title: string;
  hint?: string;
  initialPath?: string;
  /**
   * 能逛到的最上层。绑定代码目录时要传 CODE_ROOT：
   * 服务端现在会拒掉代码库之外的 codePath，让用户先选中再报 400 是在耍人。
   */
  root?: string;
  submitLabel?: string;
  /**
   * 也能选单个文件。挂参考资料时要用：产品线能力地图这类常常是**一份文件**，
   * 只能选目录的话就得把它所在的整层（连同别的产品）一起挂上。
   */
  allowFiles?: boolean;
  onPick: (path: string) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [path, setPathRaw] = useState(initialPath);
  /** 选中的文件（allowFiles 时）。换目录就清掉，免得「已选」显示的是上一层的文件。 */
  const [file, setFile] = useState<string | null>(null);
  const setPath = (next: string): void => {
    setFile(null);
    setPathRaw(next);
  };
  const chosen = file ?? path;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Esc 关闭。仓里另外四个弹窗都做了，这个和 panels.tsx 的两个漏了——
  // 键盘用户按 Esc 关不掉，而 role="dialog" aria-modal 已经承诺了这个行为。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const listing = useQuery({
    // key 必须与文件模块同源（FilesPage / FolderTree 都是 ["files-list", path]）：
    // 不同源的话这份缓存永远收不到 invalidateQueries(["files-list"])，还多占一份。
    queryKey: ["files-list", path],
    queryFn: () => listFolder(path),
  });
  const folders = (listing.data?.entries ?? []).filter(
    (e) => e.kind === "folder",
  );
  const fileEntries = allowFiles
    ? (listing.data?.entries ?? []).filter((e) => e.kind !== "folder")
    : [];

  const pick = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onPick(chosen);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      // 成功路径也要复位：原来靠「父组件会卸载我」兜底，调用点一改就卡在转圈上。
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="dialog wide" role="dialog" aria-modal="true">
        <header className="dialog-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        {hint !== undefined && <p className="field-hint">{hint}</p>}

        {/*
          面包屑裁到 root 为止。绑定代码目录时 root 是代码库那一层——
          让用户能点回「文件」再选中一个文档目录，而服务端随后 400，是在耍人。
        */}
        <nav className="picker-crumbs" aria-label="当前位置">
          <button type="button" onClick={() => setPath(root)}>
            {root === "/" ? "文件" : root.slice(root.lastIndexOf("/") + 1)}
          </button>
          {crumbsOf(path)
            .filter((c) => root === "/" || c.path.startsWith(`${root}/`))
            .map((c) => (
              <span key={c.path}>
                <ChevronRight size={12} className="faint" />
                <button type="button" onClick={() => setPath(c.path)}>
                  {c.name}
                </button>
              </span>
            ))}
        </nav>

        <div className="picker-folders">
          {listing.isPending && (
            <p className="muted small">
              <Loader2 size={13} className="spin" /> 读取中…
            </p>
          )}
          {listing.isError && (
            <p className="err-text">读取失败：{listing.error.message}</p>
          )}
          {listing.isSuccess &&
            folders.length === 0 &&
            fileEntries.length === 0 && (
              <p className="muted small">这一层没有子文件夹，可以直接选它。</p>
            )}
          {folders.map((f) => (
            <button
              key={f.name}
              type="button"
              className="picker-folder"
              onClick={() => setPath(childOf(path, f.name))}
            >
              <Folder size={14} className="faint" />
              <span>{f.name}</span>
              <ChevronRight size={14} className="faint" />
            </button>
          ))}
          {fileEntries.map((f) => {
            const full = childOf(path, f.name);
            return (
              <button
                key={f.name}
                type="button"
                className={`picker-folder${file === full ? " active" : ""}`}
                aria-pressed={file === full}
                onClick={() => setFile(file === full ? null : full)}
              >
                <FileText size={14} className="faint" />
                <span>{f.name}</span>
              </button>
            );
          })}
        </div>

        {error !== null && (
          <p className="err-text" role="alert">
            {error}
          </p>
        )}

        <footer className="dialog-foot">
          <span className="muted small picker-current">
            已选：<code>{chosen}</code>
          </span>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || chosen === "/"}
            title={chosen === "/" ? "不要选根目录，选到具体的产品库那一层" : ""}
            onClick={() => void pick()}
          >
            {busy ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Sparkles size={13} />
            )}
            {submitLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
