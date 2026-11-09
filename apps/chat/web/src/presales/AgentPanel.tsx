import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, ExternalLink, Loader2, PanelRightClose } from "lucide-react";

import { listSessions, loadHistory } from "../api";
import { ChatView } from "../chat/ChatView";
import { aiKey } from "./ai-api";
import { agentKey, ensureAgentSession } from "./agent-api";

/**
 * 售前助手：常驻在售前页右侧的一条真会话。
 *
 * 它和对话页里的会话是同一条（对话页左栏也能看到「售前助手 · 库名」），区别只是
 * 服务端给它换了身份、开了售前专属工具。这里只做三件事：
 *   ① 取（没有就建）这本库的助手会话；
 *   ② 把清单上「让助手做」的话递进去（outbox）；
 *   ③ 助手在干活时定时刷新清单——它发起的审阅、写的草稿要立刻反映到左边。
 */

const STARTERS = [
  "现在还缺哪些材料？按影响排个先后。",
  "对外材料之间口径一致吗？挑出互相矛盾的说法。",
  "把还没审过的对外材料都审一遍。",
];

export function AgentPanel({
  libId,
  libName,
  outbox,
  onOutboxSent,
  onCollapse,
  onOpenSession,
}: {
  libId: string;
  libName: string;
  outbox: { id: number; text: string } | undefined;
  onOutboxSent: () => void;
  onCollapse: () => void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 空会话时给几句开场；点了就交给 outbox 发出去。 */
  const [starter, setStarter] = useState<{ id: number; text: string }>();

  useEffect(() => {
    // 换库时整个面板按 key 重挂，这里不用手动清状态。
    let alive = true;
    ensureAgentSession(libId)
      .then((r) => {
        if (alive) setSessionId(r.sessionId);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "打不开助手");
      });
    return () => {
      alive = false;
    };
  }, [libId]);

  /*
   * 助手在跑：4 秒刷一次清单与 AI 状态；跑完再刷一次收尾。
   * 会话列表本来就由外壳在回答中时轮询（同一个查询键），这里只读。
   */
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: listSessions,
    refetchInterval: 4000,
    enabled: sessionId !== null,
  });
  const streaming =
    sessionId !== null &&
    (sessions.data ?? []).some((s) => s.id === sessionId && s.streaming);
  const was = useRef(false);
  useEffect(() => {
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: ["presales", libId] });
      void queryClient.invalidateQueries({ queryKey: aiKey(libId) });
      void queryClient.invalidateQueries({ queryKey: agentKey(libId) });
      void queryClient.invalidateQueries({ queryKey: ["presales"] });
    };
    if (streaming) {
      const timer = window.setInterval(refresh, 4000);
      was.current = true;
      return () => window.clearInterval(timer);
    }
    if (was.current) {
      was.current = false;
      refresh();
    }
    return undefined;
  }, [streaming, libId, queryClient]);

  /**
   * 空会话才给开场问题。历史只在打开时看一次（独立的查询键，不碰 ChatView 自己的缓存）；
   * 点过一句或外面递进来一句就收起。
   */
  const opening = useQuery({
    queryKey: ["presales-agent-opening", sessionId],
    queryFn: () => loadHistory(sessionId ?? ""),
    enabled: sessionId !== null,
    staleTime: Infinity,
    gcTime: 0,
  });
  const [spoke, setSpoke] = useState(false);
  const empty =
    !spoke &&
    outbox === undefined &&
    opening.data?.messages.length === 0 &&
    !opening.data.streaming;

  return (
    <aside className="presales-agent" aria-label="售前助手">
      <header className="presales-agent-head">
        <span className="presales-agent-avatar" aria-hidden="true">
          <Bot size={15} />
        </span>
        <div className="presales-agent-title">
          <strong>售前助手</strong>
          <span className="muted small">
            {streaming ? "正在干活…" : `负责「${libName}」`}
          </span>
        </div>
        {sessionId !== null && onOpenSession !== undefined && (
          <button
            type="button"
            className="btn ghost icon"
            title="在对话页打开（宽屏看过程）"
            aria-label="在对话页打开"
            onClick={() => onOpenSession(sessionId)}
          >
            <ExternalLink size={14} />
          </button>
        )}
        <button
          type="button"
          className="btn ghost icon"
          title="收起助手"
          aria-label="收起助手"
          onClick={onCollapse}
        >
          <PanelRightClose size={14} />
        </button>
      </header>
      <p className="presales-agent-note muted small">
        看得见清单、模板标准与事实依据；能读材料、发起审阅、给缺口起草。
        起草只存成草稿，采纳与「设为可对外」由你来点。
      </p>
      {empty && (
        <div className="presales-agent-starters">
          {STARTERS.map((t) => (
            <button
              key={t}
              type="button"
              className="presales-agent-chip"
              onClick={() => {
                setSpoke(true);
                setStarter({ id: Date.now(), text: t });
              }}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      <div className="presales-agent-body">
        {error !== null ? (
          <p className="presales-error pad">{error}</p>
        ) : sessionId === null ? (
          <p className="muted small pad">
            <Loader2 size={14} className="spin" /> 打开助手…
          </p>
        ) : (
          <ChatView
            key={sessionId}
            sessionId={sessionId}
            outbox={outbox ?? starter}
            onOutboxSent={() => {
              setSpoke(true);
              if (outbox !== undefined) onOutboxSent();
              else setStarter(undefined);
            }}
          />
        )}
      </div>
    </aside>
  );
}
