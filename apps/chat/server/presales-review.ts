import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "./db.js";
import { badRequest, conflict, notFound } from "./errors.js";
import type { EvidenceService } from "./evidence/index.js";
import { extractKeywords } from "./evidence/keywords.js";
import { pickTiered, renderTieredBrief } from "./evidence/tiers.js";
import type { LocateResult } from "./evidence/locate.js";
import { childOf } from "./files/paths.js";
import type { FileStore } from "./files/store.js";
import { safeSegment } from "./global-fill-prompts.js";
import { parseResult } from "./analysis/tasks.js";
import {
  applyReplacements,
  countMatches,
  editableKindOf,
} from "./office-edit.js";
import { extractOfficeText, isOfficeFile } from "./office-text.js";
import { textOf } from "./pi/parts.js";
import {
  createCatalog,
  type PresalesSlot,
  type PresalesVersion,
} from "./presales.js";
import { presalesStagingFolder } from "./presales-routes.js";
import {
  crossPrompt,
  crossResultSchema,
  ledgerPrompt,
  ledgerResultSchema,
  reviewPrompt,
  reviewResultSchema,
  type CrossNote,
  type LedgerResult,
  type MaterialMeta,
  type ReviewResult,
  type SiblingContext,
} from "./presales-review-prompts.js";
import type { PresalesTemplates } from "./presales-templates.js";
import type { SessionStore } from "./sessions.js";

/**
 * 售前材料的 AI 审阅（单份）与体系复盘（整库）。
 *
 * ## 修改的依据
 *
 * 第一基于代码、第二基于 PRD、第三基于路线图等其他资料——依据只经平台的定位器取
 * ，这里按材料分段各定位一次，再按三层分预算交给 AI
 * （evidence/tiers.ts）。同库其他材料是第四路：只用来发现说法不一致，不是权威。
 *
 * ## 两种用法
 *
 * - **单份审阅**：一份材料 → 修订清单。其他材料的说法优先用最近一次复盘抽的台账，
 *   没有台账就按本材料的主题从原文里挑片段。
 * - **体系复盘**：先预览（几份、几条对话、多少 token）、确认后服务端自己排队跑：
 *   ① 每份材料抽口径台账 → ② 所有台账放一起比对（腐烂文字 / 上下文不一致 / 与依据不符）
 *   → ③ 每份材料出修订清单（带上 ② 点到它的问题）。保证**每一份都过一遍**。
 *
 * ## 修改怎么落地
 *
 * 修订清单里每条是「原文 → 改为」。人逐条采纳后，在**原文件里替换文字**（office-edit.ts，
 * 保留样式），另存成一个新的**草稿版本**——不覆盖现行版。人预览没问题再设为「可对外」。
 * 原文找不到（跨段落、数字单元格、模型没逐字摘）的条目标「需手改」。
 *
 * ## 为什么服务端自己跑对话
 *
 * 一次审阅的提示词常常超过 10 万字（依据 + 材料全文 + 其他材料），超过对话接口的
 * 单条消息上限，也不该让浏览器来回搬。和「全局 AI 补齐」一样，服务端直接驱动运行器；
 * 每一步仍是一条真对话，可以在对话列表里点开看过程、追问。
 */

export const REVIEW_CONCURRENCY = 2;
/** 交给 AI 的材料正文上限。超出的部分这次审不到，界面与提示词都会说明。 */
const MAX_MATERIAL_CHARS = 45_000;
/** 三层依据各自的正文预算（字符）。 */
const EVIDENCE_BUDGETS = { code: 18_000, prd: 18_000, other: 12_000 } as const;
/** 其他材料的原文片段：每份上限与总上限。 */
const SIBLING_EACH = 1_500;
const SIBLING_TOTAL = 18_000;
/** 口径类材料整份带上（它就是规则），但也要封顶。 */
const CALIBER_MAX = 6_000;
const CALIBER_RE = /口径|措辞|禁区/;
/** 定位时把材料切成几段：定位器只看任务文本前 2000 字。 */
const LOCATE_CHUNKS = 6;
const CHUNK_CHARS = 1_800;
/** 在过半分段里都出现的词算「通篇词」（品牌名、API、平台…），不拿去定位。 */
const UBIQUITOUS_RATIO = 0.5;

type JobKind = "ledger" | "cross" | "review";
type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
type RunStatus = "running" | "done" | "cancelled" | "interrupted";
type Decision = "pending" | "accepted" | "rejected";

/** 存进库的修订条目：模型给的 + 平台算的（命中几处）+ 人的取舍。 */
export interface StoredIssue {
  id: string;
  severity: string;
  type: string;
  original: string;
  replacement: string | null;
  reason: string;
  evidence: string[];
  related: string[];
  /** 原文在审阅那一版文件里能命中几处。0 = 找不到，只能手改。 */
  matches: number;
  decision: Decision;
  /** 已写进某个修订稿。 */
  applied: boolean;
}

export interface StoredReview {
  verdict: string;
  summary: string;
  issues: StoredIssue[];
  gaps: string[];
  /** 材料正文是否被截断（后半部分没审到）。 */
  truncated: boolean;
}

interface JobRow {
  id: string;
  lib_id: string;
  run_id: string | null;
  kind: JobKind;
  slot_id: string | null;
  version_id: string | null;
  session_id: string | null;
  status: JobStatus;
  error: string | null;
  result: string | null;
  applied_version_id: string | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: string;
  lib_id: string;
  status: RunStatus;
  created_at: number;
  finished_at: number | null;
}

class Cancelled extends Error {}

export interface PresalesReviewDeps {
  db: Db;
  files: FileStore;
  store: SessionStore;
  runner: {
    chat(params: {
      sessionId: string;
      message: string;
      onChunk: (chunk: unknown) => void;
      signal: AbortSignal;
    }): Promise<void>;
    abort(sessionId: string): void;
  };
  newHeader: () => unknown;
  templates?: PresalesTemplates;
  evidence?: EvidenceService;
  now?: () => number;
}

export function registerPresalesReview(
  app: FastifyInstance,
  deps: PresalesReviewDeps,
): { idle: () => Promise<void> } {
  const { db, files, store } = deps;
  const now = deps.now ?? Date.now;
  const catalog = createCatalog(db, now, deps.templates);
  const live = new Set<string>();
  /** 测试用：等当前所有任务跑完。 */
  const inflight = new Set<Promise<void>>();

  // 上次退出时还在跑的：单份审阅直接标失败（重新点一次即可），复盘里的回到队列、整批标「中断」。
  db.prepare(
    "UPDATE presales_ai_jobs SET status = 'failed', error = '服务重启时中断，重新发起即可', updated_at = ? WHERE status IN ('running', 'queued') AND run_id IS NULL",
  ).run(now());
  db.prepare(
    "UPDATE presales_ai_jobs SET status = 'queued', error = '服务重启时中断，继续后会重跑', updated_at = ? WHERE status = 'running' AND run_id IS NOT NULL",
  ).run(now());
  db.prepare(
    "UPDATE presales_ai_runs SET status = 'interrupted' WHERE status = 'running'",
  ).run();

  /* ── 读写 ── */

  const jobRow = (id: string): JobRow => {
    const row = db
      .prepare<[string], JobRow>("SELECT * FROM presales_ai_jobs WHERE id = ?")
      .get(id);
    if (row === undefined) throw notFound("审阅任务不存在");
    return row;
  };
  const runRow = (id: string): RunRow => {
    const row = db
      .prepare<[string], RunRow>("SELECT * FROM presales_ai_runs WHERE id = ?")
      .get(id);
    if (row === undefined) throw notFound("复盘不存在");
    return row;
  };
  const jobsOfRun = (runId: string): JobRow[] =>
    db
      .prepare<[string], JobRow>(
        "SELECT * FROM presales_ai_jobs WHERE run_id = ? ORDER BY created_at, rowid",
      )
      .all(runId);
  const setJob = (
    id: string,
    patch: Partial<
      Pick<
        JobRow,
        "status" | "error" | "result" | "session_id" | "applied_version_id"
      >
    >,
  ): void => {
    const row = jobRow(id);
    db.prepare(
      `UPDATE presales_ai_jobs
          SET status = ?, error = ?, result = ?, session_id = ?, applied_version_id = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      patch.status ?? row.status,
      patch.error === undefined ? row.error : patch.error,
      patch.result === undefined ? row.result : patch.result,
      patch.session_id === undefined ? row.session_id : patch.session_id,
      patch.applied_version_id === undefined
        ? row.applied_version_id
        : patch.applied_version_id,
      now(),
      id,
    );
  };
  const insertJob = (input: {
    libId: string;
    runId: string | null;
    kind: JobKind;
    slotId: string | null;
    versionId: string | null;
  }): string => {
    const id = randomUUID();
    const t = now();
    db.prepare(
      `INSERT INTO presales_ai_jobs
         (id, lib_id, run_id, kind, slot_id, version_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
    ).run(
      id,
      input.libId,
      input.runId,
      input.kind,
      input.slotId,
      input.versionId,
      t,
      t,
    );
    return id;
  };

  const libDetail = (libId: string) => {
    const detail = catalog.get(libId);
    if (detail === undefined) throw notFound("售前库不存在");
    return detail;
  };

  const productNameOf = (productId: string | null): string | null =>
    productId === null
      ? null
      : (db
          .prepare<[string], { name: string }>(
            "SELECT name FROM products WHERE id = ?",
          )
          .get(productId)?.name ?? null);

  const stageLabelOf = (libId: string, code: string): string => {
    const lib = libDetail(libId).lib;
    if (lib.templateId === null || deps.templates === undefined) return code;
    try {
      return (
        deps.templates.get(lib.templateId).stages.find((s) => s.code === code)
          ?.label ?? code
      );
    } catch {
      return code;
    }
  };

  /* ── 材料正文 ── */

  const readBytes = async (path: string): Promise<Buffer> => {
    const { stream } = await files.openRead(path);
    const chunks: Buffer[] = [];
    for await (const chunk of stream)
      chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  };

  /** 同一版本的正文抽一次就记住：复盘一次要读十几份 docx 好几遍。 */
  const textCache = new Map<string, { stamp: number; text: string }>();

  type Material =
    | { ok: true; text: string; truncated: boolean; full: string }
    | { ok: false; reason: string };

  const materialText = async (version: PresalesVersion): Promise<Material> => {
    if (version.filePath === null || version.fileName === null)
      return { ok: false, reason: "没有关联文件" };
    if (!files.exists(version.filePath))
      return { ok: false, reason: "文件已不在文件库" };
    const name = version.fileName;
    const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
    const textLike = ["md", "markdown", "txt", "csv"].includes(ext);
    if (!textLike && !isOfficeFile(name))
      return {
        ok: false,
        reason: `「.${ext}」读不出文字，AI 审不了（视频、PDF、图片请人工核对）`,
      };
    const stamp = version.updatedAt;
    const cached = textCache.get(version.id);
    let full: string;
    if (cached?.stamp === stamp) full = cached.text;
    else {
      const bytes = await readBytes(version.filePath);
      if (textLike) full = bytes.toString("utf8");
      else {
        const got = extractOfficeText(name, bytes);
        if (got === null)
          return {
            ok: false,
            reason: "这份 Office 文件读不出文字（可能是纯图片或文件损坏）",
          };
        full = got.text;
      }
      textCache.set(version.id, { stamp, text: full });
    }
    if (full.trim() === "") return { ok: false, reason: "文件里没有文字" };
    return {
      ok: true,
      full,
      text: full.slice(0, MAX_MATERIAL_CHARS),
      truncated: full.length > MAX_MATERIAL_CHARS,
    };
  };

  const metaOf = (
    slot: PresalesSlot,
    version: PresalesVersion,
  ): MaterialMeta => ({
    title: slot.title,
    stageLabel: stageLabelOf(slot.libId, slot.stage),
    audience: slot.audience,
    required: slot.priority,
    templateItemName: slot.templateItem?.name ?? null,
    guide: slot.guide,
    checkpoints: slot.checkpoints,
    version: version.version,
    fileName: version.fileName ?? "",
  });

  /* ── 事实依据（分层） ── */

  /**
   * 生命周期比对里认定为 PRD 的文件。比路径猜更准：它是 AI 逐份看过文件名、
   * 对着「需求规格（PRD）」这一项判出来的。
   */
  const prdPathsOf = (productId: string | null): Set<string> => {
    if (productId === null) return new Set();
    const row = db
      .prepare<[string], { findings: string }>(
        "SELECT findings FROM product_checks WHERE product_id = ?",
      )
      .get(productId);
    if (row === undefined) return new Set();
    try {
      const findings = JSON.parse(row.findings) as {
        artifact?: string;
        files?: string[];
      }[];
      return new Set(
        findings
          .filter((f) => /PRD|需求规格/i.test(f.artifact ?? ""))
          .flatMap((f) => f.files ?? []),
      );
    } catch {
      return new Set();
    }
  };

  /** 按几段任务文本分别定位、分层合并，写成依据段。 */
  const tieredEvidence = async (
    productId: string | null,
    tasks: readonly string[],
  ): Promise<string> => {
    const results: LocateResult[] = [];
    if (productId !== null && deps.evidence !== undefined) {
      for (const task of tasks) {
        if (task.trim() === "") continue;
        try {
          results.push(
            await deps.evidence.locate({ productId }, task, {
              limits: { docs: 10, code: 8 },
              budget: 100_000,
            }),
          );
        } catch {
          // 一段定位失败不影响其它段。
        }
      }
      if (results.length === 0) {
        // 一次都没成：至少交代依据范围，免得 AI 以为什么都没绑。
        results.push({
          library: deps.evidence.library({ productId }),
          searched: deps.evidence.library({ productId }).sources,
          keywords: [],
          hits: [],
          files: [],
          skipped: [],
          truncated: [],
          elapsedMs: 0,
        });
      }
    }
    // 代码层只认「有实词命中」的：只命中 sec / ops / key 这种三四个字母的缩写，
    // 在大仓里能撞上几百个文件，挑出来的多半是迁移脚本，白占预算还误导 AI。
    const meaningful = (term: string): boolean =>
      /[\u4e00-\u9fff]/.test(term) || term.length >= 5;
    const filtered = results.map((r) => ({
      ...r,
      files: r.files.filter(
        (f) => f.kind !== "code" || f.matched.some(meaningful),
      ),
    }));
    return renderTieredBrief(
      pickTiered(filtered, {
        prdPaths: prdPathsOf(productId),
        budgets: { ...EVIDENCE_BUDGETS },
      }),
    );
  };

  /**
   * 材料切成几段当定位任务：开头一段放材料名与模板说明。
   *
   * 每段先剥掉**通篇词**再交给定位器。真实库上实测：白皮书里每段都有 RouteHub、
   * API Key、模型，不剥的话关键词全被它们占满，代码层挑出来的是「API Key 绑定模型」
   * 这类和本段内容无关的文件。判定口径：在过半分段里都出现，或者就是产品 / 库名的一部分。
   */
  const locateTasks = (
    meta: MaterialMeta,
    text: string,
    names: readonly string[],
  ): string[] => {
    const windows: string[] = [];
    if (text.length <= CHUNK_CHARS * LOCATE_CHUNKS) {
      for (let i = 0; i < text.length; i += CHUNK_CHARS)
        windows.push(text.slice(i, i + CHUNK_CHARS));
    } else {
      const step = Math.floor(text.length / LOCATE_CHUNKS);
      for (let i = 0; i < LOCATE_CHUNKS; i++)
        windows.push(text.slice(i * step, i * step + CHUNK_CHARS));
    }
    const head = [meta.title, meta.guide, ...meta.checkpoints].join("\n");
    return [head, ...stripUbiquitous(windows, names)];
  };

  /* ── 其他材料 ── */

  /** 最近一次复盘里，某个版本抽出来的台账。版本变了就不算。 */
  const ledgerOf = (versionId: string): LedgerResult | null => {
    const row = db
      .prepare<[string], { result: string }>(
        `SELECT result FROM presales_ai_jobs
          WHERE kind = 'ledger' AND version_id = ? AND status = 'done' AND result IS NOT NULL
          ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(versionId);
    if (row === undefined) return null;
    try {
      return ledgerResultSchema.parse(JSON.parse(row.result));
    } catch {
      return null;
    }
  };

  const renderLedger = (l: LedgerResult): string =>
    l.claims.map((c) => `- [${c.category}] ${c.topic}：${c.claim}`).join("\n");

  /** 按本材料的主题，从别的材料原文里挑几行。 */
  const excerptFor = (target: string, sibling: string): string => {
    const terms = extractKeywords(target, 40)
      .filter((k) => k.weight >= 2)
      .map((k) => k.term);
    const lines = sibling
      .split("\n")
      .map((line, i) => ({ line: line.trim(), i }))
      .filter((x) => x.line.length >= 6);
    const scored = lines
      .map((x) => ({
        ...x,
        score: terms.filter((t) => x.line.toLowerCase().includes(t)).length,
      }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    const picked: typeof scored = [];
    let used = 0;
    for (const x of scored) {
      if (used + x.line.length > SIBLING_EACH) continue;
      picked.push(x);
      used += x.line.length;
    }
    if (picked.length === 0)
      return sibling.slice(0, Math.min(600, SIBLING_EACH));
    return picked
      .sort((a, b) => a.i - b.i)
      .map((x) => x.line)
      .join("\n");
  };

  const othersOf = async (
    libId: string,
    selfSlotId: string,
    targetText: string,
    caliberOnly = false,
  ): Promise<{
    siblings: SiblingContext[];
    caliber: { title: string; text: string }[];
  }> => {
    const siblings: SiblingContext[] = [];
    const caliber: { title: string; text: string }[] = [];
    let used = 0;
    for (const s of libDetail(libId).slots) {
      if (s.id === selfSlotId || s.current === null) continue;
      const isCaliber =
        CALIBER_RE.test(s.title) || CALIBER_RE.test(s.templateItem?.name ?? "");
      if (caliberOnly && !isCaliber) continue;
      const ledger = ledgerOf(s.current.id);
      const got =
        ledger === null || isCaliber ? await materialText(s.current) : null;
      if (isCaliber && got?.ok === true) {
        caliber.push({ title: s.title, text: got.full.slice(0, CALIBER_MAX) });
        continue;
      }
      if (used >= SIBLING_TOTAL) continue;
      let body: string;
      let source: SiblingContext["source"];
      if (ledger !== null) {
        body = renderLedger(ledger);
        source = "ledger";
      } else if (got?.ok === true) {
        body = excerptFor(targetText, got.full);
        source = "excerpt";
      } else continue;
      body = body.slice(0, Math.max(0, SIBLING_TOTAL - used));
      used += body.length;
      siblings.push({ title: s.title, audience: s.audience, source, body });
    }
    return { siblings, caliber };
  };

  /* ── 对话 ── */

  const assistantText = (sessionId: string): string =>
    store
      .entries(sessionId)
      .map((entry) => {
        if (entry === null || typeof entry !== "object") return "";
        const e = entry as {
          type?: unknown;
          message?: { role?: unknown; content?: unknown };
        };
        if (e.type !== "message" || e.message?.role !== "assistant") return "";
        return textOf(e.message.content);
      })
      .filter((t) => t !== "")
      .join("\n\n");

  const converse = async (
    job: JobRow,
    title: string,
    productId: string | null,
    prompt: string,
  ): Promise<string> => {
    const header = deps.newHeader() as { id: string };
    const session = store.create({
      id: header.id,
      title,
      header,
      productId,
      task: {
        kind: "presales-ai",
        libId: job.lib_id,
        jobId: job.id,
        job: job.kind,
      },
    });
    setJob(job.id, { session_id: session.id });
    const state: { failed: string | null } = { failed: null };
    live.add(session.id);
    try {
      await deps.runner.chat({
        sessionId: session.id,
        message: prompt,
        signal: new AbortController().signal,
        onChunk: (raw) => {
          const chunk = raw as {
            type?: string;
            finishReason?: string;
            data?: { message?: string };
          };
          if (chunk.type === "data-error")
            state.failed = chunk.data?.message ?? "对话出错";
          if (
            chunk.type === "finish" &&
            chunk.finishReason === "error" &&
            state.failed === null
          )
            state.failed = "对话出错";
        },
      });
    } finally {
      live.delete(session.id);
    }
    if (jobRow(job.id).status !== "running") throw new Cancelled("已停止");
    if (state.failed !== null) throw new Error(state.failed);
    return session.id;
  };

  /* ── 取结果 ── */

  /** 修订清单落库前的加工：原文去首尾空白、在审阅那一版文件里数命中、补上取舍。 */
  const storeReview = async (
    version: PresalesVersion,
    parsed: ReviewResult,
    truncated: boolean,
    previous: StoredReview | null,
  ): Promise<StoredReview> => {
    const issues = parsed.issues.map((i) => ({
      ...i,
      original: i.original.trim(),
    }));
    let counts: (number | null)[] = issues.map(() => null);
    if (version.filePath !== null && version.fileName !== null) {
      try {
        const bytes = await readBytes(version.filePath);
        counts =
          countMatches(
            version.fileName,
            bytes,
            issues.map((i) => i.original),
          ) ?? counts;
      } catch {
        // 读不到文件：命中数全记 0，采纳时会如实失败。
      }
    }
    // 重新取结果时，人已经做过的取舍按「原文 + 改为」认回来，不让追问一次就清空。
    const keep = new Map(
      (previous?.issues ?? []).map((i) => [
        `${i.original}\u0000${i.replacement ?? ""}`,
        i,
      ]),
    );
    return {
      verdict: parsed.verdict,
      summary: parsed.summary,
      gaps: parsed.gaps,
      truncated,
      issues: issues.map((i, n) => {
        const old = keep.get(`${i.original}\u0000${i.replacement ?? ""}`);
        return {
          id: String(n + 1),
          severity: i.severity,
          type: i.type,
          original: i.original,
          replacement: i.replacement,
          reason: i.reason,
          evidence: i.evidence,
          related: i.related,
          matches: i.original === "" ? 0 : (counts[n] ?? 0),
          decision: old?.decision ?? "pending",
          applied: old?.applied ?? false,
        };
      }),
    };
  };

  const parseStored = (job: JobRow): unknown =>
    job.result === null ? null : (JSON.parse(job.result) as unknown);

  /** 从会话里取结果、校验、落库。runJob 与「重新取结果」共用。 */
  const collect = async (job: JobRow): Promise<void> => {
    if (job.session_id === null) throw badRequest("这一步还没开始对话");
    const text = assistantText(job.session_id);
    if (text.trim() === "") throw badRequest("还没有回答，等它答完再取。");
    if (job.kind === "ledger") {
      const parsed = parseResult(text, ledgerResultSchema);
      setJob(job.id, { result: JSON.stringify(parsed) });
      return;
    }
    if (job.kind === "cross") {
      const parsed = parseResult(text, crossResultSchema);
      setJob(job.id, { result: JSON.stringify(parsed) });
      return;
    }
    const parsed = parseResult(text, reviewResultSchema);
    const version = versionOf(job);
    const material = await materialText(version);
    const stored = await storeReview(
      version,
      parsed,
      material.ok && material.truncated,
      (parseStored(job) as StoredReview | null) ?? null,
    );
    setJob(job.id, { result: JSON.stringify(stored) });
  };

  const slotOf = (job: JobRow): PresalesSlot => {
    if (job.slot_id === null) throw notFound("材料条目不存在");
    const slot = catalog.slotOf(job.slot_id);
    if (slot === undefined) throw notFound("材料条目已被删除");
    return slot;
  };
  const versionOf = (job: JobRow): PresalesVersion => {
    const slot = slotOf(job);
    const version = slot.versions.find((v) => v.id === job.version_id);
    if (version === undefined) throw notFound("审阅的那一版已被删除");
    return version;
  };

  /* ── 跑一步 ── */

  const runJob = async (job: JobRow): Promise<void> => {
    const lib = libDetail(job.lib_id).lib;
    const productName = productNameOf(lib.productId);

    if (job.kind === "ledger") {
      const slot = slotOf(job);
      const version = versionOf(job);
      const material = await materialText(version);
      if (!material.ok) throw new Error(material.reason);
      await converse(
        job,
        `售前复盘 · 台账：${slot.title}`,
        lib.productId,
        ledgerPrompt({
          libName: lib.name,
          material: metaOf(slot, version),
          text: material.text,
          truncated: material.truncated,
        }),
      );
      await collect(jobRow(job.id));
      return;
    }

    if (job.kind === "cross") {
      if (job.run_id === null) throw new Error("比对只在体系复盘里跑");
      const ledgerJobs = jobsOfRun(job.run_id).filter(
        (j) => j.kind === "ledger",
      );
      const ledgers: Parameters<typeof crossPrompt>[0]["ledgers"][number][] =
        [];
      const missing: { title: string; reason: string }[] = [];
      for (const lj of ledgerJobs) {
        let slot: PresalesSlot;
        try {
          slot = slotOf(lj);
        } catch {
          continue;
        }
        const version = slot.versions.find((v) => v.id === lj.version_id);
        const result =
          lj.status === "done" && lj.result !== null
            ? ledgerResultSchema.safeParse(JSON.parse(lj.result))
            : null;
        if (result?.success !== true || version === undefined) {
          missing.push({
            title: slot.title,
            reason: lj.error ?? "台账没抽出来",
          });
          continue;
        }
        ledgers.push({
          title: slot.title,
          audience: slot.audience,
          stageLabel: stageLabelOf(slot.libId, slot.stage),
          fileName: version.fileName ?? "",
          claims: result.data.claims,
        });
      }
      if (ledgers.length === 0)
        throw new Error("没有一份材料抽出了台账，比对不了");
      const { caliber } = await othersOf(job.lib_id, "", "", true);
      const evidence = await tieredEvidence(
        lib.productId,
        ledgers.map((l) =>
          [l.title, ...l.claims.map((c) => `${c.topic} ${c.claim}`)].join("\n"),
        ),
      );
      await converse(
        job,
        `售前复盘 · 跨材料比对：${lib.name}`,
        lib.productId,
        crossPrompt({
          libName: lib.name,
          productName,
          evidence,
          ledgers,
          missing,
          caliber,
        }),
      );
      await collect(jobRow(job.id));
      return;
    }

    // review
    const slot = slotOf(job);
    const version = versionOf(job);
    const material = await materialText(version);
    if (!material.ok) throw new Error(material.reason);
    const meta = metaOf(slot, version);
    const [evidence, others] = await Promise.all([
      tieredEvidence(
        lib.productId,
        locateTasks(meta, material.text, [lib.name, productName ?? ""]),
      ),
      othersOf(job.lib_id, slot.id, material.text),
    ]);
    const crossNotes: CrossNote[] = [];
    if (job.run_id !== null) {
      const cross = jobsOfRun(job.run_id).find(
        (j) => j.kind === "cross" && j.status === "done" && j.result !== null,
      );
      if (cross?.result != null) {
        const parsed = crossResultSchema.safeParse(JSON.parse(cross.result));
        if (parsed.success)
          for (const i of parsed.data.issues) {
            if (i.materials.some((m) => m.trim() === slot.title))
              crossNotes.push(i);
          }
      }
    }
    await converse(
      job,
      `售前审阅：${slot.title}（${version.version}）`,
      lib.productId,
      reviewPrompt({
        libName: lib.name,
        productName,
        evidence,
        material: meta,
        text: material.text,
        truncated: material.truncated,
        siblings: others.siblings,
        caliber: others.caliber,
        crossNotes,
      }),
    );
    await collect(jobRow(job.id));
  };

  /* ── 排队 ── */

  /** 复盘推进：台账都结束 → 建比对；比对结束 → 每份材料建修订；修订都结束 → 收尾。 */
  const advance = (runId: string): void => {
    const run = runRow(runId);
    if (run.status !== "running") return;
    const jobs = jobsOfRun(runId);
    const settled = (j: JobRow) =>
      j.status !== "queued" && j.status !== "running";
    const ledgers = jobs.filter((j) => j.kind === "ledger");
    const cross = jobs.find((j) => j.kind === "cross");
    const reviews = jobs.filter((j) => j.kind === "review");
    if (cross === undefined) {
      if (ledgers.every(settled))
        insertJob({
          libId: run.lib_id,
          runId,
          kind: "cross",
          slotId: null,
          versionId: null,
        });
      return;
    }
    if (reviews.length === 0) {
      if (settled(cross))
        for (const l of ledgers)
          insertJob({
            libId: run.lib_id,
            runId,
            kind: "review",
            slotId: l.slot_id,
            versionId: l.version_id,
          });
      return;
    }
    if (reviews.every(settled))
      db.prepare(
        "UPDATE presales_ai_runs SET status = 'done', finished_at = ? WHERE id = ?",
      ).run(now(), runId);
  };

  let pumping = false;
  const pump = (): void => {
    if (pumping) return;
    pumping = true;
    try {
      const running =
        db
          .prepare<[], { n: number }>(
            "SELECT COUNT(*) AS n FROM presales_ai_jobs WHERE status = 'running'",
          )
          .get()?.n ?? 0;
      const free = REVIEW_CONCURRENCY - running;
      if (free <= 0) return;
      // 单份审阅优先（人在等），复盘里的按建的先后。
      const queued = db
        .prepare<[number], JobRow>(
          `SELECT j.* FROM presales_ai_jobs j
             LEFT JOIN presales_ai_runs r ON r.id = j.run_id
            WHERE j.status = 'queued' AND (j.run_id IS NULL OR r.status = 'running')
            ORDER BY (j.run_id IS NOT NULL), j.created_at, j.rowid
            LIMIT ?`,
        )
        .all(free);
      for (const job of queued) {
        setJob(job.id, { status: "running", error: null });
        const p = runJob(job)
          .then(() => {
            if (jobRow(job.id).status === "running")
              setJob(job.id, { status: "done", error: null });
          })
          .catch((cause: unknown) => {
            const stillRunning = (() => {
              try {
                return jobRow(job.id).status === "running";
              } catch {
                return false; // 库或条目已删
              }
            })();
            if (!stillRunning) return;
            setJob(job.id, {
              status: cause instanceof Cancelled ? "cancelled" : "failed",
              error: cause instanceof Error ? cause.message : "失败",
            });
          })
          .finally(() => {
            inflight.delete(p);
            try {
              if (job.run_id !== null) advance(job.run_id);
            } catch {
              // 复盘被删了。
            }
            pump();
          });
        inflight.add(p);
      }
    } finally {
      pumping = false;
    }
  };

  /* ── 视图 ── */

  const versionView = (id: string | null): PresalesVersion | null => {
    if (id === null) return null;
    return catalog.versionOf(id) ?? null;
  };

  const jobView = (row: JobRow, withResult = true) => {
    let result: unknown = null;
    if (withResult) {
      try {
        result = parseStored(row);
      } catch {
        result = null;
      }
    }
    const base = versionView(row.version_id);
    return {
      id: row.id,
      libId: row.lib_id,
      runId: row.run_id,
      kind: row.kind,
      slotId: row.slot_id,
      versionId: row.version_id,
      sessionId: row.session_id,
      status: row.status,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      baseVersion:
        base === null
          ? null
          : { id: base.id, version: base.version, fileName: base.fileName },
      appliedVersion: versionView(row.applied_version_id),
      result,
    };
  };

  /** 修订清单的计数摘要：材料列表上一行一个小标。 */
  const reviewBrief = (row: JobRow) => {
    let issues: StoredIssue[] = [];
    let verdict: string | null = null;
    try {
      const r = parseStored(row) as StoredReview | null;
      issues = r?.issues ?? [];
      verdict = r?.verdict ?? null;
    } catch {
      // 结果损坏：当没有。
    }
    return {
      ...jobView(row, false),
      verdict,
      counts: {
        total: issues.length,
        p0: issues.filter((i) => i.severity === "P0").length,
        pending: issues.filter((i) => i.decision === "pending").length,
        accepted: issues.filter((i) => i.decision === "accepted").length,
        applied: issues.filter((i) => i.applied).length,
      },
    };
  };

  const runView = (run: RunRow) => {
    const jobs = jobsOfRun(run.id);
    const cross = jobs.find((j) => j.kind === "cross");
    const by = (kind: JobKind) => {
      const list = jobs.filter((j) => j.kind === kind);
      return {
        total: list.length,
        done: list.filter((j) => j.status === "done").length,
        failed: list.filter((j) => j.status === "failed").length,
        running: list.filter((j) => j.status === "running").length,
      };
    };
    const materials = jobs.filter((j) => j.kind === "ledger").length;
    return {
      id: run.id,
      libId: run.lib_id,
      status: run.status,
      createdAt: run.created_at,
      finishedAt: run.finished_at,
      materials,
      phase:
        cross === undefined
          ? ("ledger" as const)
          : jobs.some((j) => j.kind === "review")
            ? ("review" as const)
            : ("cross" as const),
      progress: {
        ledger: by("ledger"),
        cross: by("cross"),
        review: by("review"),
      },
      cross: cross === undefined ? null : jobView(cross),
      reviews: jobs.filter((j) => j.kind === "review").map(reviewBrief),
      failures: jobs
        .filter((j) => j.status === "failed")
        .map((j) => ({
          id: j.id,
          kind: j.kind,
          slotId: j.slot_id,
          error: j.error,
          sessionId: j.session_id,
        })),
    };
  };

  /* ── 预览 ── */

  const planOf = async (libId: string) => {
    const detail = libDetail(libId);
    const materials: {
      slotId: string;
      title: string;
      versionId: string;
      fileName: string;
      chars: number;
    }[] = [];
    const skipped: { slotId: string; title: string; reason: string }[] = [];
    for (const s of detail.slots) {
      if (s.current === null) {
        skipped.push({
          slotId: s.id,
          title: s.title,
          reason: "缺口：没有现行版",
        });
        continue;
      }
      const got = await materialText(s.current);
      if (!got.ok) {
        skipped.push({ slotId: s.id, title: s.title, reason: got.reason });
        continue;
      }
      materials.push({
        slotId: s.id,
        title: s.title,
        versionId: s.current.id,
        fileName: s.current.fileName ?? "",
        chars: got.full.length,
      });
    }
    const planId = createHash("sha256")
      .update(
        JSON.stringify(
          detail.slots.map((s) => [s.id, s.current?.id, s.current?.updatedAt]),
        ),
      )
      .digest("hex")
      .slice(0, 16);
    // token 粗估：中文约 0.7 token/字。台账 = 材料；比对 = 台账 + 依据；修订 = 材料 + 依据 + 其他材料。
    const evidence = Object.values(EVIDENCE_BUDGETS).reduce((a, b) => a + b, 0);
    const chars = materials.reduce(
      (sum, m) =>
        sum +
        Math.min(m.chars, MAX_MATERIAL_CHARS) * 2 +
        evidence +
        SIBLING_TOTAL +
        8_000,
      materials.length === 0 ? 0 : evidence + materials.length * 3_000,
    );
    const tokens = Math.round(chars * 0.7);
    return {
      planId,
      libId,
      libName: detail.lib.name,
      hasProduct: detail.lib.productId !== null,
      materials,
      skipped,
      templateGaps: detail.templateGaps,
      sessions: materials.length === 0 ? 0 : materials.length * 2 + 1,
      tokens: { min: Math.round(tokens * 0.7), max: Math.round(tokens * 1.3) },
    };
  };

  const latestRun = (libId: string): RunRow | undefined =>
    db
      .prepare<[string], RunRow>(
        "SELECT * FROM presales_ai_runs WHERE lib_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(libId);

  /* ── 采纳 ── */

  const bumpMinor = (version: string, taken: readonly string[]): string => {
    const m = /^v?(\d+)(?:\.(\d+))?/i.exec(version);
    let major = m === null ? 1 : Number(m[1]);
    let minor = m === null ? 0 : Number(m[2] ?? 0);
    for (;;) {
      minor += 1;
      const next = `v${String(major)}.${String(minor)}`;
      if (!taken.includes(next)) return next;
      if (minor > 999) {
        major += 1;
        minor = -1;
      }
    }
  };

  const applyJob = async (job: JobRow) => {
    if (job.kind !== "review") throw badRequest("只有修订清单能采纳");
    if (job.status !== "done") throw badRequest("这份审阅还没完成");
    const stored = parseStored(job) as StoredReview | null;
    if (stored === null) throw badRequest("这份审阅没有结果");
    const picked = stored.issues.filter(
      (i) =>
        i.decision === "accepted" &&
        !i.applied &&
        i.replacement !== null &&
        i.original !== "" &&
        i.matches > 0,
    );
    if (picked.length === 0)
      throw badRequest(
        "没有可以写进文件的条目：先勾选「采纳」，且只有能在原文件里找到原文、给了改法的条目才能自动替换。",
      );
    const slot = slotOf(job);
    const base = versionOf(job);
    if (base.filePath === null || base.fileName === null)
      throw notFound("审阅的那一版没有文件");
    if (!files.exists(base.filePath))
      throw conflict("审阅的那一版文件已不在文件库，没法在它上面改");
    if (editableKindOf(base.fileName) === null)
      throw badRequest("这种格式不支持在原文件里修改");

    const bytes = await readBytes(base.filePath);
    let out: ReturnType<typeof applyReplacements>;
    try {
      out = applyReplacements(
        base.fileName,
        bytes,
        picked.map((i) => ({
          original: i.original,
          replacement: i.replacement ?? "",
        })),
      );
    } catch {
      throw conflict("原文件解不开（可能已损坏），没法自动修改");
    }
    const done = new Set(
      picked.filter((_, n) => (out.counts[n] ?? 0) > 0).map((i) => i.id),
    );
    if (done.size === 0)
      throw conflict(
        "采纳的条目在原文件里一条都没找到（可能文件被改过），请手改或重新审阅。",
      );

    const lib = libDetail(slot.libId).lib;
    const nextVersion = bumpMinor(
      base.version,
      slot.versions.map((v) => v.version),
    );
    const dot = base.fileName.lastIndexOf(".");
    const stem = dot > 0 ? base.fileName.slice(0, dot) : base.fileName;
    const ext = dot > 0 ? base.fileName.slice(dot) : "";
    // 修订版先落临时区；设为现行版时才搬进 /售前/<库名>/（presales-routes.ts promoteVersion）。
    const folder = presalesStagingFolder(lib.name, "AI修订");
    const { entry } = await files.write(
      childOf(folder, safeSegment(`${stem}（AI修订 ${nextVersion}）${ext}`)),
      out.bytes,
      { mode: "autorename", parents: true },
    );
    const version = catalog.addVersion(slot.id, {
      version: nextVersion,
      status: "draft",
      note: `AI 修订：在 ${base.version} 上采纳 ${String(done.size)} 条（${picked
        .filter((i) => done.has(i.id))
        .map((i) => `#${i.id}`)
        .join(" ")}）`,
      filePath: entry.path,
      fileName: entry.name,
      fileSize: entry.size,
    });
    const next: StoredReview = {
      ...stored,
      issues: stored.issues.map((i) =>
        done.has(i.id) ? { ...i, applied: true } : i,
      ),
    };
    setJob(job.id, {
      result: JSON.stringify(next),
      applied_version_id: version.id,
    });
    return {
      version,
      applied: [...done],
      missed: picked.filter((i) => !done.has(i.id)).map((i) => i.id),
    };
  };

  /* ── 路由 ── */

  const idParams = z.object({ id: z.string() });

  /** 一本库的 AI 状态：最近一次复盘 + 每份材料最近一次审阅。 */
  app.get("/api/presales/:id/ai", (request) => {
    const { id } = idParams.parse(request.params);
    libDetail(id);
    const run = latestRun(id);
    const rows = db
      .prepare<[string], JobRow>(
        `SELECT * FROM presales_ai_jobs
          WHERE lib_id = ? AND kind = 'review'
          ORDER BY created_at DESC, rowid DESC`,
      )
      .all(id);
    const latest = new Map<string, JobRow>();
    for (const r of rows)
      if (r.slot_id !== null && !latest.has(r.slot_id))
        latest.set(r.slot_id, r);
    return {
      run: run === undefined ? null : runView(run),
      reviews: Object.fromEntries(
        [...latest].map(([slotId, r]) => [slotId, reviewBrief(r)]),
      ),
      busy:
        (db
          .prepare<[string], { n: number }>(
            "SELECT COUNT(*) AS n FROM presales_ai_jobs WHERE lib_id = ? AND status IN ('queued', 'running')",
          )
          .get(id)?.n ?? 0) > 0,
    };
  });

  app.get("/api/presales/:id/ai/plan", async (request) => {
    const { id } = idParams.parse(request.params);
    return planOf(id);
  });

  /** 发起体系复盘：带预览给的 planId（预览之后材料变了就作废）。不再要求手打确认语。 */
  app.post("/api/presales/:id/ai/runs", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ planId: z.string() }).parse(request.body);
    const plan = await planOf(id);
    if (plan.planId !== body.planId)
      throw conflict("材料在预览之后有变动，请重新预览再确认。");
    if (plan.materials.length === 0)
      throw badRequest("这本库没有能读出文字的现行材料，没什么可复盘的");
    const busy = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM presales_ai_runs WHERE lib_id = ? AND status IN ('running', 'interrupted')",
      )
      .get(id);
    if (busy !== undefined)
      throw conflict(
        "这本库已有一次复盘在跑（或被中断待继续），先停掉或继续它。",
      );
    const runId = randomUUID();
    db.transaction(() => {
      db.prepare(
        "INSERT INTO presales_ai_runs (id, lib_id, status, created_at) VALUES (?, ?, 'running', ?)",
      ).run(runId, id, now());
      for (const m of plan.materials)
        insertJob({
          libId: id,
          runId,
          kind: "ledger",
          slotId: m.slotId,
          versionId: m.versionId,
        });
    })();
    pump();
    return reply.code(201).send(runView(runRow(runId)));
  });

  app.post("/api/presales/ai/runs/:id/cancel", (request) => {
    const { id } = idParams.parse(request.params);
    const run = runRow(id);
    if (run.status !== "running" && run.status !== "interrupted")
      return runView(run);
    db.transaction(() => {
      db.prepare(
        "UPDATE presales_ai_runs SET status = 'cancelled', finished_at = ? WHERE id = ?",
      ).run(now(), id);
      db.prepare(
        "UPDATE presales_ai_jobs SET status = 'cancelled', updated_at = ? WHERE run_id = ? AND status IN ('queued', 'running')",
      ).run(now(), id);
    })();
    for (const j of jobsOfRun(id))
      if (j.session_id !== null && live.has(j.session_id))
        deps.runner.abort(j.session_id);
    return runView(runRow(id));
  });

  /** 继续：中断的接着跑；失败 / 停掉的那几步重排。 */
  app.post("/api/presales/ai/runs/:id/resume", (request) => {
    const { id } = idParams.parse(request.params);
    const run = runRow(id);
    if (run.status === "running") return runView(run);
    db.transaction(() => {
      db.prepare(
        "UPDATE presales_ai_runs SET status = 'running', finished_at = NULL WHERE id = ?",
      ).run(id);
      db.prepare(
        "UPDATE presales_ai_jobs SET status = 'queued', error = NULL, updated_at = ? WHERE run_id = ? AND status IN ('failed', 'cancelled')",
      ).run(now(), id);
    })();
    advance(id);
    pump();
    return runView(runRow(id));
  });

  /** 单份审阅：审这一类材料的现行版（或指定版本）。 */
  app.post("/api/presales/slots/:id/ai/review", (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { versionId } = z
      .object({ versionId: z.string().optional() })
      .parse(request.body ?? {});
    const slot = catalog.slotOf(id);
    if (slot === undefined) throw notFound("材料条目不存在");
    const version =
      versionId === undefined
        ? slot.current
        : (slot.versions.find((v) => v.id === versionId) ?? null);
    if (version === null)
      throw badRequest("这一类还没有现行版，先上传或登记一份文件");
    const running = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM presales_ai_jobs WHERE slot_id = ? AND kind = 'review' AND status IN ('queued', 'running')",
      )
      .get(id);
    if (running !== undefined)
      throw conflict("这份材料已有一次审阅在进行，等它完成");
    const jobId = insertJob({
      libId: slot.libId,
      runId: null,
      kind: "review",
      slotId: slot.id,
      versionId: version.id,
    });
    pump();
    return reply.code(201).send(jobView(jobRow(jobId)));
  });

  app.get("/api/presales/ai/jobs/:id", (request) => {
    const { id } = idParams.parse(request.params);
    return jobView(jobRow(id));
  });

  /** 在对话里追问之后：重新从会话里取结果（人做过的取舍按原文认回）。 */
  app.post("/api/presales/ai/jobs/:id/collect", async (request) => {
    const { id } = idParams.parse(request.params);
    const job = jobRow(id);
    if (job.status === "running" || job.status === "queued")
      throw conflict("还在跑，等它答完");
    await collect(job);
    setJob(id, { status: "done", error: null });
    if (job.run_id !== null) {
      advance(job.run_id);
      pump();
    }
    return jobView(jobRow(id));
  });

  app.post("/api/presales/ai/jobs/:id/decisions", (request) => {
    const { id } = idParams.parse(request.params);
    const { decisions } = z
      .object({
        decisions: z.record(
          z.string(),
          z.enum(["pending", "accepted", "rejected"]),
        ),
      })
      .parse(request.body);
    const job = jobRow(id);
    if (job.kind !== "review") throw badRequest("只有修订清单能逐条取舍");
    const stored = parseStored(job) as StoredReview | null;
    if (stored === null) throw badRequest("这份审阅还没有结果");
    const next: StoredReview = {
      ...stored,
      issues: stored.issues.map((i) => {
        const d = decisions[i.id];
        return d === undefined || i.applied ? i : { ...i, decision: d };
      }),
    };
    setJob(id, { result: JSON.stringify(next) });
    return jobView(jobRow(id));
  });

  /** 按已采纳的条目在原文件里替换，另存成草稿版本。 */
  app.post("/api/presales/ai/jobs/:id/apply", async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const out = await applyJob(jobRow(id));
    return reply.code(201).send({ ...out, job: jobView(jobRow(id)) });
  });

  /** 复盘收尾：每份材料按各自已采纳的条目一次性生成修订稿。 */
  app.post("/api/presales/ai/runs/:id/apply", async (request) => {
    const { id } = idParams.parse(request.params);
    runRow(id);
    const results: {
      jobId: string;
      slotId: string | null;
      ok: boolean;
      message: string;
      versionId?: string;
    }[] = [];
    for (const job of jobsOfRun(id).filter(
      (j) => j.kind === "review" && j.status === "done",
    )) {
      try {
        const out = await applyJob(job);
        results.push({
          jobId: job.id,
          slotId: job.slot_id,
          ok: true,
          versionId: out.version.id,
          message: `写入 ${String(out.applied.length)} 条${out.missed.length > 0 ? `，${String(out.missed.length)} 条没找到原文` : ""}`,
        });
      } catch (cause) {
        results.push({
          jobId: job.id,
          slotId: job.slot_id,
          ok: false,
          message: cause instanceof Error ? cause.message : "失败",
        });
      }
    }
    return { results };
  });

  // 服务起来时把中断前排着的单份审阅之外的东西接着推（复盘要人点「继续」）。
  pump();

  return {
    async idle() {
      while (inflight.size > 0) await Promise.all([...inflight]);
    },
  };
}

/**
 * 剥掉通篇词：在过半分段里都出现的关键词，以及产品 / 库名拆出来的词。
 * 纯函数，导出给单测。
 */
export function stripUbiquitous(
  windows: readonly string[],
  names: readonly string[],
): string[] {
  const per = windows.map(
    (w) => new Set(extractKeywords(w, 40).map((k) => k.term)),
  );
  const counts = new Map<string, number>();
  for (const set of per)
    for (const t of set) counts.set(t, (counts.get(t) ?? 0) + 1);
  const noise = new Set(
    [...counts]
      .filter(
        ([, n]) => windows.length >= 3 && n / windows.length > UBIQUITOUS_RATIO,
      )
      .map(([t]) => t),
  );
  for (const name of names)
    for (const k of extractKeywords(name, 20)) noise.add(k.term);
  // 长词先剥：先剥 routehub，再剥 cloud，避免剩下 router 半截。
  const terms = [...noise].sort((a, b) => b.length - a.length);
  return windows.map((w) => {
    let out = w;
    for (const t of terms) {
      const re = new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      out = out.replace(re, " ");
    }
    return out;
  });
}
