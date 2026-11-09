import { createRequest, json } from "../http";

/**
 * AI 工坊的接口（服务端见 server/forge.ts）。
 */

const request = createRequest("/api");

export type ForgeKind = "skill" | "agent";
export type ForgeMode = "create" | "edit" | "distill";

/** 界面用词：执行体页叫「执行体」，跟着页面走。 */
export const KIND_LABEL: Record<ForgeKind, string> = {
  skill: "技能",
  agent: "执行体",
};

export interface ForgeDraft {
  sessionId: string;
  kind: ForgeKind;
  mode: ForgeMode;
  /** 改的是哪个现有定义；null = 新建（还没保存过）。 */
  target: string | null;
  /** 开工（或上次保存）时的快照：对比视图的左边。 */
  base: Record<string, string>;
  files: Record<string, string>;
  /** 二进制或过大的附属文件：工坊不碰，原样保留。 */
  locked: string[];
  savedName: string | null;
  dirty: boolean;
  problems: { errors: string[]; warnings: string[] };
  name: string | null;
  /** 原件在开工后被别处改过（保存会覆盖那次修改）。 */
  stale: boolean;
  updatedAt: number;
}

export interface ForgeDraftBrief {
  sessionId: string;
  kind: ForgeKind;
  mode: ForgeMode;
  target: string | null;
  name: string | null;
  dirty: boolean;
  savedName: string | null;
  updatedAt: number;
}

export const forgeKey = (sessionId: string) => ["forge", sessionId] as const;

export const listForgeDrafts = (kind: ForgeKind) =>
  request<{ drafts: ForgeDraftBrief[] }>(`/forge?kind=${kind}`).then(
    (r) => r.drafts,
  );

export const openForge = (input: {
  kind: ForgeKind;
  mode: ForgeMode;
  name?: string;
}) =>
  request<{ sessionId: string; reused: boolean; kickoff: string | null }>(
    "/forge",
    { method: "POST", ...json(input) },
  );

export const getForgeDraft = (sessionId: string) =>
  request<ForgeDraft>(`/forge/${sessionId}`);

/** 人手改草稿里的一个文件；content = null 删掉它。 */
export const putForgeFile = (
  sessionId: string,
  path: string,
  content: string | null,
) =>
  request<ForgeDraft>(`/forge/${sessionId}/file`, {
    method: "PUT",
    ...json({ path, content }),
  });

export const saveForge = (sessionId: string, force = false) =>
  request<{ name: string; draft: ForgeDraft }>(`/forge/${sessionId}/save`, {
    method: "POST",
    ...json({ force }),
  });

export const discardForge = (sessionId: string) =>
  request<undefined>(`/forge/${sessionId}`, { method: "DELETE" });
