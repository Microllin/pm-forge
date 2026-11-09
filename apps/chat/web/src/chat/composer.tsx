import { useRef, useState } from "react";
import { ArrowUp, Clock, Square } from "lucide-react";

import type { ModelControls } from "./model-controls";
import { ModelBar } from "./ModelPicker";
import { SkillPicker } from "./SkillPicker";

/**
 * 输入框。
 *
 * 不用 assistant-ui 的 ComposerPrimitive：它在 AI SDK runtime 下没有「流式中排队」
 * 的通道，而这里要把补充的话交给 pi 的 followUp。
 *
 * 中文输入法：选词确认的那个 Enter 在部分平台会到达两次 keydown，第二次的
 * `isComposing` 已是 false。所以组词结束后立一个持续一帧的门，再加上
 * keyCode 229（组词期的上报值）一起判断。
 *
 * 与 pi CLI 一致的三个快捷方式：输入 `/model [搜索词]` 回车打开模型选择器、
 * `/skill [搜索词]` 回车打开技能选择器（都不会当成消息发出去）；Shift+Tab 切思考强度。
 * 直接打 `/skill:名字 参数` 则照常发出去，由服务端展开成技能正文（pi 的口径）。
 */
const MODEL_COMMAND = /^\/model(?:\s+(.*))?$/;
/** 只拦不带冒号的 `/skill`：带冒号的是真命令，要发给服务端。 */
const SKILL_PICKER_COMMAND = /^\/skills?(?:\s+(.*))?$/;

export function Composer({
  busy,
  pending,
  controls,
  onSubmit,
  onStop,
}: {
  busy: boolean;
  pending: number;
  controls: ModelControls;
  onSubmit: (text: string) => void;
  onStop: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState("");
  const [skillQuery, setSkillQuery] = useState<string | null>(null);
  const lastSent = useRef("");
  const composingGate = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);

  const submit = (): void => {
    const text = draft.trim();
    if (text === "") return;
    const command = MODEL_COMMAND.exec(text);
    if (command) {
      setDraft("");
      if (!busy) controls.openPicker(command[1]?.trim() ?? "");
      return;
    }
    const skillCommand = SKILL_PICKER_COMMAND.exec(text);
    if (skillCommand) {
      setDraft("");
      setSkillQuery(skillCommand[1]?.trim() ?? "");
      return;
    }
    lastSent.current = text;
    setDraft("");
    onSubmit(text);
  };

  return (
    <div className="composer">
      {/* 选择器用 .picker 的绝对定位（bottom: 100%+10px），需要一个零高的定位锚点；
          直接挂在 .composer 下会以更外层为基准，被顶到视口外（实测点不到）。 */}
      {skillQuery !== null && (
        <div className="picker-anchor">
          <SkillPicker
            query={skillQuery}
            onClose={() => setSkillQuery(null)}
            onPick={(name) => {
              // 填回输入框而不是直接发：技能通常还要带一句「做什么」。
              setSkillQuery(null);
              setDraft(`/skill:${name} `);
              box.current?.focus();
            }}
          />
        </div>
      )}
      <textarea
        ref={box}
        aria-label="输入消息"
        value={draft}
        rows={1}
        placeholder={
          busy
            ? "正在回答…现在发送会排在后面（Esc 停止）"
            : "发消息（Enter 发送，Shift+Enter 换行）"
        }
        onChange={(e) => setDraft(e.target.value)}
        onCompositionEnd={() => {
          composingGate.current = true;
          requestAnimationFrame(() => {
            composingGate.current = false;
          });
        }}
        onKeyDown={(e) => {
          const composing =
            e.nativeEvent.isComposing ||
            composingGate.current ||
            // 组词期部分输入法只报 229。已弃用但仍是唯一信号。
            // eslint-disable-next-line @typescript-eslint/no-deprecated
            e.keyCode === 229;
          if (e.key === "Tab" && e.shiftKey) {
            e.preventDefault();
            if (!busy) void controls.cycleThinking();
            return;
          }
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (!composing) submit();
            return;
          }
          // 输入框为空时 ↑ 取回刚发的那句（改一下重发）。
          if (e.key === "ArrowUp" && draft === "" && lastSent.current !== "") {
            e.preventDefault();
            setDraft(lastSent.current);
            return;
          }
          if (e.key === "Escape" && busy) {
            e.preventDefault();
            onStop();
          }
        }}
      />
      <div className="composer-bottom">
        <ModelBar controls={controls} busy={busy} />
        <div className="composer-side">
          {pending > 0 && (
            <span className="queue-hint" title="将在当前回答之后处理">
              <Clock size={12} /> {pending}
            </span>
          )}
          {busy && (
            <button
              type="button"
              className="icon-btn stop"
              aria-label="停止"
              title="停止（Esc）"
              // detail > 1 是双击：第一下发送、按钮刚变成停止，第二下会把刚起的这一轮掐掉。
              onClick={(e) => {
                if (e.detail <= 1) onStop();
              }}
            >
              <Square size={14} />
            </button>
          )}
          <button
            type="button"
            className="icon-btn send"
            aria-label={busy ? "排队发送" : "发送"}
            disabled={draft.trim() === ""}
            onClick={submit}
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
