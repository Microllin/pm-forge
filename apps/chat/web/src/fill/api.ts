/**
 * 全局 AI 补齐的接口。形状与 server/global-fill.ts 一一对应。
 */
import { createRequest, json } from "../http";

const request = createRequest("/api");

export interface PlanRow {
  productId: string;
  productName: string;
  lineName: string;
  lifecycle:
    | { state: "skip"; reason: string }
    | { state: "none"; reason: string }
    | { state: "known"; missing: string[] }
    | { state: "compare"; max: number };
  wiki:
    | { state: "skip"; reason: string }
    | { state: "none"; reason: string }
    | { state: "outline"; estimate: number }
    | { state: "pages"; pages: string[] };
  sessions: { min: number; max: number };
  idle: boolean;
}

export interface Plan {
  planId: string;
  rows: PlanRow[];
  limits: {
    concurrency: number;
    maxSessions: number;
    tokensPerSession: { min: number; max: number };
  };
  draftRoot: string;
  running: boolean;
}

export type JobStatus =
  "queued" | "running" | "done" | "failed" | "cancelled" | "skipped";
export type RunStatus = "running" | "done" | "cancelled" | "interrupted";

export interface FillJob {
  id: string;
  productId: string;
  productName: string;
  kind: "compare" | "artifact" | "wiki-outline" | "wiki-page";
  label: string;
  status: JobStatus;
  sessionId: string | null;
  error: string | null;
}

export interface FillDraft {
  id: string;
  productId: string;
  productName: string;
  kind: "artifact" | "wiki";
  title: string;
  draftPath: string;
  target: string;
  status: "pending" | "applied" | "discarded";
  willReplace: boolean;
  exists: boolean;
  sessionId: string | null;
}

export interface FillRun {
  id: string;
  status: RunStatus;
  folder: string;
  note: string;
  createdAt: number;
  finishedAt: number | null;
  jobs: FillJob[];
  drafts: FillDraft[];
}

export const getPlan = () => request<Plan>("/global-fill/plan");
export const startFill = (body: { productIds: string[]; planId: string }) =>
  request<FillRun>("/global-fill/start", { method: "POST", ...json(body) });
export const getCurrentRun = () =>
  request<{ run: FillRun | null }>("/global-fill/current").then((r) => r.run);
export const cancelRun = (id: string) =>
  request<FillRun>(`/global-fill/runs/${id}/cancel`, { method: "POST" });
export const resumeRun = (id: string) =>
  request<FillRun>(`/global-fill/runs/${id}/resume`, { method: "POST" });
export const readDraft = (id: string) =>
  request<{ content: string }>(`/global-fill/drafts/${id}`).then(
    (r) => r.content,
  );
export const applyDrafts = (ids: string[]) =>
  request<{
    applied: string[];
    replaced: string[];
    failed: { title: string; why: string }[];
  }>("/global-fill/drafts/apply", { method: "POST", ...json({ ids }) });
export const discardDrafts = (ids: string[]) =>
  request<{ discarded: number }>("/global-fill/drafts/discard", {
    method: "POST",
    ...json({ ids }),
  });
