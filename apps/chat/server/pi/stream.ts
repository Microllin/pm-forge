import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { UIMessageChunk } from "ai";

import { textOf, toolOutput } from "./parts.js";

/**
 * pi 会话事件 → AI SDK UI Message Stream v1。
 *
 * 一轮（prompt → agent_settled）= 一条 assistant UIMessage。纯函数式：只吃事件、
 * 吐 chunk，不碰 I/O。测试拿 AI SDK 官方的 readUIMessageStream 解析输出来断言，
 * 「协议对不对」由 AI SDK 自己判。
 *
 * | pi                         | UI Message Stream                         |
 * | -------------------------- | ----------------------------------------- |
 * | agent_start                | start                                     |
 * | turn_start / turn_end      | start-step / finish-step                  |
 * | text_* / thinking_*        | text-* / reasoning-*                      |
 * | toolcall_* / tool_exec_*   | tool-input-* / tool-output-*（v1 无工具，留口）|
 * | auto_retry_start           | reset-step（撤回失败那一步）+ data-retry（进度提示）|
 * | auto_retry_end             | data-retry（恢复 / 最终失败）                |
 * | queue_update               | data-queue（transient）                    |
 * | 轮中投递的用户消息         | data-user（排队补充的那句话）              |
 * | 模型错误                   | data-error（不用协议的 error chunk，见下）  |
 * | assistant 消息开始         | data-model（哪个模型在答；变了才发）        |
 * | agent_settled              | data-stopped + abort（被停止时）+ finish    |
 *
 * 模型错误不用协议自带的 `error` chunk：AI SDK 7.0.138 的 Chat 收到它会额外冒一个
 * unhandled rejection（脱离 React 用裸 Chat 类可复现）；而且错误是这一轮回答的
 * 一部分，作为消息部件刷新后还能从历史里还原。
 */

export interface StreamTranslator {
  readonly messageId: string;
  push(event: AgentSessionEvent): UIMessageChunk[];
}

/** 轮中补充的那句话在分界里最多显示多少字。 */
const BOUNDARY_LIMIT = 500;

export function createStreamTranslator(messageId: string): StreamTranslator {
  let started = false;
  let stepOpen = false;
  /** 本轮第几条 assistant 消息。部件 id 要跨消息唯一（contentIndex 每条从 0 起）。 */
  let msgIndex = 0;
  /** 触发本轮的那句用户消息前端已经有了，不回显。 */
  let firstUserSeen = false;
  /** contentIndex → 已开的部件 id。 */
  const openText = new Map<number, string>();
  const openReasoning = new Map<number, string>();
  /** contentIndex → toolCallId（toolcall_delta 只带下标）。 */
  const toolAt = new Map<number, string>();
  const toolInputSent = new Set<string>();
  /**
   * 失败但可能还会重试的错误，扣到 agent_settled 才定。
   * pi 重试的顺序是 message_end(error) → auto_retry_start → 重来：见错就发，
   * 重试成功的一轮会被误报成失败（实测过：上游超时一次后重试成功）。
   */
  let pendingError: string | undefined;
  /** 本轮上一次标注的模型。同一轮里模型没变就不重复标。 */
  let lastModel: string | undefined;

  const id = (kind: string, index: number): string =>
    `${messageId}:${String(msgIndex)}:${kind}:${String(index)}`;

  const begin = (): UIMessageChunk[] => {
    const out: UIMessageChunk[] = [];
    if (!started) {
      started = true;
      out.push({ type: "start", messageId });
    }
    if (!stepOpen) {
      stepOpen = true;
      out.push({ type: "start-step" });
    }
    return out;
  };

  const closeParts = (): UIMessageChunk[] => {
    const out: UIMessageChunk[] = [];
    for (const partId of openText.values())
      out.push({ type: "text-end", id: partId });
    for (const partId of openReasoning.values())
      out.push({ type: "reasoning-end", id: partId });
    openText.clear();
    openReasoning.clear();
    return out;
  };

  const endStep = (): UIMessageChunk[] => {
    const out = closeParts();
    if (stepOpen) {
      stepOpen = false;
      out.push({ type: "finish-step" });
    }
    return out;
  };

  type Delta = Extract<
    AgentSessionEvent,
    { type: "message_update" }
  >["assistantMessageEvent"];

  const delta = (e: Delta): UIMessageChunk[] => {
    switch (e.type) {
      case "text_start": {
        const partId = id("text", e.contentIndex);
        openText.set(e.contentIndex, partId);
        return [...begin(), { type: "text-start", id: partId }];
      }
      case "text_delta": {
        if (e.delta === "") return [];
        const existing = openText.get(e.contentIndex);
        if (existing !== undefined)
          return [{ type: "text-delta", id: existing, delta: e.delta }];
        // 有的 provider 不发 text_start 直接给 delta：补开一个。
        const partId = id("text", e.contentIndex);
        openText.set(e.contentIndex, partId);
        return [
          ...begin(),
          { type: "text-start", id: partId },
          { type: "text-delta", id: partId, delta: e.delta },
        ];
      }
      case "text_end": {
        const partId = openText.get(e.contentIndex);
        if (partId === undefined) return [];
        openText.delete(e.contentIndex);
        return [{ type: "text-end", id: partId }];
      }
      case "thinking_start": {
        const partId = id("reasoning", e.contentIndex);
        openReasoning.set(e.contentIndex, partId);
        return [...begin(), { type: "reasoning-start", id: partId }];
      }
      case "thinking_delta": {
        if (e.delta === "") return [];
        const existing = openReasoning.get(e.contentIndex);
        if (existing !== undefined)
          return [{ type: "reasoning-delta", id: existing, delta: e.delta }];
        const partId = id("reasoning", e.contentIndex);
        openReasoning.set(e.contentIndex, partId);
        return [
          ...begin(),
          { type: "reasoning-start", id: partId },
          { type: "reasoning-delta", id: partId, delta: e.delta },
        ];
      }
      case "thinking_end": {
        const partId = openReasoning.get(e.contentIndex);
        if (partId === undefined) return [];
        openReasoning.delete(e.contentIndex);
        return [{ type: "reasoning-end", id: partId }];
      }
      case "toolcall_start": {
        const call = e.partial.content[e.contentIndex] as
          { id?: string; name?: string } | undefined;
        const toolCallId = call?.id ?? id("tool", e.contentIndex);
        toolAt.set(e.contentIndex, toolCallId);
        return [
          ...begin(),
          {
            type: "tool-input-start",
            toolCallId,
            toolName: call?.name ?? "unknown",
            dynamic: true,
          },
        ];
      }
      case "toolcall_delta": {
        const toolCallId = toolAt.get(e.contentIndex);
        if (toolCallId === undefined || e.delta === "") return [];
        return [
          { type: "tool-input-delta", toolCallId, inputTextDelta: e.delta },
        ];
      }
      case "toolcall_end": {
        toolAt.delete(e.contentIndex);
        toolInputSent.add(e.toolCall.id);
        return [
          ...begin(),
          {
            type: "tool-input-available",
            toolCallId: e.toolCall.id,
            toolName: e.toolCall.name,
            input: e.toolCall.arguments,
            dynamic: true,
          },
        ];
      }
      default:
        return [];
    }
  };

  const push = (event: AgentSessionEvent): UIMessageChunk[] => {
    // 嵌套工具调用（工具内部再调工具）不在对话记录里，不进界面。
    if ((event as { parentToolCallId?: unknown }).parentToolCallId) return [];

    switch (event.type) {
      case "agent_start":
        if (started) return [];
        started = true;
        return [{ type: "start", messageId }];
      case "turn_start":
        return [...endStep(), ...begin()];
      case "turn_end":
        return endStep();
      case "message_start": {
        const msg = event.message as { role?: string; content?: unknown };
        if (msg.role === "assistant") {
          msgIndex += 1;
          const label = modelLabelOf(event.message);
          if (label === undefined || label === lastModel) return [];
          lastModel = label;
          return [
            ...begin(),
            modelChunk(`${messageId}:model:${String(msgIndex)}`, label),
          ];
        }
        if (msg.role !== "user") return [];
        if (!firstUserSeen) {
          firstUserSeen = true;
          return [];
        }
        // 轮中补充的用户消息在历史里是一条独立的用户消息，其后的回答会重新标模型；
        // 这里同步重置，刷新前后才一致。
        lastModel = undefined;
        return [
          ...begin(),
          {
            type: "data-user",
            id: `${messageId}:user:${String(msgIndex)}`,
            data: { text: textOf(msg.content).slice(0, BOUNDARY_LIMIT) },
          },
        ];
      }
      case "message_update":
        return delta(event.assistantMessageEvent);
      case "message_end": {
        const msg = event.message as {
          role?: string;
          stopReason?: string;
          errorMessage?: unknown;
        };
        if (msg.role !== "assistant" || msg.stopReason !== "error") return [];
        pendingError =
          typeof msg.errorMessage === "string" && msg.errorMessage !== ""
            ? msg.errorMessage
            : "模型调用失败";
        return closeParts();
      }
      case "tool_execution_start": {
        if (toolInputSent.has(event.toolCallId)) return [];
        // 上游不流式吐工具参数时，这里补声明，否则输出会挂在一个未声明的调用上。
        toolInputSent.add(event.toolCallId);
        return [
          ...begin(),
          {
            type: "tool-input-available",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: event.args as unknown,
            dynamic: true,
          },
        ];
      }
      case "tool_execution_update":
        return [
          {
            type: "tool-output-available",
            toolCallId: event.toolCallId,
            output: toolOutput(event.partialResult),
            dynamic: true,
            preliminary: true,
          },
        ];
      case "tool_execution_end":
        return [
          event.isError
            ? {
                type: "tool-output-error",
                toolCallId: event.toolCallId,
                errorText: toolOutput(event.result).text || "工具执行失败",
                dynamic: true,
              }
            : {
                type: "tool-output-available",
                toolCallId: event.toolCallId,
                output: toolOutput(event.result),
                dynamic: true,
              },
        ];
      case "auto_retry_start":
        openText.clear();
        openReasoning.clear();
        toolAt.clear();
        pendingError = undefined;
        // 重试提示用 transient：它是**过程**不是结果。pi 的 transcript 里不留
        // 失败那次（有测试钉着「刷新后失败那次也不冒出来」），所以这条提示也
        // 不该进消息部件，否则刷新前后对不上。续流重放会带上它，不会丢。
        return [
          ...(started ? [{ type: "reset-step" as const }] : []),
          retryChunk({
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            message: event.errorMessage,
          }),
        ];
      case "auto_retry_end":
        return [
          retryChunk({
            attempt: event.attempt,
            done: true,
            success: event.success,
            ...(event.finalError === undefined
              ? {}
              : { message: event.finalError }),
          }),
        ];
      case "queue_update":
        return [
          {
            type: "data-queue",
            data: { pending: event.steering.length + event.followUp.length },
            transient: true,
          },
        ];
      case "agent_settled": {
        const failed = pendingError !== undefined && !event.aborted;
        const out: UIMessageChunk[] = [];
        if (!started) {
          started = true;
          out.push({ type: "start", messageId });
        }
        if (failed)
          out.push(
            ...begin(),
            errorChunk(`${messageId}:error`, pendingError ?? ""),
          );
        // 被停止：作为消息部件落一个标记。它与历史还原（stopReason=aborted）同形，
        // 刷新后照样能看出「这条回答是被截断的」。
        if (event.aborted)
          out.push(...begin(), stoppedChunk(`${messageId}:stopped`));
        out.push(...endStep());
        if (event.aborted) out.push({ type: "abort", reason: "用户停止" });
        out.push({ type: "finish", finishReason: failed ? "error" : "stop" });
        return out;
      }
      default:
        return [];
    }
  };

  return { messageId, push };
}

/** pi 的 AssistantMessage 记着实际作答的 provider / model。 */
export function modelLabelOf(message: unknown): string | undefined {
  const m = message as { provider?: unknown; model?: unknown };
  return typeof m.provider === "string" && typeof m.model === "string"
    ? `${m.provider}/${m.model}`
    : undefined;
}

export function modelChunk(id: string, model: string): UIMessageChunk {
  return { type: "data-model", id, data: { model } };
}

export function stoppedChunk(id: string): UIMessageChunk {
  return { type: "data-stopped", id, data: {} };
}

export function errorChunk(id: string, message: string): UIMessageChunk {
  return { type: "data-error", id, data: { message } };
}

/** 自动重试的进度提示。transient：只给当下看，不进消息部件、不进历史。 */
export function retryChunk(data: {
  attempt: number;
  maxAttempts?: number;
  delayMs?: number;
  message?: string;
  done?: boolean;
  success?: boolean;
}): UIMessageChunk {
  return { type: "data-retry", data, transient: true };
}

export const UI_STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "x-vercel-ai-ui-message-stream": "v1",
} as const;

export const sse = (chunk: UIMessageChunk): string =>
  `data: ${JSON.stringify(chunk)}\n\n`;

export const SSE_DONE = "data: [DONE]\n\n";
