/**
 * 两个 AI 分析的接口。形状与 server/analysis/routes.ts 一一对应。
 *
 * 分析**跑在真对话里**：这里只负责建会话、取结果、落库；中间那一段流式
 * 走的是现成的 `/api/sessions/:id/chat`（见 server/analysis/routes.ts 顶部注释）。
 */

/** 发起一次分析：拿到会话 id 与要发出去的那段提示词。 */
import { createRequest, json } from "../http";

export { ApiError } from "../http";

const request = createRequest("/api");

export interface Started {
  sessionId: string;
  title: string;
  prompt: string;
  stats: { dirs: number; nodes: number; truncated: boolean };
  /** 因疑似含凭据而只报了文件名、没读正文的文件。服务端一直在回，要如实显示。 */
  skippedDocs?: { path: string; reason: string }[];
}

interface DiscoveredBase {
  name: string;
  description: string;
  folderPath: string;
  reason: string;
}
export interface DiscoveredProduct extends DiscoveredBase {
  /** 代码目录（/代码库 下），服务端已核过存在。空串 = AI 没对上。 */
  codePath?: string;
  /** 参考资料，服务端已核过存在。 */
  refPaths?: string[];
  /** AI 给了但没采用的路径（找不到 / 放错地方），如实列给人看。 */
  droppedPaths?: { path: string; why: string }[];
}
export interface DiscoveredLine extends DiscoveredBase {
  products: DiscoveredProduct[];
}
export interface DiscoverResult {
  kind: "discover";
  lines: DiscoveredLine[];
  uncertain: string[];
}

export type ArtifactStatus = "present" | "partial" | "missing";
export interface Finding {
  stageCode: string;
  stageLabel: string;
  artifact: string;
  required: boolean;
  status: ArtifactStatus;
  files: string[];
  missedCheckpoints: string[];
  note: string;
  judged: boolean;
}
export interface CheckSummary {
  total: number;
  present: number;
  partial: number;
  missing: number;
  requiredGap: number;
}
export interface CompareResult {
  kind: "compare";
  productId: string;
  templateId: string;
  templateName: string;
  summary: CheckSummary;
  findings: Finding[];
}

/* ── 产品 Wiki ─────────────────────────────────────────────────────── */

export interface OutlinePage {
  title: string;
  brief: string;
  children?: OutlinePage[];
}
export interface WikiOutlineResult {
  kind: "wiki-outline";
  productId: string;
  mode: "append" | "replace";
  pages: OutlinePage[];
  uncertain: string[];
  /** replace 模式下有多少页已经写了正文（会被保留，不清）。 */
  written: number;
}
export interface WikiPageResult {
  kind: "wiki-page";
  productId: string;
  pageId: string;
  pageTitle: string;
  /** 这一页已经有正文——应用会覆盖它，要说清楚。 */
  hadContent: boolean;
  content: string;
  sources: string[];
  gaps: string[];
}

/** 规划整本 wiki 的目录。 */
export const startWikiOutline = (input: {
  productId: string;
  mode?: "append" | "replace";
}) =>
  request<Started>("/analysis/wiki-outline", {
    method: "POST",
    ...json({ mode: "append", ...input }),
  });

/** 给某一章写正文。 */
export const startWikiPage = (pageId: string) =>
  request<Started>("/analysis/wiki-page", {
    method: "POST",
    ...json({ pageId }),
  });

export const applyWikiOutline = (sessionId: string) =>
  request<{
    created: string[];
    skipped: string[];
    /** AI 指定、但越界或不存在而被丢掉的精读路径。 */
    droppedSources?: string[];
  }>(`/analysis/${sessionId}/apply-wiki-outline`, { method: "POST" });

export const applyWikiPage = (sessionId: string) =>
  request<{ page: { id: string } }>(`/analysis/${sessionId}/apply-wiki-page`, {
    method: "POST",
  });

export type AnalysisResult =
  | DiscoverResult
  | CompareResult
  | ArchitectureResult
  | WikiOutlineResult
  | WikiPageResult;

export interface StoredCheck {
  productId: string;
  templateId: string;
  sessionId: string | null;
  folderPath: string;
  summary: CheckSummary;
  findings: Finding[];
  checkedAt: number;
}

/** 应用识别结果时回传的（用户可能改过名、去掉了几项）。 */
export interface ApplyLine {
  name: string;
  description: string;
  folderPath: string;
  products: {
    name: string;
    description: string;
    folderPath: string;
    codePath: string;
    refPaths: string[];
    templateId: string;
  }[];
}

export interface ApplyReport {
  createdLines: string[];
  createdProducts: string[];
  /** 已存在的产品，只补了空着的依据。 */
  filledProducts?: string[];
  skipped: { what: string; why: string }[];
}

/** 识别范围：文档文件夹、单个文件、代码仓库可以混着勾。 */
export const startDiscover = (paths: string[]) =>
  request<Started>("/analysis/discover", {
    method: "POST",
    ...json({ paths }),
  });

export const startCompare = (productId: string) =>
  request<Started>("/analysis/compare", {
    method: "POST",
    ...json({ productId }),
  });

export const readResult = (sessionId: string) =>
  request<AnalysisResult>(`/analysis/${sessionId}/result`);

export const applyDiscovered = (sessionId: string, lines: ApplyLine[]) =>
  request<ApplyReport>(`/analysis/${sessionId}/apply`, {
    method: "POST",
    ...json({ lines }),
  });

export const saveCheck = (sessionId: string) =>
  request<StoredCheck>(`/analysis/${sessionId}/save`, { method: "POST" });

export const listChecks = () =>
  request<{ checks: StoredCheck[] }>("/product-checks").then((r) => r.checks);

/* ── 产品功能架构 ──────────────────────────────────────────────────── */

export interface FeatureNode {
  id: string;
  productId: string;
  parentId: string | null;
  name: string;
  duty: string;
  /** 代码证据（文件 / 目录指针）。 */
  evidence: string[];
  source: "ai" | "manual";
  sessionId: string | null;
  /** 1 = 一级功能。 */
  level: number;
  children: FeatureNode[];
}

export interface AiFeature {
  name: string;
  duty: string;
  evidence: string[];
  children: AiFeature[];
}

export interface ArchitectureResult {
  kind: "architecture";
  productId: string;
  nodeId: string | null;
  mode: "append" | "replace";
  features: AiFeature[];
  uncertain: string[];
  /** replace 模式下这一支里手改过、会被覆盖掉的子功能名。 */
  manualAtRisk: string[];
}

export interface ArchitectureApplied {
  created: string[];
  skipped: string[];
  features: FeatureNode[];
}

/** 发起一次功能架构分析。`nodeId` 为空 = 分析一级功能。 */
export const startArchitecture = (input: {
  productId: string;
  nodeId?: string;
  mode?: "append" | "replace";
}) =>
  request<Started>("/analysis/architecture", {
    method: "POST",
    ...json({ mode: "append", ...input }),
  });

export const applyArchitecture = (sessionId: string) =>
  request<ArchitectureApplied>(`/analysis/${sessionId}/apply-architecture`, {
    method: "POST",
  });

export const listFeatures = (productId: string) =>
  request<{ features: FeatureNode[] }>(`/products/${productId}/features`).then(
    (r) => r.features,
  );

export const createFeature = (
  productId: string,
  fields: { name: string; duty: string; evidence: string; parentId?: string },
) =>
  request<FeatureNode>(`/products/${productId}/features`, {
    method: "POST",
    ...json(fields),
  });

export const updateFeature = (
  id: string,
  fields: Partial<{ name: string; duty: string; evidence: string }>,
) =>
  request<FeatureNode>(`/feature-nodes/${id}`, {
    method: "PATCH",
    ...json(fields),
  });

export const deleteFeature = (id: string) =>
  request<undefined>(`/feature-nodes/${id}`, { method: "DELETE" });
