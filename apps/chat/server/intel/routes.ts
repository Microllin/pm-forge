import type { FastifyInstance } from "fastify";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import { notFound } from "../errors.js";
import type { SessionProfile } from "../pi/runner.js";
import type { AnalysisTask, SessionRow, SessionStore } from "../sessions.js";
import { BRIEF_LIMIT, renderIntelBrief } from "./brief.js";
import {
  CONFIDENCE_LABEL,
  INTEL_CONFIDENCE,
  INTEL_KINDS,
  KIND_LABEL,
  type IntelStore,
} from "./store.js";
import { intelProposeTool, intelReadTool, intelSearchTool } from "./tools.js";

/**
 * 市场情报的接口、对话注入与「AI 调研」助手。
 */

const kindSchema = z.enum(INTEL_KINDS);
const inputSchema = z.object({
  kind: kindSchema,
  subject: z.string().max(200).optional(),
  title: z.string().min(1).max(300),
  summary: z.string().max(2000).optional(),
  content: z.string().optional(),
  sources: z
    .array(
      z.object({
        // 情报来源来自外部调研（模型抓回来的），属于不可信输入。前端会直接渲染成链接，
        // 所以只放行 http(s)：界面其余渲染点（Markdown、Wiki）都是同一口径。
        url: z
          .string()
          .max(2000)
          .refine((u) => /^https?:\/\//i.test(u), "来源链接只能用 http(s)"),
        title: z.string().max(300).optional(),
      }),
    )
    .max(50)
    .optional(),
  tags: z.array(z.string().max(60)).max(30).optional(),
  productIds: z.array(z.string()).max(50).optional(),
  observedAt: z.string().max(10).nullable().optional(),
  reviewAfter: z.number().int().nullable().optional(),
  confidence: z.enum(INTEL_CONFIDENCE).optional(),
});
const idParams = z.object({ id: z.string().min(1) });

/** 普通对话、产品对话和「写一份产出物 / Wiki 章节」这类起草任务才附情报；核对类任务不附。 */
const WANTS_INTEL = new Set<AnalysisTask["kind"]>([
  "fill-artifact",
  "wiki-page",
  "intel-research",
]);

const MIN_FOLLOWUP_CHARS = 8;

export interface IntelDeps {
  store: IntelStore;
  sessions: SessionStore;
  newHeader: () => unknown;
  /** 联网搜索工具（借智能体团队的 web_search）。拿不到就不给，调研助手会如实说没联网。 */
  webSearch?: () => ToolDefinition | undefined;
}

export interface Intel {
  profile(session: SessionRow): SessionProfile | undefined;
  /** 这条消息该附的参考情报段；null = 不附。会把给过的条目记进 state。 */
  brief(
    session: { productId: string | null; task: AnalysisTask | null },
    message: string,
    state: { first: boolean; given: Set<string> },
  ): string | null;
}

export const RESEARCH_PROMPT = (productName: string | null): string =>
  [
    "你是 PMForge 的市场情报调研员。你的产出是**情报库里的条目**，不是一篇报告：每条讲清一个对象（一个竞品、一条法规、一个细分市场）的一个发现，人确认后，AI 以后写 PRD 时会把相关条目当参考。",
    productName === null
      ? "这次调研不绑定具体产品，条目默认对所有产品可见。"
      : `这次调研服务于产品「${productName}」：对话里会附上它的事实依据，用来判断哪些外部情况和它有关；提交的条目会自动关联它。`,
    "",
    "## 怎么做",
    "1. 先弄清人要回答的问题：调研对象、关心的维度（功能 / 定价 / 目标客户 / 政策要求……）、用在哪个决策上。说得不清就先问一句（带上你的默认理解）。",
    "2. 先 intel_search 看库里已有的，避免重复；已有但过时的，提交更新后的新条目，并在正文里写明替代哪条。",
    "3. 用 web_search 查，一次只问一个具体问题。没有联网能力时如实说「未联网核实」，只整理人提供的材料与常识，可信度标「推断」。",
    "4. 每个发现用 intel_propose 提交一条：标题、一句话结论、正文（事实与数据在前，「对我们的启示」单列并标为推断）、来源链接、事实对应的日期、可信度、建议复核周期。",
    "5. 最后用简体中文汇报：提交了哪几条（标题）、最值得注意的 1–3 个发现、还没查到要人补的。",
    "",
    "## 纪律",
    "- 情报是参考，不是准则：写「竞品 X 这么做」，不写「我们必须这么做」。",
    "- 没有来源的数字不写；单一来源标「单一来源」；推断标「推断」。",
    "- 合规条目写清法规名称、条款、生效日期与适用条件，结论只说「可能涉及」，适用与否留给法务。",
    "- 不编造竞品功能、价格、客户案例。",
    `- 分类：${INTEL_KINDS.map((k) => `${k}=${KIND_LABEL[k]}`).join("，")}；可信度：${INTEL_CONFIDENCE.map((c) => `${c}=${CONFIDENCE_LABEL[c]}`).join("，")}。`,
  ].join("\n");

export function registerIntel(
  app: FastifyInstance,
  deps: IntelDeps & { productName: (id: string) => string | null },
): Intel {
  const { store, sessions } = deps;

  app.get("/api/intel", (request) => {
    const q = z
      .object({
        kind: kindSchema.optional(),
        status: z.enum(["pending", "active", "archived"]).optional(),
        productId: z.string().optional(),
      })
      .parse(request.query);
    return { items: store.list(q) };
  });

  app.get("/api/intel/:id", (request) =>
    store.get(idParams.parse(request.params).id),
  );

  app.post("/api/intel", (request, reply) =>
    reply.code(201).send(store.create(inputSchema.parse(request.body))),
  );

  app.put("/api/intel/:id", (request) =>
    store.update(
      idParams.parse(request.params).id,
      inputSchema.parse(request.body),
    ),
  );

  /** 确认（pending → active）、归档、恢复。 */
  app.post("/api/intel/:id/status", (request) => {
    const { status } = z
      .object({ status: z.enum(["active", "archived", "pending"]) })
      .parse(request.body);
    return store.setStatus(idParams.parse(request.params).id, status);
  });

  app.delete("/api/intel/:id", (request, reply) => {
    store.remove(idParams.parse(request.params).id);
    return reply.code(204).send();
  });

  /** 开一条「AI 调研」对话。首句由前端自动发出（kickoff），人能看到过程、能追问。 */
  app.post("/api/intel/research", (request, reply) => {
    const body = z
      .object({
        topic: z.string().trim().min(2).max(2000),
        kind: kindSchema.optional(),
        productId: z.string().nullable().optional(),
      })
      .parse(request.body);
    const productId = body.productId ?? null;
    if (productId !== null && deps.productName(productId) === null)
      throw notFound("产品不存在");
    const header = deps.newHeader() as { id: string };
    const row = sessions.create({
      id: header.id,
      title: `情报调研 · ${body.topic.slice(0, 24)}`,
      header,
      productId,
      task: { kind: "intel-research", productId },
    });
    const kickoff = [
      `请调研：${body.topic}`,
      body.kind === undefined ? null : `侧重：${KIND_LABEL[body.kind]}`,
      "查完把发现逐条提交进情报库（待我确认），最后汇报。",
    ]
      .filter((x): x is string => x !== null)
      .join("\n");
    return reply.code(201).send({ sessionId: row.id, kickoff });
  });

  return {
    profile(session) {
      if (session.task?.kind !== "intel-research") return undefined;
      const ctx = { productId: session.productId, sessionId: session.id };
      const web = deps.webSearch?.();
      return {
        systemPrompt: RESEARCH_PROMPT(
          session.productId === null
            ? null
            : deps.productName(session.productId),
        ),
        tools: [
          intelSearchTool(store, ctx),
          intelReadTool(store),
          intelProposeTool(store, ctx),
          ...(web === undefined ? [] : [web]),
        ],
      };
    },

    brief(session, message, state) {
      if (session.task !== null && !WANTS_INTEL.has(session.task.kind))
        return null;
      if (!state.first && message.trim().length < MIN_FOLLOWUP_CHARS)
        return null;
      const hits = store
        .search(message, {
          productId: session.productId,
          limit: BRIEF_LIMIT * 2,
        })
        // 续聊不重复给同一条；条目改过（updatedAt 变了）就算新的。
        .filter(
          (h) =>
            !state.given.has(`intel:${h.item.id}:${String(h.item.updatedAt)}`),
        )
        .slice(0, BRIEF_LIMIT);
      const text = renderIntelBrief(hits);
      for (const h of hits)
        state.given.add(`intel:${h.item.id}:${String(h.item.updatedAt)}`);
      return text;
    },
  };
}
