import { randomUUID } from "node:crypto";

import type { Db } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { extractKeywords } from "../evidence/keywords.js";

/**
 * 市场情报库：竞品、市场、行业动态、合规等**外部**资料。
 *
 * 三样东西别混：
 * - **事实依据**（evidence/）= 我们自己产品的代码、PRD、真实页面。描述「我们是什么」。
 * - **准则**（技能、生命周期规范）= 必须照做的方法和标准。
 * - **情报**（这里）= 外部世界的情况。AI 写 PRD 时要**考虑**它，但它不是要照做的规则，
 *   也不能拿来描述我们自己。所以它单独一张表、单独一段下发，标签上写明「参考」。
 *
 * 情报会过期：每条带「观察日期」与可选的「复核日期」，过了复核日期就标「可能过时」，
 * AI 引用时要说出来。AI 写的条目一律先是「待确认」，人确认后才会被附给别的对话。
 *
 * 表由本模块自建（IF NOT EXISTS），不进 db.ts 的序号迁移——原因见 agent-team/runs.ts 顶注。
 */

export const INTEL_MIGRATION = `
  CREATE TABLE IF NOT EXISTS intel_items (
    id           TEXT PRIMARY KEY,
    kind         TEXT NOT NULL,
    subject      TEXT NOT NULL DEFAULT '',
    title        TEXT NOT NULL,
    summary      TEXT NOT NULL DEFAULT '',
    content      TEXT NOT NULL DEFAULT '',
    sources      TEXT NOT NULL DEFAULT '[]',
    tags         TEXT NOT NULL DEFAULT '[]',
    product_ids  TEXT NOT NULL DEFAULT '[]',
    observed_at  TEXT,
    review_after INTEGER,
    confidence   TEXT NOT NULL DEFAULT 'single',
    status       TEXT NOT NULL DEFAULT 'active',
    origin       TEXT NOT NULL DEFAULT 'manual',
    session_id   TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS intel_items_kind_idx ON intel_items(kind, status, updated_at);
`;

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

/** 可信度：决定 AI 引用时要不要加一句「单一来源」「推断」。 */
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

/** pending = AI 写的、还没人看过；active = 生效；archived = 不再附给 AI，但留档。 */
export type IntelStatus = "pending" | "active" | "archived";

export interface IntelSource {
  title?: string | undefined;
  url: string;
}

export interface IntelItem {
  id: string;
  kind: IntelKind;
  /** 对象：竞品名、法规名、细分市场……同一对象的条目在界面上归成一组。 */
  subject: string;
  title: string;
  /** 一句话结论：列表与下发给 AI 时优先用它。 */
  summary: string;
  /** 正文（Markdown）。 */
  content: string;
  sources: IntelSource[];
  tags: string[];
  /** 关联的产品；空 = 全局（所有产品都可能用到）。 */
  productIds: string[];
  /** 这条情报对应的时间（YYYY-MM 或 YYYY-MM-DD）：情报说的是「那时候」的情况。 */
  observedAt: string | null;
  /** 过了这天就标「可能过时」。null = 不设。 */
  reviewAfter: number | null;
  confidence: IntelConfidence;
  status: IntelStatus;
  origin: "manual" | "ai";
  /** AI 写的：出自哪条会话（可回看过程）。 */
  sessionId: string | null;
  createdAt: number;
  updatedAt: number;
  /** 现算：过了复核日期。 */
  stale: boolean;
}

export interface IntelInput {
  kind: IntelKind;
  subject?: string | undefined;
  title: string;
  summary?: string | undefined;
  content?: string | undefined;
  sources?: IntelSource[] | undefined;
  tags?: string[] | undefined;
  productIds?: string[] | undefined;
  observedAt?: string | null | undefined;
  reviewAfter?: number | null | undefined;
  confidence?: IntelConfidence | undefined;
}

interface Raw {
  id: string;
  kind: string;
  subject: string;
  title: string;
  summary: string;
  content: string;
  sources: string;
  tags: string;
  product_ids: string;
  observed_at: string | null;
  review_after: number | null;
  confidence: string;
  status: string;
  origin: string;
  session_id: string | null;
  created_at: number;
  updated_at: number;
}

const parseList = <T>(raw: string): T[] => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

const MAX_CONTENT = 200_000;
const OBSERVED_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

export interface IntelFilter {
  kind?: IntelKind | undefined;
  status?: IntelStatus | undefined;
  /** 只看和这个产品有关的（含全局条目）。 */
  productId?: string | undefined;
}

export interface IntelHit {
  item: IntelItem;
  score: number;
  matched: string[];
}

export interface IntelStore {
  list(filter?: IntelFilter): IntelItem[];
  get(id: string): IntelItem;
  create(
    input: IntelInput,
    meta?: {
      status?: IntelStatus;
      origin?: "manual" | "ai";
      sessionId?: string | null;
    },
  ): IntelItem;
  update(id: string, input: IntelInput): IntelItem;
  setStatus(id: string, status: IntelStatus): IntelItem;
  remove(id: string): void;
  /**
   * 按任务挑相关条目（只挑生效中的）。关键词命中 主题 / 标题 / 标签 / 摘要 / 正文，
   * 按字段加权；产品对话只看全局 + 关联了这个产品的。
   */
  search(
    task: string,
    options?: {
      productId?: string | null;
      kind?: IntelKind | undefined;
      limit?: number;
      includePending?: boolean;
    },
  ): IntelHit[];
}

export function createIntelStore(
  db: Db,
  now: () => number = Date.now,
): IntelStore {
  db.exec(INTEL_MIGRATION);

  const toItem = (r: Raw): IntelItem => ({
    id: r.id,
    kind: (INTEL_KINDS as readonly string[]).includes(r.kind)
      ? (r.kind as IntelKind)
      : "other",
    subject: r.subject,
    title: r.title,
    summary: r.summary,
    content: r.content,
    sources: parseList<IntelSource>(r.sources).filter(
      (s) => typeof s.url === "string",
    ),
    tags: parseList<string>(r.tags).filter((t) => typeof t === "string"),
    productIds: parseList<string>(r.product_ids),
    observedAt: r.observed_at,
    reviewAfter: r.review_after,
    confidence: (INTEL_CONFIDENCE as readonly string[]).includes(r.confidence)
      ? (r.confidence as IntelConfidence)
      : "single",
    status:
      r.status === "pending" || r.status === "archived" ? r.status : "active",
    origin: r.origin === "ai" ? "ai" : "manual",
    sessionId: r.session_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    stale: r.review_after !== null && r.review_after < now(),
  });

  const clean = (input: IntelInput) => {
    const title = input.title.trim();
    if (title === "") throw badRequest("标题不能为空");
    if ((input.content ?? "").length > MAX_CONTENT)
      throw badRequest("正文太长（上限 20 万字）");
    const observed = input.observedAt?.trim() ?? "";
    if (observed !== "" && !OBSERVED_RE.test(observed))
      throw badRequest("观察日期要写成 2026、2026-10 或 2026-10-31");
    const uniq = (xs: readonly string[] | undefined): string[] => [
      ...new Set((xs ?? []).map((x) => x.trim()).filter(Boolean)),
    ];
    return {
      kind: input.kind,
      subject: input.subject?.trim() ?? "",
      title,
      summary: input.summary?.trim() ?? "",
      content: input.content ?? "",
      sources: JSON.stringify(
        (input.sources ?? [])
          .map((s) => ({
            url: s.url.trim(),
            ...(s.title?.trim() ? { title: s.title.trim() } : {}),
          }))
          .filter((s) => s.url !== ""),
      ),
      tags: JSON.stringify(uniq(input.tags)),
      productIds: JSON.stringify(uniq(input.productIds)),
      observedAt: observed === "" ? null : observed,
      reviewAfter: input.reviewAfter ?? null,
      confidence: input.confidence ?? "single",
    };
  };

  const rawOf = (id: string): Raw => {
    const r = db
      .prepare<[string], Raw>("SELECT * FROM intel_items WHERE id = ?")
      .get(id);
    if (r === undefined) throw notFound("情报不存在");
    return r;
  };

  const list: IntelStore["list"] = (filter = {}) =>
    db
      .prepare<[], Raw>("SELECT * FROM intel_items ORDER BY updated_at DESC")
      .all()
      .map(toItem)
      .filter(
        (i) =>
          (filter.kind === undefined || i.kind === filter.kind) &&
          (filter.status === undefined || i.status === filter.status) &&
          (filter.productId === undefined ||
            i.productIds.length === 0 ||
            i.productIds.includes(filter.productId)),
      );

  return {
    list,
    get: (id) => toItem(rawOf(id)),

    create(input, meta = {}) {
      const c = clean(input);
      const id = randomUUID();
      const t = now();
      db.prepare(
        `INSERT INTO intel_items (id, kind, subject, title, summary, content, sources, tags, product_ids,
           observed_at, review_after, confidence, status, origin, session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        c.kind,
        c.subject,
        c.title,
        c.summary,
        c.content,
        c.sources,
        c.tags,
        c.productIds,
        c.observedAt,
        c.reviewAfter,
        c.confidence,
        meta.status ?? "active",
        meta.origin ?? "manual",
        meta.sessionId ?? null,
        t,
        t,
      );
      return toItem(rawOf(id));
    },

    update(id, input) {
      rawOf(id);
      const c = clean(input);
      db.prepare(
        `UPDATE intel_items SET kind = ?, subject = ?, title = ?, summary = ?, content = ?, sources = ?,
           tags = ?, product_ids = ?, observed_at = ?, review_after = ?, confidence = ?, updated_at = ?
         WHERE id = ?`,
      ).run(
        c.kind,
        c.subject,
        c.title,
        c.summary,
        c.content,
        c.sources,
        c.tags,
        c.productIds,
        c.observedAt,
        c.reviewAfter,
        c.confidence,
        now(),
        id,
      );
      return toItem(rawOf(id));
    },

    setStatus(id, status) {
      rawOf(id);
      db.prepare(
        "UPDATE intel_items SET status = ?, updated_at = ? WHERE id = ?",
      ).run(status, now(), id);
      return toItem(rawOf(id));
    },

    remove(id) {
      rawOf(id);
      db.prepare("DELETE FROM intel_items WHERE id = ?").run(id);
    },

    search(task, options = {}) {
      // 本地二元组（「退款审批」拆出的「款审」）是碎片，命中只算半分。
      const kws = extractKeywords(task, 40)
        .map((k) => ({
          term: k.term.toLowerCase(),
          w: k.weight >= 2 ? 1 : 0.5,
        }))
        .filter((k) => k.term.length >= 2);
      if (kws.length === 0) return [];
      const pool = list({
        ...(options.kind === undefined ? {} : { kind: options.kind }),
        ...(options.productId == null ? {} : { productId: options.productId }),
      }).filter(
        (i) =>
          i.status === "active" ||
          (options.includePending === true && i.status === "pending"),
      );
      const hits: IntelHit[] = [];
      for (const item of pool) {
        // 字段加权：对象 / 标题 / 标签命中最说明问题，正文命中最弱。
        const fields: [string, number][] = [
          [item.subject.toLowerCase(), 6],
          [item.title.toLowerCase(), 5],
          [item.tags.join(" ").toLowerCase(), 4],
          [item.summary.toLowerCase(), 3],
          [item.content.toLowerCase(), 1],
        ];
        let score = 0;
        const matched: string[] = [];
        for (const k of kws) {
          let best = 0;
          for (const [text, w] of fields)
            if (text.includes(k.term)) best = Math.max(best, w);
          if (best > 0) {
            score += best * k.w;
            matched.push(k.term);
          }
        }
        // 只碰到一个正文里的词多半是巧合，不值得占 AI 的上下文。
        if (score < 3) continue;
        // 关联了这个产品的比全局的更相关。
        if (
          options.productId != null &&
          item.productIds.includes(options.productId)
        )
          score += 2;
        hits.push({ item, score, matched });
      }
      return hits
        .sort(
          (a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt,
        )
        .slice(0, options.limit ?? 10);
    },
  };
}
