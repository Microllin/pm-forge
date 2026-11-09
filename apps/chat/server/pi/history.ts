import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { UIMessage } from "ai";

import { textOf, toolOutput } from "./parts.js";
import { collapseSkillCommand } from "./skills.js";
import { modelLabelOf } from "./stream.js";

/**
 * 库里的会话 → 前端 useChat 的初始 UIMessage[]。
 *
 * 不自己拼条目树：交给 pi 的 SessionManager 原样恢复后取 `getBranch()`（从根到当前
 * 叶子的完整路径，含压缩前的旧消息——界面要看全），再剔除被 context_edit 拿掉的
 * 条目（典型：自动重试前失败的那次）。分支与 parentId 的解释由 pi 负责。
 *
 * 分组与流式一致：每条 user 自成一条；其后连续的 assistant / toolResult 合成一条
 * assistant（一轮 = 一条）。
 */

type Part = UIMessage["parts"][number];
type ToolPart = Extract<Part, { type: "dynamic-tool" }>;

interface PiEntry {
  type: string;
  id: string;
  targetId?: string;
  replacement?: { content: unknown } | null;
  summary?: unknown;
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: unknown;
    toolCallId?: string;
    isError?: boolean;
  };
}

export function historyToUiMessages(
  cwd: string,
  header: unknown,
  entries: readonly unknown[],
): UIMessage[] {
  if (entries.length === 0) return [];
  const branch = SessionManager.inMemory(cwd, undefined, [
    header,
    ...entries,
  ] as never).getBranch() as unknown as PiEntry[];

  // context_edit：null = 拿掉；有值 = 换内容。
  const edits = new Map<string, { content: unknown } | null>();
  for (const e of branch) {
    if (e.type === "context_edit" && e.targetId !== undefined) {
      edits.set(e.targetId, e.replacement ?? null);
    }
  }

  const out: UIMessage[] = [];
  let current: UIMessage | undefined;
  /** 当前这条 UIMessage 里上一次标注的模型（与流式一致：一轮内变了才标）。 */
  let lastModel: string | undefined;
  const tools = new Map<string, ToolPart>();
  const assistantOf = (id: string): UIMessage => {
    if (!current) {
      current = { id, role: "assistant", parts: [] };
      out.push(current);
    }
    return current;
  };

  for (const entry of branch) {
    const edit = edits.get(entry.id);
    if (edit === null) continue;

    if (entry.type === "compaction") {
      if (typeof entry.summary === "string" && entry.summary !== "") {
        assistantOf(entry.id).parts.push({
          type: "data-compaction",
          data: { summary: entry.summary },
        });
      }
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const message =
      edit === undefined
        ? entry.message
        : { ...entry.message, content: edit.content };

    if (message.role === "user") {
      current = undefined;
      lastModel = undefined;
      out.push({
        id: entry.id,
        role: "user",
        // 点名调用的那条只显示命令本身，不把注入的技能正文摊在历史里。
        parts: [
          { type: "text", text: collapseSkillCommand(textOf(message.content)) },
        ],
      });
      continue;
    }

    if (message.role === "assistant") {
      const target = assistantOf(entry.id);
      target.parts.push({ type: "step-start" });
      const label = modelLabelOf(message);
      if (label !== undefined && label !== lastModel) {
        lastModel = label;
        target.parts.push({
          type: "data-model",
          id: `${entry.id}:model`,
          data: { model: label },
        });
      }
      for (const block of Array.isArray(message.content)
        ? message.content
        : []) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text !== "") {
          target.parts.push({ type: "text", text: b.text, state: "done" });
        } else if (
          b.type === "thinking" &&
          typeof b.thinking === "string" &&
          b.thinking !== ""
        ) {
          target.parts.push({
            type: "reasoning",
            text: b.thinking,
            state: "done",
          });
        } else if (b.type === "toolCall" && typeof b.id === "string") {
          const part: ToolPart = {
            type: "dynamic-tool",
            toolCallId: b.id,
            toolName: typeof b.name === "string" ? b.name : "unknown",
            state: "input-available",
            input: b.arguments ?? {},
          };
          tools.set(b.id, part);
          target.parts.push(part);
        }
      }
      // 被用户停止的回答：与流式时的 data-stopped 同形。
      if (message.stopReason === "aborted") {
        target.parts.push({
          type: "data-stopped",
          id: `${entry.id}:stopped`,
          data: {},
        });
      }
      // 没被 context_edit 拿掉的错误就是这一轮真正的失败结果：与流式时的 data-error 同形。
      if (message.stopReason === "error") {
        target.parts.push({
          type: "data-error",
          id: `${entry.id}:error`,
          data: {
            message:
              typeof message.errorMessage === "string" &&
              message.errorMessage !== ""
                ? message.errorMessage
                : "模型调用失败",
          },
        });
      }
      continue;
    }

    if (message.role === "toolResult" && message.toolCallId !== undefined) {
      const part = tools.get(message.toolCallId);
      if (!part) continue;
      const output = toolOutput(message);
      const mutable = part as Record<string, unknown>;
      if (message.isError === true) {
        mutable.state = "output-error";
        mutable.errorText = output.text || "工具执行失败";
      } else {
        mutable.state = "output-available";
        mutable.output = output;
      }
    }
  }
  return out;
}

/**
 * 一轮正在跑时，续流前该显示的历史。
 *
 * - 只取开轮**之前**的条目：之后落库的属于这一轮，续流会从头重放。
 *   用开轮水位这个确切边界，而不是「去掉末尾 assistant」这种猜法——本轮用户
 *   消息还没落库时，末尾那条 assistant 是**上一轮**的回答。
 * - 末尾补上触发这一轮的那句话：pi 在轮末才落库它。
 */
export function runningHistory(
  cwd: string,
  header: unknown,
  entries: readonly unknown[],
  run: { prompt: string; startEntries: number; sessionId: string },
): UIMessage[] {
  return [
    ...historyToUiMessages(cwd, header, entries.slice(0, run.startEntries)),
    {
      id: `pending:${run.sessionId}`,
      role: "user",
      parts: [{ type: "text", text: run.prompt }],
    },
  ];
}
