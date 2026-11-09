import { useEffect, useState } from "react";
import { FileSearch, FolderPlus, Loader2, Pencil, X } from "lucide-react";

import { FolderPicker } from "../analysis/FolderPicker";

/** 与服务端 wiki.ts 的 MAX_PAGE_SOURCES 一致。 */
const MAX_PAGE_SOURCES = 8;

/**
 * 章节标题下的「精读路径」栏。
 *
 * 让 AI 写这一章时，系统**只对这些路径读文件正文（含源代码）**，别处只给浅层目录。
 * 所以它直接决定这一章写得出有出处的内容，还是只能看着目录名猜——必须摆在明面上、能改。
 * 空着时要明说后果，不能只显示一个空位。
 */
export function SourcesBar({
  sources,
  onSave,
}: {
  sources: readonly string[];
  onSave: (next: string[]) => Promise<void>;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="wiki-sources">
      <FileSearch size={13} className="faint" />
      {sources.length === 0 ? (
        <span className="wiki-sources-empty">
          没指定精读路径——让 AI 写时读不到源代码和文档正文，只能看目录名。
        </span>
      ) : (
        <span className="wiki-sources-list">
          精读：
          {sources.map((s) => (
            <code key={s} title={s}>
              {s}
            </code>
          ))}
        </span>
      )}
      <button
        type="button"
        className="icon-btn ghost"
        aria-label="改精读路径"
        title="改精读路径"
        onClick={() => setOpen(true)}
      >
        <Pencil size={12} />
      </button>
      {open && (
        <SourcesDialog
          initial={sources}
          onClose={() => setOpen(false)}
          onSave={async (next) => {
            await onSave(next);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function SourcesDialog({
  initial,
  onSave,
  onClose,
}: {
  initial: readonly string[];
  onSave: (next: string[]) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [text, setText] = useState(initial.join("\n"));
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = [
    ...new Set(
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== ""),
    ),
  ];

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy && !picking) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy, picking]);

  if (picking)
    return (
      <FolderPicker
        title="加一条精读路径"
        hint="选一个目录（会往下找源文件读）或点选单个文件。只能选这个产品绑定的文档、代码目录和参考资料里的路径，别处的写正文时会被忽略。"
        submitLabel="加上"
        allowFiles
        onClose={() => setPicking(false)}
        onPick={async (path) => {
          setText((t) => (t.trim() === "" ? path : `${t.trimEnd()}\n${path}`));
          setPicking(false);
          return Promise.resolve();
        }}
      />
    );

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <form
        className="dialog wide"
        role="dialog"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          void onSave(list)
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "保存失败");
            })
            .finally(() => setBusy(false));
        }}
      >
        <header className="dialog-head">
          <h2>精读路径</h2>
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
        <p className="field-hint">
          让 AI
          写这一章时，只对这些路径读文件正文（包括源代码）。代码类章节要指到具体的子目录（比如
          <code>…/backend/ent/schema</code>
          ），指到仓库根会把篇幅摊薄、读不到关键文件。一行一条，最多{" "}
          {MAX_PAGE_SOURCES} 条。改完要重新点「让 AI 写 / 重写」才生效。
        </p>
        <label className="field">
          路径
          <textarea
            rows={6}
            value={text}
            spellCheck={false}
            placeholder={
              "/代码库/xxx/server/internal/handler\n/product-docs/xxx/prd"
            }
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        {list.length > MAX_PAGE_SOURCES && (
          <p className="err-text">
            最多 {MAX_PAGE_SOURCES} 条，现在是 {list.length} 条。
          </p>
        )}
        {error !== null && (
          <p className="err-text" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-foot">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setPicking(true)}
          >
            <FolderPlus size={13} /> 从文件里选
          </button>
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || list.length > MAX_PAGE_SOURCES}
          >
            {busy && <Loader2 size={13} className="spin" />}
            保存
          </button>
        </footer>
      </form>
    </div>
  );
}
