import { mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type {
  CustomApi,
  ModelRef,
  ProvidersConfig,
  ThinkingLevel,
} from "../model-config.js";
import {
  SKILL_TOOL_NAME,
  createSkillTool,
  skillsPromptSection,
} from "./skills.js";

/**
 * pi 的装配：模型运行时、会话恢复、受控的 AgentSession。
 *
 * 这是本服务里**唯一**直接碰 pi 构造 API 的地方。pi 升级若改了这些 API，
 * 改动应当只落在这个文件——升级自检（pi/selfcheck.ts）也正是对着它跑的。
 */

/** pi 的模型对象类型不从包根导出，用 getModel 的返回类型反推。 */
export type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export const DEFAULT_SYSTEM_PROMPT = [
  "你是一个可靠、直接的助手。",
  "回答用用户使用的语言；先给结论，再给必要的理由；不确定的事情明说不确定，不编造。",
  "需要结构时用 Markdown（标题、列表、表格、代码块）。",
].join("\n");

export interface PiPaths {
  /** pi 的配置目录（auth.json、settings.json）。刻意不用 ~/.pi/agent，免得与用户自己的 pi 串味。 */
  agentDir: string;
  /** 会话的工作目录。没有文件工具，它只是 pi 要求的一个 cwd。 */
  cwd: string;
  /** skill 库。技能页改的、对话里加载的都是它（见 pi/skills.ts）。 */
  skillsDir: string;
  /**
   * 执行体（agent）定义库。与 skill 平级而不是它的子目录：两者是组合关系
   * （手册 vs 照手册干活的人），嵌起来会让「执行体是一种技能」这个误解落到目录上。
   */
  agentsDir: string;
}

export function piPaths(dataDir: string): PiPaths {
  const paths = {
    agentDir: join(dataDir, "pi"),
    cwd: join(dataDir, "workspace"),
    skillsDir: join(dataDir, "skills"),
    agentsDir: join(dataDir, "agents"),
  };
  mkdirSync(paths.agentDir, { recursive: true });
  mkdirSync(paths.cwd, { recursive: true });
  mkdirSync(paths.skillsDir, { recursive: true });
  mkdirSync(paths.agentsDir, { recursive: true });
  return paths;
}

/** 空的模型运行时（只有 pi 内置目录，不带任何 key）。 */
export async function emptyRuntime(paths: PiPaths): Promise<ModelRuntime> {
  return ModelRuntime.create({
    authPath: join(paths.agentDir, "auth.json"),
    // 不读任何 models.json，不联网刷目录：行为只由本服务的配置决定，
    // 起会话也不会因为网络慢几秒。
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}

export interface BuiltinProvider {
  id: string;
  name: string;
  models: { id: string; name: string }[];
}

let builtinCache: BuiltinProvider[] | undefined;

/** pi 内置 provider 与模型清单（静态目录，进程内缓存）。 */
export async function listBuiltinProviders(
  paths: PiPaths,
): Promise<BuiltinProvider[]> {
  if (builtinCache) return builtinCache;
  const runtime = await emptyRuntime(paths);
  builtinCache = runtime
    .getProviders()
    .map((p) => ({
      id: p.id,
      name: p.name,
      models: runtime
        .getModels(p.id)
        .map((m) => ({ id: m.id, name: m.name }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .filter((p) => p.models.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  return builtinCache;
}

export interface ResolvedCustomModel {
  /** 交给 registerProvider 的模型定义。 */
  definition: Record<string, unknown> & { id: string };
  /** 元数据继承自哪个内置模型（"provider/model"）；手填兜底时为 null。 */
  inheritedFrom: string | null;
}

/**
 * 中转模型的元数据：优先按「同 id、同协议」从 pi 内置目录继承。
 *
 * 不继承的代价是实测出来的：某中转服务上的 claude-opus-4-8 只认 adaptive
 * thinking，而这个事实只记在内置目录的 `compat.forceAdaptiveThinking` 里。
 * `/v1/models` 只给 id，不给这些元数据；手填时也没人会知道要填它，结果是随机的 400。
 *
 * 成本刻意不继承（置 0）：中转价格与官方价不同，套官方价会误导。
 *
 * ## 故意**不继承**的一项：supportsMidConvoEffort
 *
 * 这个标记会让 pi 在请求头里带上两个 beta（`mid-conversation-output-config-*`、
 * `thinking-binding-controls-*`）。官方 Anthropic 认；中转**不认**，而且报的是
 * 一句没有细节的 `Invalid request` —— 实测（2026-11-02）：某中转服务上的
 * claude-opus-5-5 继承了它之后，任何一轮对话都 400，而同一个请求去掉这个头就 200。
 *
 * 「我们的中转吃不吃官方 beta」无法从 `/v1/models` 预知，猜错的代价是「这个模型直接用不了」
 * 而不是「少了一个优化」。所以对中转一律不继承；需要时再按 provider 单独放开。
 */
const MID_CONVO_ONLY_KEYS = ["supportsMidConvoEffort"] as const;

/** 去掉中转不该继承的 compat 项。 */
function compatForRelay(
  compat: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (compat === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(compat))
    if (!(MID_CONVO_ONLY_KEYS as readonly string[]).includes(k)) out[k] = v;
  return out;
}

export function resolveCustomModel(
  runtime: ModelRuntime,
  api: CustomApi,
  modelId: string,
): ResolvedCustomModel {
  const match = runtime
    .getModels()
    .find((m) => m.id === modelId && m.api === api);
  const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (match) {
    const compat = compatForRelay(match.compat);
    return {
      definition: {
        id: match.id,
        name: match.name,
        api: match.api,
        input: [...match.input],
        cost: zeroCost,
        reasoning: match.reasoning,
        contextWindow: match.contextWindow,
        maxTokens: match.maxTokens,
        ...(compat === undefined ? {} : { compat }),
        ...(match.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: match.thinkingLevelMap }),
      },
      inheritedFrom: `${match.provider}/${match.id}`,
    };
  }
  // 目录里没有的模型：保守的兜底值。reasoning 置 true 让思考强度可调，
  // 不支持思考的模型由 pi 在请求时按 off 处理。
  return {
    definition: {
      id: modelId,
      name: modelId,
      api,
      input: ["text"],
      cost: zeroCost,
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 8_192,
    },
    inheritedFrom: null,
  };
}

export interface ModelSetup {
  runtime: ModelRuntime;
  /** 可用模型 = 所有已接入（有 key）的 provider 的模型并集。pi 的 /model 列的就是它。 */
  available: PiModel[];
  /** 中转模型 "provider/id" → 元数据继承自的内置模型。 */
  inherited: Map<string, string>;
}

export const modelKey = (provider: string, id: string): string =>
  `${provider}/${id}`;

/**
 * 按配置装好**一个**模型运行时，里面是全部已接入的 provider：
 * - pi 内置 provider：有 key 就注入（运行时注入，不落 pi 的 auth.json）。
 * - 自定义中转：注册成 provider，模型清单逐个按内置目录继承元数据。没 key 的跳过。
 */
export async function createModelSetup(
  paths: PiPaths,
  config: ProvidersConfig,
  keys: ReadonlyMap<string, string>,
): Promise<ModelSetup> {
  const runtime = await emptyRuntime(paths);
  const customIds = new Set(config.custom.map((c) => c.id));
  const configured = new Set<string>();
  const inherited = new Map<string, string>();

  // 先解析全部中转模型再注册：解析要对照内置目录，不能让刚注册的中转模型匹配到自己。
  const customDefs = config.custom.map((c) => ({
    provider: c,
    models: c.models.map((id) => resolveCustomModel(runtime, c.api, id)),
  }));

  for (const providerId of keys.keys()) {
    if (customIds.has(providerId) || !runtime.getProvider(providerId)) continue;
    await runtime.setRuntimeApiKey(providerId, keys.get(providerId) ?? "");
    configured.add(providerId);
  }
  for (const { provider, models } of customDefs) {
    const apiKey = keys.get(provider.id);
    if (!apiKey) continue;
    runtime.registerProvider(provider.id, {
      name: provider.id,
      baseUrl: provider.baseUrl,
      api: provider.api,
      apiKey,
      models: models.map((m) => m.definition as never),
    });
    for (const m of models) {
      if (m.inheritedFrom)
        inherited.set(modelKey(provider.id, m.definition.id), m.inheritedFrom);
    }
    configured.add(provider.id);
  }

  const available = runtime
    .getModels()
    .filter((m) => configured.has(m.provider));
  return { runtime, available, inherited };
}

/** 在可用模型里找一个。找不到返回 undefined（provider 被移除、模型下线……）。 */
export function findModel(
  setup: ModelSetup,
  ref: ModelRef | null | undefined,
): PiModel | undefined {
  if (!ref) return undefined;
  return setup.available.find(
    (m) => m.provider === ref.provider && m.id === ref.modelId,
  );
}

/**
 * 会话 transcript 里记着的选择：当前分支上最后一次 model_change / thinking_level_change。
 *
 * 不靠 pi 的自动恢复：pi 只在「已有消息」时才恢复模型，而在新会话里发第一句话之前
 * 就切了模型，这个选择同样要生效。
 */
export function transcriptSelection(
  paths: PiPaths,
  header: unknown,
  entries: readonly unknown[],
): {
  model: ModelRef | undefined;
  thinking: ThinkingLevel | undefined;
  hasMessages: boolean;
} {
  if (entries.length === 0)
    return { model: undefined, thinking: undefined, hasMessages: false };
  const branch = SessionManager.inMemory(paths.cwd, undefined, [
    header,
    ...entries,
  ] as never).getBranch();
  let model: ModelRef | undefined;
  let thinking: ThinkingLevel | undefined;
  let hasMessages = false;
  for (const e of branch) {
    if (e.type === "model_change")
      model = { provider: e.provider, modelId: e.modelId };
    else if (e.type === "thinking_level_change")
      thinking = e.thinkingLevel as ThinkingLevel;
    else if (e.type === "message") hasMessages = true;
  }
  return { model, thinking, hasMessages };
}

/** 新会话头。id 即本服务的会话 id（pi 以会话头 id 为会话 id）。 */
export function newSessionHeader(paths: PiPaths, id?: string): unknown {
  return SessionManager.inMemory(
    paths.cwd,
    id === undefined ? undefined : { id },
  ).getHeader();
}

export interface OpenSessionOptions {
  paths: PiPaths;
  runtime: ModelRuntime;
  model: PiModel;
  thinkingLevel: ThinkingLevel;
  /** pi 会话头原文。 */
  header: unknown;
  /** 条目原文，按到达序。 */
  entries: readonly unknown[];
  systemPrompt?: string;
  /**
   * 这条会话额外开放的工具（如售前助手的「读清单 / 发起审阅 / 起草」）。
   * 只加不减：`skill` 工具总在；内置的 read / bash / edit / write 仍一个都不开。
   */
  extraTools?: readonly ToolDefinition[];
  /**
   * 每轮现场追加在系统提示词末尾的一段（如智能体团队花名册）。
   * 与技能清单同一机制：定义改了，下一轮就生效，不必等会话被回收。
   */
  promptExtra?: () => string;
}

export interface OpenedSession {
  session: AgentSession;
  sessionManager: SessionManager;
  dispose: () => void;
}

/**
 * 打开（或恢复）一个会话。
 *
 * **原样恢复**：会话头 + 条目原文整段交回 `SessionManager.inMemory`，id、parentId、
 * context_edit、压缩都由 pi 自己解释。
 *
 * 资源自动发现全部关闭：扩展、上下文文件、提示词模板、主题都不加载，机器上任何
 * pi 配置都影响不到这个服务。skill 也不走 pi 的发现（noSkills），而是由本服务的
 * skill 库显式提供——每轮现场扫一次，所以技能页改完下一轮即生效（见 pi/skills.ts）。
 * 工具只有一个 `skill`：它只能读 skill 库里的文件，拿不到机器上别的东西。
 */
export async function openAgentSession(
  options: OpenSessionOptions,
): Promise<OpenedSession> {
  const { paths } = options;
  const basePrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  /** 每轮重算：skill 库随时在变，提示词不能定格在开会话那一刻。 */
  const composePrompt = (): string => {
    const skills = skillsPromptSection(paths.skillsDir);
    const extra = options.promptExtra?.() ?? "";
    return [basePrompt, skills, extra].filter((s) => s !== "").join("\n");
  };
  const systemPrompt = composePrompt();
  const settingsManager = SettingsManager.create(paths.cwd, paths.agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt,
    /**
     * 系统提示词**整段**替换。只给 `systemPrompt` 时 pi 会把它当前缀，后面还拼上
     * `<cwd>` 等段落——一个文件系统路径足以让模型自认「软件工程智能体」（实测）。
     * pi 的整段替换只开放给 before_agent_start 钩子，所以用一个内联扩展来做；
     * 内联扩展不受 noExtensions 影响，也不读任何磁盘上的扩展。
     */
    extensionFactories: [
      {
        name: "chat-system-prompt",
        factory: (pi) => {
          pi.on("before_agent_start", () => ({
            systemPrompt: composePrompt(),
          }));
        },
      },
    ],
  });
  await resourceLoader.reload();

  const sessionManager = SessionManager.inMemory(paths.cwd, undefined, [
    options.header,
    ...options.entries,
  ] as never);

  const { session } = await createAgentSession({
    cwd: paths.cwd,
    agentDir: paths.agentDir,
    modelRuntime: options.runtime,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    // 白名单只放 skill：内置的 read / bash / edit / write 一个都不开。
    noTools: "all",
    tools: [SKILL_TOOL_NAME, ...(options.extraTools ?? []).map((t) => t.name)],
    customTools: [
      createSkillTool(paths.skillsDir),
      ...(options.extraTools ?? []),
    ],
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  return {
    session,
    sessionManager,
    dispose: () => {
      session.dispose();
    },
  };
}
