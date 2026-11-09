import { useEffect, useId, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

/**
 * 新建 / 编辑对话框（产品线与产品共用）。只管名称与描述；产品额外的
 * 「所属产品线」由调用方通过 `extra` 塞进来。
 *
 * 不用原生 <dialog>：showModal 在 jsdom 里没有实现，组件测试跑不了。
 * 自己做一层遮罩 + role="dialog"，Esc 关闭、打开时聚焦名称输入框。
 */
export function EditDialog({
  title,
  submitLabel,
  initial,
  extra,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  initial?: { name: string; description: string };
  /** 额外的表单项（如产品的「所属产品线」）。 */
  extra?: React.ReactNode;
  /** 抛错时错误信息显示在对话框里，对话框不关。 */
  onSubmit: (fields: { name: string; description: string }) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const headingId = useId();

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name: name.trim(), description: description.trim() });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <header className="dialog-head">
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
        <label className="field">
          名称
          <input
            ref={nameRef}
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="field">
          描述
          <textarea
            rows={4}
            maxLength={2000}
            placeholder="选填"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        {extra}
        {error && (
          <p className="err-text" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-foot">
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
    </div>
  );
}
