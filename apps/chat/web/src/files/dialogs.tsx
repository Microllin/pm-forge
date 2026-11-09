import { useEffect, useId, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

import { FolderTree } from "./FolderTree";

/**
 * 文件模块的两个对话框：输入名称（新建文件夹 / 新建 Markdown / 改名）、选择目标文件夹（移动）。
 * 提交抛错时错误显示在对话框里、对话框不关（比如重名 409）。
 */

function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
}

function Shell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}): React.JSX.Element {
  const headingId = useId();
  useEscape(onClose);
  return (
    <div
      className="files-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="files-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
      >
        <header className="files-dialog-head">
          <h2 id={headingId}>{title}</h2>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : "操作失败";

export function NameDialog({
  title,
  label = "名称",
  initial = "",
  submitLabel,
  onSubmit,
  onClose,
}: {
  title: string;
  label?: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (name: string) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    // 改名时只选中主文件名，不选扩展名（与 Finder 一致）。
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  };

  return (
    <Shell title={title} onClose={onClose}>
      <form
        className="files-dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="files-field">
          {label}
          <input
            ref={ref}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && (
          <p className="err-text" role="alert">
            {error}
          </p>
        )}
        <footer className="files-dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || name.trim() === ""}
          >
            {busy && <Loader2 size={13} className="spin" />}
            {submitLabel}
          </button>
        </footer>
      </form>
    </Shell>
  );
}

/** 选择目标文件夹（移动 / 复制，单个或批量）。 */
export function TargetDialog({
  title,
  submitLabel,
  initial,
  unchanged,
  folders,
  root = "/",
  rootName = "文件",
  hide = [],
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  /** 打开时默认选中的文件夹。 */
  initial: string;
  /** 选它等于没动（移动时的原位置）：按钮置灰。复制不传——复制到原处是合法的。 */
  unchanged?: string;
  /** 被操作的文件夹：它们自己与子文件夹不能选。 */
  folders: readonly string[];
  /** 目标只能在本入口的根下选，不能把仓库里的文件挪进文件库，反之亦然。 */
  root?: string;
  rootName?: string;
  hide?: readonly string[];
  onSubmit: (folder: string) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [target, setTarget] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Shell title={title} onClose={onClose}>
      <div className="files-dialog-body">
        <div className="files-move-tree">
          <FolderTree
            selected={target}
            onSelect={setTarget}
            label="目标文件夹"
            disabledWithin={folders}
            root={root}
            rootName={rootName}
            hide={hide}
          />
        </div>
        {error && (
          <p className="err-text" role="alert">
            {error}
          </p>
        )}
        <footer className="files-dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || target === unchanged}
            onClick={() => {
              setBusy(true);
              setError(null);
              onSubmit(target).catch((cause: unknown) => {
                setError(messageOf(cause));
                setBusy(false);
              });
            }}
          >
            {busy && <Loader2 size={13} className="spin" />}
            {submitLabel}
          </button>
        </footer>
      </div>
    </Shell>
  );
}
