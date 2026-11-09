import { useState } from "react";
import { Loader2, Save, X } from "lucide-react";

import { draftName } from "../skills/skill-file";

/**
 * 「新建」面板：技能页和执行体页共用。
 *
 * 两边原本是两份几乎逐字相同的组件（约 95% 一样），差别只有三处：标题、保存时调哪个接口、
 * 底下那行提示。复制两份的代价不在当下，而在以后改样式或改交互要记得改两处——
 * 这类面板最容易「一个改了另一个忘了」。
 */
export function NewDefinitionPanel({
  title,
  hint,
  template,
  ariaLabel,
  placeholder,
  footnote,
  onSave,
  onDone,
  onCancel,
}: {
  title: string;
  /** 保存后会叫什么、会建在哪。 */
  hint: (name: string | null) => React.ReactNode;
  template: string;
  ariaLabel: string;
  /** 没写时输入框里的灰字。 */
  placeholder?: string | undefined;
  /** 底部右侧：保存前显示它，出错后换成错误。 */
  footnote: React.ReactNode;
  onSave: (content: string) => Promise<{ name: string }>;
  onDone: (name: string) => Promise<void> | void;
  onCancel: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(template);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="skill-detail">
      <header className="skill-detail-head">
        <div>
          <h3>{title}</h3>
          <p className="muted small">{hint(draftName(draft))}</p>
        </div>
      </header>
      <textarea
        className="skill-editor"
        aria-label={ariaLabel}
        spellCheck={false}
        value={draft}
        {...(placeholder === undefined ? {} : { placeholder })}
        onChange={(e) => setDraft(e.target.value)}
      />
      <footer className="skill-foot">
        <span className="row gap">
          <button
            type="button"
            className="btn primary"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setError(null);
              void onSave(draft)
                .then((saved) => onDone(saved.name))
                .catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : "保存失败");
                })
                .finally(() => setSaving(false));
            }}
          >
            {saving ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Save size={13} />
            )}{" "}
            保存
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            <X size={13} /> 取消
          </button>
        </span>
        {error !== null ? (
          <span className="err-text small">{error}</span>
        ) : (
          <span className="muted small">{footnote}</span>
        )}
      </footer>
    </div>
  );
}
