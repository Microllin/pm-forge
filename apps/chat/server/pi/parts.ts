/**
 * 流式翻译（stream.ts）与历史还原（history.ts）共用的部件构造。
 * 两边必须产出同样的形状，否则刷新前后同一条回答长得不一样——所以规则只写一次。
 */

/** pi 的 content（字符串或部件数组）里的纯文本。非文本部件跳过。 */
export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (part === null || typeof part !== "object") return "";
      const p = part as { type?: unknown; text?: unknown };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}

export interface ToolOutput {
  text: string;
  truncated: boolean;
  /**
   * 派活工具（agent-team/team.ts）的运行快照：智能体卡片靠它画进度。
   * 只认 `details.agentRun`，别的工具的 details 不推给前端（可能很大）。
   */
  agentRun?: unknown;
}

/**
 * 单条工具输出推给前端的上限。模型拿到的是全文；界面上工具卡片默认折叠，
 * 推几十 KB 只会撑大流量与前端状态。
 */
export const TOOL_OUTPUT_LIMIT = 4000;

/** pi 工具结果（`{ content, details }`）→ 给界面看的文本。 */
export function toolOutput(result: unknown): ToolOutput {
  const content =
    result !== null && typeof result === "object"
      ? (result as { content?: unknown }).content
      : result;
  const details =
    result !== null && typeof result === "object"
      ? (result as { details?: unknown }).details
      : undefined;
  const agentRun =
    details !== null && typeof details === "object"
      ? (details as { agentRun?: unknown }).agentRun
      : undefined;
  const text = textOf(content);
  // 智能体结论是这张卡片的主体，按派活工具自己的上限（12k）给全，不按普通工具截。
  const limit = agentRun === undefined ? TOOL_OUTPUT_LIMIT : 16_000;
  const base =
    text.length <= limit
      ? { text, truncated: false }
      : { text: text.slice(0, limit), truncated: true };
  return agentRun === undefined ? base : { ...base, agentRun };
}
