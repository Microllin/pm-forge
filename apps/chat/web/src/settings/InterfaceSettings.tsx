import {
  REASONING_DISPLAY,
  REASONING_DISPLAY_HINT,
  REASONING_DISPLAY_LABEL,
  setReasoningDisplay,
  useReasoningDisplay,
} from "./ui-prefs";
import { THEME_LABEL, THEMES, setTheme, useTheme } from "./theme";

/**
 * 界面偏好。存本机浏览器（localStorage），不发给服务端——见 ui-prefs.ts 的理由。
 * 所以这里没有「保存」按钮：点一下即生效，正在显示的思考部件立刻跟着变。
 */
export function InterfaceSettings(): React.JSX.Element {
  const mode = useReasoningDisplay();
  const theme = useTheme();
  return (
    <section className="card">
      <header className="card-head">
        <h3>界面</h3>
      </header>
      <div className="grid">
        <div className="field">
          <span>主题</span>
          <span className="seg" role="group" aria-label="主题">
            {THEMES.map((t) => (
              <button
                key={t}
                type="button"
                className={t === theme ? "on" : ""}
                aria-pressed={t === theme}
                onClick={() => setTheme(t)}
              >
                {THEME_LABEL[t]}
              </button>
            ))}
          </span>
        </div>
        {/* 一组按钮不能包在 <label> 里：label 会把自己的文字变成每个按钮的
            可访问名（实测读出来是「思考过程思考过程显示方式」）。 */}
        <div className="field">
          <span>思考过程</span>
          <span className="seg" role="group" aria-label="思考过程显示方式">
            {REASONING_DISPLAY.map((m) => (
              <button
                key={m}
                type="button"
                className={m === mode ? "on" : ""}
                aria-pressed={m === mode}
                title={REASONING_DISPLAY_HINT[m]}
                onClick={() => setReasoningDisplay(m)}
              >
                {REASONING_DISPLAY_LABEL[m]}
              </button>
            ))}
          </span>
        </div>
      </div>
      <p className="muted small">
        {REASONING_DISPLAY_HINT[mode]}
        自己点开或收起某一条时以手动为准，换了这里的选项后恢复按选项走。
      </p>
      <p className="muted small">
        注意：有些模型是「自适应思考」（如 Claude Opus
        5.5），简单问题它根本不思考，这时无论选哪档都不会有思考过程——不是没生效。
      </p>
    </section>
  );
}
