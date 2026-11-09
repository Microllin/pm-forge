import { createRequest, json } from "../http";

/**
 * 市场情报的接口（服务端见 server/intel/routes.ts）。
 */

const request = createRequest("/api");

export const INTEL_KINDS = [
  "competitor",
  "market",
  "industry",
  "compliance",
  "other",
] as const;
export type IntelKind = (typeof INTEL_KINDS)[number];
export const KIND_LABEL: Record<IntelKind, string> = {
  competitor: "竞品",
  market: "市场",
  industry: "行业动态",
  compliance: "合规",
  other: "其他",
};

export const INTEL_CONFIDENCE = [
  "official",
  "multi",
  "single",
  "inferred",
] as const;
export type IntelConfidence = (typeof INTEL_CONFIDENCE)[number];
export const CONFIDENCE_LABEL: Record<IntelConfidence, string> = {
  official: "官方来源",
  multi: "多源一致",
  single: "单一来源",
  inferred: "推断",
};

export type IntelStatus = "pending" | "active" | "archived";

export interface IntelSource {
  title?: string;
  url: string;
}

export interface IntelItem {
  id: string;
  kind: IntelKind;
  subject: string;
  title: string;
  summary: string;
  content: string;
  sources: IntelSource[];
  tags: string[];
  productIds: string[];
  observedAt: string | null;
  reviewAfter: number | null;
  confidence: IntelConfidence;
  status: IntelStatus;
  origin: "manual" | "ai";
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  stale: boolean;
}

export interface IntelInput {
  kind: IntelKind;
  subject: string;
  title: string;
  summary: string;
  content: string;
  sources: IntelSource[];
  tags: string[];
  productIds: string[];
  observedAt: string | null;
  reviewAfter: number | null;
  confidence: IntelConfidence;
}

export const INTEL_KEY = ["intel"] as const;

export const listIntel = () =>
  request<{ items: IntelItem[] }>("/intel").then((r) => r.items);

export const createIntel = (input: IntelInput) =>
  request<IntelItem>("/intel", { method: "POST", ...json(input) });

export const updateIntel = (id: string, input: IntelInput) =>
  request<IntelItem>(`/intel/${id}`, { method: "PUT", ...json(input) });

export const setIntelStatus = (id: string, status: IntelStatus) =>
  request<IntelItem>(`/intel/${id}/status`, {
    method: "POST",
    ...json({ status }),
  });

export const deleteIntel = (id: string) =>
  request<undefined>(`/intel/${id}`, { method: "DELETE" });

export const startResearch = (input: {
  topic: string;
  kind?: IntelKind;
  productId?: string | null;
}) =>
  request<{ sessionId: string; kickoff: string }>("/intel/research", {
    method: "POST",
    ...json(input),
  });
