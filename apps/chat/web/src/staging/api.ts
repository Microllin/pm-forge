/**
 * 临时区的接口。形状与 server/staging/routes.ts 一一对应。
 */
import { createRequest, json } from "../http";

const request = createRequest("/api");

export type StagingSource = "chat" | "agent" | "fill" | "presales";

export interface StagingItem {
  key: string;
  source: StagingSource;
  productId: string | null;
  productName: string | null;
  title: string;
  origin: string;
  draftPath: string;
  /** 确认后去哪；null = 没有建议，确认时必须填。 */
  target: string | null;
  /** 去处能不能在确认时改（对话 / 智能体草稿）。 */
  targetEditable: boolean;
  willReplace: boolean;
  note: string | null;
  exists: boolean;
  sessionId: string | null;
  createdAt: number;
}

export interface StagingList {
  root: string;
  items: StagingItem[];
  counts: Record<StagingSource, number>;
}

export interface ApplyReport {
  applied: { key: string; title: string; path: string | null }[];
  replaced: string[];
  failed: { key: string; title: string; why: string }[];
}

export const STAGING_QUERY_KEY = ["staging"] as const;

export const getStaging = () => request<StagingList>("/staging");

export const readStagingContent = (key: string) =>
  request<{ path: string; content: string | null }>(
    `/staging/content?key=${encodeURIComponent(key)}`,
  );

export const checkTarget = (path: string) =>
  request<{ path: string; problem: string | null; exists: boolean }>(
    `/staging/target?path=${encodeURIComponent(path)}`,
  );

export const saveToStaging = (body: {
  sessionId: string;
  markdown: string;
  title?: string;
}) =>
  request<StagingItem>("/staging/drafts", { method: "POST", ...json(body) });

export const applyStaging = (items: { key: string; target?: string }[]) =>
  request<ApplyReport>("/staging/apply", {
    method: "POST",
    ...json({ items }),
  });

export const discardStaging = (keys: string[]) =>
  request<{ discarded: number }>("/staging/discard", {
    method: "POST",
    ...json({ keys }),
  });
