import { secretByContent, secretByName } from "../analysis/scan.js";
import type { FileStore } from "../files/store.js";
import {
  extensionOf,
  inNoiseDir,
  type Atlas,
  type AtlasEntry,
} from "./atlas.js";
import { extractKeywords, mergeKeywords, type Keyword } from "./keywords.js";
import {
  codeSources,
  schemaBriefFor,
  type SchemaBrief,
  type SchemaIndex,
} from "./schema/index.js";
import { uiBriefFor, type UiIndex } from "./ui/index.js";
import type {
  EvidenceKind,
  EvidenceLibrary,
  EvidenceSource,
} from "./library.js";

/**
 * 依据定位器：从依据库（文件夹级、全量）里挑出**这次任务**真正该读的文件，
 * 并把正文一并带出来交给 AI。
 *
 * 为什么连正文一起读：3200 的对话会话**没有文件工具**（见 pi/runtime.ts 的
 * `noTools: "all"`，这是防提示词注入的安全边界，不能为了这个功能开）。所以
 * 「给一份路径清单让 AI 自己去读」在这个服务里根本不成立——平台必须把该读的
 * 正文摘出来喂进提示词。扫描面、字节上限、到底读了哪些文件都写得死，出了错
 * 能复查，不用猜模型当时翻了什么。
 *
 * 三路信号叠加打分：
 * 1. 路径 / 文件名命中（依据地图）；
 * 2. 文档标题 / 章节命中（依据地图）；
 * 3. 全文命中（文件库的 FTS5 索引，按关键词分别搜，看「命中几个不同的词」而不是
 *    总次数——一篇文章把「退款」写 80 遍，不比同时写了「退款」「审批」「回调」更相关）。
 * 文档与代码分开取前几名，避免代码文件数量碾压文档。
 */

export interface LocateHit {
  path: string;
  kind: EvidenceKind;
  sourceLabel: string;
  title: string | null;
  /** 命中的关键词（最多 4 个），给 AI 和人看「为什么挑它」。 */
  matched: string[];
  score: number;
}

export interface LocatedFile extends LocateHit {
  content: string;
  truncated: boolean;
  /**
   * 数据结构摘要（schema/index.ts）没有对应的真实文件，它展开了哪些表记在这里，
   * 续聊时按表去重——同一个子系统下次命中别的表还要能给。
   */
  covers?: string[];
}

export interface LocateResult {
  library: EvidenceLibrary;
  /** 实际参与匹配的依据目录。 */
  searched: EvidenceSource[];
  keywords: Keyword[];
  /** 挑中的文件（只含元信息，正文按预算另读）。 */
  hits: LocateHit[];
  /** 已读正文的文件，按分数排序。 */
  files: LocatedFile[];
  /** 疑似含凭据、只给了路径没给正文的。要如实报，不能静默。 */
  skipped: { path: string; reason: string }[];
  /** 文件数过多被截断的依据目录，提示「没列到不代表不存在」。 */
  truncated: string[];
  elapsedMs: number;
}

export interface LocateRequest {
  library: EvidenceLibrary;
  task: string;
  /** 已给过 AI 的文件，续聊时不再重复给。 */
  exclude?: ReadonlySet<string> | undefined;
  limits?: { docs?: number; code?: number } | undefined;
  /** 正文总预算（字符）。超出就按分数截断，并如实报出还有几份没读。 */
  budget?: number | undefined;
}

/**
 * 关键词扩写：把任务改写成一组检索词（含中英同义），由调用方注入（通常是一次
 * 模型调用）。失败 / 超时返回空数组即可，定位器退回本地关键词。
 */
export type KeywordExpander = (input: {
  task: string;
  productName: string | null;
  local: string[];
}) => Promise<string[]>;

export interface LocatorDeps {
  files: FileStore;
  atlas: Atlas;
  expand?: KeywordExpander | undefined;
  /** 数据结构索引。不传就不附表结构（测试或精简部署）。 */
  schema?: SchemaIndex | undefined;
  /** 页面清单索引。不传就不附页面清单。 */
  ui?: UiIndex | undefined;
}

/** 一次最多附几个子系统的数据结构 / 几个前端的页面清单。 */
const MAX_SCHEMA_SUBSYSTEMS = 2;
const MAX_UI_FRONTENDS = 2;

const MIN_SCORE = 4;
const MAX_CONTENT_TERMS = 8;
/** 单个文件正文上限；比 wiki 精读小一档——这里一次可能带好几个文件。 */
const MAX_FILE_CHARS = 6000;
const DEFAULT_BUDGET = 40_000;

/**
 * 从文件库索引里按关键词搜：文件名命中 + 正文命中两路。
 *
 * 返回 `content`（路径 → 命中的词）给打分用，`named`（文件名命中、但地图里可能
 * 没收录的文件）补进候选——地图有上限，而大代码仓里最相关的源码往往不在
 * 「最近修改」的那一截里（真实库实测：feishu_approval 的 .go 文件就漏在外面）。
 */
function indexHits(
  files: FileStore,
  keywords: readonly Keyword[],
  scope: readonly string[],
): { content: Map<string, Set<string>>; named: Map<string, string> } {
  const content = new Map<string, Set<string>>();
  /** 路径 → 它落在哪个依据目录。 */
  const named = new Map<string, string>();
  const ownerOf = (path: string): string | undefined =>
    scope.find((p) => path === p || path.startsWith(`${p}/`));
  for (const k of keywords) {
    // 文件库的全文索引是 trigram：少于 3 个字符搜不了，只走路径 / 标题。
    if (Array.from(k.term).length < 3) continue;
    for (const hit of files.search(k.term, 300)) {
      if (hit.isDir || inNoiseDir(hit.path)) continue;
      const owner = ownerOf(hit.path);
      if (owner === undefined) continue;
      if (hit.match === "name") named.set(hit.path, owner);
      const set = content.get(hit.path) ?? new Set<string>();
      set.add(k.term);
      content.set(hit.path, set);
    }
  }
  return { content, named };
}

const DOC_LIKE = new Set([
  "md",
  "markdown",
  "mdown",
  "mkd",
  "txt",
  "html",
  "htm",
]);

/**
 * 旧版 / 归档 / 废弃目录：降权而不是排除。
 *
 * 不排除的理由：有时人就是要查「以前是怎么定的」。降权的理由：在真实库里实测，
 * `_archive/` 下的旧手册与现行 PRD 命中同一批词，不降权就会把已作废的口径喂给 AI。
 */
export const STALE_SEGMENT =
  /(^|\/)(_?archive[sd]?|_?old|deprecated|legacy|backup[s]?|归档|废弃|旧版)(\/|$)/i;

/**
 * 测试文件：有信息量（能看出行为），但不该先于实现占预算。口径与
 * analysis/scan.ts 的精读排序一致，那边已经在真实仓库上调过。
 */
const TEST_FILE =
  /(_test\.go|\.test\.[jt]sx?|\.spec\.[jt]sx?|(^|\/)test_[^/]*\.py)$|(^|\/)__tests__\//i;

/** 只算文件本身是源码——代码目录里的 md 是文档，不该占「代码」名额。 */
function isSourceFile(entry: AtlasEntry): boolean {
  return !entry.isDoc;
}

/** 纯打分：便于单测，不碰文件系统。 */
export function rankEntries(input: {
  entries: readonly AtlasEntry[];
  keywords: readonly Keyword[];
  content: ReadonlyMap<string, ReadonlySet<string>>;
  sources: ReadonlyMap<string, EvidenceSource>;
}): LocateHit[] {
  const out: LocateHit[] = [];
  for (const e of input.entries) {
    const source = input.sources.get(e.sourceKey);
    if (source === undefined) continue;
    const path = e.path.toLowerCase();
    const name = path.slice(path.lastIndexOf("/") + 1);
    const title = (e.title ?? "").toLowerCase();
    const heads = e.headings.join("\n").toLowerCase();
    const content = input.content.get(e.path);

    let score = 0;
    const matched: { term: string; s: number }[] = [];
    for (const k of input.keywords) {
      let s = 0;
      if (name.includes(k.term)) s += 4 * k.weight;
      else if (path.includes(k.term)) s += 3 * k.weight;
      if (title.includes(k.term)) s += 4 * k.weight;
      else if (heads.includes(k.term)) s += 2 * k.weight;
      if (content?.has(k.term) === true) s += 2 * k.weight;
      if (s > 0) {
        score += s;
        matched.push({ term: k.term, s });
      }
    }
    if (score <= 0) continue;
    if (STALE_SEGMENT.test(e.path)) score *= 0.3;
    if (TEST_FILE.test(e.path)) score *= 0.5;
    out.push({
      path: e.path,
      // 代码目录里的说明文档按「文档」算：否则 RouteHub 这类仓库的 docs/ 会把
      // 「代码」名额全占掉，真正的源码一份也进不来（真实库上实测过）。
      kind: source.kind === "code" && !isSourceFile(e) ? "doc" : source.kind,
      sourceLabel: source.label,
      title: e.title,
      matched: matched
        .sort((a, b) => b.s - a.s)
        .slice(0, 4)
        .map((m) => m.term),
      score: Math.round(score * 10) / 10,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

export function createLocator(deps: LocatorDeps) {
  return async function locate(req: LocateRequest): Promise<LocateResult> {
    const started = Date.now();
    const { library } = req;
    const searched = library.sources;

    const local = extractKeywords(req.task);
    const nameKeywords: Keyword[] =
      library.productName === null
        ? []
        : [{ term: library.productName.toLowerCase(), weight: 3 }];
    let expanded: Keyword[] = [];
    if (deps.expand !== undefined) {
      try {
        const terms = await deps.expand({
          task: req.task.slice(0, 1500),
          productName: library.productName,
          local: local.slice(0, 15).map((k) => k.term),
        });
        expanded = terms.map((t) => ({ term: t.toLowerCase(), weight: 3 }));
      } catch {
        // 扩写只是锦上添花。
      }
    }
    const keywords = mergeKeywords(nameKeywords, expanded, local);

    if (searched.length === 0 || keywords.length === 0) {
      return {
        library,
        searched,
        keywords,
        hits: [],
        files: [],
        skipped: [],
        truncated: [],
        elapsedMs: Date.now() - started,
      };
    }

    const { entries: mapped, truncated } =
      await deps.atlas.entriesFor(searched);
    // 全文搜索不用二元组（weight 1）：「订阅体系」切出的「阅体」这类跨词碎片
    // 在正文里到处都能撞上，只会把无关文件抬上来。二元组只参与路径 / 标题匹配。
    const contentTerms = keywords
      .filter((k) => k.weight >= 2)
      .slice(0, MAX_CONTENT_TERMS);
    const { content, named } = indexHits(
      deps.files,
      contentTerms,
      searched.map((s) => s.path),
    );
    // 文件名命中但地图没收录的：补成最小条目（只有路径），照样参与打分。
    const known = new Set(mapped.map((e) => e.path));
    const entries: AtlasEntry[] = [...mapped];
    for (const [path, owner] of named) {
      if (known.has(path)) continue;
      entries.push({
        path,
        sourceKey: owner,
        isDoc: DOC_LIKE.has(extensionOf(path)),
        title: null,
        headings: [],
      });
    }

    const ranked = rankEntries({
      entries,
      keywords,
      content,
      sources: new Map(searched.map((s) => [s.key, s])),
    }).filter((h) => h.score >= MIN_SCORE && !req.exclude?.has(h.path));

    const hits = [
      ...ranked.filter((h) => h.kind === "doc").slice(0, req.limits?.docs ?? 6),
      ...ranked
        .filter((h) => h.kind === "code")
        .slice(0, req.limits?.code ?? 6),
    ];

    // 读正文：按分数顺序花预算。凭据一步都不能省——这里读到的东西会原样进提示词。
    const files: LocatedFile[] = [];
    const skipped: { path: string; reason: string }[] = [];
    let budget = req.budget ?? DEFAULT_BUDGET;

    // 数据结构排在源码前面：定位器只能挑出零散的几份代码，看不出「整个产品有哪些表、
    // 表和表怎么连」——PRD 最容易在这里编。
    // 挑表不用产品名：「ModelHub（模型路由中枢）」会被词表翻成 model / route，
    // 把 models、routes 这类与任务无关的表全带进来（真实库实测）。
    const taskKeywords = mergeKeywords(expanded, local);
    const schemaHits: SchemaBrief[] = [];
    if (deps.schema !== undefined) {
      for (const source of codeSources(searched)) {
        try {
          for (const sub of await deps.schema.subsystems(source.path)) {
            const b = schemaBriefFor(sub, taskKeywords, req.exclude);
            if (b !== null) schemaHits.push(b);
          }
        } catch {
          // 表结构解析失败不影响普通依据。
        }
      }
    }
    // 页面清单（前端视角）：同一套口径——按任务挑页，不整份塞。
    if (deps.ui !== undefined) {
      const readText = async (path: string): Promise<string | null> => {
        const item = await deps.files
          .item(path, { content: true })
          .catch(() => null);
        return typeof item?.content === "string" ? item.content : null;
      };
      const uiHits: SchemaBrief[] = [];
      for (const source of codeSources(searched)) {
        try {
          for (const fe of await deps.ui.frontends(source.path)) {
            const b = await uiBriefFor(fe, taskKeywords, req.exclude, readText);
            if (b !== null) uiHits.push(b);
          }
        } catch {
          // 页面清单解析失败不影响普通依据。
        }
      }
      uiHits.sort((a, b) => b.score - a.score);
      schemaHits.push(
        ...uiHits
          .slice(0, MAX_UI_FRONTENDS)
          .map((b) => ({ ...b, label: "页面清单" })),
      );
    }
    const pickedStructure = [
      ...schemaHits
        .filter((b) => b.label === undefined)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_SCHEMA_SUBSYSTEMS),
      ...schemaHits.filter((b) => b.label !== undefined),
    ];
    for (const b of pickedStructure) {
      if (budget <= 0) break;
      const content = b.content.slice(0, budget);
      budget -= content.length;
      const hit: LocateHit = {
        path: b.path,
        kind: "code",
        sourceLabel: b.label ?? "数据结构",
        title: b.title,
        matched: b.matched,
        score: b.score,
      };
      hits.unshift(hit);
      files.push({
        ...hit,
        content,
        truncated: b.truncated || content.length < b.content.length,
        covers: b.covers,
      });
    }
    for (const hit of hits) {
      if (budget <= 0) break;
      const name = hit.path.slice(hit.path.lastIndexOf("/") + 1);
      if (secretByName(name)) {
        skipped.push({ path: hit.path, reason: "名称疑似凭据文件" });
        continue;
      }
      const item = await deps.files
        .item(hit.path, { content: true })
        .catch(() => null);
      const raw = item?.content;
      if (typeof raw !== "string" || raw.trim() === "") continue;
      if (secretByContent(raw)) {
        skipped.push({ path: hit.path, reason: "正文疑似含凭据" });
        continue;
      }
      const content = raw.slice(0, Math.min(MAX_FILE_CHARS, budget));
      budget -= content.length;
      files.push({ ...hit, content, truncated: content.length < raw.length });
    }

    return {
      library,
      searched,
      keywords,
      hits,
      files,
      skipped,
      truncated,
      elapsedMs: Date.now() - started,
    };
  };
}

export type Locate = ReturnType<typeof createLocator>;
