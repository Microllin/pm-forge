import { createHash, randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "./db.js";
import { badRequest, conflict, notFound } from "./errors.js";
import type { FileStore } from "./files/store.js";
import { createLifecycle } from "./lifecycle.js";
import { createCatalog, type Product } from "./products.js";
import type { SessionStore } from "./sessions.js";
import { createWiki, type WikiNode } from "./wiki.js";
import { BUILTIN_WIKI } from "./wiki-builtin.js";
import { scanFolder, type ScanResult } from "./analysis/scan.js";
import { STAGING_DIRS } from "./staging/paths.js";
import type { NormalizedFinding } from "./analysis/tasks.js";
import {
  artifactDraftPrompt,
  safeRelativeName,
  safeSegment,
} from "./global-fill-prompts.js";

/**
 * 全局 AI 补齐：一次把所有产品「生命周期里缺的产出物」「Wiki 里没写的章节」都让 AI 起草出来。
 *
 * ## 为什么做得这么拘谨
 *
 * 这是平台里最贵的一个按钮：一次可能开上百条对话、烧掉几百万 token，而且产出的是
 * **会被当成正式文档的东西**。所以三道闸（2026-10-22 起取消手打确认语，产品负责人：太难用）：
 *
 * 1. **先预览，后执行。** `GET /plan` 只算不跑：每个产品要开几条对话、为什么跳过、总量粗估多少 token。
 * 2. **二次确认。** 前端在预览后有一步确认（摆出代价、勾选「我了解」）。`POST /start` 要带预览给的
 *    `planId`：情况变了就作废，防止拿旧预览去跑新情况。不再要求手打确认语。
 * 3. **只写临时区。** AI 产出的文件一律落在 `/临时区/AI补齐/<时间>/<产品>/…`，不碰产品自己的目录，
 *    也不改 wiki 正文；人看过以后在补齐页「一键挪入」，才写进正式位置（同名的替换）。
 *    唯一的例外是「规划 Wiki 目录」：只在这个产品**一页 wiki 都没有**时做，建的是空章节骨架，没有可覆盖的东西。
 *
 * ## 怎么跑
 *
 * 每一步都是一条**真对话**（与手动点「AI 比对」「AI 写 Wiki」完全同一条路：直接复用那几个接口），
 * 所以每条都能在对话列表里点开看过程、追问。服务端自己排队驱动，同时最多跑 {@link CONCURRENCY} 条，
 * 单次总数封顶 {@link MAX_SESSIONS}。比对完才知道缺什么、规划完目录才知道有哪些页，
 * 所以 job 是**边跑边长**的：比对 job 跑完追加「写产出物」，目录 job 跑完追加「写章节」。
 */

export const CONCURRENCY = 2;
/** 单次补齐最多开多少条对话。超了的 job 标「超出上限」不跑，人可以下次再补。 */
export const MAX_SESSIONS = 150;
/** 每条对话的 token 粗估区间（输入的目录事实 + 输出的正文）。只用来给人一个量级。 */
const TOKENS_PER_SESSION = { min: 20_000, max: 45_000 } as const;
/** 补齐草稿在临时区里的位置。 */
export const DRAFT_ROOT = STAGING_DIRS.fill;

type JobKind = "compare" | "artifact" | "wiki-outline" | "wiki-page";
type JobStatus =
  "queued" | "running" | "done" | "failed" | "cancelled" | "skipped";
type RunStatus = "running" | "done" | "cancelled" | "interrupted";

/* ── 预览 ─────────────────────────────────────────────────────────── */

export interface PlanRow {
  productId: string;
  productName: string;
  lineName: string;
  lifecycle:
    | { state: "skip"; reason: string }
    | { state: "none"; reason: string }
    /** 已有比对结果：缺几份就写几份。 */
    | { state: "known"; missing: string[] }
    /** 没比对过（或换过规范）：先比对一次，缺几份要比完才知道，最多 max 份。 */
    | { state: "compare"; max: number };
  wiki:
    | { state: "skip"; reason: string }
    | { state: "none"; reason: string }
    /** 一页都没有：先规划目录，章节数按出厂目录估。 */
    | { state: "outline"; estimate: number }
    | { state: "pages"; pages: string[] };
  sessions: { min: number; max: number };
  /** 这个产品完全没事可做（全跳过或已经齐了）。前端不让勾。 */
  idle: boolean;
}

export interface Plan {
  planId: string;
  rows: PlanRow[];
  limits: {
    concurrency: number;
    maxSessions: number;
    tokensPerSession: { min: number; max: number };
  };
  draftRoot: string;
  running: boolean;
}

const startBody = z.object({
  productIds: z.array(z.string().min(1)).min(1, "至少选一个产品"),
  planId: z.string().min(1, "缺少预览编号，请重新预览"),
});

const idsBody = z.object({
  ids: z.array(z.string().min(1)).min(1, "至少选一份草稿"),
});

/* ── 落库的形状 ─────────────────────────────────────────────────────── */

interface RunRow {
  id: string;
  status: RunStatus;
  folder: string;
  note: string;
  created_at: number;
  finished_at: number | null;
}
interface JobRow {
  id: string;
  run_id: string;
  product_id: string;
  product_name: string;
  kind: JobKind;
  label: string;
  payload: string;
  status: JobStatus;
  session_id: string | null;
  error: string | null;
  seq: number;
  updated_at: number;
}
interface DraftRow {
  id: string;
  run_id: string;
  product_id: string;
  product_name: string;
  kind: "artifact" | "wiki";
  title: string;
  draft_path: string;
  target_path: string | null;
  page_id: string | null;
  session_id: string | null;
  status: "pending" | "applied" | "discarded";
  created_at: number;
  updated_at: number;
}

/** 前端看到的跑批详情。 */
export interface FillRunView {
  id: string;
  status: RunStatus;
  folder: string;
  note: string;
  createdAt: number;
  finishedAt: number | null;
  jobs: {
    id: string;
    productId: string;
    productName: string;
    kind: JobKind;
    label: string;
    status: JobStatus;
    sessionId: string | null;
    error: string | null;
  }[];
  drafts: FillDraftView[];
}

export interface FillDraftView {
  id: string;
  runId: string;
  productId: string;
  productName: string;
  kind: "artifact" | "wiki";
  title: string;
  draftPath: string;
  /** 挪入的去处：文件路径，或「Wiki · 章节」。 */
  target: string;
  status: "pending" | "applied" | "discarded";
  /** 挪入会替换已有内容（目标文件已存在 / 这一章已经写了正文）。 */
  willReplace: boolean;
  /** 草稿文件还在不在（人可能在文件库里删了它）。 */
  exists: boolean;
  sessionId: string | null;
  createdAt: number;
}

export interface FillApplyReport {
  applied: string[];
  replaced: string[];
  failed: { id: string; title: string; why: string }[];
  /** 挪入成功的草稿 id（临时区按 id 对回条目，名字可能重复）。 */
  appliedIds: string[];
}

/**
 * 补齐草稿的读与处理。补齐页与临时区共用这一份——两个入口点的是同一个动作，
 * 状态也只记在 fill_drafts 一处。
 */
export interface FillDraftOps {
  /** 所有批次里还没处理的草稿（临时区用）。 */
  pending(): FillDraftView[];
  read(id: string): Promise<{ path: string; content: string }>;
  apply(ids: readonly string[]): Promise<FillApplyReport>;
  discard(ids: readonly string[]): Promise<number>;
}

class Cancelled extends Error {}

/* ── 注册 ─────────────────────────────────────────────────────────── */

export function registerGlobalFill(
  app: FastifyInstance,
  deps: {
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
    now?: () => number;
  },
): FillDraftOps {
  const { db, files, store } = deps;
  const now = deps.now ?? Date.now;
  const catalog = createCatalog(db, now);
  const lifecycle = createLifecycle(db, now);
  const wiki = createWiki(db);

  /** 跑批要靠本服务自己的分析接口；它们过安全闸，Host 用发起请求时的那个。 */
  let host = "127.0.0.1";
  /** 正在跑的对话：停止时要逐个 abort。 */
  const live = new Set<string>();
  let pumping = false;

  // 上次服务退出时还在跑的批：标成「中断」，可以在补齐页点「继续」。
  db.prepare(
    "UPDATE fill_jobs SET status = 'queued', error = '服务重启时中断，继续后会重跑' WHERE status = 'running'",
  ).run();
  db.prepare(
    "UPDATE fill_runs SET status = 'interrupted' WHERE status = 'running'",
  ).run();

  /* ── 读写小工具 ── */

  const products = (): (Product & { lineName: string })[] =>
    catalog
      .list()
      .flatMap((l) => l.products.map((p) => ({ ...p, lineName: l.name })));
  const productOf = (id: string) => products().find((p) => p.id === id);

  const latestCheck = (
    productId: string,
  ): { templateId: string; findings: NormalizedFinding[] } | undefined => {
    const row = db
      .prepare<[string], { template_id: string; findings: string }>(
        "SELECT template_id, findings FROM product_checks WHERE product_id = ?",
      )
      .get(productId);
    return row
      ? {
          templateId: row.template_id,
          findings: JSON.parse(row.findings) as NormalizedFinding[],
        }
      : undefined;
  };

  const flat = (nodes: readonly WikiNode[]): WikiNode[] =>
    nodes.flatMap((n) => [n, ...flat(n.children)]);
  const builtinPages = (() => {
    const count = (list: readonly { children?: unknown[] }[]): number =>
      list.reduce(
        (sum, p) =>
          sum +
          1 +
          count((p.children ?? []) as readonly { children?: unknown[] }[]),
        0,
      );
    return count(BUILTIN_WIKI);
  })();

  const currentRun = (): RunRow | undefined =>
    db
      .prepare<[], RunRow>(
        "SELECT * FROM fill_runs ORDER BY created_at DESC LIMIT 1",
      )
      .get();
  const runOf = (id: string): RunRow => {
    const row = db
      .prepare<[string], RunRow>("SELECT * FROM fill_runs WHERE id = ?")
      .get(id);
    if (!row) throw notFound("找不到这次补齐");
    return row;
  };
  const jobsOf = (runId: string): JobRow[] =>
    db
      .prepare<[string], JobRow>(
        "SELECT * FROM fill_jobs WHERE run_id = ? ORDER BY seq",
      )
      .all(runId);
  const setJob = (
    id: string,
    patch: Partial<Pick<JobRow, "status" | "session_id" | "error">>,
  ): void => {
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    if (keys.length === 0) return;
    db.prepare(
      `UPDATE fill_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`,
    ).run(...keys.map((k) => patch[k] ?? null), now(), id);
  };
  const addJob = (
    runId: string,
    product: { id: string; name: string },
    kind: JobKind,
    label: string,
    payload: Record<string, unknown> = {},
  ): void => {
    const seq =
      (db
        .prepare<[string], { s: number | null }>(
          "SELECT MAX(seq) AS s FROM fill_jobs WHERE run_id = ?",
        )
        .get(runId)?.s ?? 0) + 1;
    // 单次总数封顶：超出的照样记一行（让人看得见被截掉了什么），但直接标「跳过」。
    const counted =
      db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM fill_jobs WHERE run_id = ? AND status != 'skipped'",
        )
        .get(runId)?.n ?? 0;
    const over = counted >= MAX_SESSIONS;
    db.prepare(
      "INSERT INTO fill_jobs (id, run_id, product_id, product_name, kind, label, payload, status, error, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      randomUUID(),
      runId,
      product.id,
      product.name,
      kind,
      label,
      JSON.stringify(payload),
      over ? "skipped" : "queued",
      over
        ? `超过单次 ${String(MAX_SESSIONS)} 条对话的上限，没有跑；下次补齐会接着补`
        : null,
      seq,
      now(),
    );
  };

  /* ── 预览 ── */

  const planRow = (p: Product & { lineName: string }): PlanRow => {
    const noSource = p.folderPath === null && p.codePath === null;
    let life: PlanRow["lifecycle"];
    if (noSource)
      life = {
        state: "skip",
        reason: "没绑文档目录也没绑代码目录，AI 无事实可依",
      };
    else if (p.templateId === null)
      life = { state: "skip", reason: "没绑生命周期规范" };
    else if (p.folderPath === null)
      life = { state: "skip", reason: "没绑文档目录，产出物无处比对" };
    else {
      const check = latestCheck(p.id);
      if (check?.templateId === p.templateId) {
        const missing = check.findings
          .filter((f) => f.status === "missing")
          .map((f) => `${f.stageCode} ${f.artifact}`);
        life =
          missing.length === 0
            ? { state: "none", reason: "上次比对已经齐了" }
            : { state: "known", missing };
      } else {
        let max: number;
        try {
          max = lifecycle
            .get(p.templateId)
            .stages.reduce((n, s) => n + s.artifacts.length, 0);
        } catch {
          max = 0;
        }
        life = { state: "compare", max };
      }
    }

    let wk: PlanRow["wiki"];
    if (noSource)
      wk = {
        state: "skip",
        reason: "没绑文档目录也没绑代码目录，AI 无事实可依",
      };
    else if (wiki.isEmpty(p.id))
      wk = { state: "outline", estimate: builtinPages };
    else {
      const pages = flat(wiki.tree(p.id))
        .filter((n) => n.length === 0)
        .map((n) => `${n.number} ${n.title}`);
      wk =
        pages.length === 0
          ? { state: "none", reason: "每一章都已经写了正文" }
          : { state: "pages", pages };
    }

    const lifeMin =
      life.state === "known"
        ? life.missing.length
        : life.state === "compare"
          ? 1
          : 0;
    const lifeMax =
      life.state === "known"
        ? life.missing.length
        : life.state === "compare"
          ? 1 + life.max
          : 0;
    const wikiMin =
      wk.state === "pages" ? wk.pages.length : wk.state === "outline" ? 1 : 0;
    const wikiMax =
      wk.state === "pages"
        ? wk.pages.length
        : wk.state === "outline"
          ? 1 + wk.estimate
          : 0;
    return {
      productId: p.id,
      productName: p.name,
      lineName: p.lineName,
      lifecycle: life,
      wiki: wk,
      sessions: { min: lifeMin + wikiMin, max: lifeMax + wikiMax },
      idle: lifeMax + wikiMax === 0,
    };
  };

  const plan = (): Plan => {
    const rows = products().map(planRow);
    // planId 只取「会影响要跑什么」的部分：情况一变（新比对、新写一章、改绑定），旧预览就作废。
    const planId = createHash("sha256")
      .update(JSON.stringify(rows))
      .digest("hex")
      .slice(0, 16);
    return {
      planId,
      rows,
      limits: {
        concurrency: CONCURRENCY,
        maxSessions: MAX_SESSIONS,
        tokensPerSession: TOKENS_PER_SESSION,
      },
      draftRoot: DRAFT_ROOT,
      running: currentRun()?.status === "running",
    };
  };

  /* ── 跑一条对话 ── */

  const inject = async <T>(
    method: "GET" | "POST",
    url: string,
    payload?: object,
  ): Promise<T> => {
    const res = await app.inject({
      method,
      url,
      headers: { host },
      ...(payload === undefined ? {} : { payload }),
    });
    if (res.statusCode >= 400) {
      let message = `请求失败（${String(res.statusCode)}）`;
      try {
        message =
          res.json<{ error?: { message?: string } }>().error?.message ??
          message;
      } catch {
        // 非 JSON 的错误体：用兜底文案。
      }
      throw new Error(message);
    }
    return res.json<T>();
  };

  const converse = async (
    runId: string,
    sessionId: string,
    prompt: string,
  ): Promise<void> => {
    if (runOf(runId).status !== "running") throw new Cancelled("已停止");
    // 放对象里：回调里改的值，TS 的流分析看不见，会误判成常量。
    const state: { failed: string | null } = { failed: null };
    live.add(sessionId);
    try {
      await deps.runner.chat({
        sessionId,
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
      live.delete(sessionId);
    }
    if (runOf(runId).status !== "running") throw new Cancelled("已停止");
    if (state.failed !== null) throw new Error(state.failed);
  };

  const writeDraft = async (
    run: RunRow,
    job: JobRow,
    input: {
      kind: "artifact" | "wiki";
      title: string;
      relPath: string;
      content: string;
      targetPath: string | null;
      pageId: string | null;
      sessionId: string;
    },
  ): Promise<void> => {
    /*
     * 草稿目录带上产品 id 的短前缀。
     *
     * 原来只用产品名：表约束是「同一产品线内名称唯一」，跨产品线允许重名。两条同名产品
     * 一起补齐、缺的是同一章时，草稿落到同一个文件夹——Wiki 章节名是按位次算的（「01 产品快照」），
     * 跨产品必然重复，于是后写的把先写的覆盖掉。两条草稿行都还是待确认，磁盘上却只剩一份：
     * 一键挪入时会把这份内容同时写进两个产品各自的页面。
     */
    const draftPath = `${run.folder}/${safeSegment(job.product_name)}-${job.product_id.slice(0, 6)}/${input.relPath}`;
    await files.write(draftPath, Buffer.from(`${input.content}\n`, "utf8"), {
      mode: "overwrite",
      parents: true,
    });
    db.prepare(
      "INSERT INTO fill_drafts (id, run_id, product_id, product_name, kind, title, draft_path, target_path, page_id, session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
    ).run(
      randomUUID(),
      run.id,
      job.product_id,
      job.product_name,
      input.kind,
      input.title,
      draftPath,
      input.targetPath,
      input.pageId,
      input.sessionId,
      now(),
      now(),
    );
  };

  const scanSafely = async (
    path: string | null,
    depth: number,
  ): Promise<ScanResult | null> => {
    if (path === null) return null;
    try {
      return await scanFolder(files, path, { maxDepth: depth });
    } catch {
      // 绑的目录被删了 / 参考资料是单个文件：这一路事实读不到就少一路，不让整个 job 失败。
      return null;
    }
  };

  const runJob = async (run: RunRow, job: JobRow): Promise<void> => {
    const product = productOf(job.product_id);
    if (!product) throw new Error("产品已被删除");
    const payload = JSON.parse(job.payload) as Record<string, string>;

    if (job.kind === "compare") {
      const started = await inject<{ sessionId: string; prompt: string }>(
        "POST",
        "/api/analysis/compare",
        { productId: product.id },
      );
      setJob(job.id, { session_id: started.sessionId });
      await converse(run.id, started.sessionId, started.prompt);
      const check = await inject<{ findings: NormalizedFinding[] }>(
        "POST",
        `/api/analysis/${started.sessionId}/save`,
      );
      for (const f of check.findings.filter((x) => x.status === "missing"))
        addJob(
          run.id,
          product,
          "artifact",
          `写产出物：${f.stageCode} ${f.artifact}`,
          {
            stageCode: f.stageCode,
            artifact: f.artifact,
            note: f.note,
          },
        );
      return;
    }

    if (job.kind === "artifact") {
      if (product.templateId === null || product.folderPath === null)
        throw new Error("产品已解绑生命周期规范或文档目录");
      const template = lifecycle.get(product.templateId);
      const stage = template.stages.find((s) => s.code === payload.stageCode);
      const artifact = stage?.artifacts.find(
        (a) => a.name === payload.artifact,
      );
      if (!stage || !artifact)
        throw new Error("规范里已经没有这份产出物了（可能被改名或删除）");
      const scans = (
        await Promise.all([
          scanSafely(product.folderPath, 3),
          scanSafely(product.codePath, 2),
          ...product.refPaths.map((r) => scanSafely(r, 2)),
        ])
      ).filter((s): s is ScanResult => s !== null);
      const defaultFileName = `${safeSegment(`${stage.code}-${artifact.name}`)}.md`;
      const header = deps.newHeader() as { id: string };
      const row = store.create({
        id: header.id,
        title: `AI 补齐产出物：${product.name} · ${artifact.name}`,
        header,
        productId: product.id,
        task: {
          kind: "fill-artifact",
          productId: product.id,
          runId: run.id,
          stageCode: stage.code,
          artifact: artifact.name,
        },
      });
      setJob(job.id, { session_id: row.id });
      await converse(
        run.id,
        row.id,
        artifactDraftPrompt({
          productName: product.name,
          productDescription: product.description,
          templateName: template.name,
          stage,
          artifact,
          note: payload.note ?? "",
          defaultFileName,
          scans,
        }),
      );
      const result = await inject<{ content: string; fileName: string }>(
        "GET",
        `/api/analysis/${row.id}/result`,
      );
      const rel = safeRelativeName(result.fileName, defaultFileName);
      await writeDraft(run, job, {
        kind: "artifact",
        title: `${stage.code} ${artifact.name}`,
        relPath: `生命周期/${safeSegment(`${stage.code} ${stage.label}`)}/${safeSegment(artifact.name)}.md`,
        content: result.content,
        targetPath: `${product.folderPath}/${rel}`,
        pageId: null,
        sessionId: row.id,
      });
      return;
    }

    if (job.kind === "wiki-outline") {
      // 跑到这里时可能已经有人手动建了目录：那就不再规划，直接补没写的章。
      if (wiki.isEmpty(product.id)) {
        const started = await inject<{ sessionId: string; prompt: string }>(
          "POST",
          "/api/analysis/wiki-outline",
          { productId: product.id, mode: "append" },
        );
        setJob(job.id, { session_id: started.sessionId });
        await converse(run.id, started.sessionId, started.prompt);
        await inject(
          "POST",
          `/api/analysis/${started.sessionId}/apply-wiki-outline`,
        );
      }
      for (const page of flat(wiki.tree(product.id)).filter(
        (n) => n.length === 0,
      ))
        addJob(
          run.id,
          product,
          "wiki-page",
          `写 Wiki：${page.number} ${page.title}`,
          {
            pageId: page.id,
          },
        );
      return;
    }

    // wiki-page
    const pageId = payload.pageId ?? "";
    const started = await inject<{ sessionId: string; prompt: string }>(
      "POST",
      "/api/analysis/wiki-page",
      { pageId },
    );
    setJob(job.id, { session_id: started.sessionId });
    await converse(run.id, started.sessionId, started.prompt);
    const result = await inject<{ content: string; pageTitle: string }>(
      "GET",
      `/api/analysis/${started.sessionId}/result`,
    );
    await writeDraft(run, job, {
      kind: "wiki",
      title: result.pageTitle,
      relPath: `Wiki/${safeSegment(result.pageTitle)}.md`,
      content: result.content,
      targetPath: null,
      pageId,
      sessionId: started.sessionId,
    });
  };

  /** 排队驱动：空出位置就拉下一条，全跑完收尾。 */
  const pump = (runId: string): void => {
    if (pumping) return;
    pumping = true;
    try {
      const run = runOf(runId);
      if (run.status !== "running") return;
      const jobs = jobsOf(runId);
      const running = jobs.filter((j) => j.status === "running").length;
      const queued = jobs.filter((j) => j.status === "queued");
      if (running === 0 && queued.length === 0) {
        db.prepare(
          "UPDATE fill_runs SET status = 'done', finished_at = ? WHERE id = ?",
        ).run(now(), runId);
        return;
      }
      for (const job of queued.slice(0, Math.max(0, CONCURRENCY - running))) {
        setJob(job.id, { status: "running", error: null });
        void runJob(run, job)
          .then(() => {
            setJob(job.id, { status: "done" });
          })
          .catch((cause: unknown) => {
            setJob(job.id, {
              status: cause instanceof Cancelled ? "cancelled" : "failed",
              error: cause instanceof Error ? cause.message : "失败",
            });
          })
          .finally(() => {
            pump(runId);
          });
      }
    } finally {
      pumping = false;
    }
  };

  /* ── 视图 ── */

  const draftView = (d: DraftRow): FillDraftView => {
    let willReplace = false;
    let target = d.target_path ?? "";
    if (d.kind === "artifact")
      willReplace = d.target_path !== null && files.exists(d.target_path);
    else {
      try {
        const page = wiki.page(d.page_id ?? "");
        willReplace = page.content !== "";
        target = `Wiki · ${page.number} ${page.title}`;
      } catch {
        target = "Wiki · （这一章已被删除）";
      }
    }
    return {
      id: d.id,
      runId: d.run_id,
      productId: d.product_id,
      productName: d.product_name,
      kind: d.kind,
      title: d.title,
      draftPath: d.draft_path,
      target,
      status: d.status,
      willReplace: d.status === "pending" && willReplace,
      exists: files.exists(d.draft_path),
      // 会话可能已经被删了：前端只判 sessionId !== null 就渲染「看对话」按钮，
      // 点进去是一个空的「开始新对话」。临时区那边早就在做这个存在性校验了。
      sessionId:
        d.session_id !== null && deps.store.get(d.session_id) !== undefined
          ? d.session_id
          : null,
      createdAt: d.created_at,
    };
  };

  const view = (run: RunRow): FillRunView => {
    const drafts = db
      .prepare<[string], DraftRow>(
        "SELECT * FROM fill_drafts WHERE run_id = ? ORDER BY product_name, created_at",
      )
      .all(run.id);
    return {
      id: run.id,
      status: run.status,
      folder: run.folder,
      note: run.note,
      createdAt: run.created_at,
      finishedAt: run.finished_at,
      jobs: jobsOf(run.id).map((j) => ({
        id: j.id,
        productId: j.product_id,
        productName: j.product_name,
        kind: j.kind,
        label: j.label,
        status: j.status,
        sessionId: j.session_id,
        error: j.error,
      })),
      drafts: drafts.map(draftView),
    };
  };

  const draftsByIds = (ids: readonly string[]): DraftRow[] =>
    ids
      .map((id) =>
        db
          .prepare<[string], DraftRow>("SELECT * FROM fill_drafts WHERE id = ?")
          .get(id),
      )
      .filter((d): d is DraftRow => d !== undefined);

  const setDraft = (id: string, status: DraftRow["status"]): void => {
    db.prepare(
      "UPDATE fill_drafts SET status = ?, updated_at = ? WHERE id = ?",
    ).run(status, now(), id);
  };

  /** 一次补齐的草稿都处理完了：把它的草稿文件夹删掉，别在文件库里留一堆空目录。 */
  const tidy = async (runId: string): Promise<void> => {
    const run = runOf(runId);
    if (run.status === "running") return;
    const pending =
      db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM fill_drafts WHERE run_id = ? AND status = 'pending'",
        )
        .get(runId)?.n ?? 0;
    if (pending === 0)
      await files
        .remove(run.folder, { recursive: true })
        .catch(() => undefined);
  };

  /* ── 路由 ── */

  app.get("/api/global-fill/plan", () => plan());

  app.post("/api/global-fill/start", async (request, reply) => {
    const body = startBody.parse(request.body);
    const current = plan();
    if (current.running)
      throw conflict("已经有一次全局补齐在跑，先等它结束或停止它");
    if (body.planId !== current.planId)
      throw conflict(
        "预览之后情况变了（有新的比对、章节或绑定），请重新预览再确认",
      );
    const chosen = current.rows.filter(
      (r) => body.productIds.includes(r.productId) && !r.idle,
    );
    if (chosen.length === 0) throw badRequest("选中的产品都没有可补的东西");

    host = request.headers.host ?? host;
    const stamp = new Date(now());
    const pad = (n: number) => String(n).padStart(2, "0");
    const folder = `${DRAFT_ROOT}/${String(stamp.getFullYear())}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}`;
    const runId = randomUUID();
    db.prepare(
      "INSERT INTO fill_runs (id, status, folder, note, created_at) VALUES (?, 'running', ?, ?, ?)",
    ).run(runId, folder, chosen.map((r) => r.productName).join("、"), now());
    for (const row of chosen) {
      const product = { id: row.productId, name: row.productName };
      if (row.lifecycle.state === "compare")
        addJob(runId, product, "compare", "比对产出物（看缺什么）");
      if (row.lifecycle.state === "known") {
        const check = latestCheck(row.productId);
        for (const f of (check?.findings ?? []).filter(
          (x) => x.status === "missing",
        ))
          addJob(
            runId,
            product,
            "artifact",
            `写产出物：${f.stageCode} ${f.artifact}`,
            {
              stageCode: f.stageCode,
              artifact: f.artifact,
              note: f.note,
            },
          );
      }
      if (row.wiki.state === "outline")
        addJob(runId, product, "wiki-outline", "规划 Wiki 目录");
      if (row.wiki.state === "pages")
        for (const page of flat(wiki.tree(row.productId)).filter(
          (n) => n.length === 0,
        ))
          addJob(
            runId,
            product,
            "wiki-page",
            `写 Wiki：${page.number} ${page.title}`,
            {
              pageId: page.id,
            },
          );
    }
    pump(runId);
    return reply.code(201).send(view(runOf(runId)));
  });

  app.get("/api/global-fill/current", () => {
    const run = currentRun();
    return { run: run ? view(run) : null };
  });

  app.post<{ Params: { id: string } }>(
    "/api/global-fill/runs/:id/cancel",
    (request) => {
      const run = runOf(request.params.id);
      if (run.status !== "running") return view(run);
      db.prepare(
        "UPDATE fill_runs SET status = 'cancelled', finished_at = ? WHERE id = ?",
      ).run(now(), run.id);
      db.prepare(
        "UPDATE fill_jobs SET status = 'cancelled', error = '已停止', updated_at = ? WHERE run_id = ? AND status = 'queued'",
      ).run(now(), run.id);
      for (const sessionId of live) deps.runner.abort(sessionId);
      return view(runOf(run.id));
    },
  );

  /** 服务重启打断的批：把没跑完的接着跑。 */
  app.post<{ Params: { id: string } }>(
    "/api/global-fill/runs/:id/resume",
    (request) => {
      const run = runOf(request.params.id);
      if (run.status !== "interrupted")
        throw badRequest("只有被服务重启打断的补齐可以继续");
      if (currentRun()?.id !== run.id || plan().running)
        throw conflict("已经有别的补齐在跑");
      host = request.headers.host ?? host;
      db.prepare("UPDATE fill_runs SET status = 'running' WHERE id = ?").run(
        run.id,
      );
      pump(run.id);
      return view(runOf(run.id));
    },
  );

  /**
   * 一键挪入：草稿写进正式位置（同名替换），然后删掉草稿文件。
   * 读的是**草稿文件此刻的内容**——人在文件库里改过草稿，挪进去的就是改过的版本。
   */
  const applyDrafts = async (
    ids: readonly string[],
  ): Promise<FillApplyReport> => {
    const report: FillApplyReport = {
      applied: [],
      replaced: [],
      failed: [],
      appliedIds: [],
    };
    const runs = new Set<string>();
    for (const draft of draftsByIds(ids)) {
      if (draft.status !== "pending") continue;
      runs.add(draft.run_id);
      const name = `${draft.product_name} · ${draft.title}`;
      try {
        const item = await files.item(draft.draft_path, { content: true });
        if (item.content === null) throw new Error("草稿不是文本或太大");
        if (draft.kind === "artifact") {
          if (draft.target_path === null) throw new Error("没有目标路径");
          const existed = files.exists(draft.target_path);
          await files.write(
            draft.target_path,
            Buffer.from(item.content, "utf8"),
            { mode: "overwrite", parents: true },
          );
          if (existed) report.replaced.push(name);
        } else {
          const page = wiki.page(draft.page_id ?? "");
          const sessionId =
            draft.session_id !== null && store.get(draft.session_id)
              ? draft.session_id
              : null;
          wiki.applyPage(
            page.id,
            { content: item.content.trim(), sources: [], gaps: [] },
            { sessionId },
          );
          if (page.content !== "") report.replaced.push(name);
        }
        await files.remove(draft.draft_path).catch(() => undefined);
        setDraft(draft.id, "applied");
        report.applied.push(name);
        report.appliedIds.push(draft.id);
      } catch (cause) {
        report.failed.push({
          id: draft.id,
          title: name,
          why:
            cause instanceof Error
              ? cause.message.includes("不存在")
                ? "草稿文件已不在（可能在文件库里被删了）"
                : cause.message
              : "挪入失败",
        });
      }
    }
    for (const runId of runs) await tidy(runId);
    return report;
  };

  const discardDrafts = async (ids: readonly string[]): Promise<number> => {
    const runs = new Set<string>();
    let discarded = 0;
    for (const draft of draftsByIds(ids)) {
      if (draft.status !== "pending") continue;
      runs.add(draft.run_id);
      await files.remove(draft.draft_path).catch(() => undefined);
      setDraft(draft.id, "discarded");
      discarded += 1;
    }
    for (const runId of runs) await tidy(runId);
    return discarded;
  };

  const readDraft = async (
    id: string,
  ): Promise<{ path: string; content: string }> => {
    const [draft] = draftsByIds([id]);
    if (!draft) throw notFound("草稿不存在");
    const item = await files.item(draft.draft_path, { content: true });
    return { path: draft.draft_path, content: item.content ?? "" };
  };

  app.get<{ Params: { id: string } }>(
    "/api/global-fill/drafts/:id",
    async (request) => ({
      content: (await readDraft(request.params.id)).content,
    }),
  );

  app.post("/api/global-fill/drafts/apply", async (request) =>
    applyDrafts(idsBody.parse(request.body).ids),
  );

  app.post("/api/global-fill/drafts/discard", async (request) => ({
    discarded: await discardDrafts(idsBody.parse(request.body).ids),
  }));

  return {
    pending: () =>
      db
        .prepare<[], DraftRow>(
          "SELECT * FROM fill_drafts WHERE status = 'pending' ORDER BY created_at DESC",
        )
        .all()
        .map(draftView),
    read: readDraft,
    apply: applyDrafts,
    discard: discardDrafts,
  };
}
