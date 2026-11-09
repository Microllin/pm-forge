import { useState } from "react";
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronRight,
  FileSearch,
  Loader2,
  Scissors,
  Square,
  Wrench,
  X,
} from "lucide-react";
import type {
  DataMessagePartProps,
  ReasoningMessagePartProps,
  TextMessagePartProps,
  ToolCallMessagePartProps,
} from "@assistant-ui/react";

import { AgentRunCard } from "./AgentRunCard";
import { errorHint } from "./error-hint";
import { MarkdownText } from "./markdown";
import {
  useReasoningDisplay,
  type ReasoningDisplay,
} from "../settings/ui-prefs";

/**
 * 消息部件渲染器（交给 assistant-ui 的 MessagePrimitive.Parts）。
 * 部件语义来自服务端（server/pi/stream.ts 与 history.ts 产出同一套），
 * 所以这里不区分实时与历史。
 */

export function AssistantText({
  text,
  status,
}: TextMessagePartProps): React.JSX.Element {
  return <MarkdownText text={text} streaming={status.type === "running"} />;
}

/** 用户消息保持原样：你打的字不该被当 Markdown 解释。 */
/**
 * 用户发出的那句话。
 *
 * **超过 LONG_USER_LINES 行就先折叠**：AI 分析那两个入口发出去的是服务端拼好的
 * 一大段目录事实（实测 1.5 万字符量级）。不折叠的话，点一次「AI 识别」整屏都是
 * 目录树，真正要看的回答被推到视口外。折叠但可展开——那段事实是分析的依据，
 * 要能原样复查，不能藏起来。
 */
const LONG_USER_LINES = 14;

/** 与 server/evidence/brief.ts 的标记一致。前端不引服务端代码，这两个字面量要一起改。 */
const EVIDENCE_OPEN = "<pmforge-evidence>";
const EVIDENCE_CLOSE = "</pmforge-evidence>";

/**
 * 平台自动附上的「本次事实依据」。
 *
 * 它作为用户消息的一部分落库——续聊时 AI 还看得到、事后能追查「这份产出照着
 * 什么写的」。但展开放在气泡里会盖住用户真正说的话，所以默认收成一行。
 */
function EvidenceFold({ brief }: { brief: string }): React.JSX.Element {
  const files = (brief.match(/<事实来源 /g) ?? []).length;
  // 参考情报（市场情报库，见 server/intel/brief.ts）与事实依据同在一个包裹里，分开计数。
  const intel = (brief.match(/<情报条目 /g) ?? []).length;
  const parts = [
    files > 0 ? `事实依据 ${String(files)} 份文件` : null,
    intel > 0 ? `参考情报 ${String(intel)} 条` : null,
  ].filter((x): x is string => x !== null);
  return (
    <details className="evidence-fold">
      <summary>
        <FileSearch size={12} />
        {parts.length > 0
          ? `平台已附上${parts.join(" · ")}`
          : "平台已附上事实依据说明"}
      </summary>
      <div className="evidence-fold-body">{brief}</div>
    </details>
  );
}

export function UserText(props: TextMessagePartProps): React.JSX.Element {
  const raw = props.text;
  if (raw.startsWith(EVIDENCE_OPEN)) {
    const end = raw.indexOf(EVIDENCE_CLOSE);
    if (end !== -1) {
      const brief = raw.slice(EVIDENCE_OPEN.length, end).trim();
      const body = raw.slice(end + EVIDENCE_CLOSE.length).replace(/^\s+/, "");
      return (
        <>
          <EvidenceFold brief={brief} />
          <PlainUserText text={body} />
        </>
      );
    }
  }
  return <PlainUserText text={raw} />;
}

function PlainUserText({ text }: { text: string }): React.JSX.Element {
  const lines = text.split("\n");
  const long = lines.length > LONG_USER_LINES;
  const [open, setOpen] = useState(false);
  if (!long || open) {
    return (
      <>
        <span className="user-text">{text}</span>
        {long && (
          <button
            type="button"
            className="user-more"
            onClick={() => setOpen(false)}
          >
            收起
          </button>
        )}
      </>
    );
  }
  return (
    <>
      <span className="user-text">
        {lines.slice(0, LONG_USER_LINES).join("\n")}
      </span>
      <button type="button" className="user-more" onClick={() => setOpen(true)}>
        展开全文（共 {lines.length} 行）
      </button>
    </>
  );
}

/**
 * 思考过程。展开还是折叠由设置里的「思考过程」决定（settings/ui-prefs.ts）：
 * 折叠 / 边想边看（流式时开、答完收）/ 始终展开。
 *
 * 手动点过就以手动为准，但把当时的模式一起存着——模式一改，这份手动状态自动作废。
 * （派生状态不用 effect 算：把键与值存在一起，归零就成了纯派生。）
 * 标题里的字数在流式时实时增长——这是「它在动、没卡死」的直接证据。
 */
export function Reasoning({
  text,
  status,
}: ReasoningMessagePartProps): React.JSX.Element {
  const mode = useReasoningDisplay();
  const running = status.type === "running";
  const [manual, setManual] = useState<{
    mode: ReasoningDisplay;
    open: boolean;
  } | null>(null);
  const auto = mode === "expanded" || (mode === "streaming" && running);
  const open = manual !== null && manual.mode === mode ? manual.open : auto;
  return (
    <div className={`fold${open ? " open" : ""}`}>
      <button
        type="button"
        className="fold-head"
        aria-expanded={open}
        onClick={() => setManual({ mode, open: !open })}
      >
        <ChevronRight size={12} className="fold-chevron" />
        {running ? <Loader2 size={12} className="spin" /> : <Brain size={12} />}
        <span>{running ? "思考中" : "思考过程"}</span>
        <span className="fold-meta">{text.length} 字</span>
      </button>
      {open && <div className="fold-body reasoning-text">{text}</div>}
    </div>
  );
}

/** 工具调用（v1 服务端不给工具；保留渲染，后续加工具时直接可用）。 */
export function ToolCall({
  toolName,
  argsText,
  result,
  isError,
}: ToolCallMessagePartProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  // 派活（智能体团队）有自己的卡片：要能看到它在干什么、交回了什么。
  if (toolName === "delegate")
    return (
      <AgentRunCard
        argsText={argsText}
        output={
          result !== null && typeof result === "object" ? result : undefined
        }
        isError={isError === true}
      />
    );
  const done = result !== undefined || isError === true;
  const output =
    result !== null && typeof result === "object" && "text" in result
      ? String(result.text)
      : typeof result === "string"
        ? result
        : "";
  return (
    <div
      className={`fold${open ? " open" : ""}${isError === true ? " error" : ""}`}
    >
      <button
        type="button"
        className="fold-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={12} className="fold-chevron" />
        <Wrench size={12} />
        <span>{toolName}</span>
        <span className="fold-meta">
          {!done ? (
            <Loader2 size={12} className="spin" />
          ) : isError === true ? (
            <X size={12} />
          ) : (
            <Check size={12} />
          )}
        </span>
      </button>
      {open && (
        <div className="fold-body">
          <pre className="pre">{argsText}</pre>
          {done && <pre className="pre">{output}</pre>}
        </div>
      )}
    </div>
  );
}

const field = (data: unknown, key: string): string => {
  const value = (data as Record<string, unknown> | null)?.[key];
  return typeof value === "string" ? value : "";
};

/**
 * 轮中投递的补充（排队的那句话）。画成用户气泡，与刷新后历史里的样子一致
 * （历史里 pi 记录的就是一条普通用户消息）。位置在回答中间：pi 就是在那里把它
 * 交给模型的，后面的内容考虑了这句补充。
 */
export function QueuedUser({ data }: DataMessagePartProps): React.JSX.Element {
  return (
    <div className="msg user inline">
      <div className="bubble">
        <span className="user-text">{field(data, "text")}</span>
      </div>
    </div>
  );
}

/** 这条回答被用户停止了（可能不完整）。 */
export function Stopped(): React.JSX.Element {
  return (
    <p className="aside">
      <Square size={11} /> 已停止，这条回答可能不完整
    </p>
  );
}

export function Compaction(): React.JSX.Element {
  return (
    <p className="aside">
      <Scissors size={12} /> 更早的对话已压缩成摘要，要点仍在上下文里
    </p>
  );
}

/** 这一轮失败的原因。是消息的一部分：刷新后由历史还原，照样看得见。 */
export function ErrorPart({ data }: DataMessagePartProps): React.JSX.Element {
  return <ErrorLine message={field(data, "message") || "模型调用失败"} />;
}

/**
 * 把常见的接入层错误翻成「去哪修」。原文保留在下面一行，排查用。
 */
export function ErrorLine({ message }: { message: string }): React.JSX.Element {
  const hint = errorHint(message);
  return (
    <div className="error-line" role="alert">
      <p>
        <AlertTriangle size={13} /> {hint ?? message}
      </p>
      {hint !== null && <p className="error-raw">{message}</p>}
    </div>
  );
}

/** 这段回答是哪个模型写的（provider 放在悬停提示里，正文只显示模型名）。 */
export function ModelLabel({ data }: DataMessagePartProps): React.JSX.Element {
  const full = field(data, "model");
  const name = full.includes("/") ? full.slice(full.indexOf("/") + 1) : full;
  return (
    <span className="model-label" title={full}>
      {name}
    </span>
  );
}
