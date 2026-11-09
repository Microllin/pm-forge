import { useEffect, useId, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";

import type { ArtifactFields, StageFields, TemplateFields } from "./api";

/**
 * 生命周期规范页的三个表单浮层：模板 / 阶段 / 产出物。
 *
 * 共用一层 `DialogShell`（遮罩 + Esc 关闭 + 打开聚焦 + 错误内嵌不关窗），
 * 与 products/EditDialog 同一套交互口径；样式类在 styles.css 的「对话框」一节。
 *
 * 不用原生 <dialog>：showModal 在 jsdom 里没有实现，组件测试跑不了。
 */
function DialogShell({
  title,
  submitLabel,
  wide = false,
  disabled = false,
  children,
  onSubmit,
  onClose,
  focusRef,
}: {
  title: string;
  submitLabel: string;
  wide?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  onSubmit: () => Promise<void>;
  onClose: () => void;
  focusRef: React.RefObject<HTMLInputElement | null>;
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const headingId = useId();

  useEffect(() => {
    focusRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, focusRef]);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
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
        className={`dialog${wide ? " wide" : ""}`}
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
        {children}
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
            disabled={busy || disabled}
          >
            {busy && <Loader2 size={13} className="spin" />}
            {submitLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}

export function TemplateDialog({
  title,
  submitLabel,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  initial?: TemplateFields;
  onSubmit: (fields: TemplateFields) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const nameRef = useRef<HTMLInputElement>(null);

  return (
    <DialogShell
      title={title}
      submitLabel={submitLabel}
      disabled={name.trim() === ""}
      onClose={onClose}
      focusRef={nameRef}
      onSubmit={() =>
        onSubmit({ name: name.trim(), description: description.trim() })
      }
    >
      <label className="field">
        模板名称
        <input
          ref={nameRef}
          value={name}
          maxLength={80}
          placeholder="如：标准 SaaS Web 产品"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field">
        适用说明
        <textarea
          rows={3}
          maxLength={2000}
          placeholder="这套规范适用于什么样的产品、为什么这么分阶段"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </label>
    </DialogShell>
  );
}

export function StageDialog({
  title,
  submitLabel,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  initial?: StageFields;
  onSubmit: (fields: StageFields) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [code, setCode] = useState(initial?.code ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [question, setQuestion] = useState(initial?.question ?? "");
  const codeRef = useRef<HTMLInputElement>(null);

  return (
    <DialogShell
      title={title}
      submitLabel={submitLabel}
      disabled={code.trim() === "" || label.trim() === ""}
      onClose={onClose}
      focusRef={codeRef}
      onSubmit={() =>
        onSubmit({
          code: code.trim(),
          label: label.trim(),
          question: question.trim(),
        })
      }
    >
      <div className="field-row">
        <label className="field">
          代号
          <input
            ref={codeRef}
            value={code}
            maxLength={20}
            placeholder="L0.1"
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <label className="field">
          阶段名称
          <input
            value={label}
            maxLength={80}
            placeholder="想法卡"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
      </div>
      <label className="field">
        这一阶段回答什么问题
        <input
          value={question}
          maxLength={200}
          placeholder="这个想法值不值得细看"
          onChange={(e) => setQuestion(e.target.value)}
        />
      </label>
      <p className="field-hint">
        代号在同一个模板内唯一，用来排序与引用；不想按 L0/L1 编号也可以写
        「立项」「规划」这类自定义代号。
      </p>
    </DialogShell>
  );
}

export function ArtifactDialog({
  title,
  submitLabel,
  initial,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  initial?: ArtifactFields;
  onSubmit: (fields: ArtifactFields) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? "");
  const [required, setRequired] = useState(initial?.required ?? true);
  const [guide, setGuide] = useState(initial?.guide ?? "");
  const [checkpoints, setCheckpoints] = useState(initial?.checkpoints ?? "");
  const [fileHints, setFileHints] = useState(initial?.fileHints ?? "");
  const nameRef = useRef<HTMLInputElement>(null);

  return (
    <DialogShell
      title={title}
      submitLabel={submitLabel}
      wide
      disabled={name.trim() === ""}
      onClose={onClose}
      focusRef={nameRef}
      onSubmit={() =>
        onSubmit({
          name: name.trim(),
          required,
          guide: guide.trim(),
          checkpoints,
          fileHints,
        })
      }
    >
      <label className="field">
        产出物名称
        <input
          ref={nameRef}
          value={name}
          maxLength={80}
          placeholder="如：立项 PR-FAQ"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label className="field check-field">
        <input
          type="checkbox"
          checked={required}
          onChange={(e) => setRequired(e.target.checked)}
        />
        必交（取消勾选就是选填，比对时缺了只提示不判不合格）
      </label>
      <label className="field">
        写作指引
        <textarea
          rows={3}
          maxLength={2000}
          placeholder="这份东西该怎么写、写到什么程度"
          value={guide}
          onChange={(e) => setGuide(e.target.value)}
        />
      </label>
      <label className="field">
        判定要点（一行一条）
        <textarea
          rows={6}
          maxLength={4000}
          placeholder={
            "谁的什么痛点，具体到人和场景\n他们现在怎么凑合解决的\n为什么值得细看"
          }
          value={checkpoints}
          onChange={(e) => setCheckpoints(e.target.value)}
        />
      </label>
      <label className="field">
        文件线索（一行一条）
        <textarea
          rows={3}
          maxLength={500}
          placeholder={"想法卡\nidea-card"}
          value={fileHints}
          onChange={(e) => setFileHints(e.target.value)}
        />
      </label>
      <p className="field-hint">
        这两栏是给「AI
        读文件比对」用的：文件线索先把扫描面缩小到可能相关的文件，
        判定要点让结论能落到「有，但第 2 点没答」，而不只是「有 / 没有」。
      </p>
    </DialogShell>
  );
}
