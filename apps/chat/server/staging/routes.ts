import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../db.js";
import { badRequest, notFound } from "../errors.js";
import { childOf, normalizePath, parentOf } from "../files/paths.js";
import type { FileStore } from "../files/store.js";
import type { FillDraftOps } from "../global-fill.js";
import { promoteVersion } from "../presales-routes.js";
import { createCatalog as createPresalesCatalog } from "../presales.js";
import { createCatalog as createProductCatalog } from "../products.js";
import type { SessionStore } from "../sessions.js";
import type { DraftStore, StagingDraft } from "./drafts.js";
import { moveTo, pruneEmpty } from "./move.js";
import { STAGING_DIRS, STAGING_ROOT, targetProblem } from "./paths.js";
import { suggestTarget } from "./suggest.js";

/**
 * 临时区：所有待确认的 AI 产出，一处看、一套动作。
 *
 * 这里是**聚合视图 + 统一动作**，不是第四份状态：
 * - 对话 / 智能体草稿 → staging_drafts（drafts.ts）；
 * - AI 补齐草稿      → fill_drafts，动作交给 global-fill 的 FillDraftOps；
 * - 售前草稿         → presales_versions 里文件在临时区的草稿版本，确认走 promoteVersion。
 * 补齐页、售前页原有的按钮照旧能用，走的是同一段代码，所以两边不会对不上。
 *
 * 条目键：`draft:<id>` / `fill:<id>` / `presales:<版本 id>`。
 */

export type StagingSource = "chat" | "agent" | "fill" | "presales";

export interface StagingItem {
  key: string;
  source: StagingSource;
  productId: string | null;
  productName: string | null;
  title: string;
  /** 给人看的出处：「对话：xxx」「智能体 prd-writer」「AI 补齐」「售前助手起草」。 */
  origin: string;
  draftPath: string;
  /** 确认后去哪：文件路径，或「Wiki · 章节」「售前 · 库 · 条目」这类说明。null = 没有建议，确认时必须填。 */
  target: string | null;
  /** 去处能不能在确认时改（只有对话 / 智能体草稿能改，其余是定死的）。 */
  targetEditable: boolean;
  /** 确认会替换已有内容。 */
  willReplace: boolean;
  /** 补充说明，如「现行版 v1.0 会归档」。 */
  note: string | null;
  /** 草稿文件还在不在（人可能在文件库里删了它）。 */
  exists: boolean;
  sessionId: string | null;
  createdAt: number;
}

export interface StagingApplyReport {
  applied: { key: string; title: string; path: string | null }[];
  replaced: string[];
  failed: { key: string; title: string; why: string }[];
}

const keySchema = z
  .string()
  .regex(/^(draft|fill|presales):.+$/, "条目编号不合法");

const applyBody = z.object({
  items: z
    .array(
      z.object({
        key: keySchema,
        /** 只对对话 / 智能体草稿生效：改过的去处。 */
        target: z.string().trim().max(1000).optional(),
      }),
    )
    .min(1, "至少选一项")
    .max(200),
});
const discardBody = z.object({
  keys: z.array(keySchema).min(1, "至少选一项").max(200),
});
const saveBody = z.object({
  sessionId: z.string().min(1),
  title: z.string().trim().max(120).optional(),
  markdown: z
    .string()
    .refine((v) => v.trim() !== "", "内容是空的")
    .refine((v) => v.length <= 500_000, "内容太大（上限 50 万字）"),
});

const splitKey = (key: string): { kind: string; id: string } => {
  const at = key.indexOf(":");
  return { kind: key.slice(0, at), id: key.slice(at + 1) };
};

const pad = (n: number): string => String(n).padStart(2, "0");
const dayOf = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 没给标题时：正文第一个 Markdown 标题，其次会话标题。 */
export function draftTitle(markdown: string, fallback: string | null): string {
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1];
  const picked = heading ?? fallback ?? "";
  return picked.trim() === "" ? "对话草稿" : picked.trim().slice(0, 80);
}

interface PresalesRow {
  id: string;
  version: string;
  status: string;
  note: string;
  file_path: string;
  created_at: number;
  slot_title: string;
  lib_name: string;
  product_id: string | null;
  current_version: string | null;
}

export interface StagingDeps {
  db: Db;
  files: FileStore;
  store: SessionStore;
  drafts: DraftStore;
  fill?: FillDraftOps | undefined;
  now?: () => number;
}

export function registerStagingRoutes(
  app: FastifyInstance,
  deps: StagingDeps,
): void {
  const { db, files, store, drafts, fill } = deps;
  const now = deps.now ?? Date.now;
  const presales = createPresalesCatalog(db, now);

  const productNames = (): Map<string, string> =>
    new Map(
      createProductCatalog(db)
        .list()
        .flatMap((line) => line.products)
        .map((p) => [p.id, p.name]),
    );

  const draftItem = (
    d: StagingDraft,
    names: Map<string, string>,
  ): StagingItem => ({
    key: `draft:${d.id}`,
    source: d.source,
    productId: d.productId,
    productName: d.productId === null ? null : (names.get(d.productId) ?? null),
    title: d.title,
    origin: d.origin,
    draftPath: d.draftPath,
    target: d.targetPath,
    targetEditable: true,
    willReplace: d.targetPath !== null && files.exists(d.targetPath),
    note: null,
    exists: files.exists(d.draftPath),
    sessionId:
      d.sessionId !== null && store.get(d.sessionId) ? d.sessionId : null,
    createdAt: d.createdAt,
  });

  /** 售前：只认文件在临时区里的草稿版本——人自己上传的草稿不是平台产出。 */
  const presalesRows = (): PresalesRow[] =>
    db
      .prepare<[{ root: string }], PresalesRow>(
        `SELECT v.id, v.version, v.status, v.note, v.file_path, v.created_at,
                s.title AS slot_title, l.name AS lib_name, l.product_id,
                (SELECT c.version FROM presales_versions c
                  WHERE c.slot_id = s.id AND c.status = 'current') AS current_version
           FROM presales_versions v
           JOIN presales_slots s ON s.id = v.slot_id
           JOIN presales_libs  l ON l.id = s.lib_id
          WHERE v.status IN ('draft', 'review')
            AND v.file_path IS NOT NULL
            AND substr(v.file_path, 1, length(@root) + 1) = @root || '/'
          ORDER BY v.created_at DESC`,
      )
      .all({ root: STAGING_ROOT });

  const presalesItem = (
    r: PresalesRow,
    names: Map<string, string>,
  ): StagingItem => ({
    key: `presales:${r.id}`,
    source: "presales",
    productId: r.product_id,
    productName:
      r.product_id === null ? null : (names.get(r.product_id) ?? null),
    title: `${r.slot_title}（${r.version}）`,
    origin: r.note === "" ? "售前 AI" : r.note,
    draftPath: r.file_path,
    target: `售前 · ${r.lib_name} · ${r.slot_title} 现行版`,
    targetEditable: false,
    willReplace: false,
    note:
      r.current_version === null
        ? null
        : `现行版 ${r.current_version} 会转为归档（不删）`,
    exists: files.exists(r.file_path),
    sessionId: null,
    createdAt: r.created_at,
  });

  const list = (): StagingItem[] => {
    const names = productNames();
    const items: StagingItem[] = [
      ...drafts.pending().map((d) => draftItem(d, names)),
      ...(fill?.pending() ?? []).map((d): StagingItem => ({
        key: `fill:${d.id}`,
        source: "fill",
        productId: d.productId,
        productName: d.productName,
        title: d.title,
        origin: d.kind === "wiki" ? "AI 补齐 · Wiki" : "AI 补齐 · 产出物",
        draftPath: d.draftPath,
        target: d.target === "" ? null : d.target,
        targetEditable: false,
        willReplace: d.willReplace,
        note: null,
        exists: d.exists,
        sessionId: d.sessionId,
        createdAt: d.createdAt,
      })),
      ...presalesRows().map((r) => presalesItem(r, names)),
    ];
    return items.sort((a, b) => b.createdAt - a.createdAt);
  };

  /* ── 列表与预览 ── */

  app.get("/api/staging", () => {
    const items = list();
    const counts: Record<StagingSource, number> = {
      chat: 0,
      agent: 0,
      fill: 0,
      presales: 0,
    };
    for (const item of items) counts[item.source] += 1;
    return { root: STAGING_ROOT, items, counts };
  });

  app.get<{ Querystring: { key?: string } }>(
    "/api/staging/content",
    async (request) => {
      const { kind, id } = splitKey(keySchema.parse(request.query.key));
      if (kind === "fill") {
        if (fill === undefined) throw notFound("AI 补齐未启用");
        const read = await fill.read(id);
        return { path: read.path, content: read.content };
      }
      const path =
        kind === "draft"
          ? drafts.get(id)?.draftPath
          : (presales.versionOf(id)?.filePath ?? undefined);
      if (path === undefined) throw notFound("这一项已经不在临时区了");
      const item = await files.item(path, { content: true });
      // content 为 null：二进制（PPT / Word）或太大，界面上让人去原处打开。
      return { path, content: item.content };
    },
  );

  /** 确认前校验去处：能不能写、会不会替换。 */
  app.get<{ Querystring: { path?: string } }>(
    "/api/staging/target",
    (request) => {
      let path: string;
      try {
        path = normalizePath(request.query.path ?? "");
      } catch {
        return {
          path: request.query.path ?? "",
          problem: "路径不合法",
          exists: false,
        };
      }
      const problem = targetProblem(path);
      return { path, problem, exists: problem === null && files.exists(path) };
    },
  );

  /* ── 对话：存到临时区 ── */

  app.post("/api/staging/drafts", async (request, reply) => {
    const body = saveBody.parse(request.body);
    const session = store.get(body.sessionId);
    if (session === undefined) throw notFound("对话不存在");
    const title =
      body.title !== undefined && body.title !== ""
        ? body.title
        : draftTitle(body.markdown, session.title);
    const saved = await drafts.save({
      source: "chat",
      productId: session.productId,
      title,
      markdown: body.markdown,
      origin: `对话：${session.title}`,
      folder: childOf(STAGING_DIRS.chat, dayOf(now())),
      targetPath: suggestTarget(db, session.productId, title),
      sessionId: session.id,
    });
    return reply.code(201).send(draftItem(saved, productNames()));
  });

  /* ── 确认 / 丢弃 ── */

  const failure = (cause: unknown, fallback: string): string =>
    cause instanceof Error
      ? cause.message.includes("不存在")
        ? "草稿文件已不在（可能在文件库里被删了）"
        : cause.message
      : fallback;

  app.post("/api/staging/apply", async (request) => {
    const { items } = applyBody.parse(request.body);
    const report: StagingApplyReport = {
      applied: [],
      replaced: [],
      failed: [],
    };
    const fillKeys: string[] = [];

    for (const { key, target } of items) {
      const { kind, id } = splitKey(key);
      if (kind === "fill") {
        fillKeys.push(id);
        continue;
      }

      if (kind === "draft") {
        const draft = drafts.get(id);
        if (draft === undefined) {
          report.failed.push({ key, title: key, why: "这份草稿已经不存在" });
          continue;
        }
        if (draft.status !== "pending") {
          /*
           * 页面停留期间，同一份已被别处确认或丢弃。原来直接 continue：既不进 applied
           * 也不进 failed，界面提示的「已确认 N 份」比用户勾的少，还不说哪条没做。
           */
          report.failed.push({
            key,
            title: draft.title,
            why:
              draft.status === "applied"
                ? "这份已经在别处确认过了"
                : "这份已经在别处丢弃了",
          });
          continue;
        }
        try {
          const raw =
            target !== undefined && target !== "" ? target : draft.targetPath;
          if (raw === null)
            throw badRequest("还没选去处：填一个要写到的文件路径");
          const to = normalizePath(raw);
          const problem = targetProblem(to);
          if (problem !== null) throw badRequest(problem);
          const { entry, replaced } = await moveTo(files, draft.draftPath, to);
          drafts.mark(draft.id, "applied", entry.path);
          await pruneEmpty(
            files,
            parentOf(draft.draftPath),
            STAGING_DIRS[draft.source],
          );
          if (replaced) report.replaced.push(draft.title);
          report.applied.push({ key, title: draft.title, path: entry.path });
        } catch (cause) {
          report.failed.push({
            key,
            title: draft.title,
            why: failure(cause, "确认失败"),
          });
        }
        continue;
      }

      // presales
      const row = presalesRows().find((r) => r.id === id);
      if (row === undefined) continue;
      const title = `${row.slot_title}（${row.version}）`;
      try {
        await promoteVersion(presales, files, id);
        await pruneEmpty(files, parentOf(row.file_path), STAGING_DIRS.presales);
        report.applied.push({
          key,
          title,
          path: presales.versionOf(id)?.filePath ?? null,
        });
      } catch (cause) {
        report.failed.push({
          key,
          title,
          why: failure(cause, "设为现行版失败"),
        });
      }
    }

    if (fillKeys.length > 0) {
      if (fill === undefined) {
        for (const id of fillKeys)
          report.failed.push({
            key: `fill:${id}`,
            title: id,
            why: "AI 补齐未启用",
          });
      } else {
        const before = new Map(fill.pending().map((d) => [d.id, d]));
        const r = await fill.apply(fillKeys);
        report.replaced.push(...r.replaced);
        for (const f of r.failed)
          report.failed.push({
            key: `fill:${f.id}`,
            title: f.title,
            why: f.why,
          });
        for (const id of r.appliedIds) {
          const d = before.get(id);
          report.applied.push({
            key: `fill:${id}`,
            title: d === undefined ? id : `${d.productName} · ${d.title}`,
            path: d?.kind === "artifact" ? d.target : null,
          });
        }
      }
    }
    return report;
  });

  app.post("/api/staging/discard", async (request) => {
    const { keys } = discardBody.parse(request.body);
    let discarded = 0;
    const fillIds: string[] = [];
    for (const key of keys) {
      const { kind, id } = splitKey(key);
      if (kind === "fill") {
        fillIds.push(id);
        continue;
      }
      if (kind === "draft") {
        const draft = drafts.get(id);
        if (draft?.status !== "pending") continue;
        await files.remove(draft.draftPath).catch(() => undefined);
        drafts.mark(draft.id, "discarded");
        await pruneEmpty(
          files,
          parentOf(draft.draftPath),
          STAGING_DIRS[draft.source],
        );
        discarded += 1;
        continue;
      }
      // presales：只丢临时区里的草稿版本，绝不碰现行版与人上传的版本。
      const row = presalesRows().find((r) => r.id === id);
      if (row === undefined) continue;
      presales.removeVersion(id);
      await files.remove(row.file_path).catch(() => undefined);
      await pruneEmpty(files, parentOf(row.file_path), STAGING_DIRS.presales);
      discarded += 1;
    }
    if (fillIds.length > 0 && fill !== undefined)
      discarded += await fill.discard(fillIds);
    return { discarded };
  });
}
