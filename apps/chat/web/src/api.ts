import { DefaultChatTransport, type UIMessage } from "ai";

import type { AnalysisTask } from "./analysis/AnalysisBanner";

/**
 * 前端与对话服务的全部接口。形状与 server/app.ts 一一对应。
 */
import { createRequest, json } from "./http";

import { ApiError, UNAUTHORIZED_EVENT } from "./http";

export { ApiError };

const request = createRequest("/api");

/* ── 会话 ── */

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  streaming: boolean;
  /** 这条会话是不是一次 AI 分析（见 analysis/AnalysisBanner.tsx）；null = 普通对话。 */
  task: AnalysisTask | null;
  /** 这段对话属于哪个产品（决定事实依据）；null = 普通对话，不注入依据。 */
  productId: string | null;
  /** 手选的依据范围（文件库路径）；空 = 整个依据库。 */
  evidenceScope: string[];
}

/** 这段对话的依据库与当前范围（输入框上方「依据范围」的数据源）。 */
export interface SessionEvidence {
  productName: string | null;
  sources: { path: string; label: string; kind: "doc" | "code" }[];
  scope: string[];
  /** 绑定了但文件库里找不到的路径。 */
  missing: string[];
}

export const loadSessionEvidence = (id: string) =>
  request<SessionEvidence>(`/sessions/${id}/evidence`);
export const setSessionEvidenceScope = (id: string, scope: string[]) =>
  request<{ scope: string[] }>(`/sessions/${id}/evidence-scope`, {
    method: "PUT",
    ...json({ scope }),
  });

export const listSessions = () =>
  request<{ sessions: Session[] }>("/sessions").then((r) => r.sessions);
/**
 * AI 工坊的会话不进对话列表（用户拍板：列表里只放干活的对话）。
 * 只在展示处过滤、接口照常返回：工坊面板还要靠同一份列表判断「AI 正在改」。
 */
export const isForgeSession = (s: Session): boolean => s.task?.kind === "forge";
/** 新建对话。带 `productId` 时这段对话会按该产品的依据库注入事实依据。 */
export const createSession = (input?: { productId?: string }) =>
  request<Session>("/sessions", {
    method: "POST",
    ...(input?.productId === undefined ? {} : json(input)),
  });
export const renameSession = (id: string, title: string) =>
  request<Session>(`/sessions/${id}`, { method: "PATCH", ...json({ title }) });
export const deleteSession = (id: string) =>
  request<undefined>(`/sessions/${id}`, { method: "DELETE" });

export interface History {
  messages: UIMessage[];
  /** 服务端此刻有一轮在跑：要续流。 */
  streaming: boolean;
}
export const loadHistory = (id: string) =>
  request<History>(`/sessions/${id}/messages`);
export const queueMessage = (id: string, message: string) =>
  request<{ queued: boolean; pending: number }>(`/sessions/${id}/queue`, {
    method: "POST",
    ...json({ message }),
  });
export const abortSession = (id: string) =>
  request<undefined>(`/sessions/${id}/abort`, { method: "POST" });

/**
 * 会话专属的对话传输（AI SDK UI Message Stream v1）。
 *
 * - 发送只带最后一句：历史的真相源在服务端的 pi 会话里。
 * - 续流走 GET /chat/stream；服务端从本轮开头重放，所以 resumeStreamIsReplay。
 */
export function chatTransport(
  sessionId: string,
): DefaultChatTransport<UIMessage> {
  const base = `/api/sessions/${sessionId}`;
  return new DefaultChatTransport<UIMessage>({
    api: `${base}/chat`,
    resumeStreamIsReplay: true,
    prepareSendMessagesRequest: ({ messages }) => {
      const last = messages.findLast((m) => m.role === "user");
      const text = (last?.parts ?? [])
        .map((p) => (p.type === "text" ? p.text : ""))
        .join("");
      return { body: { message: text } };
    },
    prepareReconnectToStreamRequest: () => ({ api: `${base}/chat/stream` }),
  });
}

/* ── 模型接入（照 pi CLI：多个 provider，可用模型是并集，对话里随时切换）── */

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export const CUSTOM_APIS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;
export type CustomApi = (typeof CUSTOM_APIS)[number];

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface AvailableModel {
  provider: string;
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  /** 中转模型的元数据继承自哪个 pi 内置模型。 */
  inheritedFrom: string | null;
}

export interface ModelsState {
  models: AvailableModel[];
  defaultModel: ModelRef | null;
  defaultThinking: ThinkingLevel;
  /** 为什么没有可用模型（没接入 provider 等）。 */
  problem: string | null;
}

export type KeySource = "env" | "file" | "none";

export type ConfiguredProvider =
  | {
      id: string;
      kind: "custom";
      name: string;
      baseUrl: string;
      api: CustomApi;
      models: string[];
      keySource: KeySource;
    }
  | {
      id: string;
      kind: "builtin";
      name: string;
      models: string[];
      keySource: KeySource;
    };

export interface ProvidersState {
  configured: ConfiguredProvider[];
  /** 可添加的 pi 内置 provider。 */
  catalog: { id: string; name: string; modelCount: number }[];
  defaultModel: ModelRef | null;
  defaultThinking: ThinkingLevel;
}

export const getModels = () => request<ModelsState>("/models");
export const getProviders = () => request<ProvidersState>("/providers");
export const saveCustomProvider = (
  id: string,
  body: { baseUrl: string; api: CustomApi; models: string[]; key?: string },
) =>
  request<unknown>(`/providers/custom/${encodeURIComponent(id)}`, {
    method: "PUT",
    ...json(body),
  });
export const setProviderKey = (id: string, key: string) =>
  request<undefined>(`/providers/${encodeURIComponent(id)}/key`, {
    method: "PUT",
    ...json({ key }),
  });
export const removeProvider = (id: string) =>
  request<undefined>(`/providers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
export const saveDefaults = (body: {
  defaultModel: ModelRef | null;
  defaultThinking: ThinkingLevel;
}) => request<unknown>("/defaults", { method: "PUT", ...json(body) });

/** 用 key 拉取中转的模型清单（服务端请求 {base}/v1/models）。key 不传则用该 provider 已保存的。 */
export const probeModels = (params: {
  baseUrl: string;
  api: CustomApi;
  providerId: string;
  key?: string;
}) =>
  request<{ models: string[] }>("/model/probe", {
    method: "POST",
    ...json(params),
  }).then((r) => r.models);

/* ── 会话的模型（pi 的 /model 与 Shift+Tab）── */

export interface SessionModel {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** 当前模型支持的思考强度。 */
  thinkingLevels: ThinkingLevel[];
}

export const getSessionModel = (id: string) =>
  request<SessionModel>(`/sessions/${id}/model`);
export const setSessionModel = (id: string, ref: ModelRef) =>
  request<SessionModel>(`/sessions/${id}/model`, {
    method: "PUT",
    ...json(ref),
  });
export const setSessionThinking = (id: string, level: ThinkingLevel) =>
  request<SessionModel>(`/sessions/${id}/thinking`, {
    method: "PUT",
    ...json({ level }),
  });

/* ── 技能（skill）── */

export const SKILL_TARGETS = ["pi"] as const;
export type SkillTarget = (typeof SKILL_TARGETS)[number];
export type SkillLinkState = "linked" | "absent" | "blocked";
export type SkillDistribution = Record<SkillTarget, SkillLinkState>;

export interface SkillSummary {
  name: string;
  description: string;
  /** frontmatter 写了 disable-model-invocation：模型不会自动选它，仍可点名用。 */
  hidden: boolean;
  /** 它在每轮系统提示词里占多少字节（隐藏的为 0）。 */
  promptBytes: number;
  fileCount: number;
  updatedAt: number;
  distribution: SkillDistribution;
}

export interface SkillDetail extends SkillSummary {
  /** SKILL.md 全文（含 frontmatter）。编辑器改的就是它。 */
  content: string;
  files: string[];
}

export const listSkills = () =>
  request<{ skills: SkillSummary[]; promptBytes: number }>("/skills");
export const getSkill = (name: string) =>
  request<SkillDetail>(`/skills/${encodeURIComponent(name)}`);
/** 新建。名字取自 frontmatter 的 name，不单独传。 */
export const createSkill = (content: string) =>
  request<SkillDetail>("/skills", { method: "POST", ...json({ content }) });
/** 保存。改了 frontmatter 的 name 就连目录一起改，返回的 name 是改后的。 */
export const saveSkill = (name: string, content: string) =>
  request<SkillDetail>(`/skills/${encodeURIComponent(name)}`, {
    method: "PUT",
    ...json({ content }),
  });
export const deleteSkill = (name: string) =>
  request<undefined>(`/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
/** 导入一个技能目录（文件夹选择器 / 拖放）。一次一个技能，批量由调用方拆开调。 */
export const importSkillTree = (files: { path: string; base64: string }[]) =>
  request<SkillDetail>("/skills/tree", {
    method: "POST",
    ...json({ files }),
  });

/** 读技能目录里的某个文件（展览页点开附属文件）。 */
export const getSkillFile = (name: string, path: string) =>
  request<{ path: string; text: string | null; bytes: number }>(
    `/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`,
  );

/** 导入 zip（带附属文件的技能只能这么进来）。 */
export const importSkillZip = (zipBase64: string) =>
  request<SkillDetail>("/skills/import", {
    method: "POST",
    ...json({ zip: zipBase64 }),
  });
/** 开关「对模型隐藏」。改的是 SKILL.md 的 frontmatter，不另存一份状态。 */
export const setSkillHidden = (name: string, hidden: boolean) =>
  request<SkillDetail>(`/skills/${encodeURIComponent(name)}/visibility`, {
    method: "PUT",
    ...json({ hidden }),
  });

/** 软链到本机 CLI 的技能目录。传期望的集合，多的摘、缺的建。 */
export const setSkillDistribution = (name: string, targets: SkillTarget[]) =>
  request<SkillDetail>(`/skills/${encodeURIComponent(name)}/distribution`, {
    method: "PUT",
    ...json({ targets }),
  });

/* ── 执行体（agent）── */

export const AGENT_TARGETS = ["pi"] as const;
export type AgentTarget = (typeof AGENT_TARGETS)[number];
export type AgentLinkState = "linked" | "absent" | "blocked";
export type AgentDistribution = Record<AgentTarget, AgentLinkState>;

export interface AgentSummary {
  name: string;
  description: string;
  /** 空数组 = frontmatter 没写 tools，含义是**继承全部工具**，不是没有工具。 */
  tools: string[];
  /** 指定模型；没写就跟随调用方。 */
  model?: string;
  /** 启动时预加载的 skill 名字。 */
  skills: string[];
  updatedAt: number;
  distribution: AgentDistribution;
}

export interface AgentDetail extends AgentSummary {
  /** 定义全文（含 frontmatter）。编辑器改的就是它。 */
  content: string;
  /** `skills:` 点名了、技能库里却没有的那些——执行体最容易出的哑故障。 */
  missingSkills: string[];
}

export const listAgents = () =>
  request<{ agents: AgentSummary[] }>("/agents").then((r) => r.agents);
export const getAgent = (name: string) =>
  request<AgentDetail>(`/agents/${encodeURIComponent(name)}`);
/** 新建。名字取自 frontmatter 的 name，不单独传。 */
export const createAgent = (content: string) =>
  request<AgentDetail>("/agents", { method: "POST", ...json({ content }) });
/** 保存。改了 frontmatter 的 name 就连文件一起改，返回的 name 是改后的。 */
export const saveAgent = (name: string, content: string) =>
  request<AgentDetail>(`/agents/${encodeURIComponent(name)}`, {
    method: "PUT",
    ...json({ content }),
  });
export const deleteAgent = (name: string) =>
  request<undefined>(`/agents/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
/** 软链到 ~/.pi/agent/agents。传期望的集合，多的摘、缺的建。 */
export const setAgentDistribution = (name: string, targets: AgentTarget[]) =>
  request<AgentDetail>(`/agents/${encodeURIComponent(name)}/distribution`, {
    method: "PUT",
    ...json({ targets }),
  });

/* ── pi 版本 ── */

export interface PiState {
  installed: string;
  installedAt: string | null;
  latest: string | null;
  latestAt: string | null;
  updateAvailable: boolean;
  repository: string | null;
  upgrading: boolean;
  registryError: string | null;
}

export type UpgradeEvent =
  | { type: "log"; line: string }
  | { type: "step"; name: string }
  | { type: "done"; ok: true; version: string; restarting: boolean }
  | { type: "done"; ok: false; error: string; rolledBack: boolean };

export const getPi = () => request<PiState>("/pi");

/** 发起升级并逐帧读进度（SSE）。409/400 之类的拒绝以 ApiError 抛出。 */
/** POST 一条流式接口，逐帧把 `data:` 之后的 JSON 交给 onEvent。 */
export async function readSse(
  url: string,
  body: unknown,
  onEvent: (event: unknown) => void,
  fallbackMessage = "请求失败",
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    const payload = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    throw new ApiError(
      res.status,
      payload.error?.code ?? "HTTP_ERROR",
      payload.error?.message ?? fallbackMessage,
    );
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      if (frame.startsWith("data: ")) onEvent(JSON.parse(frame.slice(6)));
      cut = buffer.indexOf("\n\n");
    }
  }
}

export function upgradePi(
  version: string | undefined,
  onEvent: (e: UpgradeEvent) => void,
): Promise<void> {
  return readSse(
    "/api/pi/upgrade",
    version === undefined ? {} : { version },
    (event) => onEvent(event as UpgradeEvent),
    "升级请求失败",
  );
}

/** 升级后服务会重启：轮询健康检查直到它回来。 */
export async function waitForServer(timeoutMs = 60_000): Promise<boolean> {
  const start = Date.now();
  // 先等它真的下线，免得在旧进程退出前就判定「已恢复」。
  await new Promise((r) => setTimeout(r, 1200));
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch("/api/health");
      if (res.ok) return true;
    } catch {
      // 还在重启。
    }
    await new Promise((r) => setTimeout(r, 800));
  }
  return false;
}
