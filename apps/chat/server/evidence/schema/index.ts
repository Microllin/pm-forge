import { secretByContent } from "../../analysis/scan.js";
import type { FileStore } from "../../files/store.js";
import { inNoiseDir } from "../atlas.js";
import type { Keyword } from "../keywords.js";
import type { EvidenceSource } from "../library.js";
import { expandForTables } from "./glossary.js";
import { STALE_SEGMENT } from "../locate.js";
import {
  parseEntSchemas,
  parsePrismaSchemas,
  parseSqlMigrations,
  type SchemaFormat,
  type SchemaModel,
  type SchemaRelation,
  type SchemaTable,
  type SourceText,
} from "./parse.js";

/**
 * 数据结构索引：在产品绑定的代码目录里找出各个子系统的表结构定义，解析、缓存。
 *
 *
 * 「子系统」不要用户登记，按定义文件的位置自动划分：
 * - ent：含 `ent/schema/` 的那一层（如 `apps/console/backend`）；
 * - Prisma：`.prisma` 文件所在目录；
 * - SQL：名为 `migrations` / `migration` 的目录的上一层。
 * 再去掉末尾的 `backend` / `server` / `prisma` 这类壳目录，得到 `apps/console`。
 * 同一个子系统里有几种写法时取 ent > Prisma > SQL（前两种是「定义」，迁移脚本是「过程」）。
 *
 * 缓存按代码目录的「文件数 + 最近修改时间」作指纹：拉取更新 / 重新上传后指纹变了就重算，
 * 不用另外挂钩子。
 */

export interface Subsystem {
  /** 子系统根目录（文件库路径），同时是它的标识。 */
  root: string;
  /** 给人看的名字：相对代码目录的路径，如 `apps/console`。 */
  label: string;
  format: SchemaFormat;
  /** 同一子系统里另外还有、但没采用的写法。 */
  /**
   * 同一子系统里另外还有的写法。SQL 迁移脚本不会被丢掉：只在脚本里建的表会并进来
   * （见 mergeSqlOnly）。
   */
  alsoHas: SchemaFormat[];
  /** 参与解析的文件数。 */
  files: number;
  model: SchemaModel;
}

export interface SchemaIndex {
  /** 一个代码目录下的全部子系统。目录不存在或没有表结构时为空数组。 */
  subsystems(codePath: string): Promise<Subsystem[]>;
  invalidate(codePath?: string): void;
}

const SHELL_DIRS = new Set([
  "backend",
  "server",
  "api",
  "prisma",
  "db",
  "database",
]);
const FORMAT_RANK: Record<SchemaFormat, number> = { ent: 0, prisma: 1, sql: 2 };
/** 单个子系统最多读多少份定义文件。超出的如实截断（真实仓库最多 437 份迁移脚本）。 */
const MAX_FILES_PER_SUBSYSTEM = 2000;
const MAX_LIST = 200_000;

interface Found {
  root: string;
  format: SchemaFormat;
  path: string;
}

function trimShell(dir: string, floor: string): string {
  let d = dir;
  while (d.length > floor.length) {
    const name = d.slice(d.lastIndexOf("/") + 1).toLowerCase();
    if (!SHELL_DIRS.has(name)) break;
    d = d.slice(0, d.lastIndexOf("/"));
  }
  return d;
}

/** 一份文件是哪种定义、属于哪个子系统；不是定义文件返回 null。 */
export function classify(path: string, codePath: string): Found | null {
  if (inNoiseDir(path) || STALE_SEGMENT.test(path)) return null;
  const lower = path.toLowerCase();
  const ent = /^(.*)\/ent\/schema\/.+\.go$/.exec(path);
  if (ent?.[1] !== undefined && !lower.endsWith("_test.go"))
    return { root: trimShell(ent[1], codePath), format: "ent", path };
  if (lower.endsWith(".prisma")) {
    const dir = path.slice(0, path.lastIndexOf("/"));
    return { root: trimShell(dir, codePath), format: "prisma", path };
  }
  const sql = /^(.*)\/migrations?\/(?:[^/]+\/)*[^/]+\.sql$/i.exec(path);
  if (sql?.[1] !== undefined)
    return { root: trimShell(sql[1], codePath), format: "sql", path };
  return null;
}

/** 迁移脚本的执行顺序：按文件名（时间戳 / 序号前缀）而不是按路径里的子目录。 */
const byName = (a: string, b: string): number => {
  const na = a.slice(a.lastIndexOf("/") + 1);
  const nb = b.slice(b.lastIndexOf("/") + 1);
  return na < nb ? -1 : na > nb ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/**
 * 把「只在迁移脚本里建、定义里没有」的表并进主模型。同名表以定义为准（定义带说明、
 * 关联语义更全）；脚本里的外键只在至少一端是并进来的表时才收，避免和定义里的关联重复。
 */
export function mergeSqlOnly(
  primary: SchemaModel,
  sql: SchemaModel,
): SchemaModel {
  const known = new Set(primary.tables.map((t) => t.name));
  const extra = sql.tables.filter((t) => !known.has(t.name));
  const added = new Set(extra.map((t) => t.name));
  return {
    ...primary,
    tables: [...primary.tables, ...extra],
    relations: [
      ...primary.relations,
      ...sql.relations.filter((r) => added.has(r.from) || added.has(r.to)),
    ],
    unparsed: {
      count: primary.unparsed.count + sql.unparsed.count,
      samples: [...primary.unparsed.samples, ...sql.unparsed.samples].slice(
        0,
        5,
      ),
    },
  };
}

export function createSchemaIndex(files: FileStore): SchemaIndex {
  const cache = new Map<
    string,
    { fingerprint: string; pending: Promise<Subsystem[]> }
  >();

  const read = async (path: string): Promise<string | null> => {
    const item = await files.item(path, { content: true }).catch(() => null);
    return typeof item?.content === "string" ? item.content : null;
  };

  const build = async (codePath: string): Promise<Subsystem[]> => {
    const { files: listed } = files.listFilesDeep(codePath, {
      limit: MAX_LIST,
    });
    const groups = new Map<string, Map<SchemaFormat, string[]>>();
    for (const entry of listed) {
      const hit = classify(entry.path, codePath);
      if (hit === null) continue;
      const byFormat =
        groups.get(hit.root) ?? new Map<SchemaFormat, string[]>();
      const list = byFormat.get(hit.format) ?? [];
      list.push(hit.path);
      byFormat.set(hit.format, list);
      groups.set(hit.root, byFormat);
    }

    const out: Subsystem[] = [];
    for (const [root, byFormat] of groups) {
      const formats = [...byFormat.keys()].sort(
        (a, b) => FORMAT_RANK[a] - FORMAT_RANK[b],
      );
      const format = formats[0];
      if (format === undefined) continue;
      const load = async (f: SchemaFormat): Promise<SourceText[]> => {
        const paths = (byFormat.get(f) ?? [])
          .sort(byName)
          .slice(0, MAX_FILES_PER_SUBSYSTEM);
        const texts: SourceText[] = [];
        for (const path of paths) {
          const text = await read(path);
          if (text !== null) texts.push({ path, text });
        }
        return texts;
      };
      const texts = await load(format);
      let model =
        format === "ent"
          ? parseEntSchemas(texts)
          : format === "prisma"
            ? parsePrismaSchemas(texts)
            : parseSqlMigrations(texts);
      let fileCount = texts.length;
      // ent / Prisma 之外还有迁移脚本时，把只在脚本里建的表并进来：真实仓库里
      // console-v2 的 ent 管 84 张表，脚本另外直接建了 88 张（监控、推广、短信……），
      // 只画 ent 会让人以为库里就这些。
      if (format !== "sql" && byFormat.has("sql")) {
        const sqlTexts = await load("sql");
        fileCount += sqlTexts.length;
        model = mergeSqlOnly(model, parseSqlMigrations(sqlTexts));
      }
      if (model.tables.length === 0) continue;
      const rel = root.slice(codePath.length).replace(/^\//, "");
      out.push({
        root,
        label: rel === "" ? codePath.slice(codePath.lastIndexOf("/") + 1) : rel,
        format,
        alsoHas: formats.slice(1),
        files: fileCount,
        model,
      });
    }
    return out.sort((a, b) => (a.label < b.label ? -1 : 1));
  };

  return {
    async subsystems(codePath) {
      if (!files.exists(codePath)) return [];
      const s = files.summarize(codePath);
      const fingerprint = `${String(s.files)}-${String(s.modifiedAt)}`;
      const hit = cache.get(codePath);
      if (hit?.fingerprint === fingerprint) return hit.pending;
      const pending = build(codePath);
      cache.set(codePath, { fingerprint, pending });
      pending.catch(() => cache.delete(codePath));
      return pending;
    },
    invalidate(codePath) {
      if (codePath === undefined) cache.clear();
      else cache.delete(codePath);
    },
  };
}

// ─────────────────────── 交给 AI：按任务挑表 ───────────────────────

const KIND_CN: Record<SchemaRelation["kind"], string> = {
  "many-to-one": "多对一",
  "one-to-one": "一对一",
  "many-to-many": "多对多",
};
const FORMAT_CN: Record<SchemaFormat, string> = {
  ent: "ent 定义",
  prisma: "Prisma 定义",
  sql: "SQL 迁移脚本重放",
};

const MIN_TABLE_SCORE = 4;
const MAX_TABLES = 6;
/** 一个子系统的数据结构摘要上限：88 张表整份塞进去会把别的依据挤掉。 */
const MAX_SCHEMA_CHARS = 8000;

export interface TableHit {
  table: SchemaTable;
  score: number;
  matched: string[];
}

/**
 * 给表打分：表名 / 实体名 > 表说明 > 字段名 / 字段说明。纯函数，便于单测。
 *
 * 中文关键词先按词表翻成表名里的英文写法（glossary.ts）。中文二元组（权重 1）
 * 只认表说明：「配置」「规则」这种碎片在字段注释里到处都是，放开会把半个库挑进来。
 */
export function rankTables(
  tables: readonly SchemaTable[],
  input: readonly Keyword[],
): TableHit[] {
  const keywords = expandForTables(input);
  const out: TableHit[] = [];
  for (const t of tables) {
    const name = `${t.name}\n${t.entity}`.toLowerCase();
    const comment = (t.comment ?? "").toLowerCase();
    const fieldNames = t.fields.map((f) => f.name.toLowerCase()).join("\n");
    const fieldNotes = t.fields
      .map((f) => (f.comment ?? "").toLowerCase())
      .join("\n");
    let score = 0;
    const matched: { term: string; s: number }[] = [];
    for (const k of keywords) {
      let s = 0;
      if (k.weight < 2) {
        if (comment.includes(k.term)) s += 3 * k.weight;
      } else {
        if (name.includes(k.term)) s += 4 * k.weight;
        if (comment.includes(k.term)) s += 3 * k.weight;
        if (fieldNames.includes(k.term)) s += 1 * k.weight;
        if (fieldNotes.includes(k.term)) s += 1 * k.weight;
      }
      if (s > 0) {
        score += s;
        matched.push({ term: k.term, s });
      }
    }
    if (score < MIN_TABLE_SCORE) continue;
    out.push({
      table: t,
      score,
      matched: matched
        .sort((a, b) => b.s - a.s)
        .slice(0, 4)
        .map((m) => m.term),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** 已给过 AI 的表的去重键。续聊时同一张表不重复给。 */
export const tableKey = (root: string, table: string): string =>
  `${root}#数据结构/${table}`;

/** 数据结构摘要的虚拟路径：它不是一份真实文件，但要能在依据清单里被认出、被引用。 */
export const schemaPath = (root: string): string => `${root}#数据结构`;

function renderTable(
  t: SchemaTable,
  relations: readonly SchemaRelation[],
): string[] {
  const lines = [
    "",
    `## ${t.name}${t.entity !== t.name ? `（实体 ${t.entity}）` : ""}`,
    `来源：${t.source}`,
  ];
  if (t.comment !== null) lines.push(`说明：${t.comment.replace(/\n/g, " ")}`);
  lines.push("字段：");
  for (const f of t.fields) {
    const bits = [f.type, ...(f.nullable ? ["可空"] : []), ...f.flags];
    lines.push(
      `- ${f.name}：${bits.join("，")}${f.comment === null ? "" : ` — ${f.comment.replace(/\n/g, " ")}`}`,
    );
  }
  const out = relations.filter((r) => r.from === t.name);
  const inbound = relations.filter((r) => r.to === t.name && r.from !== t.name);
  if (out.length + inbound.length > 0) {
    lines.push("关联：");
    for (const r of out)
      lines.push(
        `- ${r.field ?? "（无外键字段）"} → ${r.to}（${KIND_CN[r.kind]}${r.label === null ? "" : `，${r.label}`}）`,
      );
    for (const r of inbound)
      lines.push(
        `- ← ${r.from}${r.field === null ? "" : `.${r.field}`}（对方${KIND_CN[r.kind]}指向本表）`,
      );
  }
  return lines;
}

export interface SchemaBrief {
  path: string;
  title: string;
  content: string;
  truncated: boolean;
  matched: string[];
  score: number;
  /** 这份摘要里展开了哪些表（去重键）。 */
  covers: string[];
  /** 依据清单里显示的来源名；不写就是「数据结构」。页面清单复用这个形状。 */
  label?: string;
}

/**
 * 按任务从一个子系统里挑表，写成一份交给 AI 的摘要。
 *
 * 只展开命中的表（字段、类型、可空、默认值、说明、关联）；与它们直接关联的表只列名字，
 * 一跳以外不给——否则 users 这种和什么都连着的表会把整个库带进来。
 */
export function schemaBriefFor(
  sub: Subsystem,
  keywords: readonly Keyword[],
  exclude: ReadonlySet<string> | undefined,
): SchemaBrief | null {
  const { model } = sub;
  const hits = rankTables(model.tables, keywords)
    .filter((h) => exclude?.has(tableKey(sub.root, h.table.name)) !== true)
    .slice(0, MAX_TABLES);
  if (hits.length === 0) return null;

  const picked = new Set(hits.map((h) => h.table.name));
  const neighbors = new Map<string, SchemaTable>();
  for (const r of model.relations) {
    const other = picked.has(r.from) ? r.to : picked.has(r.to) ? r.from : null;
    if (other === null || picked.has(other)) continue;
    const t = model.tables.find((x) => x.name === other);
    if (t !== undefined) neighbors.set(other, t);
  }

  const head = [
    `数据结构 · ${sub.label}（取自${FORMAT_CN[sub.format]}，共 ${String(model.tables.length)} 张表；关联只取代码里声明的，没声明的不代表没关系）`,
    `按这次任务命中的表：${hits.map((h) => h.table.name).join("、")}`,
  ];
  if (model.unparsed.count > 0)
    head.push(
      `（这个子系统里有 ${String(model.unparsed.count)} 处写法没认出来，涉及的字段可能缺失。）`,
    );
  const body: string[] = [];
  const covers: string[] = [];
  let truncated = false;
  let size = head.join("\n").length;
  for (const h of hits) {
    const block = renderTable(h.table, model.relations).join("\n");
    if (size + block.length > MAX_SCHEMA_CHARS && covers.length > 0) {
      truncated = true;
      break;
    }
    body.push(block);
    covers.push(tableKey(sub.root, h.table.name));
    size += block.length;
  }
  const tail: string[] = [];
  if (neighbors.size > 0) {
    tail.push(
      "",
      "直接关联、这次没展开的表（需要时可以追问）：",
      ...[...neighbors.values()].map(
        (t) =>
          `- ${t.name}${t.comment === null ? "" : `：${t.comment.split("\n")[0] ?? ""}`}（${String(t.fields.length)} 个字段，来源 ${t.source}）`,
      ),
    );
  }
  let content = [...head, ...body, ...tail].join("\n");
  if (content.length > MAX_SCHEMA_CHARS) {
    content = content.slice(0, MAX_SCHEMA_CHARS);
    truncated = true;
  }
  if (secretByContent(content)) return null;
  const matched = [...new Set(hits.flatMap((h) => h.matched))].slice(0, 4);
  return {
    path: schemaPath(sub.root),
    title: `数据结构：${sub.label}`,
    content,
    truncated,
    matched,
    score: hits[0]?.score ?? 0,
    covers,
  };
}

/** 依据库里的代码目录（数据结构只从代码里读）。 */
export const codeSources = (
  sources: readonly EvidenceSource[],
): EvidenceSource[] => sources.filter((s) => s.kind === "code" && !s.isFile);
