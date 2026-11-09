/**
 * 任务与需求的接口。形状与 server/work-items.ts 一一对应。
 */
import { createRequest, json } from "../http";

const request = createRequest("/api");

export type WorkKind = "request" | "task";
export type WorkStatus = "todo" | "doing" | "done" | "canceled";

export interface WorkItem {
  id: string;
  kind: WorkKind;
  source: "manual" | "linear";
  externalKey: string | null;
  url: string | null;
  title: string;
  description: string;
  status: WorkStatus;
  externalStatus: string | null;
  /** 0 无 / 1 紧急 / 2 高 / 3 中 / 4 低（与 Linear 同一套编号）。 */
  priority: number;
  requester: string;
  assignee: string;
  labels: string[];
  team: string;
  productId: string | null;
  productName: string | null;
  sessionId: string | null;
  externalUpdatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkFields {
  title: string;
  description: string;
  status: WorkStatus;
  priority: number;
  requester: string;
  productId: string | null;
}

export const workKey = (kind: WorkKind) => ["work-items", kind] as const;

export const listWorkItems = (kind: WorkKind) =>
  request<{ items: WorkItem[] }>(`/work-items?kind=${kind}`).then(
    (r) => r.items,
  );
/** 只有用户需求能手建；内部任务只从 Linear 拉。 */
export const createRequestItem = (fields: Partial<WorkFields>) =>
  request<WorkItem>("/work-items", {
    method: "POST",
    ...json({ kind: "request", ...fields }),
  });
export const updateWorkItem = (id: string, fields: Partial<WorkFields>) =>
  request<WorkItem>(`/work-items/${id}`, { method: "PATCH", ...json(fields) });
export const deleteWorkItem = (id: string) =>
  request<undefined>(`/work-items/${id}`, { method: "DELETE" });
export const startWorkChat = (id: string) =>
  request<{ sessionId: string; prompt: string; item: WorkItem }>(
    `/work-items/${id}/chat`,
    { method: "POST" },
  );

/* Linear */

export interface LinearState {
  connected: boolean;
  keyHint: string | null;
  scope: "mine" | "all";
  teamKey: string;
  includeDone: boolean;
  lastSync: {
    at: number;
    ok: boolean;
    added: number;
    updated: number;
    error: string | null;
  } | null;
}
export const LINEAR_KEY = ["integrations", "linear"] as const;

export const getLinear = () => request<LinearState>("/integrations/linear");
export const saveLinear = (body: {
  key?: string;
  scope: "mine" | "all";
  teamKey: string;
  includeDone: boolean;
}) =>
  request<LinearState>("/integrations/linear", {
    method: "PUT",
    ...json(body),
  });
export const disconnectLinear = () =>
  request<LinearState>("/integrations/linear/key", { method: "DELETE" });
export const syncLinear = () =>
  request<LinearState>("/integrations/linear/sync", { method: "POST" });
