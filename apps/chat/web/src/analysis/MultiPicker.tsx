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
import { CODE_ROOT } from "../files/location";
import "./analysis.css";

/** 一次最多勾几处。与服务端 MAX_DISCOVER_PATHS 一致。 */
export const MAX_PICKS = 12;

type PickKind = "doc" | "file" | "code";

const inCode = (p: string): boolean =>
  p === CODE_ROOT || p.startsWith(`${CODE_ROOT}/`);

const KIND_LABEL: Record<PickKind, string> = {
  doc: "文档",
  file: "文件",
  code: "代码",
};

/**
 * 多选版的文件选择器：在同一个框里勾文档文件夹、单个文件和代码仓库。
 *
 * 和 FolderPicker 一样只能选文件模块里的路径。交互是「点名字进下一层、点勾选框选中」，
 * 两件事分开：产品库与代码库层级深浅不一，选中某层之后还经常要进别处再勾几处。
 * 根目录和代码库那一层本身不让勾——勾了等于「全部」，范围就没意义了。
 */
export function MultiPicker({
  title,
  hint,
  initialPath = "/",
  submitLabel = "就选这些",
  onPick,
  onClose,
}: {
  title: string;
  hint?: string;
  initialPath?: string;
  submitLabel?: string;
  onPick: (paths: string[]) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [path, setPath] = useState(initialPath);
  /** 已勾选的路径 → 类别。用 Map 保持勾选顺序。 */
  const [picked, setPicked] = useState<ReadonlyMap<string, PickKind>>(
    () => new Map(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const listing = useQuery({
    queryKey: ["files-list", path],
    queryFn: () => listFolder(path),
  });
  const entries = listing.data?.entries ?? [];
  const folders = entries.filter((e) => e.kind === "folder");
  const fileEntries = entries.filter((e) => e.kind !== "folder");

  const selectable = (p: string): boolean => p !== "/" && p !== CODE_ROOT;
  const full = picked.size >= MAX_PICKS;

  const toggle = (p: string, isFile: boolean): void =>
    setPicked((prev) => {
      const next = new Map(prev);
      if (next.has(p)) next.delete(p);
      else if (next.size < MAX_PICKS)
        next.set(p, inCode(p) ? "code" : isFile ? "file" : "doc");
      return next;
    });

  const pick = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onPick([...picked.keys()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setBusy(false);
    }
  };

  const row = (name: string, isFile: boolean): React.JSX.Element => {
    const p = childOf(path, name);
    const on = picked.has(p);
    const canPick = selectable(p) && (on || !full);
    return (
      <div key={name} className={`picker-folder${on ? " active" : ""}`}>
        <input
          type="checkbox"
          aria-label={`勾选 ${name}`}
          checked={on}
          disabled={!canPick}
          onChange={() => toggle(p, isFile)}
        />
        {isFile ? (
          <button
            type="button"
            className="picker-name"
            disabled={!canPick}
            onClick={() => toggle(p, isFile)}
          >
            <FileText size={14} className="faint" />
            <span>{name}</span>
          </button>
        ) : (
          <button
            type="button"
            className="picker-name"
            aria-label={`进入 ${name}`}
            onClick={() => setPath(p)}
          >
            <Folder size={14} className="faint" />
            <span>{name}</span>
            <ChevronRight size={14} className="faint" />
          </button>
        )}
      </div>
    );
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

        <nav className="picker-crumbs" aria-label="当前位置">
          <button type="button" onClick={() => setPath("/")}>
            文件
          </button>
          {crumbsOf(path).map((c) => (
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
          {listing.isSuccess && entries.length === 0 && (
            <p className="muted small">这一层是空的。</p>
          )}
          {folders.map((f) => row(f.name, false))}
          {fileEntries.map((f) => row(f.name, true))}
        </div>

        <div className="picker-picked" aria-label="已勾选">
          {picked.size === 0 ? (
            <span className="muted small">
              还没勾选。点名字进入下一层，点前面的勾选框选中。
            </span>
          ) : (
            [...picked].map(([p, kind]) => (
              <span key={p} className="picker-chip">
                <span className="tag">{KIND_LABEL[kind]}</span>
                <code title={p}>{p}</code>
                <button
                  type="button"
                  className="icon-btn ghost"
                  aria-label={`去掉 ${p}`}
                  disabled={busy}
                  onClick={() => toggle(p, kind === "file")}
                >
                  <X size={12} />
                </button>
              </span>
            ))
          )}
        </div>

        {error !== null && (
          <p className="err-text" role="alert">
            {error}
          </p>
        )}

        <footer className="dialog-foot">
          <span className="muted small picker-current">
            已选 {String(picked.size)} 处
            {full ? `（最多 ${String(MAX_PICKS)} 处）` : ""}
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
            disabled={busy || picked.size === 0}
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
