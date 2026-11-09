import { createHash } from "node:crypto";

import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";

import { HttpError, badRequest, notFound } from "./errors.js";
import type { Db } from "./db.js";
import {
  customApis,
  customProviderSchema,
  modelRefSchema,
  providerIdSchema,
  readProvidersConfig,
  thinkingLevels,
  writeProvidersConfig,
  type KeyStore,
} from "./model-config.js";
import {
  AGENT_TARGETS,
  assertValidAgentName,
  type AgentStore,
  type AgentTarget,
} from "./agents.js";
import { registerFileRoutes } from "./files/routes.js";
import type { FileStore } from "./files/store.js";
import { registerProductRoutes } from "./product-routes.js";
import { registerPresalesRoutes } from "./presales-routes.js";
import { registerPresalesTemplateRoutes } from "./presales-template-routes.js";
import { createPresalesTemplates } from "./presales-templates.js";
import { registerCodeRepoRoutes } from "./code-repos.js";
import { registerGlobalFill, type FillDraftOps } from "./global-fill.js";
import { registerForge, type Forge } from "./forge.js";
import { mergeBriefs } from "./intel/brief.js";
import { registerIntel } from "./intel/routes.js";
import { createIntelStore } from "./intel/store.js";
import { createDraftStore } from "./staging/drafts.js";
import { registerStagingRoutes } from "./staging/routes.js";
import { registerPresalesReview } from "./presales-review.js";
import { registerPresalesAgent, type PresalesAgent } from "./presales-agent.js";
import { registerLifecycleRoutes } from "./lifecycle-routes.js";
import { registerWikiRoutes } from "./wiki-routes.js";
import { createLinearClient, registerWorkItemRoutes } from "./work-items.js";
import { registerAnalysisRoutes } from "./analysis/routes.js";
import { INTERNAL_HEADER, registerAuth } from "./auth.js";
import { outboundProblem } from "./net-guard.js";
import { registerSecurity } from "./security.js";
import { createSessionStore, type SessionRow } from "./sessions.js";
import { createCatalog } from "./products.js";
import { createEvidenceService } from "./evidence/index.js";
import { registerSchemaRoutes } from "./evidence/schema/routes.js";
import { registerUiRoutes } from "./evidence/ui/routes.js";
import { createEnvStore } from "./evidence/live/envs.js";
import { registerEnvRoutes } from "./evidence/live/routes.js";
import {
  createBrowseService,
  type BrowseService,
} from "./evidence/live/tools.js";
import { createSnapshotStore } from "./evidence/live/snapshots.js";
import type { BrowserDeps } from "./evidence/live/browser.js";
import {
  registerSnapshotRoutes,
  type SnapshotService,
} from "./evidence/live/snapshot-routes.js";
import { DEFAULT_SYSTEM_PROMPT } from "./pi/runtime.js";
import {
  SKILL_TARGETS,
  assertValidName,
  type SkillStore,
  type SkillTarget,
} from "./skills.js";
import { historyToUiMessages, runningHistory } from "./pi/history.js";
import { createRunStore } from "./agent-team/runs.js";
import { createTeam, type Team } from "./agent-team/team.js";
import { createToolRegistry } from "./agent-team/tools.js";
import { probeModels } from "./pi/probe-models.js";
import {
  DEFAULT_TITLE,
  createRunner,
  type ModelProvision,
  type Runner,
} from "./pi/runner.js";
import {
  createModelSetup,
  findModel,
  listBuiltinProviders,
  modelKey,
  newSessionHeader,
  type PiModel,
  type PiPaths,
} from "./pi/runtime.js";
import { SSE_DONE, UI_STREAM_HEADERS, errorChunk, sse } from "./pi/stream.js";
import type { UIMessageChunk } from "ai";

export interface AppDeps {
  db: Db;
  paths: PiPaths;
  keys: KeyStore;
  /** 技能库。文件系统就是真相源，对话侧读的是同一份目录。 */
  skills: SkillStore;
  /**
   * 执行体库（一级菜单「执行体」）。不传则不注册这组接口——
   * 只测对话 / 产品的用例不必为它准备目录；正式入口（main.ts）一定会传。
   */
  agents?: AgentStore;
  /** 技能清单在每轮系统提示词里占多少字节（server/pi/skills.ts 的 promptCost）。 */
  skillsPromptBytes?: () => number;
  /** 安全校验参数；传 false 关闭（仅限 inject 测试）。 */
  security:
    | {
        port: number;
        webPort: number;
        extraOrigins: string[];
        /** 显式绑定的地址，也算合法 Host（局域网部署）。 */
        bindHost?: string;
      }
    | false;
  /**
   * 登录闸（auth.ts）。默认开；只有测试为了不在每个用例里先登录才传 false。
   * 正式入口（main.ts）不传这一项，所以不会被误关。
   */
  auth?: boolean;
  /** 测试注入：替换真实的模型装配（比如换成 faux）。 */
  provision?: () => Promise<ModelProvision>;
  /** 测试注入：全局补齐驱动对话用的运行器（默认就是真的对话运行器）。 */
  fillRunner?: Parameters<typeof registerGlobalFill>[1]["runner"];
  /** 测试注入：拉取模型清单时用的 fetch。 */
  probeFetch?: typeof fetch;
  /** 测试注入：智能体联网搜索用的 fetch。 */
  teamFetch?: typeof fetch;
  /** 测试注入：智能体团队的预算（超时、轮数、并发）。 */
  teamLimits?: Partial<import("./agent-team/team.js").TeamLimits>;
  /**
   * 文件模块（一级菜单「文件」）的存储。不传则不注册文件接口——
   * 只测对话 / 产品的用例不必为它准备目录。正式入口（main.ts）一定会传。
   */
  files?: FileStore;
  /**
   * 只读浏览工具（AI 看测试环境的真实页面，见 browse/）。传数据目录才开启：
   * 账号密码要落在那下面的 envs/。测试可连浏览器一起换掉。
   */
  browse?: { dataDir: string; browser?: BrowserDeps };
  /**
   * 外部系统（Linear 等）的凭证库。与模型 Key 分开存：放进 `keys` 会被当成模型服务商列出来。
   * 不传则「任务与需求」只能手记，连接外部系统的接口回 501。
   */
  integrationKeys?: KeyStore;
  /** 测试注入：访问 Linear 用的 fetch。 */
  linearFetch?: typeof fetch;
  /** 测试注入：时钟（产品模块的 createdAt / updatedAt 用）。 */
  now?: () => number;
  /** pi 版本与升级的路由（C4）。分开注册，便于单测各自隔离。 */
  registerPiRoutes?: (app: FastifyInstance, ctx: { runner: Runner }) => void;
  logger?: boolean;
}

const messageBody = z.object({
  message: z.string().trim().min(1).max(100_000),
});
const titleBody = z.object({ title: z.string().trim().min(1).max(200) });
const createSessionBody = z.object({
  productId: z.string().trim().min(1).optional(),
  /** 手选的依据范围（文件库路径，须在依据库内）。 */
  evidenceScope: z.array(z.string().trim().min(1).max(4096)).max(50).optional(),
});
const evidenceScopeBody = z.object({
  scope: z.array(z.string().trim().min(1).max(4096)).max(50),
});
const keyBody = z.object({ key: z.string().trim().min(1).max(1000) });
const thinkingBody = z.object({ level: z.enum(thinkingLevels) });
const defaultsBody = z.object({
  defaultModel: modelRefSchema.nullable(),
  defaultThinking: z.enum(thinkingLevels),
});
/*
 * `baseUrl` 由用户填，而服务端会带着**真实 key** 去请求它：填成云元数据地址或内网地址时，
 * key 就跟着外泄了。schema 里拦一道，本地推理服务（Ollama 等）显式勾选 `allowLocal` 放行。
 */
const customUpsertBody = z.object({
  /** 勾了「允许本机地址」时用宽松校验：本地推理服务常跑在 127.0.0.1。 */
  allowLocal: z.boolean().optional(),
  baseUrl: z.url().max(500),
  api: z.enum(customApis),
  models: z
    .array(z.string().trim().min(1).max(200))
    .min(1, "至少要有一个模型")
    .max(500),
  key: z.string().trim().min(1).max(1000).optional(),
});
const probeBody = z.object({
  allowLocal: z.boolean().optional(),
  baseUrl: z.url().max(500),
  api: z.enum(customApis),
  /** 用哪把已保存的 key（没传 key 时）。 */
  providerId: z.string().trim().min(1).max(64),
  /** 刚填、还没保存的 key：先拉清单再保存是顺序流，不必先存 key。 */
  key: z.string().trim().min(1).max(1000).optional(),
});
const skillBody = z.object({
  content: z
    .string()
    .min(1)
    .max(512 * 1024),
});
const skillZipBody = z.object({ zip: z.string().min(1) });
const skillTreeBody = z.object({
  files: z
    .array(
      z.object({
        /** 相对技能根的路径。绝对路径与 .. 由服务端再挡一次，不信前端。 */
        path: z.string().min(1).max(400),
        base64: z.string(),
      }),
    )
    .min(1)
    .max(500),
});
const skillVisibilityBody = z.object({ hidden: z.boolean() });
const agentBody = z.object({
  content: z
    .string()
    .min(1)
    .max(512 * 1024),
});
const agentDistributionBody = z.object({
  /** 期望的分发集合：列内的建软链，没列的摘掉。 */
  targets: z.array(z.enum(AGENT_TARGETS)),
});
const skillDistributionBody = z.object({
  /** 期望的分发集合：列内的建软链，没列的摘掉。 */
  targets: z.array(z.enum(SKILL_TARGETS)),
});
/** zip 过 base64 比原体大 1/3，fastify 默认的 1 MiB 远不够。 */
const SKILL_IMPORT_BODY_LIMIT = 28 * 1024 * 1024;

/**
 * fastify 自己的请求层错误（空 JSON body、body 超限……）带着 4xx 状态码。
 * 不认它就会把「你的请求不对」报成 500「服务内部错误」，排障时往错的方向找。
 */
function clientError(
  error: unknown,
): { status: number; code: string; message: string } | null {
  if (typeof error !== "object" || error === null) return null;
  const { statusCode, code } = error as {
    statusCode?: unknown;
    code?: unknown;
  };
  if (typeof statusCode !== "number" || statusCode < 400 || statusCode >= 500) {
    return null;
  }
  return {
    status: statusCode,
    code: typeof code === "string" ? code : "BAD_REQUEST",
    message: error instanceof Error ? error.message : "请求不合法",
  };
}

export function createApp(deps: AppDeps): {
  app: FastifyInstance;
  runner: Runner;
  /** 售前助手（测试要直接取它的身份与工具）。 */
  presalesAgent: PresalesAgent;
  /** AI 工坊（测试要直接取它的工具）。 */
  forge: Forge;
} {
  /*
   * forceCloseConnections：服务关闭时主动断开长连接。
   *
   * 对话、升级、克隆这些接口是把响应 hijack 给应用自己写的 SSE。只要有一条还在跑，
   * `app.close()` 就会一直等它结束，后面的 db.close()、process.exit() 全被卡住，
   * 端口不释放，supervisor 只能干等或强杀（强杀可能丢掉正在写库的收尾）。
   * 实测：默认值下「回答进行中收到 SIGTERM」4 秒仍未关闭，打开后 2 毫秒关完。
   */
  const app = Fastify({
    logger: deps.logger ?? false,
    forceCloseConnections: true,
  });
  const store = createSessionStore(deps.db);

  if (deps.security !== false) registerSecurity(app, deps.security);
  // 登录闸紧跟在 Host / Origin 闸后面：先挡跨站，再认人。
  const auth =
    deps.auth === false ? null : registerAuth(app, deps.db, deps.now);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) {
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof z.ZodError) {
      return reply.code(400).send({
        error: {
          code: "BAD_REQUEST",
          message: error.issues[0]?.message ?? "参数不合法",
        },
      });
    }
    // fastify 自己的请求层错误：原样回 4xx，不当成服务故障。
    const client = clientError(error);
    if (client) {
      return reply
        .code(client.status)
        .send({ error: { code: client.code, message: client.message } });
    }
    app.log.error(error);
    return reply
      .code(500)
      .send({ error: { code: "INTERNAL", message: "服务内部错误" } });
  });

  /* ── 产品模块（一级菜单「产品」，与对话互不依赖）────────────────────── */

  registerProductRoutes(app, deps.db, deps.now, async (productId) => {
    // 测试环境的账号密码是明文文件，数据库级联删不掉它。
    if (deps.browse === undefined) return;
    const envs = createEnvStore(deps.db, deps.browse.dataDir, deps.now);
    for (const env of await Promise.resolve(envs.list(productId)))
      await envs.remove(env.id);
  });
  registerLifecycleRoutes(app, deps.db, deps.now);
  // 售前模板：出厂模板是种子，之后可改可复制。库绑模板来铺材料。
  const presalesTemplates = createPresalesTemplates(deps.db, deps.now);
  presalesTemplates.seedBuiltins();
  registerPresalesTemplateRoutes(app, presalesTemplates);
  // 售前助手：每本库一个常驻 agent + 规则巡检（见 presales-agent.ts）。
  // 它的工具走本服务自己的接口，所以 Host 要用安全检查认的那个。
  const presalesAgent = registerPresalesAgent(app, {
    db: deps.db,
    store,
    newHeader: () => newSessionHeader(deps.paths),
    selfHost:
      deps.security === false
        ? "localhost"
        : `127.0.0.1:${String(deps.security.port)}`,
    // 工具调自己的接口要过登录闸：带上本进程的内部凭证。
    selfHeaders: auth === null ? {} : { [INTERNAL_HEADER]: auth.internalToken },
    ...(deps.now ? { now: deps.now } : {}),
  });
  registerPresalesRoutes(
    app,
    deps.db,
    deps.files,
    deps.now,
    { store, newHeader: () => newSessionHeader(deps.paths) },
    presalesTemplates,
    {
      onUploaded: (slotId) => {
        presalesAgent.onUploaded(slotId);
      },
    },
  );
  registerWikiRoutes(app, deps.db);
  // 任务与需求：手记的用户需求 + 内部任务（可从 Linear 导入），都能一键开对话。
  registerWorkItemRoutes(app, {
    db: deps.db,
    sessions: store,
    newHeader: () => newSessionHeader(deps.paths),
    ...(deps.integrationKeys ? { keys: deps.integrationKeys } : {}),
    ...(deps.linearFetch
      ? { linear: createLinearClient(deps.linearFetch) }
      : {}),
    ...(deps.now ? { now: deps.now } : {}),
  });
  if (deps.files) {
    registerFileRoutes(app, deps.files);
    registerCodeRepoRoutes(app, deps.db, deps.files, deps.now);
  }
  // AI 分析（识别产线与产品、比对产出物）。它不自己做流式：建好会话与提示词后
  // 交回前端，由现成的 /api/sessions/:id/chat 发出去——用户因此能看着它跑、还能追问。
  registerAnalysisRoutes(
    app,
    deps.db,
    {
      store,
      ...(deps.files ? { files: deps.files } : {}),
      newHeader: () => newSessionHeader(deps.paths),
    },
    deps.now,
  );

  /* ── 模型装配 ───────────────────────────────────────────────────────── */

  let cached: ModelProvision | undefined;
  /** 配置或 key 变了：丢掉缓存。活着的会话在下次使用时按新配置重开（见 runner.open）。 */
  const invalidate = (): void => {
    cached = undefined;
  };
  const provision =
    deps.provision ??
    (async (): Promise<ModelProvision> => {
      const config = readProvidersConfig(deps.db);
      const keys = new Map<string, string>();
      for (const id of await deps.keys.list()) {
        const { value } = await deps.keys.get(id);
        if (value) keys.set(id, value);
      }
      if (keys.size === 0)
        throw badRequest("还没有接入任何模型，去设置里添加一个 provider");
      // 指纹含 key 的哈希而不是 key 本身：它只用来判断「变没变」。
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(config))
        .update(JSON.stringify([...keys]))
        .digest("hex");
      if (cached?.key === fingerprint) return cached;
      const setup = await createModelSetup(deps.paths, config, keys);
      if (setup.available.length === 0) {
        throw badRequest("已填 key 的 provider 里没有可用模型，去设置里检查");
      }
      cached = {
        key: fingerprint,
        setup,
        defaultModel:
          findModel(setup, config.defaultModel) ?? setup.available[0],
        defaultThinking: config.defaultThinking,
      };
      return cached;
    });

  /**
   * 事实依据服务。
   *
   * 所有对话都经 runner 接入它；没有文件库（测试或精简部署）时留空——那样
   * 依据段不会注入，其余行为不变。
   */
  let browse: BrowseService | undefined;
  let snapshots: SnapshotService | undefined;
  const evidence =
    deps.files === undefined
      ? undefined
      : createEvidenceService({
          files: deps.files,
          catalog: createCatalog(deps.db, deps.now),
          ...(deps.now === undefined ? {} : { now: deps.now }),
        });
  // 产品 → 数据结构（ER 图）/ 页面（前端视角）：与交给 AI 的是同一份解析结果。
  if (evidence !== undefined) {
    const catalog = createCatalog(deps.db, deps.now);
    registerSchemaRoutes(app, { catalog, schema: evidence.schema });
    registerUiRoutes(app, { catalog, ui: evidence.ui });
    if (deps.browse !== undefined && deps.files !== undefined) {
      const envs = createEnvStore(deps.db, deps.browse.dataDir, deps.now);
      registerEnvRoutes(app, {
        catalog,
        envs,
        dataDir: deps.browse.dataDir,
        ...(deps.browse.browser === undefined
          ? {}
          : { browser: deps.browse.browser }),
      });
      browse = createBrowseService({
        envs,
        catalog,
        files: deps.files,
        ui: evidence.ui,
        browser: {
          dataDir: deps.browse.dataDir,
          ...(deps.browse.browser ?? {}),
        },
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
      snapshots = createSnapshotStore({
        files: deps.files,
        catalog,
        ui: evidence.ui,
        envs,
        browser: {
          dataDir: deps.browse.dataDir,
          ...(deps.browse.browser ?? {}),
        },
        ...(deps.now === undefined ? {} : { now: deps.now }),
      });
      registerSnapshotRoutes(app, { catalog, snapshots, envs });
      app.addHook("onClose", async () => {
        await browse?.closeAll();
      });
    }
  }

  /*
   * 智能体团队：普通对话的协调者身上挂 delegate，
   * 每轮现场拼团队花名册。带 task 的后台对话（补齐、审阅、售前助手）不派活。
   */
  const agentRuns = createRunStore(deps.db, deps.now);
  agentRuns.sweepOrphans();
  // 临时区的草稿登记（对话「存到临时区」、智能体 draft_write 共用）。
  const stagingDrafts = deps.files
    ? createDraftStore(deps.db, deps.files, deps.now)
    : undefined;
  // 联网借模型接口自带搜索：只认 anthropic-messages 协议（见 agent-team/web-search.ts）。
  const webTarget = async (model: PiModel) => {
    const m = model as { api?: string; baseUrl?: string };
    if (m.api !== "anthropic-messages" || !m.baseUrl) return null;
    const { value } = await deps.keys
      .get(model.provider)
      .catch(() => ({ value: null }));
    return value
      ? { baseUrl: m.baseUrl, apiKey: value, modelId: model.id }
      : null;
  };
  // 市场情报：外部参考资料，不是准则也不是事实依据。
  const intelStore = createIntelStore(deps.db, deps.now);
  const toolRegistry = createToolRegistry({
    db: deps.db,
    files: deps.files,
    evidence,
    drafts: stagingDrafts,
    intel: intelStore,
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.teamFetch ? { fetchImpl: deps.teamFetch } : {}),
  });
  const team: Team = createTeam({
    paths: deps.paths,
    registry: toolRegistry,
    runs: agentRuns,
    provision,
    ...(deps.teamLimits ? { limits: deps.teamLimits } : {}),
    webTarget,
  });

  const intel = registerIntel(app, {
    store: intelStore,
    sessions: store,
    newHeader: () => newSessionHeader(deps.paths),
    productName: (id) =>
      deps.db
        .prepare<[string], { name: string }>(
          "SELECT name FROM products WHERE id = ?",
        )
        .get(id)?.name ?? null,
    // 调研助手的联网：借智能体团队的 web_search。按默认模型判断能不能联网
    // （会话中途切了模型也照默认模型的接口走——联网只认 anthropic-messages 协议）。
    webSearch: () =>
      toolRegistry.get("web_search")?.build({
        productId: null,
        agentName: "intel-research",
        runId: "intel-research",
        webTarget: async () => {
          const p = await provision();
          const m = p.defaultModel ?? p.setup.available[0];
          return m === undefined ? null : webTarget(m);
        },
      }),
  });

  // AI 工坊：AI 新建 / 修改 / 从历史沉淀技能与智能体，草稿人确认后才进库（见 forge.ts）。
  const forge = registerForge(app, {
    db: deps.db,
    store,
    skills: deps.skills,
    agents: deps.agents,
    newHeader: () => newSessionHeader(deps.paths),
    toolCatalog: () =>
      [...toolRegistry.values()].map((t) => ({
        name: t.name,
        label: t.label,
        level: t.level,
        summary: t.summary,
      })),
    cwd: deps.paths.cwd,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const runner = createRunner({
    onTurn: (sessionId) => {
      browse?.newTurn(sessionId);
    },
    store,
    paths: deps.paths,
    provision,
    /*
     * 售前助手有自己的整段提示词与工具。其余对话：
     * - 只读浏览（真实页面）：产品绑定了测试环境就挂（原逻辑不变，后台任务也挂）；
     * - 智能体团队：只挂在普通对话（无 task）上——后台补齐/审阅不派活。
     */
    profile: (session) => {
      const own =
        presalesAgent.profile(session) ??
        forge.profile(session) ??
        intel.profile(session);
      if (own !== undefined) return own;
      const b = browse?.profile(session);
      const delegate = session.task
        ? []
        : [
            team.delegateTool({
              sessionId: session.id,
              productId: session.productId,
              depth: 0,
              parentRunId: null,
            }),
          ];
      if (b === undefined && delegate.length === 0) return undefined;
      return {
        ...(b === undefined
          ? {}
          : { systemPrompt: `${DEFAULT_SYSTEM_PROMPT}\n${b.prompt}` }),
        tools: [...(b?.tools ?? []), ...delegate],
        ...(delegate.length === 0
          ? {}
          : { promptExtra: () => team.rosterPrompt() }),
      };
    },
    /*
     * 每轮附上的资料：事实依据（我们自己的产品）+ 参考情报（外部世界）。
     * 情报要先算：它看 state.first 判断是不是首轮，依据那边会把它置成 false。
     */
    evidence: {
      brief: async (session, message, state) => {
        const extra = intel.brief(session, message, state);
        const facts =
          evidence === undefined
            ? null
            : await evidence.brief(
                {
                  productId: session.productId,
                  scope: session.evidenceScope,
                },
                message,
                state,
              );
        return mergeBriefs(facts, extra);
      },
    },
  });

  // 售前材料 AI 审阅 / 体系复盘：同样由服务端驱动对话（提示词常超过对话接口的单条上限）。
  if (deps.files)
    registerPresalesReview(app, {
      db: deps.db,
      files: deps.files,
      store,
      runner: deps.fillRunner ?? runner,
      newHeader: () => newSessionHeader(deps.paths),
      templates: presalesTemplates,
      ...(evidence === undefined ? {} : { evidence }),
      ...(deps.now ? { now: deps.now } : {}),
    });

  // 全局 AI 补齐：服务端自己排队驱动一批分析对话，产出只进临时区（见 global-fill.ts）。
  const fillDrafts: FillDraftOps | undefined = deps.files
    ? registerGlobalFill(app, {
        db: deps.db,
        files: deps.files,
        store,
        runner: deps.fillRunner ?? runner,
        newHeader: () => newSessionHeader(deps.paths),
        ...(deps.now ? { now: deps.now } : {}),
      })
    : undefined;

  // 临时区：所有待确认的 AI 产出一处看、一套动作。
  if (deps.files && stagingDrafts)
    registerStagingRoutes(app, {
      db: deps.db,
      files: deps.files,
      store,
      drafts: stagingDrafts,
      fill: fillDrafts,
      ...(deps.now ? { now: deps.now } : {}),
    });

  /* ── 会话 ───────────────────────────────────────────────────────────── */

  const sessionOr404 = (id: string) => {
    const row = store.get(id);
    if (!row) throw notFound("会话不存在");
    return row;
  };
  const dto = (row: SessionRow) => ({
    ...row,
    streaming: runner.activeRun(row.id) !== undefined,
  });

  app.get("/api/health", () => ({ status: "ok" }));

  app.get("/api/sessions", () => ({ sessions: store.list().map(dto) }));

  /**
   * 新建对话。
   *
   * `productId` 决定这段对话的事实依据库（平台规范）。从产品页开出来的对话都
   * 会带上它；不带就是普通对话，不注入依据。
   */
  app.post("/api/sessions", (request, reply) => {
    const body = createSessionBody.parse(request.body ?? {});
    const header = newSessionHeader(deps.paths) as { id: string };
    const row = store.create({
      id: header.id,
      title: DEFAULT_TITLE,
      header,
      productId: body.productId ?? null,
      ...(body.evidenceScope === undefined
        ? {}
        : { evidenceScope: body.evidenceScope }),
    });
    return reply.code(201).send(dto(row));
  });

  /**
   * 这段对话的依据库与当前范围（输入框上方「依据范围」选择器的数据源）。
   *
   * 每次现算：产品绑定的目录随时会变，存快照会让选择器列出已经解绑的路径。
   */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/evidence",
    (request) => {
      const row = sessionOr404(request.params.id);
      if (evidence === undefined)
        return { productName: null, sources: [], scope: [], missing: [] };
      const lib = evidence.library({
        productId: row.productId,
        scope: row.evidenceScope,
      });
      const full = evidence.library({ productId: row.productId });
      return {
        productName: lib.productName,
        sources: full.sources.map((s) => ({
          path: s.path,
          label: s.label,
          kind: s.kind,
        })),
        scope: row.evidenceScope,
        missing: full.missing,
      };
    },
  );

  /**
   * 改依据范围，从下一条消息起生效。
   *
   * 只收依据库内的路径：范围的语义是「缩小」，允许指向库外等于凭空扩权。
   */
  app.put<{ Params: { id: string } }>(
    "/api/sessions/:id/evidence-scope",
    (request) => {
      const row = sessionOr404(request.params.id);
      const { scope } = evidenceScopeBody.parse(request.body);
      if (evidence === undefined) return { scope: [] };
      const lib = evidence.library({ productId: row.productId });
      const inside = scope.filter((p) =>
        lib.sources.some(
          (s) =>
            p === s.path ||
            p.startsWith(`${s.path}/`) ||
            s.path.startsWith(`${p}/`),
        ),
      );
      return {
        scope: store.setEvidenceScope(row.id, inside)?.evidenceScope ?? [],
      };
    },
  );

  app.patch<{ Params: { id: string } }>("/api/sessions/:id", (request) => {
    sessionOr404(request.params.id);
    const { title } = titleBody.parse(request.body);
    const row = store.rename(request.params.id, title);
    if (!row) throw notFound("会话不存在");
    return dto(row);
  });

  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id",
    (request, reply) => {
      const id = request.params.id;
      sessionOr404(id);
      // 删一个正在跑的会话：先停 pi 再释放，免得它在后台继续花 key、往已删的会话落库。
      runner.abort(id);
      runner.dispose(id);
      store.remove(id);
      return reply.code(204).send();
    },
  );

  /**
   * 历史（useChat 的初始消息）。有一轮在跑时按开轮水位截断并补回本轮问题，
   * 前端据 streaming 决定续流（见 pi/history.ts 的 runningHistory）。
   */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/messages",
    (request) => {
      const id = request.params.id;
      sessionOr404(id);
      const header = store.header(id);
      const entries = store.entries(id);
      const run = runner.activeRun(id);
      return {
        messages:
          run === undefined
            ? historyToUiMessages(deps.paths.cwd, header, entries)
            : runningHistory(deps.paths.cwd, header, entries, {
                ...run,
                sessionId: id,
              }),
        streaming: run !== undefined,
      };
    },
  );

  /** 打开一条 UI Message Stream 响应。断开只会触发 signal，不中断 agent。 */
  const openStream = (reply: FastifyReply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, UI_STREAM_HEADERS);
    const controller = new AbortController();
    raw.on("close", () => {
      controller.abort();
    });
    return {
      signal: controller.signal,
      write: (chunk: UIMessageChunk) => {
        if (!raw.writableEnded) raw.write(sse(chunk));
      },
      end: () => {
        if (!raw.writableEnded) {
          raw.write(SSE_DONE);
          raw.end();
        }
      },
    };
  };

  /**
   * 发一条消息。请求体只要那句话：历史的真相源在服务端，前端不该把整段
   * messages 传回来（那会制造「两份历史谁说了算」）。
   */
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/chat",
    async (request, reply) => {
      const id = request.params.id;
      sessionOr404(id);
      const { message } = messageBody.parse(request.body);
      const stream = openStream(reply);
      // 放对象里：回调里改的值，TS 的流分析看不见，会误判成常量。
      const state = { wrote: false };
      try {
        await runner.chat({
          sessionId: id,
          message,
          onChunk: (chunk) => {
            state.wrote = true;
            stream.write(chunk);
          },
          signal: stream.signal,
        });
      } catch (cause) {
        // 起会话前就失败（没配模型、没填 key……）：作为一条失败的回答返回，
        // 前端就地显示原因，而不是一个看不懂的网络错误。
        const text = cause instanceof Error ? cause.message : "对话失败";
        if (!state.wrote) stream.write({ type: "start" });
        stream.write(errorChunk("setup-error", text));
        stream.write({ type: "finish", finishReason: "error" });
      } finally {
        stream.end();
      }
    },
  );

  /** 断线续流。协议约定没有活跃流时回 204。 */
  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id/chat/stream",
    async (request, reply) => {
      const id = request.params.id;
      sessionOr404(id);
      if (runner.activeRun(id) === undefined) return reply.code(204).send();
      const stream = openStream(reply);
      // 这个响应已经 hijack 给了我们自己：抛错时 fastify 的错误处理接不上，
      // 不在这里收尾就是一个永远不结束的流，前端会一直转圈到超时。
      try {
        await runner.resume(id, stream.write, stream.signal);
      } catch (cause) {
        stream.write(
          errorChunk(
            "resume-error",
            cause instanceof Error ? cause.message : "续流失败",
          ),
        );
        stream.write({ type: "finish", finishReason: "error" });
      } finally {
        stream.end();
      }
      return reply;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/queue",
    async (request) => {
      sessionOr404(request.params.id);
      const { message } = messageBody.parse(request.body);
      return runner.queue(request.params.id, message);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/abort",
    (request, reply) => {
      sessionOr404(request.params.id);
      runner.abort(request.params.id);
      return reply.code(204).send();
    },
  );

  /* ── 会话的模型（pi 的 /model 与 Shift+Tab）──────────────────────── */

  app.get<{ Params: { id: string } }>("/api/sessions/:id/model", (request) =>
    runner.sessionModel(request.params.id),
  );

  app.put<{ Params: { id: string } }>("/api/sessions/:id/model", (request) =>
    runner.setModel(request.params.id, modelRefSchema.parse(request.body)),
  );

  app.put<{ Params: { id: string } }>("/api/sessions/:id/thinking", (request) =>
    runner.setThinking(
      request.params.id,
      thinkingBody.parse(request.body).level,
    ),
  );

  /* ── 模型接入（provider）────────────────────────────────────────────── */

  /** 可用模型（已接入 provider 的模型并集）。对话里的模型选择器列的就是它。 */
  app.get("/api/models", async () => {
    const config = readProvidersConfig(deps.db);
    try {
      const { setup, defaultModel } = await provision();
      return {
        models: setup.available.map((m) => ({
          provider: m.provider,
          id: m.id,
          name: m.name,
          reasoning: m.reasoning,
          contextWindow: m.contextWindow,
          inheritedFrom:
            setup.inherited.get(modelKey(m.provider, m.id)) ?? null,
        })),
        defaultModel: defaultModel
          ? { provider: defaultModel.provider, modelId: defaultModel.id }
          : null,
        defaultThinking: config.defaultThinking,
        problem: null,
      };
    } catch (cause) {
      return {
        models: [],
        defaultModel: null,
        defaultThinking: config.defaultThinking,
        problem: cause instanceof Error ? cause.message : "模型配置有误",
      };
    }
  });

  /** 已接入的 provider + 可添加的 pi 内置 provider 目录。key 只回来源，不回内容。 */
  app.get("/api/providers", async () => {
    const config = readProvidersConfig(deps.db);
    const catalog = await listBuiltinProviders(deps.paths);
    const customIds = new Set(config.custom.map((c) => c.id));
    const configured = [];
    for (const c of config.custom) {
      configured.push({
        id: c.id,
        kind: "custom" as const,
        name: c.id,
        baseUrl: c.baseUrl,
        api: c.api,
        models: c.models,
        keySource: (await deps.keys.get(c.id)).source,
      });
    }
    for (const id of await deps.keys.list()) {
      if (customIds.has(id)) continue;
      const builtin = catalog.find((p) => p.id === id);
      if (!builtin) continue;
      configured.push({
        id,
        kind: "builtin" as const,
        name: builtin.name,
        models: builtin.models.map((m) => m.id),
        keySource: (await deps.keys.get(id)).source,
      });
    }
    return {
      configured,
      catalog: catalog.map((p) => ({
        id: p.id,
        name: p.name,
        modelCount: p.models.length,
      })),
      defaultModel: config.defaultModel,
      defaultThinking: config.defaultThinking,
    };
  });

  /** 新增 / 修改自定义中转（可同时带上 key）。 */
  app.put<{ Params: { id: string } }>(
    "/api/providers/custom/:id",
    async (request) => {
      const id = providerIdSchema.parse(request.params.id);
      const catalog = await listBuiltinProviders(deps.paths);
      if (catalog.some((p) => p.id === id)) {
        throw badRequest(`「${id}」是 pi 内置 provider 的名字，换一个`);
      }
      const body = customUpsertBody.parse(request.body);
      const problem = outboundProblem(body.baseUrl, {
        allowLocal: body.allowLocal === true,
      });
      if (problem !== null) throw badRequest(problem);
      const provider = customProviderSchema.parse({
        id,
        baseUrl: body.baseUrl,
        api: body.api,
        models: body.models,
      });
      const config = readProvidersConfig(deps.db);
      writeProvidersConfig(deps.db, {
        ...config,
        custom: [...config.custom.filter((c) => c.id !== id), provider].sort(
          (a, b) => a.id.localeCompare(b.id),
        ),
      });
      if (body.key) await deps.keys.set(id, body.key);
      invalidate();
      return { provider };
    },
  );

  /** 给 provider 设 key。内置 provider 设了 key 就算接入。 */
  app.put<{ Params: { id: string } }>(
    "/api/providers/:id/key",
    async (request, reply) => {
      const id = providerIdSchema.parse(request.params.id);
      const config = readProvidersConfig(deps.db);
      const catalog = await listBuiltinProviders(deps.paths);
      if (
        !config.custom.some((c) => c.id === id) &&
        !catalog.some((p) => p.id === id)
      ) {
        throw notFound(`没有这个 provider：${id}`);
      }
      await deps.keys.set(id, keyBody.parse(request.body).key);
      invalidate();
      return reply.code(204).send();
    },
  );

  /** 移除 provider：自定义的删定义与 key；内置的删 key。 */
  app.delete<{ Params: { id: string } }>(
    "/api/providers/:id",
    async (request, reply) => {
      const id = providerIdSchema.parse(request.params.id);
      const config = readProvidersConfig(deps.db);
      writeProvidersConfig(deps.db, {
        ...config,
        custom: config.custom.filter((c) => c.id !== id),
        defaultModel:
          config.defaultModel?.provider === id ? null : config.defaultModel,
      });
      await deps.keys.clear(id);
      invalidate();
      return reply.code(204).send();
    },
  );

  /** 新会话的默认模型与思考强度。 */
  app.put("/api/defaults", (request) => {
    const body = defaultsBody.parse(request.body);
    const config = readProvidersConfig(deps.db);
    const next = {
      ...config,
      defaultModel: body.defaultModel,
      defaultThinking: body.defaultThinking,
    };
    writeProvidersConfig(deps.db, next);
    invalidate();
    return {
      defaultModel: next.defaultModel,
      defaultThinking: next.defaultThinking,
    };
  });

  /** 用 key 拉取中转的模型清单（{base}/v1/models）。 */
  app.post("/api/model/probe", async (request) => {
    const body = probeBody.parse(request.body);
    const problem = outboundProblem(body.baseUrl, {
      allowLocal: body.allowLocal === true,
    });
    if (problem !== null) throw badRequest(problem);
    const key = body.key ?? (await deps.keys.get(body.providerId)).value;
    if (!key) throw badRequest("先填 API key 再拉取模型");
    const models = await probeModels(
      { baseUrl: body.baseUrl, api: body.api, key },
      deps.probeFetch,
    );
    return { models };
  });

  /* ── 技能（skill）───────────────────────────────────── */

  /**
   * 技能清单。这里的技能对话里直接生效（每轮重扫，见 pi/skills.ts），
   * 所以没有「启用」开关；分发只关乎要不要顺带给本机的 CLI 用。
   */
  app.get("/api/skills", async () => ({
    skills: await deps.skills.list(),
    /** 整份清单每轮占多少字节。界面要把这笔每轮成本显示出来，否则只能靠猜。 */
    promptBytes: deps.skillsPromptBytes?.() ?? 0,
  }));

  app.get<{ Params: { name: string } }>("/api/skills/:name", (request) =>
    deps.skills.get(request.params.name),
  );

  app.post("/api/skills", async (request, reply) => {
    const skill = await deps.skills.create(
      skillBody.parse(request.body).content,
    );
    return reply.code(201).send(skill);
  });

  /** 保存。frontmatter 里改了 name 就连目录一起改，返回体里的 name 是改后的。 */
  app.put<{ Params: { name: string } }>("/api/skills/:name", (request) =>
    deps.skills.update(
      request.params.name,
      skillBody.parse(request.body).content,
    ),
  );

  app.delete<{ Params: { name: string } }>(
    "/api/skills/:name",
    async (request, reply) => {
      await deps.skills.remove(request.params.name);
      return reply.code(204).send();
    },
  );

  /** 导入 zip（带 references/ 等附属文件的技能只能这么进来）。 */
  app.post(
    "/api/skills/import",
    { bodyLimit: SKILL_IMPORT_BODY_LIMIT },
    async (request, reply) => {
      const skill = await deps.skills.importZip(
        skillZipBody.parse(request.body).zip,
      );
      return reply.code(201).send(skill);
    },
  );

  /** 导入一个技能目录（浏览器选文件夹 / 拖放）。一次一个技能，批量由前端拆开调。 */
  app.post(
    "/api/skills/tree",
    { bodyLimit: SKILL_IMPORT_BODY_LIMIT },
    async (request, reply) => {
      const skill = await deps.skills.importTree(
        skillTreeBody.parse(request.body).files,
      );
      return reply.code(201).send(skill);
    },
  );

  /** 读技能目录里的某个文件（展览页点开附属文件）。 */
  app.get<{ Params: { name: string }; Querystring: { path?: string } }>(
    "/api/skills/:name/file",
    (request) => {
      const path = request.query.path;
      if (path === undefined || path === "") throw badRequest("要读哪个文件？");
      return deps.skills.readFile(request.params.name, path);
    },
  );

  /**
   * 「对模型隐藏」。写的是 SKILL.md 的 frontmatter（pi 的 disable-model-invocation），
   * 不另存一份状态——否则会出现「界面说隐藏了但命令行那边照样自动选」。
   */
  app.put<{ Params: { name: string } }>(
    "/api/skills/:name/visibility",
    (request) =>
      deps.skills.setHidden(
        request.params.name,
        skillVisibilityBody.parse(request.body).hidden,
      ),
  );

  /** 软链到本机 CLI 的技能目录。传期望的集合，多的摘、缺的建。 */
  app.put<{ Params: { name: string } }>(
    "/api/skills/:name/distribution",
    async (request) => {
      const name = request.params.name;
      assertValidName(name);
      const wanted = new Set<SkillTarget>(
        skillDistributionBody.parse(request.body).targets,
      );
      const off = SKILL_TARGETS.filter((t) => !wanted.has(t));
      if (off.length > 0) await deps.skills.undistribute(name, off);
      return deps.skills.distribute(name, [...wanted]);
    },
  );

  /* ── 执行体（agent）────────────────────────────────────── */

  /**
   * 执行体是「照手册干活、且配好工具权限的人」，skill 是手册。
   *
   * 现阶段这组接口只管定义与分发：pi 1.2.0 没有子 agent 能力，本服务的对话
   * 还派不出去（见 agents.ts 的说明）。真做派发时按名字从同一个 store 取定义，
   * 不会出现第二份真相源。
   */
  /* ── 智能体团队：花名册与运行记录 ─────────────────────────────────── */

  app.get("/api/agent-team", () => ({
    // 正文是子会话的提示词，花名册接口不下发。
    members: team.members().map((m) => ({
      name: m.name,
      description: m.description,
      tools: m.tools,
      model: m.model,
      maxTurns: m.maxTurns,
      canDelegate: m.canDelegate,
    })),
    active: team.active(),
  }));
  app.get("/api/agent-runs", (req) => {
    const q = z
      .object({ sessionId: z.string().min(1).optional() })
      .parse(req.query);
    return {
      runs: q.sessionId
        ? agentRuns.bySession(q.sessionId)
        : agentRuns.recent(100),
    };
  });
  app.get("/api/agent-runs/:id", (req) => {
    const { id } = z.object({ id: z.string().min(1) }).parse(req.params);
    const run = agentRuns.get(id);
    if (!run) throw notFound("运行记录不存在");
    const [header, ...entries] = agentRuns.transcript(id);
    return {
      run,
      children: agentRuns.children(id),
      messages:
        header === undefined
          ? []
          : historyToUiMessages(deps.paths.cwd, header, entries),
    };
  });

  const agents = deps.agents;
  if (agents) {
    app.get("/api/agents", async () => ({ agents: await agents.list() }));

    app.get<{ Params: { name: string } }>("/api/agents/:name", (request) =>
      agents.get(request.params.name),
    );

    app.post("/api/agents", async (request, reply) => {
      const agent = await agents.create(agentBody.parse(request.body).content);
      return reply.code(201).send(agent);
    });

    /** 保存。frontmatter 里改了 name 就连文件一起改，返回体里的 name 是改后的。 */
    app.put<{ Params: { name: string } }>("/api/agents/:name", (request) =>
      agents.update(request.params.name, agentBody.parse(request.body).content),
    );

    app.delete<{ Params: { name: string } }>(
      "/api/agents/:name",
      async (request, reply) => {
        await agents.remove(request.params.name);
        return reply.code(204).send();
      },
    );

    /** 软链到 ~/.pi/agent/agents。传期望的集合，多的摘、缺的建。 */
    app.put<{ Params: { name: string } }>(
      "/api/agents/:name/distribution",
      async (request) => {
        const name = request.params.name;
        assertValidAgentName(name);
        const wanted = new Set<AgentTarget>(
          agentDistributionBody.parse(request.body).targets,
        );
        const off = AGENT_TARGETS.filter((t) => !wanted.has(t));
        if (off.length > 0) await agents.undistribute(name, off);
        return agents.distribute(name, [...wanted]);
      },
    );
  }

  deps.registerPiRoutes?.(app, { runner });

  return { app, runner, presalesAgent, forge };
}
