import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";

import { HttpError, badRequest, notFound } from "./errors.js";
import { childOf, nameOf, parentOf } from "./files/paths.js";
import type { FileStore } from "./files/store.js";
import { moveInto } from "./staging/move.js";
import { STAGING_DIRS, isStagingPath } from "./staging/paths.js";
import { extractOfficeText, isOfficeFile } from "./office-text.js";
import { textOf } from "./pi/parts.js";
import type { SessionStore } from "./sessions.js";
import type { PresalesTemplates } from "./presales-templates.js";
import {
  createCandidateStore,
  recognizePrompt,
  recognizeResultSchema,
  scanForRecognition,
} from "./presales-import.js";
import {
  createLibSchema,
  createSlotSchema,
  createVersionSchema,
  createCatalog,
  STAGES,
  STATUSES,
  updateLibSchema,
  updateSlotSchema,
  updateVersionSchema,
} from "./presales.js";

/**
 * 售前材料库的接口。
 *
 *   GET    /api/presales                       库列表（含缺口统计）
 *   POST   /api/presales                       建库（按模板铺槽位）
 *   GET    /api/presales/:id                   一本库的详情（槽位 + 版本）
 *   PATCH  /api/presales/:id                   改名 / 说明 / 停用
 *   DELETE /api/presales/:id                   删库（连带删除它的材料文件）
 *   POST   /api/presales/:id/slots/sync        按模板补条目（只加不删）
 *   POST   /api/presales/:id/slots             加一条自定义材料
 *   PATCH  /api/presales/slots/:id             改条目
 *   DELETE /api/presales/slots/:id             删条目（连带版本）
 *   POST   /api/presales/slots/:id/versions    登记版本
 *   PATCH  /api/presales/versions/:id          改版本信息
 *   POST   /api/presales/versions/:id/status   改状态（设现行时旧的自动归档）
 *   DELETE /api/presales/versions/:id          删版本
 *   POST   /api/presales/slots/:id/upload      上传 / 替换文件（写进文件库）
 *   DELETE /api/presales/slots/:id/file        删除文件（从文件库删掉，变回缺口）
 *   POST   /api/presales/versions/:id/rename   改文件名（文件库同步改名）
 *   GET    /api/presales/versions/:id/file     下载文件
 *   GET    /api/presales/versions/:id/preview  在线看内容（md 可编辑，Office 抽文本）
 *   PUT    /api/presales/versions/:id/preview  保存 Markdown 正文
 *
 *   售前材料的 AI 识别（不做目录映射——真实材料堆里目录结构靠不住）：
 *   POST   /api/presales/:id/recognize          {folderPath} → {sessionId, prompt, stats}
 *   GET    /api/presales/:id/candidates         → 候选清单（含已入库的）
 *   POST   /api/presales/recognize/:sessionId   → 取 AI 结果、落成候选
 *   POST   /api/presales/candidates/:id/accept  → 确认一条：建版本、挂文件
 *   POST   /api/presales/candidates/:id/skip    → 忽略一条
 *   POST   /api/presales/:id/candidates/clear   → 清空这本库还没处理的候选
 *
 * 文件复用「事实底座」那套 FileStore，落在 `/售前/<库 id>/...` 下：
 * 不另起一套存储与第二套路径闸，且用户在「事实底座」里也翻得到这些文件。
 */
export const PRESALES_ROOT = "/售前";

/** 售前 AI 产出（起草、修订）在临时区里的位置：`/临时区/售前/<库名>/<AI草稿|AI修订>/`。 */
export const presalesStagingFolder = (
  libName: string,
  kind: "AI草稿" | "AI修订",
): string =>
  childOf(childOf(STAGING_DIRS.presales, safeFileName(libName)), kind);

/**
 * 设为现行版。售前页「设为可对外」与临时区「确认」共用这一个动作。
 *
 * 文件还在临时区里（AI 起草 / AI 修订的）就先搬到 `/售前/<库名>/`，再改状态——
 * 现行版躺在临时区里，等于「确认了却没入库」，临时区也就不再只装待确认的东西。
 * 先搬后改：搬失败时状态不动，人看到的还是一份草稿，而不是一份指向空处的现行版。
 */
export async function promoteVersion(
  catalog: ReturnType<typeof createCatalog>,
  files: FileStore | undefined,
  versionId: string,
): Promise<void> {
  const version = catalog.versionOf(versionId);
  if (version === undefined) throw notFound("版本不存在");
  if (
    files !== undefined &&
    version.filePath !== null &&
    isStagingPath(version.filePath)
  ) {
    const lib = catalog.get(version.libId)?.lib;
    if (lib === undefined) throw notFound("售前库不存在");
    const entry = await moveInto(
      files,
      version.filePath,
      childOf(PRESALES_ROOT, safeFileName(lib.name)),
    );
    catalog.attachFile(version.id, {
      path: entry.path,
      name: entry.name,
      size: entry.size,
    });
  }
  catalog.setVersionStatus(versionId, "current");
}

/** 能直接当文本给的扩展名。md 之外都是只读（只有 md 允许在线保存）。 */
const TEXT_EXT = new Set(["md", "markdown", "txt", "csv"]);
const extOf = (name: string): string =>
  name.slice(name.lastIndexOf(".") + 1).toLowerCase();

const idParams = z.object({ id: z.string() });

/** 文件名清洗：只取最后一段，剥掉分隔符与控制字符（防目录穿越）。 */
function safeFileName(name: string): string {
  const base = name.slice(
    Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1,
  );
  const cleaned = Array.from(base)
    .map((ch) =>
      ch.charCodeAt(0) < 0x20 || ch === "/" || ch === "\\" ? "_" : ch,
    )
    .join("")
    .trim();
  return cleaned === "" || cleaned === "." || cleaned === ".."
    ? "file"
    : cleaned;
}

/** v1.0 → v2.0；认不出就在后面加「-新」，不替用户编版本号。 */
function nextVersion(v: string): string {
  const m = /^v?(\d+)(?:\.(\d+))?/i.exec(v);
  if (m === null) return `${v}-新`;
  return `v${String(Number(m[1]) + 1)}.0`;
}

export function registerPresalesRoutes(
  app: FastifyInstance,
  db: Parameters<typeof createCatalog>[0],
  files: FileStore | undefined,
  now?: () => number,
  sessions?: {
    store: SessionStore;
    newHeader: () => unknown;
    /** 会话里 assistant 说过的全部文字。识别取结果时解析它末尾的 json 块。 */
  },
  templates?: PresalesTemplates,
  hooks?: {
    /** 某条材料上传 / 替换了文件（巡检据此自动发起审阅，见 presales-agent.ts）。 */
    onUploaded?: (slotId: string) => void;
  },
): void {
  const catalog = createCatalog(db, now, templates);
  // 候选只按 slot_id 关联槽位；标题在 SQL 里 JOIN 出来，这个兜底几乎不会走到。
  const candidates = createCandidateStore(db, () => "");

  /** 会话条目里的 assistant 文字，按顺序拼起来（与 analysis/routes.ts 同一做法）。 */
  const assistantText = (sessionId: string): string =>
    (sessions?.store.entries(sessionId) ?? [])
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

  /** 取末尾的 json 块。与 analysis/tasks.ts 的 parseResult 同一口径。 */
  const parseJsonBlock = (text: string): unknown => {
    const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
    const last = matches[matches.length - 1]?.[1];
    if (last === undefined) {
      throw badRequest(
        "回答末尾没有 json 结果块。可以在对话里追一句「请在末尾补一个 json 块」，再取一次。",
      );
    }
    try {
      return JSON.parse(last);
    } catch {
      throw badRequest("json 块解析失败（可能被截断了），追问让它重发一遍。");
    }
  };

  void app.register((scope, _opts, done) => {
    // 原始字节：文件边收边写，不占内存（与文件模块同一做法）。
    scope.addContentTypeParser(
      "application/octet-stream",
      (_request, payload, next) => {
        next(null, payload);
      },
    );

    scope.get("/api/presales", () => ({ libs: catalog.list() }));

    scope.post("/api/presales", (request, reply) =>
      reply.code(201).send(catalog.create(createLibSchema.parse(request.body))),
    );

    scope.get("/api/presales/:id", (request) => {
      const { id } = idParams.parse(request.params);
      const detail = catalog.get(id);
      if (detail === undefined)
        throw new HttpError(404, "NOT_FOUND", "售前库不存在");
      // 材料是文件库的映射：文件在「事实底座」里被删或被挪走时要标出来，
      // 而不是让人点了下载才发现 404。
      const exists = (path: string | null): boolean =>
        path !== null && (files?.exists(path) ?? false);
      const mark = <T extends { filePath: string | null }>(v: T) => ({
        ...v,
        fileExists: exists(v.filePath),
      });
      const tpl =
        detail.lib.templateId === null
          ? undefined
          : templates?.get(detail.lib.templateId);
      return {
        ...detail,
        /** 阶段清单来自模板；模板没了就从材料本身推，不让界面失去筛选。 */
        stages:
          tpl === undefined
            ? [...new Set(detail.slots.map((s) => s.stage))].map((code) => ({
                code,
                label: code,
              }))
            : tpl.stages.map((s) => ({ code: s.code, label: s.label })),
        slots: detail.slots.map((slot) => ({
          ...slot,
          versions: slot.versions.map(mark),
          current: slot.current === null ? null : mark(slot.current),
        })),
      };
    });

    /** 换绑模板：不动已有材料，只重新对号（说明 / 检查要点随之改取新模板的）。 */
    scope.post("/api/presales/:id/template", (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { templateId } = z
        .object({ templateId: z.string().trim().nullable() })
        .parse(request.body);
      catalog.setTemplate(
        id,
        templateId === null || templateId === "" ? null : templateId,
      );
      // 换绑后按名称 / 别名自动对号；把对号结果交回去，界面据此给人确认、手动改。
      const detail = catalog.get(id);
      if (detail === undefined) throw notFound("售前库不存在");
      return reply.send({
        linked: detail.slots.filter((s) => s.link === "linked").length,
        unmatched: detail.slots
          .filter((s) => s.link === "unmatched")
          .map((s) => s.title),
        gaps: detail.templateGaps.map((g) => g.name),
      });
    });

    scope.patch("/api/presales/:id", (request) => {
      const { id } = idParams.parse(request.params);
      return catalog.update(id, updateLibSchema.parse(request.body));
    });

    scope.delete("/api/presales/:id", async (request, reply) => {
      const { id } = idParams.parse(request.params);
      // 目录按**库名**建（见上传接口），先拿到名字，删完记录就查不到了。
      const libName = catalog.get(id)?.lib.name ?? null;
      const paths = catalog.remove(id);
      // 库记录已经删了；删文件失败不该让接口报错——留几个孤儿文件比「删不掉」好。
      for (const path of paths) {
        await files?.remove(path).catch(() => undefined);
      }
      /*
       * 版本表里只有**有文件**的那些记着路径；AI 起草过、还没定版的草稿文件、
       * 上传后又换过版的旧文件都可能不在 paths 里。所以再按库名整目录删一次。
       * 原来这里拼的是 `/售前/<库 id>`，而目录是 `/售前/<库名>`——那句从来没匹配到过，
       * 删库后材料文件一直留在盘上。
       */
      if (files !== undefined && libName !== null) {
        await files
          .remove(childOf(PRESALES_ROOT, safeFileName(libName)), {
            recursive: true,
          })
          .catch(() => undefined);
      }
      return reply.code(204).send();
    });

    scope.post("/api/presales/:id/slots/sync", (request) => {
      const { id } = idParams.parse(request.params);
      const added = catalog.syncTemplate(id);
      const detail = catalog.get(id);
      if (detail === undefined)
        throw new HttpError(404, "NOT_FOUND", "售前库不存在");
      return { ...detail, added };
    });

    scope.post("/api/presales/:id/slots", (request, reply) => {
      const { id } = idParams.parse(request.params);
      return reply
        .code(201)
        .send(catalog.addSlot(id, createSlotSchema.parse(request.body)));
    });

    scope.patch("/api/presales/slots/:id", (request, reply) => {
      const { id } = idParams.parse(request.params);
      catalog.updateSlot(id, updateSlotSchema.parse(request.body));
      return reply.code(204).send();
    });

    scope.delete("/api/presales/slots/:id", async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const paths = catalog.removeSlot(id);
      // 文件删失败不该让接口报错：留几个孤儿文件，比「删不掉」好（同一口径见删库）。
      for (const path of paths) {
        await files?.remove(path).catch(() => undefined);
      }
      return reply.code(204).send();
    });

    scope.post("/api/presales/slots/:id/versions", (request, reply) => {
      const { id } = idParams.parse(request.params);
      return reply
        .code(201)
        .send(catalog.addVersion(id, createVersionSchema.parse(request.body)));
    });

    scope.patch("/api/presales/versions/:id", (request, reply) => {
      const { id } = idParams.parse(request.params);
      catalog.updateVersion(id, updateVersionSchema.parse(request.body));
      return reply.code(204).send();
    });

    scope.post("/api/presales/versions/:id/status", async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { status } = z
        .object({ status: z.enum(STATUSES) })
        .parse(request.body);
      if (status === "current") await promoteVersion(catalog, files, id);
      else catalog.setVersionStatus(id, status);
      return reply.code(204).send();
    });

    scope.delete("/api/presales/versions/:id", (request, reply) => {
      const { id } = idParams.parse(request.params);
      const removed = catalog.removeVersion(id);
      if (removed.filePath !== null && files !== undefined) {
        void files.remove(removed.filePath).catch(() => undefined);
      }
      return reply.code(204).send();
    });

    /**
     * 上传材料文件。原始字节流 + 文件名走 query：
     * 与「事实底座」的上传同一条通道，服务端边收边写盘。
     */
    /**
     * 上传 / 替换这一类材料的文件——**写进文件库**。
     *
     * 文件落在 `/售前/<库名>/` 下（用户在「事实底座」里能直接看到、按名字找到），
     * 同名自动改名而不覆盖。替换时：新文件成为现行版，旧文件从文件库删掉——
     * 售前清单就是文件库的映射，不在库里留一份没人管的旧文件。
     */
    scope.post("/api/presales/slots/:id/upload", async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const query = z
        .object({ name: z.string().trim().min(1).max(255) })
        .parse(request.query);
      if (files === undefined)
        throw new HttpError(500, "INTERNAL", "文件存储未启用");
      const slot = catalog.slotOf(id);
      if (slot === undefined) throw notFound("材料条目不存在");
      const lib = catalog.get(slot.libId)?.lib;
      if (lib === undefined) throw notFound("售前库不存在");

      const folder = childOf(PRESALES_ROOT, safeFileName(lib.name));
      const data =
        request.body instanceof Readable ? request.body : Buffer.alloc(0);
      const { entry } = await files.write(
        childOf(folder, safeFileName(query.name)),
        data,
        { mode: "autorename", parents: true },
      );

      const old = slot.current;
      const version = catalog.addVersion(id, {
        version: old === null ? "v1.0" : nextVersion(old.version),
        status: "current",
        filePath: entry.path,
        fileName: entry.name,
        fileSize: entry.size,
      });
      if (old?.filePath != null && old.filePath !== entry.path) {
        await files.remove(old.filePath).catch(() => undefined);
        catalog.removeVersion(old.id);
      }
      hooks?.onUploaded?.(id);
      return reply.code(201).send(version);
    });

    /**
     * 写一份 Markdown 草稿（售前助手「起草缺口」用，人也能调）。
     *
     * 落在临时区 `/临时区/售前/<库名>/AI草稿/`，登记成**草稿版本**：现行版不动，
     * 人在售前页「设为可对外」或在临时区「确认」才生效（文件随之搬进 `/售前/<库名>/`）
     * ——AI 起草的东西不能不经人眼就成为对外口径。
     */
    scope.post("/api/presales/slots/:id/draft", async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = z
        .object({
          name: z.string().trim().min(1).max(200),
          text: z.string().min(1, "正文不能为空").max(500_000, "正文太大"),
        })
        .parse(request.body);
      if (files === undefined)
        throw new HttpError(500, "INTERNAL", "文件存储未启用");
      const slot = catalog.slotOf(id);
      if (slot === undefined) throw notFound("材料条目不存在");
      const lib = catalog.get(slot.libId)?.lib;
      if (lib === undefined) throw notFound("售前库不存在");
      const base = body.name.replace(/\.(md|markdown)$/i, "");
      const folder = presalesStagingFolder(lib.name, "AI草稿");
      const { entry } = await files.write(
        childOf(folder, safeFileName(`${base}.md`)),
        Buffer.from(body.text, "utf8"),
        { mode: "autorename", parents: true },
      );
      const latest = slot.versions[0];
      const version = catalog.addVersion(id, {
        version: latest === undefined ? "v0.1" : nextVersion(latest.version),
        status: "draft",
        note: "售前助手起草，待人审定",
        filePath: entry.path,
        fileName: entry.name,
        fileSize: entry.size,
      });
      return reply.code(201).send(version);
    });

    /**
     * 删除这一类材料的文件：**从文件库删掉**，这一类变回缺口。
     * 「应具备哪些材料」是模板定的，条目本身保留。
     */
    scope.delete("/api/presales/slots/:id/file", async (request, reply) => {
      const { id } = idParams.parse(request.params);
      if (files === undefined)
        throw new HttpError(500, "INTERNAL", "文件存储未启用");
      const slot = catalog.slotOf(id);
      if (slot === undefined) throw notFound("材料条目不存在");
      // 这一类下所有挂着文件的版本一起删：只删现行版，旧版会顶上来冒充「已备」。
      for (const v of slot.versions) {
        if (v.filePath !== null) {
          await files.remove(v.filePath).catch(() => undefined);
        }
        catalog.removeVersion(v.id);
      }
      return reply.code(204).send();
    });

    /** 改文件名：文件库里的文件同步改名（同目录内移动）。 */
    scope.post("/api/presales/versions/:id/rename", async (request) => {
      const { id } = idParams.parse(request.params);
      const { name } = z
        .object({ name: z.string().trim().min(1, "文件名不能为空").max(255) })
        .parse(request.body);
      if (files === undefined)
        throw new HttpError(500, "INTERNAL", "文件存储未启用");
      const version = catalog.versionOf(id);
      if (version?.filePath == null) throw notFound("这份材料还没有文件");
      const next = safeFileName(name);
      if (next === nameOf(version.filePath)) return version;
      const moved = await files.move(
        version.filePath,
        childOf(parentOf(version.filePath), next),
      );
      return catalog.attachFile(id, {
        path: moved.path,
        name: moved.name,
        size: moved.size,
      });
    });

    scope.get("/api/presales/versions/:id/file", async (request, reply) => {
      const { id } = idParams.parse(request.params);
      if (files === undefined) {
        throw new HttpError(500, "INTERNAL", "文件存储未启用");
      }
      const version = catalog.versionOf(id);
      if (version?.filePath == null) {
        throw new HttpError(404, "NOT_FOUND", "这份材料还没有文件");
      }
      const { entry, stream } = await files.openRead(version.filePath);
      const ascii = entry.name
        .replace(/[^\x20-\x7e]/g, "_")
        .replace(/["\\]/g, "_");
      return reply
        .header("Content-Type", "application/octet-stream")
        .header("Content-Length", String(entry.size))
        .header("X-Content-Type-Options", "nosniff")
        .header("Content-Security-Policy", "sandbox; default-src 'none'")
        .header("Cache-Control", "no-cache")
        .header(
          "Content-Disposition",
          `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(entry.name)}`,
        )
        .send(stream);
    });

    /**
     * 发起识别。
     *
     * 与「AI 识别产线与产品」同一形态：**不自己流式**，只建一条带 task 的会话、
     * 把提示词交回前端，由现成的 /api/sessions/:id/chat 发出去。
     * 好处是流式、停止、追问、刷新恢复全是已有能力。
     */
    scope.post("/api/presales/:id/recognize", (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { folderPath } = z
        .object({ folderPath: z.string().trim().min(1, "选一个文件夹") })
        .parse(request.body);
      if (files === undefined)
        throw new HttpError(500, "INTERNAL", "文件存储未启用");
      if (sessions === undefined)
        throw new HttpError(500, "INTERNAL", "会话存储未启用");
      const detail = catalog.get(id);
      if (detail === undefined) throw notFound("售前库不存在");

      const scan = scanForRecognition(files, folderPath);
      if (scan.files.length === 0) {
        throw badRequest("这个范围内没有文件，换一个文件夹试试");
      }
      const header = sessions.newHeader() as { id: string };
      const row = sessions.store.create({
        id: header.id,
        title: `AI 识别售前材料：${detail.lib.name}`,
        header,
        task: { kind: "presales-recognize", libId: id, folderPath },
      });
      return reply.code(201).send({
        sessionId: row.id,
        title: row.title,
        prompt: recognizePrompt({
          scopePath: folderPath,
          files: scan.files,
          total: scan.total,
          truncated: scan.truncated,
          slots: detail.slots.map((s) => ({
            id: s.id,
            title: s.title,
            stage: s.stage,
            audience: s.audience,
          })),
        }),
        stats: {
          files: scan.files.length,
          total: scan.total,
          truncated: scan.truncated,
        },
      });
    });

    /** 取识别结果，落成候选。重复取会覆盖上一轮还没处理的候选。 */
    scope.post("/api/presales/recognize/:sessionId", (request) => {
      const { sessionId } = z
        .object({ sessionId: z.string() })
        .parse(request.params);
      if (sessions === undefined)
        throw new HttpError(500, "INTERNAL", "会话存储未启用");
      const row = sessions.store.get(sessionId);
      if (row === undefined) throw notFound("会话不存在");
      const task = row.task;
      if (task?.kind !== "presales-recognize") {
        throw badRequest("这条会话不是售前材料识别");
      }
      const text = assistantText(sessionId);
      if (text.trim() === "")
        throw badRequest("这轮识别还没有回答，等它答完再取。");

      const parsed = recognizeResultSchema.parse(parseJsonBlock(text));
      const detail = catalog.get(task.libId);
      if (detail === undefined) throw notFound("售前库不存在");
      if (files === undefined)
        throw new HttpError(500, "INTERNAL", "文件存储未启用");

      const byTitle = new Map(detail.slots.map((s) => [s.title, s]));
      // 重新取一次文件元信息：模型给的是路径原文，大小与时间以库里为准，
      // 不采信模型转述的数字（它经常抄错或省略）。
      const indexed = new Map(
        scanForRecognition(files, task.folderPath).files.map((f) => [
          f.path,
          f,
        ]),
      );

      const rows: Parameters<typeof candidates.replace>[1] = [];
      const unknown: string[] = [];
      for (const pick of parsed.picks) {
        const slot = byTitle.get(pick.slotTitle);
        if (slot === undefined) {
          unknown.push(pick.slotTitle);
          continue;
        }
        const file = indexed.get(pick.filePath);
        if (file === undefined) {
          unknown.push(pick.filePath);
          continue;
        }
        // 同一类材料只留第一条；模型偶尔会重复。
        if (rows.some((r) => r.slotId === slot.id)) continue;
        rows.push({
          libId: task.libId,
          slotId: slot.id,
          slotTitle: slot.title,
          filePath: file.path,
          fileName: file.name,
          fileSize: file.size,
          fileModifiedAt: file.modifiedAt,
          confidence: pick.confidence,
          reason: pick.reason,
          alternates: pick.alternates,
          status: "pending",
          versionId: null,
        });
      }
      candidates.replace(task.libId, rows);
      return {
        libId: task.libId,
        candidates: candidates.list(task.libId),
        /** 模型提到但库里没有的标题 / 路径。不静默丢掉——它常常意味着模板缺了一类材料。 */
        unknown,
      };
    });

    scope.get("/api/presales/:id/candidates", (request) => {
      const { id } = idParams.parse(request.params);
      return { candidates: candidates.list(id) };
    });

    /**
     * 确认一条候选：建版本并把它指向文件库里的那份文件。
     *
     * 文件**不复制**：版本直接引用原路径。售前材料动辄几十上百 MB，
     * 复制一份等于同一份 PPT 在库里存两次，而且改了原件库里的还是旧的。
     * 代价是用户在「事实底座」里删掉原件后，这条材料会变成「文件找不到」——
     * 界面上会标出来，重新登记即可。
     */
    scope.post("/api/presales/candidates/:id/accept", (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const body = z
        .object({
          version: z.string().trim().min(1).max(40).optional(),
          status: z.enum(STATUSES).optional(),
          releasedAt: z.string().trim().max(40).optional(),
        })
        .parse(request.body ?? {});
      const candidate = candidates.get(id);
      if (candidate === undefined) throw notFound("候选不存在");
      if (candidate.status === "accepted") {
        throw badRequest("这条已经入库了");
      }
      const version = catalog.addVersion(candidate.slotId, {
        version: body.version ?? "v1.0",
        status: body.status ?? "current",
        ...(body.releasedAt === undefined
          ? {}
          : { releasedAt: body.releasedAt }),
        note: `AI 识别导入：${candidate.reason}`,
        filePath: candidate.filePath,
        fileName: candidate.fileName,
        fileSize: candidate.fileSize,
      });
      candidates.accept(id, version.id);
      return candidates.get(id) ?? candidate;
    });

    scope.post("/api/presales/candidates/:id/skip", (request, reply) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      if (candidates.get(id) === undefined) throw notFound("候选不存在");
      candidates.update(id, { status: "rejected" });
      return reply.code(204).send();
    });

    scope.post("/api/presales/:id/candidates/clear", (request, reply) => {
      const { id } = idParams.parse(request.params);
      candidates.clear(id);
      return reply.code(204).send();
    });

    /**
     * 在线看这份材料。
     *
     * - Markdown / 纯文本：原样给正文，前端渲染并可编辑（保存走下面那个 PUT）。
     * - docx / xlsx / pptx：抽出纯文本给前端按文本看。**只读**——这不是 Office
     *   渲染器，也不做回写（回写会毁掉原文件的样式，代价远大于收益）。
     * - pdf / 图片 / 视频：不在这个接口里，前端直接用 /file 的地址看。
     * - 其余：`kind: "unsupported"`，界面提示下载。
     */
    scope.get("/api/presales/versions/:id/preview", async (request) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      if (files === undefined)
        throw new HttpError(500, "INTERNAL", "文件存储未启用");
      const version = catalog.versionOf(id);
      if (version?.filePath == null || version.fileName == null) {
        throw notFound("这份材料还没有文件");
      }
      const name = version.fileName;
      const ext = extOf(name);

      if (TEXT_EXT.has(ext)) {
        const { stream } = await files.openRead(version.filePath);
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk as Uint8Array));
        }
        const text = Buffer.concat(chunks).toString("utf8");
        return {
          kind: ext === "md" || ext === "markdown" ? "markdown" : "text",
          name,
          editable: ext === "md" || ext === "markdown",
          text,
          truncated: false,
          filePath: version.filePath,
        } as const;
      }

      if (isOfficeFile(name)) {
        const { stream } = await files.openRead(version.filePath);
        const chunks: Uint8Array[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk as Uint8Array));
        }
        const extracted = extractOfficeText(name, Buffer.concat(chunks));
        if (extracted === null) {
          return {
            kind: "unsupported",
            name,
            editable: false,
            reason:
              "这份 Office 文件读不出文字内容（可能是纯图片或文件损坏），请下载查看",
          } as const;
        }
        return {
          kind: extracted.kind,
          name,
          editable: false,
          text: extracted.text,
          truncated: extracted.truncated,
          filePath: version.filePath,
        } as const;
      }

      return {
        kind: "unsupported",
        name,
        editable: false,
        reason: "这种格式不在线预览，请下载查看",
      } as const;
    });

    /** 保存 Markdown 正文。只允许 md——Office 回写会毁掉原样式，那条路不开。 */
    scope.put("/api/presales/versions/:id/preview", async (request, reply) => {
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const { text } = z
        .object({ text: z.string().max(5_000_000, "正文太大") })
        .parse(request.body);
      if (files === undefined)
        throw new HttpError(500, "INTERNAL", "文件存储未启用");
      const version = catalog.versionOf(id);
      if (version?.filePath == null || version.fileName == null) {
        throw notFound("这份材料还没有文件");
      }
      const ext = extOf(version.fileName);
      if (ext !== "md" && ext !== "markdown") {
        throw badRequest(
          "只有 Markdown 能在线编辑；Office 与 PDF 请下载后用原工具改",
        );
      }
      const { entry } = await files.write(
        version.filePath,
        Buffer.from(text, "utf8"),
        {
          mode: "overwrite",
        },
      );
      return reply.send({ size: entry.size, modifiedAt: entry.modifiedAt });
    });

    done();
  });
}

export const templateStages = STAGES;
