import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "../db.js";
import { badRequest, conflict, notFound } from "../errors.js";
import type { FileStore } from "../files/store.js";
import {
  architectureResultSchema,
  createArchitecture,
  createNodeSchema,
  updateNodeSchema,
} from "../architecture.js";
import { createLifecycle, type Template } from "../lifecycle.js";
import { BUILTIN_WIKI } from "../wiki-builtin.js";
import { createWiki, outlineResultSchema } from "../wiki.js";
import { textOf } from "../pi/parts.js";
import { extractArtifactDraft } from "../global-fill-prompts.js";
import { CODE_ROOT } from "../files/paths.js";
import { createCatalog, MAX_REF_PATHS } from "../products.js";
import type { SessionStore } from "../sessions.js";
import { readFocus, scanFolder, scanRef, type ScanResult } from "./scan.js";
import {
  architecturePrompt,
  extractWikiPage,
  wikiOutlinePrompt,
  wikiPagePrompt,
  compareResultSchema,
  comparePrompt,
  discoverPrompt,
  discoverResultSchema,
  parseResult,
  summarize,
  type CompareSummary,
  type NormalizedFinding,
  type SourceState,
} from "./tasks.js";

/**
 * 两个 AI 分析的接口：产线与产品识别、产出物比对。
 *
 * ## 形态：分析就跑在真对话里
 *
 * 用户要「看着它跑、还能追问」，所以这里**不自己做流式**——它只负责：
 * ① 采集目录事实、拼好提示词；② 建一条带 `task` 标记的会话；③ 把提示词交给前端。
 * 前端拿到后切到「对话」菜单，用**现成的** `/api/sessions/:id/chat` 把它发出去。
 * 于是续流、停止、切模型、刷新恢复这些全是已有能力，一行新代码都不用写。
 *
 * 取结果时再回来：从会话条目里拼出 assistant 的全部文字，取**最后一个** json 块。
 * 追问后自然就是最新那版（见 tasks.ts 顶部注释）。
 *
 *   POST /api/analysis/discover            {folderPath}  → {sessionId, prompt, title, stats}
 *   POST /api/analysis/compare             {productId}   → {sessionId, prompt, title, stats}
 *   GET  /api/analysis/:sessionId/result                 → 解析出的结构化结果
 *   POST /api/analysis/:sessionId/apply    {lines}       → 批量建产线与产品（identify）
 *   POST /api/analysis/:sessionId/save                   → 落比对结果（compare）
 *   GET  /api/products/:id/check                         → 最近一次比对结果
 */

/** 识别一次最多勾几处。每处各占一份扫描预算，再多提示词会被撑爆。 */
export const MAX_DISCOVER_PATHS = 12;

const discoverPath = z
  .string()
  .trim()
  .min(1, "要分析哪个文件夹")
  .refine((v) => v.startsWith("/"), "路径要以 / 开头（文件模块里的路径）")
  .refine((v) => v !== "/", "不要选根目录，选到具体的产品库那一层")
  .refine((v) => v !== CODE_ROOT, "不要选整个代码库，勾到具体的仓库");

/**
 * 识别的范围：可以同时勾文档文件夹、单个文件和代码仓库。
 * 旧调用只传 `folderPath`，照样认。
 */
const discoverBody = z
  .object({
    folderPath: discoverPath.optional(),
    paths: z
      .array(discoverPath)
      .max(MAX_DISCOVER_PATHS, `一次最多选 ${String(MAX_DISCOVER_PATHS)} 处`)
      .optional(),
  })
  .transform((v) => [
    ...new Set([
      ...(v.folderPath === undefined ? [] : [v.folderPath]),
      ...(v.paths ?? []),
    ]),
  ])
  .refine((list) => list.length > 0, "要分析哪个文件夹");

const compareBody = z.object({
  productId: z.string().trim().min(1, "要比对哪个产品"),
});

/** 一次架构分析最多扫几个证据根。超了截断并如实报出来。 */
const MAX_EVIDENCE_ROOTS = 6;

/** 功能架构：根级分析给 productId；展开某个节点给 nodeId。 */
const architectureBody = z.object({
  productId: z.string().trim().min(1, "要分析哪个产品"),
  nodeId: z.string().trim().optional(),
  mode: z.enum(["append", "replace"]).default("append"),
});

/** Wiki 目录：规划整本 wiki 的章节。 */
const wikiOutlineBody = z.object({
  productId: z.string().trim().min(1, "要给哪个产品做 wiki"),
  mode: z.enum(["append", "replace"]).default("append"),
});

/** Wiki 单页：给某一章写正文。 */
const wikiPageBody = z.object({
  pageId: z.string().trim().min(1, "要写哪一页"),
});

/** 应用识别结果：允许用户在确认表里改过名字、去掉几项，所以整棵树由前端回传。 */
const applyBody = z.object({
  lines: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(2000).default(""),
        folderPath: z.string().trim().default(""),
        products: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(80),
              description: z.string().trim().max(2000).default(""),
              folderPath: z.string().trim().default(""),
              codePath: z.string().trim().default(""),
              refPaths: z.array(z.string().trim()).default([]),
              templateId: z.string().trim().default(""),
            }),
          )
          .default([]),
      }),
    )
    .min(1, "至少要勾一条产品线"),
});

export interface AppliedReport {
  createdLines: string[];
  createdProducts: string[];
  /** 已存在的产品：只补了空着的依据（代码目录、参考资料）。 */
  filledProducts: string[];
  /** 已存在而跳过的（重名）。不当失败——重复点「应用」不该报错。 */
  skipped: { what: string; why: string }[];
}

export interface StoredCheck {
  productId: string;
  templateId: string;
  sessionId: string | null;
  folderPath: string;
  summary: CompareSummary;
  findings: NormalizedFinding[];
  checkedAt: number;
}

/** 识别结果里一条依据路径被拿掉的原因。界面上要如实列出，不能悄悄丢。 */
export interface DroppedPath {
  path: string;
  why: string;
}

const inCodeRoot = (p: string): boolean =>
  p === CODE_ROOT || p.startsWith(`${CODE_ROOT}/`);

/**
 * 核对 AI 给出的代码目录与参考资料：只留文件库里真实存在、且放对了地方的。
 *
 * 模型会照声明文件里的相对路径去换算，换错一层就指到不存在的地方；也可能把代码
 * 仓库塞进参考资料。这些不进确认表的默认值，而是列成「没采用」并说明原因——
 * 绑了一个不存在的路径，后面每次对话都会报「依据缺失」。
 */
export function checkEvidencePaths(
  exists: (path: string) => boolean,
  input: { folderPath: string; codePath: string; refPaths: string[] },
): { codePath: string; refPaths: string[]; dropped: DroppedPath[] } {
  const dropped: DroppedPath[] = [];
  let codePath = input.codePath;
  if (codePath !== "") {
    if (!inCodeRoot(codePath)) {
      dropped.push({ path: codePath, why: `代码目录要在 ${CODE_ROOT} 下` });
      codePath = "";
    } else if (!exists(codePath)) {
      dropped.push({ path: codePath, why: "文件库里找不到" });
      codePath = "";
    }
  }
  const refPaths: string[] = [];
  for (const ref of input.refPaths) {
    if (ref === "" || refPaths.includes(ref)) continue;
    if (ref === input.folderPath) continue; // 文档目录本来就是依据，不用再挂一遍
    if (inCodeRoot(ref)) {
      dropped.push({ path: ref, why: "代码不放参考资料，走代码目录" });
      continue;
    }
    if (!ref.startsWith("/") || !exists(ref)) {
      dropped.push({ path: ref, why: "文件库里找不到" });
      continue;
    }
    if (refPaths.length >= MAX_REF_PATHS) {
      dropped.push({
        path: ref,
        why: `参考资料最多 ${String(MAX_REF_PATHS)} 条`,
      });
      continue;
    }
    refPaths.push(ref);
  }
  return { codePath, refPaths, dropped };
}

export function registerAnalysisRoutes(
  app: FastifyInstance,
  db: Db,
  deps: { store: SessionStore; files?: FileStore; newHeader: () => unknown },
  now: () => number = Date.now,
): void {
  const catalog = createCatalog(db, now);
  const lifecycle = createLifecycle(db, now);
  const architecture = createArchitecture(db, now);
  const wiki = createWiki(db);

  const filesOr400 = (): FileStore => {
    // 文件模块没启用时整个分析都无从谈起（事实源就在那儿）。说清楚，别给个空结果。
    if (!deps.files) throw badRequest("文件模块未启用，无法读取目录");
    return deps.files;
  };

  const templateOf = (id: string): Template => lifecycle.get(id);

  /** 会话里 assistant 说过的所有文字，按顺序拼起来。 */
  const assistantText = (sessionId: string): string =>
    deps.store
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

  const taskOf = (sessionId: string) => {
    const row = deps.store.get(sessionId);
    if (!row) throw notFound("会话不存在");
    if (row.task === null) throw badRequest("这条会话不是一次 AI 分析");
    return row.task;
  };

  /* ── 发起分析 ── */

  app.post("/api/analysis/discover", async (request, reply) => {
    const paths = discoverBody.parse(request.body);
    const files = filesOr400();
    const codePicked = paths.filter(inCodeRoot);
    const docPicked = paths.filter((p) => !inCodeRoot(p));
    /*
     * 文档这边：文件夹看目录骨架 + 说明文件，单个文件直接读正文（scanRef 自己分辨）。
     * 路径不存在时由 scan 报「文件夹不存在」，不悄悄跳过——用户以为它被看过了。
     */
    const docScans: ScanResult[] = [];
    for (const p of docPicked) {
      const isFile = await files
        .item(p)
        .then(() => true)
        .catch(() => false);
      docScans.push(
        isFile
          ? await scanRef(files, p)
          : await scanFolder(files, p, { onlyFolders: true }),
      );
    }
    /*
     * 代码这边：勾了仓库就只给勾的那几个，并浅看一层目录与 README，好让 AI 对得准；
     * 没勾就把代码库里所有仓库的名字列出来，由 AI 按声明文件去对。
     */
    const codeScans: ScanResult[] = [];
    for (const p of codePicked) {
      if (!files.exists(p)) throw notFound(`代码库里找不到 ${p}`);
      codeScans.push(
        await scanFolder(files, p, { onlyFolders: true, maxDepth: 1 }),
      );
    }
    const codeRepos =
      codePicked.length > 0
        ? codePicked
        : files.exists(CODE_ROOT)
          ? (await files.list(CODE_ROOT)).entries
              .filter((e) => e.kind === "folder")
              .map((e) => `${CODE_ROOT}/${e.name}`)
          : [];
    const all = [...docScans, ...codeScans];
    const header = deps.newHeader() as { id: string };
    const row = deps.store.create({
      id: header.id,
      title: `AI 识别产线与产品：${paths.join("、")}`,
      header,
      task: { kind: "discover", folderPath: paths[0] ?? "", paths },
    });
    return reply.code(201).send({
      sessionId: row.id,
      title: row.title,
      prompt: discoverPrompt(docScans, codeRepos, codeScans),
      stats: all.reduce(
        (acc, x) => ({
          dirs: acc.dirs + x.stats.dirs,
          nodes: acc.nodes + x.stats.nodes,
          truncated: acc.truncated || x.stats.truncated,
        }),
        { dirs: 0, nodes: 0, truncated: false },
      ),
      skippedDocs: all.flatMap((x) => x.skipped),
    });
  });

  app.post("/api/analysis/compare", async (request, reply) => {
    const { productId } = compareBody.parse(request.body);
    const files = filesOr400();
    const product = catalog
      .list()
      .flatMap((l) => l.products)
      .find((p) => p.id === productId);
    if (!product) throw notFound("产品不存在");
    if (product.templateId === null)
      throw conflict(
        `「${product.name}」还没绑生命周期规范，先去编辑产品里选一个模板`,
      );
    if (product.folderPath === null)
      throw conflict(
        `「${product.name}」还没绑文件夹，先去编辑产品里指一个目录`,
      );
    const template = templateOf(product.templateId);
    // 比对要看文件名，所以不是 onlyFolders；深一层，产出物常放在 prd/ 这类二级目录里。
    const scan = await scanFolder(files, product.folderPath, { maxDepth: 4 });
    const header = deps.newHeader() as { id: string };
    const row = deps.store.create({
      id: header.id,
      title: `AI 比对产出物：${product.name}`,
      header,
      productId,
      task: {
        kind: "compare",
        productId,
        templateId: template.id,
        folderPath: product.folderPath,
      },
    });
    return reply.code(201).send({
      sessionId: row.id,
      title: row.title,
      prompt: comparePrompt(template, scan),
      stats: scan.stats,
      skippedDocs: scan.skipped,
    });
  });

  app.post("/api/analysis/architecture", async (request, reply) => {
    const body = architectureBody.parse(request.body);
    const files = filesOr400();
    const product = catalog
      .list()
      .flatMap((l) => l.products)
      .find((p) => p.id === body.productId);
    if (!product) throw notFound("产品不存在");
    if (product.codePath === null)
      throw conflict(
        `「${product.name}」还没绑代码目录，先去「事实底座 → 代码」上传代码库，再在产品里指一个目录`,
      );

    const nodeId =
      body.nodeId === undefined || body.nodeId === "" ? null : body.nodeId;
    const path =
      nodeId === null
        ? []
        : architecture.pathOf(nodeId).map((n) => ({
            name: n.name,
            duty: n.duty,
            evidence: n.evidence,
          }));
    const target = nodeId === null ? null : architecture.node(nodeId);
    /**
     * 扫描面按「这一支的代码证据」收窄。没有证据就退回整个代码目录——
     * 退回时**要让模型知道**（提示词里本来就带着这一支的上下文），
     * 否则它会把别的分支的功能也算进来。
     */
    /*
     * 扫描根。**必须校验归属**，因为 evidence 是模型生成的字符串。
     *
     * `files.list` 的 normalizePath 会拒掉 `..`，所以跳不出文件库；但证据以 `/`
     * 开头时会被当成库内绝对路径用——`evidence: "/"` 就让下一轮采集横扫整个文件库，
     * 连「文件」入口下的 PRD、合规、售前文档一起读。配合凭据防线那一节讲的外流链，
     * 这是一条自放大的通道：仓里一个被投毒的 README 让模型把证据写成 `/`，
     * 下一次「拆解功能」就把文档库的 yaml/json 正文一起发走。
     *
     * 所以越界的证据**直接丢弃**（不是静默采集），全丢光就退回产品自己的代码目录。
     */
    const base = product.codePath;
    const within = (p: string): boolean =>
      p === base || p.startsWith(`${base}/`);
    const fromEvidence =
      target === null
        ? []
        : target.evidence
            .map((e) => (e.startsWith("/") ? e : `${base}/${e}`))
            .filter(within);
    const roots = fromEvidence.length > 0 ? fromEvidence : [base];
    /**
     * 证据常常指向**文件**而不是文件夹（`app/pages/login.vue` 这种），
     * 而 scanFolder 只能 list 文件夹。原样传进去会 NOT_A_FOLDER，
     * 于是「证据全是文件」的节点一点「向下拆一层」就 409 —— 这是实际会撞上的。
     * 指到文件就退到它所在的文件夹，并去重（同目录下多个文件只扫一次）。
     */
    const asFolder = (p: string): string => {
      const name = p.slice(p.lastIndexOf("/") + 1);
      // 带扩展名的按文件看待。目录名里带点的情况（如 `.well-known`）已被隐藏文件规则挡在外面。
      return name.includes(".") ? p.slice(0, p.lastIndexOf("/")) || "/" : p;
    };
    const scanRoots = [...new Set(roots.map(asFolder))].filter(
      (p) => p !== "" && within(p),
    );
    const scans = await Promise.all(
      // 证据条数要封顶：evidence 单条上限 2000 字符、按行切分，可以有上百行。
      // 不封的话这里会并发开上百个 scanFolder，每个各带 12000 字符的文档预算，
      // 提示词能涨到 MB 级 —— 直接超模型上下文，token 成本也不可控。
      scanRoots
        .slice(0, MAX_EVIDENCE_ROOTS)
        .map((root) =>
          scanFolder(files, root, { maxDepth: 4 }).catch(() => null),
        ),
    );
    const usable = scans.filter((x) => x !== null);
    if (usable.length === 0)
      throw conflict(
        nodeId === null
          ? "读不到这个产品的代码目录，确认一下它还在不在"
          : "这个功能的代码证据指向的路径都读不到了（代码库可能动过），先改一下它的证据",
      );

    const header = deps.newHeader() as { id: string };
    const row = deps.store.create({
      id: header.id,
      title:
        nodeId === null
          ? `AI 分析功能架构：${product.name}`
          : `AI ${body.mode === "replace" ? "重新分析" : "拆解"}功能：${target?.name ?? ""}`,
      header,
      productId: product.id,
      task: {
        kind: "architecture",
        productId: product.id,
        nodeId,
        mode: body.mode,
        codePath: product.codePath,
      },
    });
    return reply.code(201).send({
      sessionId: row.id,
      title: row.title,
      prompt: architecturePrompt(usable, {
        productName: product.name,
        path,
        existing:
          body.mode === "replace"
            ? []
            : (target?.children ?? architecture.tree(product.id)).map(
                (c) => c.name,
              ),
        mode: body.mode,
      }),
      stats: usable.reduce(
        (acc, s) => ({
          dirs: acc.dirs + s.stats.dirs,
          nodes: acc.nodes + s.stats.nodes,
          truncated: acc.truncated || s.stats.truncated,
        }),
        { dirs: 0, nodes: 0, truncated: false },
      ),
      /** 因疑似含凭据而只报名字没报正文的文件。界面上要如实告诉用户。 */
      skippedDocs: usable.flatMap((s) => s.skipped),
      /** 证据条数被截掉时也要说，否则用户以为全扫了。 */
      ...(scanRoots.length > MAX_EVIDENCE_ROOTS
        ? { droppedRoots: scanRoots.length - MAX_EVIDENCE_ROOTS }
        : {}),
    });
  });

  /**
   * Wiki 的事实源：文档目录 + 代码目录，两个都用上。
   *
   * 和功能架构只读代码不同——wiki 的前几章（产品与业务、用户与场景）靠文档，
   * 后几章（架构分层、数据与接口）靠代码。只给一边会让另一半章节无源可依，
   * 而模型在无源时的默认行为是**编**，这正是这本 wiki 最该防的事。
   *
   * 两个都没绑时直接拦下，并说清去哪绑——不让它凭产品名硬写一本。
   */
  const wikiScans = async (
    product: {
      name: string;
      folderPath: string | null;
      codePath: string | null;
      refPaths: readonly string[];
    },
    depth: { main: number; refs: number } = { main: 4, refs: 3 },
  ) => {
    const files = filesOr400();
    if (
      product.folderPath === null &&
      product.codePath === null &&
      product.refPaths.length === 0
    )
      throw conflict(
        `「${product.name}」既没绑文档目录也没绑代码目录。wiki 要有事实源才写得了——先在产品页上给它绑一个（文档在「事实底座 → 文件」，代码在「事实底座 → 代码」）。`,
      );
    /*
     * 读不到的目录**不能静默丢掉**：原来 `.catch(() => null)` 之后模型只看到剩下那一边，
     * 既不知道另一边绑过、也不知道是读失败，于是会反过来让用户「把代码贴给我」。
     * 现在每一处的状态都如实交给提示词（见 tasks.ts 的 renderCoverage）。
     */
    const scanOrNull = (root: string | null) =>
      root === null
        ? Promise.resolve(null)
        : scanFolder(files, root, { maxDepth: depth.main }).catch(() => null);
    const [docScan, codeScan, ...refScans] = await Promise.all([
      scanOrNull(product.folderPath),
      scanOrNull(product.codePath),
      ...product.refPaths.map((p) =>
        scanRef(files, p, { maxDepth: depth.refs }).catch(() => null),
      ),
    ]);
    const stateOf = (
      root: string | null,
      scan: ScanResult | null | undefined,
    ): SourceState =>
      root === null
        ? { state: "unbound" }
        : scan === null || scan === undefined
          ? { state: "unreadable", root }
          : { state: "bound", root };
    const usable = [docScan, codeScan, ...refScans].filter(
      (x): x is ScanResult => x !== null,
    );
    if (usable.length === 0)
      throw conflict("绑定的目录都读不到了，确认一下它们还在不在");
    return {
      usable,
      coverage: {
        docs: stateOf(product.folderPath, docScan),
        code: stateOf(product.codePath, codeScan),
        refs: product.refPaths.map((p, i) => stateOf(p, refScans[i])),
      },
    };
  };

  /**
   * 精读路径的**归属闸**。路径是模型写的（或人手填的），必须落在这个产品
   * 自己绑的范围里——理由同功能架构那段：`"/"` 这样的路径会让下一次精读横扫整个文件库，
   * 把别的产品、售前、合规材料的正文一并发出去。
   */
  const boundRoots = (product: {
    folderPath: string | null;
    codePath: string | null;
    refPaths: readonly string[];
  }): string[] =>
    [product.folderPath, product.codePath, ...product.refPaths].filter(
      (p): p is string => p !== null,
    );
  const withinRoots = (roots: readonly string[], p: string): boolean =>
    roots.some((r) => p === r || p.startsWith(`${r}/`));
  /** 规范化：去掉尾部斜杠、合并重复斜杠。含 `..` / `.` 段的一律不认。 */
  const cleanPath = (p: string): string | null => {
    const parts = p.split("/").filter((x) => x !== "");
    if (parts.some((x) => x === "." || x === "..")) return null;
    return `/${parts.join("/")}`;
  };

  /**
   * 把模型给的精读路径落成库内绝对路径。模型常给相对路径（相对某个根），
   * 所以绝对的直接用，相对的挨个根试，取第一个**真实存在**的。
   */
  const resolveSources = async (
    roots: readonly string[],
    raw: readonly string[],
  ): Promise<{ kept: string[]; dropped: string[] }> => {
    const files = filesOr400();
    const exists = async (p: string): Promise<boolean> =>
      (await files.item(p).catch(() => null)) !== null ||
      (await files.list(p).catch(() => null)) !== null;
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const source of raw) {
      const candidates = source.startsWith("/")
        ? [source]
        : roots.map((r) => `${r}/${source}`);
      let hit: string | null = null;
      for (const c of candidates) {
        const clean = cleanPath(c);
        if (clean === null || !withinRoots(roots, clean)) continue;
        if (await exists(clean)) {
          hit = clean;
          break;
        }
      }
      if (hit === null) dropped.push(source);
      else if (!kept.includes(hit)) kept.push(hit);
    }
    return { kept, dropped };
  };

  const productOr404ById = (id: string) => {
    const hit = catalog
      .list()
      .flatMap((l) => l.products)
      .find((p) => p.id === id);
    if (!hit) throw notFound("产品不存在");
    return hit;
  };

  /** 把章节树压平成「编号 + 标题 + 提纲」的线性清单，给提示词用。 */
  const flatOutline = (
    nodes: readonly {
      number: string;
      title: string;
      brief: string;
      children: readonly unknown[];
    }[],
  ): { number: string; title: string; brief: string }[] =>
    nodes.flatMap((n) => [
      { number: n.number, title: n.title, brief: n.brief },
      ...flatOutline(
        n.children as readonly {
          number: string;
          title: string;
          brief: string;
          children: readonly unknown[];
        }[],
      ),
    ]);

  app.post("/api/analysis/wiki-outline", async (request, reply) => {
    const body = wikiOutlineBody.parse(request.body);
    const product = productOr404ById(body.productId);
    const { usable, coverage } = await wikiScans(product);
    const existing = flatOutline(wiki.tree(product.id));

    const header = deps.newHeader() as { id: string };
    const row = deps.store.create({
      id: header.id,
      title: `AI 规划 Wiki 目录：${product.name}`,
      header,
      productId: product.id,
      task: { kind: "wiki-outline", productId: product.id, mode: body.mode },
    });
    return reply.code(201).send({
      sessionId: row.id,
      title: row.title,
      prompt: wikiOutlinePrompt(usable, {
        productName: product.name,
        productDescription: product.description,
        existing: existing.map((p) => p.title),
        mode: body.mode,
        coverage,
        suggested: BUILTIN_WIKI.map((p) => ({
          title: p.title,
          brief: p.brief,
        })),
      }),
      stats: usable.reduce(
        (acc, s) => ({
          dirs: acc.dirs + s.stats.dirs,
          nodes: acc.nodes + s.stats.nodes,
          truncated: acc.truncated || s.stats.truncated,
        }),
        { dirs: 0, nodes: 0, truncated: false },
      ),
      skippedDocs: usable.flatMap((s) => s.skipped),
    });
  });

  app.post("/api/analysis/wiki-page", async (request, reply) => {
    const { pageId } = wikiPageBody.parse(request.body);
    const page = wiki.page(pageId);
    // page 上没有 productId（树接口不需要），从面包屑的顶层反查不可靠，
    // 所以直接按页反查产品——产品删了会 CASCADE 带走页，所以查得到页就查得到产品。
    const productId = wiki.productOf(pageId);
    const product = productOr404ById(productId);
    /*
     * 有精读路径时：整体目录只给浅的两层当「地图」，预算留给这一章的源文件；
     * 没有时退回规划目录那一份（深 4 层），并在提示词里说清这一章没指定资料。
     */
    const roots = boundRoots(product);
    const inBound = page.sources
      .map((p) => cleanPath(p))
      .filter((p): p is string => p !== null && withinRoots(roots, p));
    const outOfBound = page.sources.filter(
      (p) => !inBound.includes(cleanPath(p) ?? ""),
    );
    const focused = inBound.length > 0;
    const { usable, coverage } = await wikiScans(
      product,
      focused ? { main: 2, refs: 2 } : undefined,
    );
    const focus = focused ? await readFocus(filesOr400(), inBound) : null;

    const header = deps.newHeader() as { id: string };
    const row = deps.store.create({
      id: header.id,
      title: `AI 写 Wiki：${page.number} ${page.title}`,
      header,
      productId,
      task: { kind: "wiki-page", productId, pageId },
    });
    return reply.code(201).send({
      sessionId: row.id,
      title: row.title,
      prompt: wikiPagePrompt(usable, {
        productName: product.name,
        page: { number: page.number, title: page.title, brief: page.brief },
        outline: flatOutline(wiki.tree(productId)),
        previous: page.content,
        coverage,
        focus,
        outOfBound,
      }),
      stats: usable.reduce(
        (acc, s) => ({
          dirs: acc.dirs + s.stats.dirs,
          nodes: acc.nodes + s.stats.nodes,
          truncated: acc.truncated || s.stats.truncated,
        }),
        { dirs: 0, nodes: 0, truncated: false },
      ),
      skippedDocs: [
        ...usable.flatMap((s) => s.skipped),
        ...(focus?.skipped ?? []),
      ],
      ...(focus === null
        ? {}
        : {
            focus: {
              files: focus.files.length,
              unread: focus.unread,
              missing: focus.missing,
            },
          }),
    });
  });

  /* ── 取结果 ── */

  app.get<{ Params: { sessionId: string } }>(
    "/api/analysis/:sessionId/result",
    (request) => {
      const task = taskOf(request.params.sessionId);
      const text = assistantText(request.params.sessionId);
      if (text.trim() === "")
        throw badRequest("这轮分析还没有回答，等它答完再看结果");
      if (task.kind === "discover") {
        const parsed = parseResult(text, discoverResultSchema);
        const exists = (p: string): boolean => deps.files?.exists(p) ?? false;
        return {
          kind: task.kind,
          ...parsed,
          lines: parsed.lines.map((line) => ({
            ...line,
            products: line.products.map((product) => {
              const checked = checkEvidencePaths(exists, product);
              return {
                ...product,
                codePath: checked.codePath,
                refPaths: checked.refPaths,
                droppedPaths: checked.dropped,
              };
            }),
          })),
        };
      }
      if (task.kind === "wiki-outline") {
        const parsed = parseResult(text, outlineResultSchema);
        return {
          kind: task.kind,
          productId: task.productId,
          mode: task.mode,
          ...parsed,
          /** replace 会清掉没写正文的页。写过的留着，这里把数量说清楚。 */
          written:
            task.mode === "replace"
              ? flatOutline(wiki.tree(task.productId)).length -
                wiki.emptyCount(task.productId)
              : 0,
        };
      }
      if (task.kind === "wiki-page") {
        const page = wiki.page(task.pageId);
        return {
          kind: task.kind,
          productId: task.productId,
          pageId: task.pageId,
          pageTitle: `${page.number} ${page.title}`,
          /** 这一页已经有正文时要点明「会被覆盖」，不能笼统说「应用」。 */
          hadContent: page.content !== "",
          ...extractWikiPage(text),
        };
      }
      if (task.kind === "presales-recognize")
        // 售前识别的结果是候选清单，不在这里解析：它由 presales 路由自己取
        // （那边才知道有哪些槽位），这里只回一个明说。
        throw badRequest("售前材料识别请在「售前材料」页面取结果");
      if (task.kind === "presales-ai")
        // 由售前页取（那边知道审的是哪一版、要数原文命中几处）。
        throw badRequest("售前材料的审阅结果请在「售前材料」页面查看");
      if (task.kind === "intel-research")
        throw badRequest("AI 调研的结果在「市场情报」页的待确认里");
      if (task.kind === "forge")
        // 工坊的产出是草稿，在技能 / 智能体页的工坊里看与保存。
        throw badRequest("AI 工坊的草稿请在技能或智能体页查看");
      if (task.kind === "presales-agent")
        // 常驻助手不是一次性分析，没有「结果」可取。
        throw badRequest("售前助手是常驻对话，没有分析结果可取");
      if (task.kind === "fill-artifact")
        return {
          kind: task.kind,
          productId: task.productId,
          runId: task.runId,
          ...extractArtifactDraft(text),
        };
      if (task.kind === "architecture") {
        const parsed = parseResult(text, architectureResultSchema);
        return {
          kind: task.kind,
          productId: task.productId,
          nodeId: task.nodeId,
          mode: task.mode,
          ...parsed,
          /** 这一支下手改过的子功能。replace 模式要点名警告，不能笼统说「会覆盖」。 */
          manualAtRisk:
            task.mode === "replace"
              ? architecture.manualChildren(task.nodeId, task.productId)
              : [],
        };
      }
      const template = templateOf(task.templateId);
      const parsed = parseResult(text, compareResultSchema);
      const { summary, findings } = summarize(template, parsed);
      return {
        kind: task.kind,
        productId: task.productId,
        templateId: task.templateId,
        templateName: template.name,
        summary,
        findings,
      };
    },
  );

  /* ── 应用：识别结果落库 ── */

  app.post<{ Params: { sessionId: string } }>(
    "/api/analysis/:sessionId/apply",
    (request) => {
      const task = taskOf(request.params.sessionId);
      if (task.kind !== "discover")
        throw badRequest("这条会话不是产线与产品识别");
      const { lines } = applyBody.parse(request.body);
      const report: AppliedReport = {
        createdLines: [],
        createdProducts: [],
        filledProducts: [],
        skipped: [],
      };
      // 前端回传的路径不可信：入库前再按文件库核一遍。
      const exists = (p: string): boolean => deps.files?.exists(p) ?? false;
      /*
       * **整批一个事务。**
       *
       * 原来没有事务，且 `existing` 只在循环前取一次：payload 里有两条同名产品线
       * （AI 输出重复或用户勾重）时，第二条在 existing 里找不到 → createLine →
       * UNIQUE 冲突 → 409 抛出，而**前面已经建好的产品线和产品留在库里**。
       * 用户看到「失败」，再点一次又走到另一条分支。整个 apply 不是原子的。
       *
       * 另外 createLine 原来没有被 try 包住（只包了 createProduct），所以它的
       * 409 会直接掀掉整批。现在两者都按「跳过」处理。
       */
      db.transaction(() => {
        for (const line of lines) {
          // 每轮现查：这一批里前面刚建的产品线也要能被后面的认出来。
          let lineId = catalog
            .list()
            .find((l) => l.name.toLowerCase() === line.name.toLowerCase())?.id;
          if (lineId === undefined) {
            try {
              const created = catalog.createLine({
                name: line.name,
                description: line.description,
                folderPath: line.folderPath,
              });
              lineId = created.id;
              report.createdLines.push(created.name);
            } catch (cause) {
              report.skipped.push({
                what: `产品线「${line.name}」`,
                why: cause instanceof Error ? cause.message : "创建失败",
              });
              continue;
            }
          } else {
            report.skipped.push({
              what: `产品线「${line.name}」`,
              why: "已存在，沿用它，只往下面补产品",
            });
          }
          for (const product of line.products) {
            const { codePath, refPaths } = checkEvidencePaths(exists, product);
            const existing = catalog
              .list()
              .find((l) => l.id === lineId)
              ?.products.find(
                (p) => p.name.toLowerCase() === product.name.toLowerCase(),
              );
            if (existing !== undefined) {
              /*
               * 已有的产品不动名字、描述和文档目录（可能是人改过的），
               * 只补**空着的**依据：代码目录没绑就绑上，参考资料并进去。
               * 这样旧产品重新识别一遍就能补齐依据，不用逐个回去手动挂。
               */
              const nextCode =
                existing.codePath === null && codePath !== ""
                  ? codePath
                  : undefined;
              const merged = [
                ...new Set([...existing.refPaths, ...refPaths]),
              ].slice(0, MAX_REF_PATHS);
              const nextRefs =
                merged.length > existing.refPaths.length ? merged : undefined;
              if (nextCode === undefined && nextRefs === undefined) {
                report.skipped.push({
                  what: `产品「${product.name}」`,
                  why: "已存在，依据也没有可补的",
                });
                continue;
              }
              catalog.updateProduct(existing.id, {
                ...(nextCode === undefined ? {} : { codePath: nextCode }),
                ...(nextRefs === undefined ? {} : { refPaths: nextRefs }),
              });
              report.filledProducts.push(existing.name);
              continue;
            }
            try {
              const created = catalog.createProduct(lineId, {
                name: product.name,
                description: product.description,
                folderPath: product.folderPath,
                codePath,
                refPaths,
                templateId: product.templateId,
              });
              report.createdProducts.push(created.name);
            } catch (cause) {
              // 重名是预期内的（重复点「应用」），记一笔继续，不要让一条把整批掀了。
              report.skipped.push({
                what: `产品「${product.name}」`,
                why: cause instanceof Error ? cause.message : "创建失败",
              });
            }
          }
        }
      })();
      return { ...report, lines: catalog.list() };
    },
  );

  /* ── 应用：比对结果落库（只存最近一次） ── */

  app.post<{ Params: { sessionId: string } }>(
    "/api/analysis/:sessionId/save",
    (request) => {
      const sessionId = request.params.sessionId;
      const task = taskOf(sessionId);
      if (task.kind !== "compare") throw badRequest("这条会话不是产出物比对");
      const template = templateOf(task.templateId);
      const parsed = parseResult(assistantText(sessionId), compareResultSchema);
      const { summary, findings } = summarize(template, parsed);
      db.prepare(
        `INSERT INTO product_checks (product_id, template_id, session_id, folder_path, summary, findings, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(product_id) DO UPDATE SET
           template_id = excluded.template_id,
           session_id  = excluded.session_id,
           folder_path = excluded.folder_path,
           summary     = excluded.summary,
           findings    = excluded.findings,
           checked_at  = excluded.checked_at`,
      ).run(
        task.productId,
        task.templateId,
        sessionId,
        task.folderPath,
        JSON.stringify(summary),
        JSON.stringify(findings),
        now(),
      );
      return readCheck(db, task.productId);
    },
  );

  /* ── 应用：功能架构落库 ── */

  app.post<{ Params: { sessionId: string } }>(
    "/api/analysis/:sessionId/apply-architecture",
    (request) => {
      const sessionId = request.params.sessionId;
      const task = taskOf(sessionId);
      if (task.kind !== "architecture")
        throw badRequest("这条会话不是功能架构分析");
      const parsed = parseResult(
        assistantText(sessionId),
        architectureResultSchema,
      );
      const report = architecture.apply(task.productId, task.nodeId, parsed, {
        mode: task.mode,
        sessionId,
      });
      return { ...report, features: architecture.tree(task.productId) };
    },
  );

  /* ── 应用：wiki 落库 ── */

  app.post<{ Params: { sessionId: string } }>(
    "/api/analysis/:sessionId/apply-wiki-outline",
    async (request) => {
      const sessionId = request.params.sessionId;
      const task = taskOf(sessionId);
      if (task.kind !== "wiki-outline")
        throw badRequest("这条会话不是 wiki 目录规划");
      const parsed = parseResult(assistantText(sessionId), outlineResultSchema);
      const roots = boundRoots(productOr404ById(task.productId));
      /*
       * 精读路径落库前先过归属闸并解析成绝对路径。越界或不存在的丢掉，
       * 但要报出来——用户看到「丢了 3 条」才知道哪几章写正文时会缺料。
       */
      const dropped: string[] = [];
      const resolve = async (list: readonly string[]) => {
        const r = await resolveSources(roots, list);
        dropped.push(...r.dropped);
        return r.kept;
      };
      const pages = await Promise.all(
        parsed.pages.map(async (page) => ({
          ...page,
          sources: await resolve(page.sources),
          children: await Promise.all(
            page.children.map(async (child) => ({
              ...child,
              sources: await resolve(child.sources),
            })),
          ),
        })),
      );
      const report = wiki.applyOutline(
        task.productId,
        { ...parsed, pages },
        { sessionId, mode: task.mode },
      );
      return {
        ...report,
        ...(dropped.length > 0 ? { droppedSources: dropped } : {}),
        pages: wiki.tree(task.productId),
      };
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    "/api/analysis/:sessionId/apply-wiki-page",
    (request) => {
      const sessionId = request.params.sessionId;
      const task = taskOf(sessionId);
      if (task.kind !== "wiki-page") throw badRequest("这条会话不是 wiki 写页");
      const { content } = extractWikiPage(assistantText(sessionId));
      const page = wiki.applyPage(
        task.pageId,
        { content, sources: [], gaps: [] },
        {
          sessionId,
        },
      );
      return { page, pages: wiki.tree(task.productId) };
    },
  );

  /* ── 功能树的读与手工维护 ── */

  /** 产品不存在要 404。不校验的话：GET 对任意 id 都回空数组（看起来「这个产品没功能」），
   *  POST 则撞外键报 SQLITE_CONSTRAINT_FOREIGNKEY，而那个错误码没有被翻译 → 落到兜底 500。 */
  const productOr404 = (id: string): void => {
    const hit = catalog
      .list()
      .flatMap((l) => l.products)
      .find((p) => p.id === id);
    if (!hit) throw notFound("产品不存在");
  };

  app.get<{ Params: { id: string } }>(
    "/api/products/:id/features",
    (request) => {
      productOr404(request.params.id);
      return { features: architecture.tree(request.params.id) };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/products/:id/features",
    (request, reply) => {
      productOr404(request.params.id);
      return reply
        .code(201)
        .send(
          architecture.createNode(
            request.params.id,
            createNodeSchema.parse(request.body),
          ),
        );
    },
  );
  app.patch<{ Params: { id: string } }>("/api/feature-nodes/:id", (request) =>
    architecture.updateNode(
      request.params.id,
      updateNodeSchema.parse(request.body),
    ),
  );
  app.delete<{ Params: { id: string } }>(
    "/api/feature-nodes/:id",
    (request, reply) => {
      architecture.deleteNode(request.params.id);
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>("/api/products/:id/check", (request) => {
    const check = readCheck(db, request.params.id);
    if (!check) throw notFound("这个产品还没有比对过");
    return check;
  });

  /** 列表页一次把所有产品的最近一次比对拿走，避免 N 个请求。 */
  app.get("/api/product-checks", () => ({ checks: readChecks(db) }));
}

interface CheckRow {
  product_id: string;
  template_id: string;
  session_id: string | null;
  folder_path: string;
  summary: string;
  findings: string;
  checked_at: number;
}

const toCheck = (r: CheckRow): StoredCheck => ({
  productId: r.product_id,
  templateId: r.template_id,
  sessionId: r.session_id,
  folderPath: r.folder_path,
  summary: JSON.parse(r.summary) as CompareSummary,
  findings: JSON.parse(r.findings) as NormalizedFinding[],
  checkedAt: r.checked_at,
});

function readCheck(db: Db, productId: string): StoredCheck | undefined {
  const row = db
    .prepare<[string], CheckRow>(
      "SELECT * FROM product_checks WHERE product_id = ?",
    )
    .get(productId);
  return row ? toCheck(row) : undefined;
}

function readChecks(db: Db): StoredCheck[] {
  return db
    .prepare<[], CheckRow>("SELECT * FROM product_checks")
    .all()
    .map(toCheck);
}
