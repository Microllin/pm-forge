import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { renderItem } from "./brief.js";
import {
  CONFIDENCE_LABEL,
  INTEL_CONFIDENCE,
  INTEL_KINDS,
  KIND_LABEL,
  type IntelStore,
} from "./store.js";

/**
 * 情报库给 AI 的三件工具：查、读、提交。
 *
 * 提交只会落成「待确认」：人在情报页确认后才生效、才会被附给别的对话。
 * 这与临时区「AI 产出先待确认」是同一条线，只是情报是
 * 结构化条目而不是文件，所以待确认状态留在情报表里，不另存一份文件。
 */

const text = (
  t: string,
): { content: { type: "text"; text: string }[]; details: undefined } => ({
  content: [{ type: "text", text: t }],
  details: undefined,
});
const asTool = (t: unknown): ToolDefinition => t as ToolDefinition;

// 逐个写字面量：从数组 map 出来的联合类型 TypeBox 推不出成员，参数会被推成 never。
const kindEnum = Type.Union([
  Type.Literal("competitor"),
  Type.Literal("market"),
  Type.Literal("industry"),
  Type.Literal("compliance"),
  Type.Literal("other"),
]);
const confidenceEnum = Type.Union([
  Type.Literal("official"),
  Type.Literal("multi"),
  Type.Literal("single"),
  Type.Literal("inferred"),
]);

export interface IntelToolContext {
  /** 当前对话绑定的产品：查询时优先它；提交时默认关联它。 */
  productId: string | null;
  /** 提交的条目记在哪条会话下（可回看过程）。 */
  sessionId: string | null;
}

export function intelSearchTool(
  store: IntelStore,
  ctx: IntelToolContext,
): ToolDefinition {
  return asTool(
    defineTool({
      name: "intel_search",
      label: "查情报库",
      description: `Search the market-intel library (competitors, market, industry news, compliance). These are REFERENCE notes about the outside world — not rules, not facts about our own product. Kinds: ${INTEL_KINDS.map((k) => `${k}=${KIND_LABEL[k]}`).join(", ")}. Use several short keywords.`,
      parameters: Type.Object({
        query: Type.String(),
        kind: Type.Optional(kindEnum),
      }),
      execute(_id, params) {
        const hits = store.search(params.query, {
          productId: ctx.productId,
          ...(params.kind === undefined ? {} : { kind: params.kind }),
          limit: 15,
          includePending: true,
        });
        if (hits.length === 0)
          return Promise.resolve(
            text(
              "情报库里没有相关条目。需要的话可以调研后用 intel_propose 补充。",
            ),
          );
        return Promise.resolve(
          text(
            hits
              .map(
                (h) =>
                  `- [${h.item.id}] ${h.item.status === "pending" ? "（待确认）" : ""}${h.item.title}｜${KIND_LABEL[h.item.kind]}${h.item.subject ? `｜${h.item.subject}` : ""}｜${h.item.observedAt ?? "日期不明"}${h.item.stale ? "｜可能过时" : ""}：${h.item.summary}`,
              )
              .join("\n"),
          ),
        );
      },
    }),
  );
}

export function intelReadTool(store: IntelStore): ToolDefinition {
  return asTool(
    defineTool({
      name: "intel_read",
      label: "读情报",
      description:
        "Read one market-intel entry in full (by id from intel_search).",
      parameters: Type.Object({ id: Type.String() }),
      execute(_id, params) {
        return Promise.resolve(text(renderItem(store.get(params.id), 30_000)));
      },
    }),
  );
}

export function intelProposeTool(
  store: IntelStore,
  ctx: IntelToolContext,
): ToolDefinition {
  return asTool(
    defineTool({
      name: "intel_propose",
      label: "提交情报",
      description: `Add one market-intel entry to the library as PENDING (a human confirms it on the 市场情报 page). One entry = one finding about one subject (a competitor, a regulation, a market segment). Always give sources with URLs when you have them, the date the fact refers to, and an honest confidence (${INTEL_CONFIDENCE.map((c) => `${c}=${CONFIDENCE_LABEL[c]}`).join(", ")}). Before proposing, intel_search to avoid duplicates.`,
      parameters: Type.Object({
        kind: kindEnum,
        subject: Type.String({
          description:
            "对象：竞品名 / 法规名 / 细分市场，如「Notion」「个人信息保护法」",
        }),
        title: Type.String({ description: "一句话标题" }),
        summary: Type.String({
          description: "一句话结论（给写 PRD 的人看的那句）",
        }),
        content: Type.String({
          description:
            "正文 Markdown：事实、数据、对我们的启示（启示标为推断）",
        }),
        sources: Type.Optional(
          Type.Array(
            Type.Object({
              url: Type.String(),
              title: Type.Optional(Type.String()),
            }),
          ),
        ),
        observed_at: Type.Optional(
          Type.String({
            description: "事实对应的日期：2026、2026-10 或 2026-10-31",
          }),
        ),
        confidence: Type.Optional(confidenceEnum),
        tags: Type.Optional(Type.Array(Type.String())),
        review_months: Type.Optional(
          Type.Number({
            description: "建议多少个月后复核（定价、榜单类 3–6，法规类 12）",
          }),
        ),
      }),
      execute(_id, params) {
        const months = params.review_months;
        const reviewAfter =
          months === undefined || months <= 0
            ? null
            : Date.now() + Math.round(months * 30 * 24 * 3600 * 1000);
        const item = store.create(
          {
            kind: params.kind,
            subject: params.subject,
            title: params.title,
            summary: params.summary,
            content: params.content,
            sources: params.sources,
            tags: params.tags,
            productIds: ctx.productId === null ? [] : [ctx.productId],
            observedAt: params.observed_at ?? null,
            reviewAfter,
            confidence: params.confidence ?? "single",
          },
          { status: "pending", origin: "ai", sessionId: ctx.sessionId },
        );
        return Promise.resolve(
          text(
            `已提交「${item.title}」（编号 ${item.id}），待人在市场情报页确认。`,
          ),
        );
      },
    }),
  );
}
