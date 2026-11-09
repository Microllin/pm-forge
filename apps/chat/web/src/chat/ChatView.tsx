import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Loader2, RotateCcw } from "lucide-react";
import { useChat } from "@ai-sdk/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ActionBarPrimitive,
  AssistantRuntimeProvider,
  AuiIf,
  MessagePrimitive,
  ThreadPrimitive,
} from "@assistant-ui/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import type { UIMessage } from "ai";

import {
  abortSession,
  chatTransport,
  loadHistory,
  queueMessage,
  type History,
} from "../api";
import { Composer } from "./composer";
import { EvidenceScope } from "./EvidenceScope";
import { SaveToStaging } from "./SaveToStaging";
import { useModelControls } from "./model-controls";
import {
  AssistantText,
  Compaction,
  ErrorLine,
  ErrorPart,
  ModelLabel,
  QueuedUser,
  Reasoning,
  Stopped,
  ToolCall,
  UserText,
} from "./parts";

/**
 * 一个会话的对话视图。
 *
 * 先拉历史再挂 useChat：useChat 的初始消息只在创建时读一次。会话切换靠 key 重挂。
 */
export function ChatView({
  sessionId,
  autoSend,
  onAutoSent,
  outbox,
  onOutboxSent,
}: {
  sessionId: string;
  /** 刚由「AI 分析」建出来的会话：这段提示词自动发一次。 */
  autoSend?: string | undefined;
  onAutoSent?: (() => void) | undefined;
  /**
   * 页面外递进来的话（如售前清单上「让助手起草」）。id 变一次发一次；
   * 正在回答时按排队处理，与人在输入框里发的完全一样。
   */
  outbox?: { id: number; text: string } | undefined;
  onOutboxSent?: (() => void) | undefined;
}): React.JSX.Element {
  const history = useQuery({
    queryKey: ["history", sessionId],
    queryFn: () => loadHistory(sessionId),
    // 只在挂载时拉：之后的真相是 useChat 自己的状态，后台重拉会盖掉正在流的那条。
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });
  if (history.isPending) {
    return (
      <div className="center muted">
        <Loader2 size={16} className="spin" /> 载入中…
      </div>
    );
  }
  if (history.isError) {
    return (
      <div className="center">
        <ErrorLine message={history.error.message} />
      </div>
    );
  }
  return (
    <Conversation
      key={sessionId}
      sessionId={sessionId}
      history={history.data}
      reload={async () => (await history.refetch()).data}
      autoSend={autoSend}
      onAutoSent={onAutoSent}
      outbox={outbox}
      onOutboxSent={onOutboxSent}
    />
  );
}

const PART_COMPONENTS = {
  Text: AssistantText,
  Reasoning,
  tools: { Fallback: ToolCall },
  data: {
    by_name: {
      user: QueuedUser,
      compaction: Compaction,
      error: ErrorPart,
      stopped: Stopped,
      model: ModelLabel,
    },
    // 未来新增的 data 部件不认识就不画，而不是把 JSON 糊在回答里。
    Fallback: () => null,
  },
};

function Conversation({
  sessionId,
  history,
  reload,
  autoSend,
  onAutoSent,
  outbox,
  onOutboxSent,
}: {
  sessionId: string;
  history: History;
  reload: () => Promise<History | undefined>;
  autoSend?: string | undefined;
  onAutoSent?: (() => void) | undefined;
  outbox?: { id: number; text: string } | undefined;
  onOutboxSent?: (() => void) | undefined;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const transport = useMemo(() => chatTransport(sessionId), [sessionId]);
  const [initial] = useState<UIMessage[]>(() => history.messages);
  /** 排队深度只信服务端（投递时机由 pi 定）；本地文本让刚排的那句立刻可见。 */
  const [pending, setPending] = useState(0);
  const [queued, setQueued] = useState<string[]>([]);
  /**
   * 上游失败后 pi 的自动重试。不显示的话用户只看到一段更长的空白，
   * 分不清「它在想」还是「它卡了」（实测重试一次就是 10 秒级的静默）。
   * 恢复后也留着——答完才能解释「刚才为什么那么慢」；下一次发送时清。
   */
  const [retry, setRetry] = useState<{
    attempt: number;
    maxAttempts?: number;
    message?: string;
    recovered: boolean;
  } | null>(null);

  const chat = useChat({
    id: sessionId,
    messages: initial,
    transport,
    // 合并同一时间窗内的增量再渲染：token 越快，越不能每个 token 渲染一次。
    throttle: 50,
    onData: (part) => {
      if (part.type === "data-retry") {
        const d = part.data as {
          attempt?: number;
          maxAttempts?: number;
          message?: string;
          done?: boolean;
          success?: boolean;
        };
        // 最终失败不在这里说：那一轮会落一个 data-error 部件，说两遍是噪音。
        if (d.done === true && d.success !== true) {
          setRetry(null);
          return;
        }
        setRetry({
          attempt: d.attempt ?? 1,
          ...(d.maxAttempts === undefined
            ? {}
            : { maxAttempts: d.maxAttempts }),
          ...(d.message === undefined ? {} : { message: d.message }),
          recovered: d.done === true,
        });
        return;
      }
      if (part.type !== "data-queue") return;
      const n = (part.data as { pending?: number }).pending ?? 0;
      setPending(n);
      if (n === 0) setQueued([]);
    },
    onFinish: () => {
      setPending(0);
      setQueued([]);
      // 标题可能刚由第一句话生成。
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });
  const runtime = useAISDKRuntime(chat);
  const controls = useModelControls(sessionId);
  const busy = chat.status === "submitted" || chat.status === "streaming";
  // 兜底定时器读的是 3 秒后的状态，不能用闭包里那一刻的。
  /** 停止后的兜底定时器；下一轮开始时清掉，免得误杀新回答。 */
  const stopTimer = useRef<number | undefined>(undefined);
  /** 清兜底定时器。发消息、卸载都要调。 */
  const clearStopTimer = (): void => {
    if (stopTimer.current === undefined) return;
    window.clearTimeout(stopTimer.current);
    stopTimer.current = undefined;
  };
  const chatStatusRef = useRef(chat.status);
  useEffect(() => {
    chatStatusRef.current = chat.status;
  }, [chat.status]);

  /**
   * 断线续流。不用 useChat 的 `resume: true`：服务端回 204（那一轮在我们拉完
   * 历史后刚好结束）时它什么也不做，而服务端给的历史里这一轮的半截已被截掉，
   * 刚说完的回答会凭空消失。所以手动续，续不上就重拉历史。
   *
   * **推迟一拍 + 清理时取消**，而不是「用 ref 记一次」：开发模式下 StrictMode 会把
   * effect 挂载→卸载→再挂载。ref 版本在第一次挂载就发起续流，紧接着的卸载让
   * runtime 中止了它，第二次挂载又因为 ref 已置位而跳过——续流静默失效（实测）。
   * 推迟到下一拍时，模拟卸载已经把第一次取消掉，只有真正的那次挂载会发起。
   */
  useEffect(() => {
    if (!history.streaming) return;
    // 放对象里：异步回调里读的是清理之后的值，TS 的流分析看不见这种改动。
    const life = { cancelled: false };
    const alive = (): boolean => !life.cancelled;
    const timer = window.setTimeout(() => {
      if (life.cancelled) return;
      const before = chat.messages.length;
      void chat.resumeStream().then(async () => {
        if (!alive() || chat.messages.length > before) return;
        const fresh = await reload();
        if (fresh && alive()) chat.setMessages(fresh.messages);
      });
    }, 0);
    return () => {
      life.cancelled = true;
      window.clearTimeout(timer);
    };
    // 只在挂载时续；chat 每次渲染都是新对象。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 排队竞态兜底：服务端说「已经不在跑了」，等前端也回到空闲再正常发。 */
  const deferred = useRef<string | null>(null);
  /**
   * 把 deferred 里那句发出去（若此刻确实空闲）。
   *
   * 两个触发点：busy 变回 false 的 effect；以及「服务端说没排上」的那条响应回来时——
   * 后者不主动查一次的话，如果流在那条响应回来之前就结束了，busy 不会再变化，
   * 依赖 [busy] 的 effect 永远不触发，这句话就永久卡住、界面上毫无提示。
   */
  const sendRef = useRef<(text: string) => void>(() => undefined);
  const flushDeferred = (): void => {
    if (busy || deferred.current === null) return;
    const text = deferred.current;
    deferred.current = null;
    sendRef.current(text);
  };
  const send = (text: string): void => {
    clearStopTimer();
    if (chat.error) chat.clearError();
    // 上一轮的重试提示只解释上一轮。
    setRetry(null);
    // 失败经 chat.error 显示；不接住会再冒一个 unhandled rejection。
    chat.sendMessage({ text }).catch(() => undefined);
  };
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    flushDeferred();
    // 只在忙碌状态变化时试；flushDeferred 自己会判断是否真的空闲。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const submit = (text: string): void => {
    if (!busy) {
      send(text);
      return;
    }
    queueMessage(sessionId, text)
      .then((r) => {
        if (r.queued) {
          setPending(r.pending);
          setQueued((q) => [...q, text]);
        } else {
          /*
           * 服务端说「没在跑、没排上」：这一句得由我们自己发。
           *
           * 存进 deferred 等 busy 变回 false 再发是不够的——如果流在这条响应回来之前
           * 就已经结束，busy 不会再有变化，依赖 [busy] 的兜底 effect 永远不触发，
           * 这句话就永久卡在 ref 里，界面上也看不出任何异常。这里立刻自己发起。
           */
          deferred.current = text;
          flushDeferred();
        }
      })
      .catch(() => {
        deferred.current = text;
        flushDeferred();
      });
  };

  /**
   * 「AI 分析」建出来的会话：把服务端拼好的那段提示词自动发一次。
   *
   * 两道门缺一不可：
   * ① **只在空会话上发**。切走再切回来、或者刷新，历史里已经有那句话了，再发一次
   *    就是白花一次钱。
   * ② **推迟一拍 + 清理时取消**（同上面的续流 effect）。StrictMode 下挂载→卸载→再挂载，
   *    立即发会发两次。
   */
  useEffect(() => {
    if (autoSend === undefined || autoSend === "") return;
    if (history.messages.length > 0 || history.streaming) {
      onAutoSent?.();
      return;
    }
    const life = { cancelled: false };
    const timer = window.setTimeout(() => {
      if (life.cancelled) return;
      send(autoSend);
      onAutoSent?.();
    }, 0);
    return () => {
      life.cancelled = true;
      window.clearTimeout(timer);
    };
    // 只在挂载时跑；send / chat 每次渲染都是新的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 页面外递进来的话。记下发过的 id：StrictMode 的二次挂载、父组件重渲染都不会重发；
   * 发完回调 onOutboxSent，由父组件清掉——切走再回来不会把上一句再发一遍。
   * 推迟一拍 + 清理时取消：同上面 autoSend 的理由。
   */
  const sentOutbox = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (outbox === undefined || sentOutbox.current === outbox.id) return;
    const life = { cancelled: false };
    const timer = window.setTimeout(() => {
      if (life.cancelled) return;
      sentOutbox.current = outbox.id;
      submit(outbox.text);
      onOutboxSent?.();
    }, 0);
    return () => {
      life.cancelled = true;
      window.clearTimeout(timer);
    };
    // 只认 id 变化；submit 每次渲染都是新的。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outbox?.id]);

  /**
   * 停止：让服务端停 pi，**不主动断开**——服务端会把这一轮以「已停止」标记收尾，
   * 断开就收不到这一帧了。只有服务端 3 秒内没把流收掉（网络断了之类），才兜底
   * 断开这一路。只断开连接是停不下 agent 的：那是为了刷新能续流。
   */
  const stop = (): void => {
    setPending(0);
    setQueued([]);
    void abortSession(sessionId).catch(() => undefined);
    /*
     * 3 秒兜底：服务端迟迟没把流收掉（网络断了之类）才强制断开这一路。
     *
     * 句柄必须留着并在下一轮开始时清掉。原来没存也没清：点「停止」后服务端很快收尾、
     * 用户 3 秒内又发了一句，定时器到点时看到的正是**新回答**的 streaming 状态，
     * 于是把新的这句掐断——表现是「刚发出去就被停了」。
     */
    stopTimer.current = window.setTimeout(() => {
      stopTimer.current = undefined;
      if (
        chatStatusRef.current === "submitted" ||
        chatStatusRef.current === "streaming"
      ) {
        void chat.stop();
      }
    }, 3000);
  };

  const last = chat.messages.at(-1);
  const waiting =
    busy &&
    (last?.role !== "assistant" ||
      last.parts.every((p) => p.type === "step-start"));

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="thread">
        <ThreadPrimitive.Viewport className="thread-viewport" autoScroll>
          <div className="thread-inner">
            <AuiIf condition={(s) => s.thread.isEmpty}>
              <div className="empty">
                <h2>有什么可以帮你？</h2>
                <p className="muted">
                  回答会流式出现；回答途中也能继续补充，补充的话会在当前回答里被处理。
                </p>
              </div>
            </AuiIf>
            <ThreadPrimitive.Messages>
              {({ message }) =>
                message.role === "user" ? (
                  <UserMessage />
                ) : (
                  <AssistantMessage sessionId={sessionId} />
                )
              }
            </ThreadPrimitive.Messages>
            {waiting && <Waiting />}
            {retry && <RetryLine {...retry} />}
            {queued.map((text, i) => (
              <div className="msg user queued" key={i}>
                <div className="bubble">{text}</div>
              </div>
            ))}
            {chat.error && <ErrorLine message={chat.error.message} />}
          </div>
        </ThreadPrimitive.Viewport>
        <div className="composer-wrap">
          <EvidenceScope sessionId={sessionId} />
          <Composer
            busy={busy}
            pending={pending}
            controls={controls}
            onSubmit={submit}
            onStop={stop}
          />
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}

function UserMessage(): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="msg user">
      <div className="bubble">
        <MessagePrimitive.Parts components={{ Text: UserText }} />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({
  sessionId,
}: {
  sessionId: string;
}): React.JSX.Element {
  return (
    <MessagePrimitive.Root className="msg assistant">
      <MessagePrimitive.Parts components={PART_COMPONENTS} />
      <ActionBarPrimitive.Root
        className="actions"
        hideWhenRunning
        autohide="not-last"
      >
        <ActionBarPrimitive.Copy className="icon-btn ghost" aria-label="复制">
          <Copy size={13} />
        </ActionBarPrimitive.Copy>
        <SaveToStaging sessionId={sessionId} />
      </ActionBarPrimitive.Root>
    </MessagePrimitive.Root>
  );
}

/** 发出之后、第一个部件到达之前。秒数在走才说明在推进——转圈在卡死时也会转。 */
function Waiting(): React.JSX.Element {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const t0 = Date.now();
    const timer = window.setInterval(
      () => setSeconds(Math.floor((Date.now() - t0) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className="waiting" role="status">
      <Loader2 size={13} className="spin" />
      <span>{seconds >= 10 ? "仍在等待模型响应" : "正在思考"}</span>
      <span className="muted">{seconds}s</span>
    </div>
  );
}

/**
 * 上游失败后的自动重试。按「这次没成功」的口径做成一行低调提示，
 * 不用 destructive 告警框：它大概率会自己好，把一次重试说成系统故障是吵人。
 * 原始错误降级成灰色小字跟在后面供排障。
 */
function RetryLine({
  attempt,
  maxAttempts,
  message,
  recovered,
}: {
  attempt: number;
  maxAttempts?: number;
  message?: string;
  recovered: boolean;
}): React.JSX.Element {
  const count = maxAttempts === undefined ? "" : ` / ${String(maxAttempts)}`;
  return (
    <div className="waiting retry-line" role="status">
      {recovered ? (
        <RotateCcw size={13} />
      ) : (
        <Loader2 size={13} className="spin" />
      )}
      <span>
        {recovered
          ? `上游失败过，自动重试后已恢复（第 ${String(attempt)} 次）`
          : `上游失败，正在自动重试（第 ${String(attempt)}${count} 次）`}
      </span>
      {message !== undefined && message !== "" && (
        <span className="muted ellipsis" title={message}>
          {message}
        </span>
      )}
    </div>
  );
}
