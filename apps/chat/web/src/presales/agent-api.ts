import { createRequest, json } from "../http";

/**
 * 售前助手与巡检的接口（服务端见 server/presales-agent.ts）。
 */

const request = createRequest("/api");

export type TodoLevel = "high" | "mid" | "low";
export type TodoAction =
  "add" | "upload" | "promote" | "review" | "open-review" | "link" | "draft";

export interface Todo {
  id: string;
  level: TodoLevel;
  title: string;
  detail: string;
  slotId: string | null;
  gapId: string | null;
  actions: TodoAction[];
}

export interface AgentState {
  sessionId: string | null;
  autoReview: boolean;
  todos: Todo[];
}

export const agentKey = (libId: string) =>
  ["presales", libId, "agent"] as const;

export const getAgent = (libId: string) =>
  request<AgentState>(`/presales/${libId}/agent`);

export const ensureAgentSession = (libId: string) =>
  request<{ sessionId: string }>(`/presales/${libId}/agent/session`, {
    method: "POST",
    ...json({}),
  });

export const setAutoReview = (libId: string, autoReview: boolean) =>
  request<{ autoReview: boolean }>(`/presales/${libId}/agent/patrol`, {
    method: "POST",
    ...json({ autoReview }),
  });

/** 草稿 → 可对外（旧现行版自动归档）。 */
export const promoteVersion = (versionId: string) =>
  request<undefined>(`/presales/versions/${versionId}/status`, {
    method: "POST",
    ...json({ status: "current" }),
  });

/** 删掉一个版本（草稿不要了）。 */
export const deleteVersion = (versionId: string) =>
  request<undefined>(`/presales/versions/${versionId}`, { method: "DELETE" });
