import { createRequest, json } from "../http";

/**
 * 售前材料 AI 审阅 / 体系复盘的接口（服务端见 server/presales-review.ts）。
 */

const request = createRequest("/api");

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type Decision = "pending" | "accepted" | "rejected";

export const ISSUE_TYPE_LABEL: Record<string, string> = {
  "code-mismatch": "与代码不符",
  "prd-mismatch": "与 PRD 不符",
  "roadmap-as-shipped": "把规划写成已有",
  stale: "过时 / 腐烂",
  inconsistent: "与其他材料不一致",
  caliber: "违反口径",
  checkpoint: "缺检查要点",
  other: "其他",
};

export interface Issue {
  id: string;
  severity: string;
  type: string;
  original: string;
  replacement: string | null;
  reason: string;
  evidence: string[];
  related: string[];
  matches: number;
  decision: Decision;
  applied: boolean;
}

export interface ReviewResult {
  verdict: string;
  summary: string;
  issues: Issue[];
  gaps: string[];
  truncated: boolean;
}

export interface CrossIssue {
  severity: string;
  type: string;
  title: string;
  detail: string;
  materials: string[];
  evidence: string[];
  suggestion: string;
}

export interface CrossResult {
  summary: string;
  issues: CrossIssue[];
}

export interface VersionLite {
  id: string;
  version: string;
  status: "draft" | "review" | "current" | "archived";
  fileName: string | null;
  fileSize: number | null;
}

export interface Job {
  id: string;
  libId: string;
  runId: string | null;
  kind: "ledger" | "cross" | "review";
  slotId: string | null;
  versionId: string | null;
  sessionId: string | null;
  status: JobStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  baseVersion: { id: string; version: string; fileName: string | null } | null;
  appliedVersion: VersionLite | null;
  result: unknown;
}

export interface ReviewBrief extends Job {
  verdict: string | null;
  counts: {
    total: number;
    p0: number;
    pending: number;
    accepted: number;
    applied: number;
  };
}

interface Progress {
  total: number;
  done: number;
  failed: number;
  running: number;
}

export interface Run {
  id: string;
  libId: string;
  status: "running" | "done" | "cancelled" | "interrupted";
  createdAt: number;
  finishedAt: number | null;
  materials: number;
  phase: "ledger" | "cross" | "review";
  progress: { ledger: Progress; cross: Progress; review: Progress };
  cross: Job | null;
  reviews: ReviewBrief[];
  failures: {
    id: string;
    kind: string;
    slotId: string | null;
    error: string | null;
    sessionId: string | null;
  }[];
}

export interface AiState {
  run: Run | null;
  reviews: Record<string, ReviewBrief>;
  busy: boolean;
}

export interface Plan {
  planId: string;
  libName: string;
  hasProduct: boolean;
  materials: {
    slotId: string;
    title: string;
    fileName: string;
    chars: number;
  }[];
  skipped: { slotId: string; title: string; reason: string }[];
  templateGaps: { name: string; required: boolean }[];
  sessions: number;
  tokens: { min: number; max: number };
}

export const aiKey = (libId: string) => ["presales", libId, "ai"] as const;
export const jobKey = (jobId: string) => ["presales-ai-job", jobId] as const;

export const getAi = (libId: string) =>
  request<AiState>(`/presales/${libId}/ai`);
export const getPlan = (libId: string) =>
  request<Plan>(`/presales/${libId}/ai/plan`);
export const startRun = (libId: string, planId: string) =>
  request<Run>(`/presales/${libId}/ai/runs`, {
    method: "POST",
    ...json({ planId }),
  });
export const cancelRun = (runId: string) =>
  request<Run>(`/presales/ai/runs/${runId}/cancel`, {
    method: "POST",
    ...json({}),
  });
export const resumeRun = (runId: string) =>
  request<Run>(`/presales/ai/runs/${runId}/resume`, {
    method: "POST",
    ...json({}),
  });
export const applyRun = (runId: string) =>
  request<{
    results: { slotId: string | null; ok: boolean; message: string }[];
  }>(`/presales/ai/runs/${runId}/apply`, { method: "POST", ...json({}) });

export const startReview = (slotId: string) =>
  request<Job>(`/presales/slots/${slotId}/ai/review`, {
    method: "POST",
    ...json({}),
  });
export const getJob = (jobId: string) =>
  request<Job>(`/presales/ai/jobs/${jobId}`);
export const collectJob = (jobId: string) =>
  request<Job>(`/presales/ai/jobs/${jobId}/collect`, {
    method: "POST",
    ...json({}),
  });
export const decide = (jobId: string, decisions: Record<string, Decision>) =>
  request<Job>(`/presales/ai/jobs/${jobId}/decisions`, {
    method: "POST",
    ...json({ decisions }),
  });
export const applyJob = (jobId: string) =>
  request<{
    version: VersionLite;
    applied: string[];
    missed: string[];
    job: Job;
  }>(`/presales/ai/jobs/${jobId}/apply`, { method: "POST", ...json({}) });
export const setVersionStatus = (versionId: string, status: string) =>
  request<undefined>(`/presales/versions/${versionId}/status`, {
    method: "POST",
    ...json({ status }),
  });

/** 能读出文字、AI 审得了的格式。与服务端 materialText 同一口径。 */
export const reviewable = (fileName: string | null): boolean => {
  if (fileName === null) return false;
  const ext = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  return ["docx", "pptx", "xlsx", "md", "markdown", "txt", "csv"].includes(ext);
};

export const asReview = (job: Job | undefined): ReviewResult | null => {
  const r = job?.result as ReviewResult | null | undefined;
  return r !== null && r !== undefined && Array.isArray(r.issues) ? r : null;
};
export const asCross = (job: Job | null | undefined): CrossResult | null => {
  const r = job?.result as CrossResult | null | undefined;
  return r !== null && r !== undefined && Array.isArray(r.issues) ? r : null;
};

/* ── 售前模板（对号与「编辑」里选模板条目用）── */

export interface TemplateSummary {
  id: string;
  name: string;
  builtinKey: "product" | "company" | null;
  stages: {
    code: string;
    label: string;
    items: { id: string; name: string }[];
  }[];
}

export const templatesKey = ["presales-templates"] as const;
export const listTemplates = () =>
  request<{ templates: TemplateSummary[] }>("/presales-templates").then(
    (r) => r.templates,
  );
