import { useState } from "react";
import { Check, ChevronRight, Loader2, Square, Users, X } from "lucide-react";
import type { UIMessage } from "ai";

import { createRequest } from "../http";
import { MarkdownText } from "./markdown";

/**
 * 智能体工作卡片：主对话里一次 delegate（派活）的样子。
 *
 * 数据来自工具输出的 agentRun 快照（server/agent-team/team.ts AgentRunView）：
 * 运行中逐步推进度，结束后带结论。刷新页面后从历史里还原的是最终快照。
 */

export interface AgentRunView {
  runId: string;
  agent: string;
  task: string;
  reason: string;
  status: "queued" | "running" | "done" | "failed" | "stopped";
  depth: number;
  model: string | null;
  steps: { at: number; label: string }[];
  turns: number;
  toolCalls: number;
  elapsedMs: number;
  preview: string;
  error: string | null;
}

/** 内置成员的中文名；用户自建的显示原名。 */
const DISPLAY: Record<string, string> = {
  "memory-master": "记忆大师",
  "market-researcher": "市场调研",
  "prd-writer": "PRD 撰写",
  "tech-expert": "技术专家",
};
const agentLabel = (name: string): string => DISPLAY[name] ?? name;

const STATUS: Record<AgentRunView["status"], string> = {
  queued: "排队中",
  running: "工作中",
  done: "已完成",
  failed: "未完成",
  stopped: "已停止",
};

const request = createRequest("/api");

const secs = (ms: number): string =>
  `${String(Math.max(0, Math.round(ms / 1000)))} 秒`;

function parseArgs(argsText: string): {
  agent?: string;
  task?: string;
  reason?: string;
} {
  try {
    return JSON.parse(argsText) as {
      agent?: string;
      task?: string;
      reason?: string;
    };
  } catch {
    return {};
  }
}

/** 结论正文：去掉服务端加在最前面的「【xx · 完成】…」统计行（卡片头已经显示了）。 */
function conclusionOf(text: string): string {
  return text.replace(/^【[^】]*】[^\n]*\n+/, "").trim();
}

export function AgentRunCard({
  argsText,
  output,
  isError,
}: {
  argsText: string;
  output: { text?: string; agentRun?: AgentRunView } | undefined;
  isError: boolean;
}): React.JSX.Element {
  const args = parseArgs(argsText);
  const view = output?.agentRun;
  const status: AgentRunView["status"] =
    view?.status ?? (output ? (isError ? "failed" : "done") : "running");
  const live = status === "running" || status === "queued";
  const [open, setOpen] = useState(false);
  const [trace, setTrace] = useState<UIMessage[] | null>(null);
  const [traceErr, setTraceErr] = useState<string | null>(null);
  const name = view?.agent ?? args.agent ?? "智能体";
  const steps = view?.steps ?? [];
  const conclusion = !live && output?.text ? conclusionOf(output.text) : "";

  const loadTrace = (): void => {
    if (!view?.runId) return;
    setTraceErr(null);
    request<{ messages: UIMessage[] }>(`/agent-runs/${view.runId}`)
      .then((r) => {
        setTrace(r.messages);
      })
      .catch((e: unknown) => {
        setTraceErr(e instanceof Error ? e.message : "加载失败");
      });
  };

  return (
    <div className={`agent-card status-${status}`}>
      <button
        type="button"
        className="agent-card-head"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
        }}
      >
        <span className="agent-avatar" aria-hidden>
          <Users size={14} />
        </span>
        <span className="agent-title">
          <strong>{agentLabel(name)}</strong>
          <span className="agent-reason">
            {view?.reason ?? args.reason ?? ""}
          </span>
        </span>
        <span className={`agent-badge ${status}`}>
          {live ? (
            <Loader2 size={12} className="spin" />
          ) : status === "done" ? (
            <Check size={12} />
          ) : status === "stopped" ? (
            <Square size={11} />
          ) : (
            <X size={12} />
          )}
          {STATUS[status]}
        </span>
        <ChevronRight
          size={14}
          className={`agent-chevron${open ? " open" : ""}`}
        />
      </button>

      {/* 运行中：总是显示最近几步，让人知道它在干什么。 */}
      {(live || open) && steps.length > 0 && (
        <ol className="agent-steps">
          {(open ? steps : steps.slice(-4)).map((s, i) => (
            <li key={`${String(s.at)}-${String(i)}`}>
              <span className="agent-step-time">{secs(s.at)}</span>
              {s.label}
            </li>
          ))}
        </ol>
      )}
      {live && view?.preview && <p className="agent-preview">{view.preview}</p>}

      {view && (
        <p className="agent-meta">
          {String(view.turns)} 轮 · {String(view.toolCalls)} 次工具 ·{" "}
          {secs(view.elapsedMs)}
          {view.model ? ` · ${view.model.split("/").pop() ?? ""}` : ""}
          {view.error && !live ? ` · ${view.error}` : ""}
        </p>
      )}

      {open && (
        <div className="agent-body">
          {(view?.task ?? args.task) && (
            <div className="agent-task">
              <span className="agent-label">任务</span>
              <p>{view?.task ?? args.task}</p>
            </div>
          )}
          {conclusion && (
            <div className="agent-conclusion">
              <span className="agent-label">结论</span>
              <MarkdownText text={conclusion} streaming={false} />
            </div>
          )}
          {view?.runId && !live && (
            <div className="agent-trace">
              {trace === null ? (
                <button
                  type="button"
                  className="link-btn small"
                  onClick={loadTrace}
                >
                  查看完整工作过程
                </button>
              ) : (
                <ol className="agent-trace-list">
                  {trace.map((m) =>
                    m.parts.map((p, i) => {
                      const key = `${m.id}-${String(i)}`;
                      if (p.type === "text" && p.text.trim())
                        return (
                          <li key={key} className={m.role}>
                            <span className="agent-label">
                              {m.role === "user" ? "收到任务" : "思考 / 回复"}
                            </span>
                            <p>
                              {p.text.length > 600
                                ? `${p.text.slice(0, 600)}…`
                                : p.text}
                            </p>
                          </li>
                        );
                      if (p.type === "dynamic-tool")
                        return (
                          <li key={key} className="tool">
                            <span className="agent-label">
                              调用 {p.toolName}
                            </span>
                            <code>{JSON.stringify(p.input).slice(0, 200)}</code>
                          </li>
                        );
                      return null;
                    }),
                  )}
                </ol>
              )}
              {traceErr && <p className="muted small">{traceErr}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
