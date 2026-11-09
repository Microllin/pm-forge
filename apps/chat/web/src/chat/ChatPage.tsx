import { useState } from "react";
import { MessageSquarePlus, Pencil, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { AnalysisBanner } from "../analysis/AnalysisBanner";
import {
  createSession,
  deleteSession,
  isForgeSession,
  listSessions,
  renameSession,
} from "../api";
import { ChatView } from "./ChatView";

/**
 * 一级菜单「对话」：左侧会话列表，右侧对话。
 *
 * 打开的是哪个会话由外壳（App）保存：切到别的菜单再切回来，仍停在原来的会话。
 * 切走时 ChatView 卸载，但正在跑的回答不受影响——断开不等于停止，切回来会自动续流。
 *
 * 带 `task` 的会话是一次 AI 分析（产线识别 / 产出物比对），对话上方多一条横幅，
 * 用来把结果取出来。分析就是普通对话，所以追问、停止、切模型、刷新续流全部照常。
 */
export function ChatPage({
  sessionId,
  onOpen,
  autoSend,
  onAutoSent,
  productNameOf,
}: {
  sessionId: string | null;
  onOpen: (id: string | null) => void;
  /** 刚由「AI 分析」建出来的会话：这段提示词要自动发出去一次。 */
  autoSend?: { sessionId: string; prompt: string } | undefined;
  onAutoSent?: (() => void) | undefined;
  /** 比对类分析的横幅要显示产品名。产品清单在外壳，这里只接一个查询函数。 */
  productNameOf?: ((productId: string) => string | undefined) | undefined;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: listSessions,
    select: (all) => all.filter((s) => !isForgeSession(s)),
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["sessions"] });

  const create = useMutation({
    // 包一层：react-query 会把 mutate 的参数传进来，直接交给 createSession 会被
    // 当成 productId 发给服务端。
    mutationFn: () => createSession(),
    onSuccess: async (s) => {
      await refresh();
      onOpen(s.id);
    },
  });
  const remove = useMutation({
    mutationFn: deleteSession,
    onSuccess: async (_r, id) => {
      if (sessionId === id) onOpen(null);
      await refresh();
    },
  });

  // 记住的会话已经不在了（被别处删掉）：当作没选。
  const activeId =
    sessions.data?.some((s) => s.id === sessionId) === false ? null : sessionId;
  const active = sessions.data?.find((s) => s.id === activeId);
  const pendingPrompt =
    autoSend?.sessionId === activeId ? autoSend.prompt : undefined;

  return (
    <div className="app">
      <aside className="sidebar">
        <button
          type="button"
          className="btn primary block"
          onClick={() => create.mutate()}
          disabled={create.isPending}
        >
          <MessageSquarePlus size={14} /> 新对话
        </button>
        <nav className="session-list" aria-label="会话">
          {(sessions.data ?? []).map((s) => (
            <SessionItem
              key={s.id}
              title={s.title}
              streaming={s.streaming}
              active={s.id === activeId}
              onOpen={() => onOpen(s.id)}
              onRename={(title) =>
                void renameSession(s.id, title).then(refresh)
              }
              onDelete={() => {
                if (window.confirm(`删除「${s.title}」？`)) remove.mutate(s.id);
              }}
            />
          ))}
          {sessions.data?.length === 0 && (
            <p className="muted small pad">还没有对话</p>
          )}
        </nav>
      </aside>

      <main className="main">
        {/* 带产品名的任务都把名字传给横幅：同一个产品常有好几条分析会话，
            「哪个产品」比「什么分析」更需要一眼看到。 */}
        {active?.task != null &&
          active.task.kind !== "presales-agent" &&
          activeId !== null && (
            <AnalysisBanner
              sessionId={activeId}
              task={active.task}
              streaming={active.streaming}
              {...(active.task.kind === "compare" ||
              active.task.kind === "wiki-outline" ||
              active.task.kind === "wiki-page"
                ? { productName: productNameOf?.(active.task.productId) }
                : {})}
            />
          )}
        {activeId !== null && (
          <ChatView
            key={activeId}
            sessionId={activeId}
            autoSend={pendingPrompt}
            onAutoSent={onAutoSent}
          />
        )}
        {activeId === null && (
          <div className="center">
            <div className="empty">
              {/* 标题在顶栏，这里给的是「下一步做什么」，不重复页面名。 */}
              <h2>开始一个新对话</h2>
              <p className="muted small">
                点左上角「新对话」；第一次用先去「设置」接入模型。
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function SessionItem({
  title,
  streaming,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  title: string;
  streaming: boolean;
  active: boolean;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  if (editing) {
    return (
      <input
        className="session-edit"
        aria-label="会话标题"
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setEditing(false)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft.trim() !== "") {
            onRename(draft.trim());
            setEditing(false);
          }
          if (e.key === "Escape") setEditing(false);
        }}
      />
    );
  }
  return (
    <div className={`session${active ? " active" : ""}`}>
      <button
        type="button"
        className="session-title"
        onClick={onOpen}
        title={title}
      >
        {streaming && <span className="dot" aria-label="进行中" />}
        {/* 标题必须包一层：flex 容器里的裸文本是「匿名弹性项」，不认
            text-overflow——原来的标题会被硬切在半个字上（「…ModelCent」）。 */}
        <span className="session-title-text">{title}</span>
      </button>
      <button
        type="button"
        className="icon-btn ghost"
        aria-label="改名"
        onClick={() => {
          setDraft(title);
          setEditing(true);
        }}
      >
        <Pencil size={12} />
      </button>
      <button
        type="button"
        className="icon-btn ghost"
        aria-label="删除"
        onClick={onDelete}
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}
