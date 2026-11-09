/**
 * 产品 wiki 的数据层。章节成树（章 / 节两层），正文是 Markdown。
 *
 * 与 `architecture.ts`（功能架构树）形状相近但**不合并**：那边的节点是名词
 * （名称 + 职责 + 代码证据），用来查询；这边的页面是文章（标题 + 提纲 + 正文），
 * 用来阅读。合并成一张「通用树」表的话，两边的字段会互相为空一半，
 * 查询和校验都得先判「我是哪种树」——省下的一张表不值这个代价。
 *
 * 这里只重复两条最容易写错的：
 *
 * 1. **显示编号（01 / 02 …）不入库**，由 sort_order 的位次算出来。
 * 2. **树接口不带 content**：13 章正文加起来几十 KB，左栏每次渲染都拉一遍纯属浪费，
 *    还会让「切章节」看起来卡。要正文走单页接口。
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Db } from "./db.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { translateUnique } from "./sql-util.js";
import { BUILTIN_WIKI, type BuiltinWikiPage } from "./wiki-builtin.js";

const now = (): number => Date.now();

/** 章节层级护栏。出厂目录是两层；真实 wiki 到不了 16 层，超了说明数据有环。 */
const MAX_DEPTH = 16;

const title = z
  .string()
  .trim()
  .min(1, "标题不能为空")
  .max(120, "标题太长（最多 120 字）");

const brief = z.string().trim().max(2000, "提纲太长").default("");

/** 一章最多指几条精读路径。每条都会展开读源文件，多了既慢又会把提示词撑爆。 */
export const MAX_PAGE_SOURCES = 8;

/**
 * 这一章要精读的路径（事实底座里的目录或文件）。**只做形状校验**——
 * 归属（在不在这个产品绑的目录里）要知道产品的绑定，在 analysis/routes.ts 里校。
 */
const sources = z
  .array(z.string().trim().max(1000))
  .max(MAX_PAGE_SOURCES, `精读路径最多 ${String(MAX_PAGE_SOURCES)} 条`)
  .transform((list) => [...new Set(list.filter((v) => v !== ""))]);

/**
 * 正文上限 200 000 字符。
 *
 * 不是防攻击（本机单用户），是防一次失控的 AI 产出把库撑大到
 * 每次开页都卡——SQLite 读一行就是读整行，正文在树接口里虽然不选，
 * 但单页接口会全量读。20 万字符约 400 KB，已经远超任何人会读完的长度。
 */
const content = z.string().max(200_000, "正文太长").default("");

export const createPageSchema = z.object({
  parentId: z.string().min(1).nullable().default(null),
  title,
  brief,
  content,
  sources: sources.default([]),
});

export const updatePageSchema = z
  .object({
    title: title.optional(),
    brief: z.string().trim().max(2000).optional(),
    content: z.string().max(200_000).optional(),
    sources: sources.optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.brief !== undefined ||
      v.content !== undefined ||
      v.sources !== undefined,
    "没有要修改的字段",
  );

/** AI 生成的目录。**限死两层**，理由同 architecture.ts：自递归没有深度上限。 */
const outlineLeaf = z.object({
  title,
  brief: z.string().trim().max(2000).default(""),
  /** 模型会多给，这里不报错而是截断：多出来的路径不值得让整份目录作废。 */
  sources: z
    .array(z.string().trim().max(1000))
    .default([])
    .transform((list) => list.slice(0, MAX_PAGE_SOURCES)),
});
const outlineNode = outlineLeaf.extend({
  children: z.array(outlineLeaf).default([]),
});
export const outlineResultSchema = z.object({
  pages: z.array(outlineNode).min(1, "目录不能为空").max(60, "章节太多"),
  /** 事实源不足以支撑的章节，AI 要如实报出来而不是硬编。 */
  uncertain: z.array(z.string().trim().max(300)).default([]),
});
export type OutlineResult = z.infer<typeof outlineResultSchema>;

export const pageResultSchema = z.object({
  /** 正文 Markdown。 */
  content: z.string().min(1, "正文不能为空").max(200_000),
  /** 这一页用到的事实出处，写进确认面板让人能抽查。 */
  sources: z.array(z.string().trim().max(500)).default([]),
  /** 写不了的部分（事实源里没有）。 */
  gaps: z.array(z.string().trim().max(300)).default([]),
});
export type PageResult = z.infer<typeof pageResultSchema>;

interface PageRow {
  id: string;
  product_id: string;
  parent_id: string | null;
  title: string;
  brief: string;
  content: string;
  source: string;
  sources: string;
  session_id: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

/** 树节点（不带正文，只给「有没有正文」）。 */
export interface WikiNode {
  id: string;
  parentId: string | null;
  title: string;
  brief: string;
  /** 这一章要精读的路径。空 = 没指定，写正文时只能用整体的浅层目录。 */
  sources: string[];
  /** 显示编号，如 `01` 或 `06.2`。由位次算出来，不入库。 */
  number: string;
  /** 正文长度。0 = 还没写。前端据此显示「待写」。 */
  length: number;
  source: "ai" | "manual";
  sessionId: string | null;
  updatedAt: number;
  children: WikiNode[];
}

/** 单页详情（带正文）。 */
export interface WikiPage extends Omit<WikiNode, "children"> {
  content: string;
  /** 面包屑用：从顶层章到这一页。 */
  path: { id: string; title: string; number: string }[];
}

export interface Wiki {
  tree: (productId: string) => WikiNode[];
  page: (id: string) => WikiPage;
  create: (
    productId: string,
    input: z.infer<typeof createPageSchema>,
    options?: { source?: "ai" | "manual"; sessionId?: string | null },
  ) => WikiNode;
  update: (id: string, input: z.infer<typeof updatePageSchema>) => WikiNode;
  remove: (id: string) => void;
  move: (id: string, delta: -1 | 1) => WikiNode[];
  /** 恢复出厂目录。只在没有任何正文时允许，否则会删掉写好的东西。 */
  reset: (productId: string, force: boolean) => WikiNode[];
  /** 这个产品有没有 wiki（用来决定首次进入显示「生成」还是显示内容）。 */
  isEmpty: (productId: string) => boolean;
  /** 某一页属于哪个产品。写页分析要据此找事实源。 */
  productOf: (pageId: string) => string;
  /** 还没写正文的页数。「重新规划目录」要据此说清会清掉几页、留下几页。 */
  emptyCount: (productId: string) => number;
  applyOutline: (
    productId: string,
    result: OutlineResult,
    options: { sessionId: string; mode: "append" | "replace" },
  ) => { created: string[]; skipped: string[] };
  applyPage: (
    pageId: string,
    result: PageResult,
    /** sessionId 为 null：来源对话已被删掉（全局补齐的草稿可能放了很久才挪入）。 */
    options: { sessionId: string | null },
  ) => WikiPage;
}

export function createWiki(db: Db): Wiki {
  const rowOf = (id: string): PageRow => {
    const row = db
      .prepare<[string], PageRow>("SELECT * FROM wiki_pages WHERE id = ?")
      .get(id);
    if (!row) throw notFound("这一页不存在");
    return row;
  };

  /**
   * 某个父节点下的子页。
   *
   * **`product_id` 不能省**——`architecture.ts` 上一轮就是在这里出的事：
   * 少了它就能把 A 产品的页挂进 B 的树，删 A 时 CASCADE 让 B 的树少一章。
   */
  const childRows = (productId: string, parentId: string | null): PageRow[] =>
    parentId === null
      ? db
          .prepare<[string], PageRow>(
            "SELECT * FROM wiki_pages WHERE product_id = ? AND parent_id IS NULL ORDER BY sort_order, created_at",
          )
          .all(productId)
      : db
          .prepare<[string, string], PageRow>(
            "SELECT * FROM wiki_pages WHERE product_id = ? AND parent_id = ? ORDER BY sort_order, created_at",
          )
          .all(productId, parentId);

  const parentOr400 = (productId: string, parentId: string): PageRow => {
    const row = rowOf(parentId);
    if (row.product_id !== productId)
      throw badRequest("父章节不属于这个产品，不能挂到它下面");
    if (row.parent_id !== null)
      throw badRequest("wiki 只支持两层（章 / 节），不能再往下挂");
    return row;
  };

  /** 顶层编号补零到两位（`01`），子层拼成 `06.2`。与参照物的观感一致。 */
  const numberOf = (index: number, parent: string | null): string =>
    parent === null
      ? String(index + 1).padStart(2, "0")
      : `${parent}.${String(index + 1)}`;

  const build = (
    row: PageRow,
    index: number,
    parentNumber: string | null,
  ): WikiNode => {
    const number = numberOf(index, parentNumber);
    return {
      id: row.id,
      parentId: row.parent_id,
      title: row.title,
      brief: row.brief,
      sources: row.sources.split("\n").filter((x) => x !== ""),
      number,
      length: row.content.length,
      source: row.source === "ai" ? "ai" : "manual",
      sessionId: row.session_id,
      updatedAt: row.updated_at,
      children: childRows(row.product_id, row.id).map((c, i) =>
        build(c, i, number),
      ),
    };
  };

  const nextOrder = (productId: string, parentId: string | null): number =>
    (parentId === null
      ? db
          .prepare<[string], { n: number }>(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM wiki_pages WHERE product_id = ? AND parent_id IS NULL",
          )
          .get(productId)
      : db
          .prepare<[string], { n: number }>(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM wiki_pages WHERE parent_id = ?",
          )
          .get(parentId)
    )?.n ?? 1;

  const clash = (t: string): string => `同一层下已有章节「${t}」`;

  const insert = (
    productId: string,
    parentId: string | null,
    v: { title: string; brief: string; content: string; sources?: string[] },
    source: "ai" | "manual",
    sessionId: string | null,
  ): string => {
    const id = randomUUID();
    const t = now();
    db.prepare(
      "INSERT INTO wiki_pages (id, product_id, parent_id, title, brief, content, sources, source, session_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      productId,
      parentId,
      v.title,
      v.brief,
      v.content,
      (v.sources ?? []).join("\n"),
      source,
      sessionId,
      nextOrder(productId, parentId),
      t,
      t,
    );
    return id;
  };

  /** 从顶层章到这一页的链路。顺 parent 上爬，带环护栏。 */
  const pathOf = (row: PageRow): WikiPage["path"] => {
    const chain: PageRow[] = [];
    let cursor: PageRow | null = row;
    while (cursor !== null) {
      chain.unshift(cursor);
      if (chain.length > MAX_DEPTH)
        throw conflict("章节层级异常（疑似成环），请检查数据");
      cursor = cursor.parent_id === null ? null : rowOf(cursor.parent_id);
    }
    // 编号要按它在同层里的真实位次算，所以一路从顶层往下数。
    const out: WikiPage["path"] = [];
    let parentNumber: string | null = null;
    for (const node of chain) {
      const siblings = childRows(node.product_id, node.parent_id);
      const index = siblings.findIndex((s) => s.id === node.id);
      const number = numberOf(index < 0 ? 0 : index, parentNumber);
      out.push({ id: node.id, title: node.title, number });
      parentNumber = number;
    }
    return out;
  };

  const nodeOf = (id: string): WikiNode => {
    const row = rowOf(id);
    const siblings = childRows(row.product_id, row.parent_id);
    const index = siblings.findIndex((s) => s.id === row.id);
    const parentNumber =
      row.parent_id === null
        ? null
        : (pathOf(rowOf(row.parent_id)).at(-1)?.number ?? null);
    return build(row, index < 0 ? 0 : index, parentNumber);
  };

  return {
    tree: (productId) =>
      childRows(productId, null).map((r, i) => build(r, i, null)),

    page: (id) => {
      const row = rowOf(id);
      const path = pathOf(row);
      // 单页接口不返回 children：要子节走树接口，省得同一棵树在两个响应里各有一份
      // （两份会不一致——上一轮在别处吃过「局部更新成功但树上还是旧的」的亏）。
      const node = nodeOf(id);
      const rest: Omit<WikiNode, "children"> = {
        id: node.id,
        parentId: node.parentId,
        title: node.title,
        brief: node.brief,
        sources: node.sources,
        number: node.number,
        length: node.length,
        source: node.source,
        sessionId: node.sessionId,
        updatedAt: node.updatedAt,
      };
      return { ...rest, content: row.content, path };
    },

    create(productId, input, options) {
      if (input.parentId !== null) parentOr400(productId, input.parentId);
      const id = translateUnique(clash(input.title), () =>
        insert(
          productId,
          input.parentId,
          input,
          options?.source ?? "manual",
          options?.sessionId ?? null,
        ),
      );
      return nodeOf(id);
    },

    update(id, input) {
      const row = rowOf(id);
      const next = {
        title: input.title ?? row.title,
        brief: input.brief ?? row.brief,
        content: input.content ?? row.content,
        sources:
          input.sources === undefined ? row.sources : input.sources.join("\n"),
      };
      translateUnique(clash(next.title), () =>
        db
          .prepare(
            "UPDATE wiki_pages SET title = ?, brief = ?, content = ?, sources = ?, source = ?, updated_at = ? WHERE id = ?",
          )
          .run(
            next.title,
            next.brief,
            next.content,
            next.sources,
            // 手改过正文就不再算 AI 产出——否则「重新生成」会毫无提示地盖掉手写内容。
            input.content !== undefined ? "manual" : row.source,
            now(),
            id,
          ),
      );
      return nodeOf(id);
    },

    remove: (id) => {
      rowOf(id);
      db.prepare("DELETE FROM wiki_pages WHERE id = ?").run(id);
    },

    move(id, delta) {
      const row = rowOf(id);
      const siblings = childRows(row.product_id, row.parent_id);
      const index = siblings.findIndex((s) => s.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= siblings.length)
        throw badRequest("已经到头了");
      const other = siblings[target];
      if (!other) throw badRequest("已经到头了");
      /*
       * 交换 sort_order 而不是重排整层。
       *
       * sort_order 上没有唯一约束，所以不需要「先挪到负数再换回来」那套；
       * 但两条 UPDATE 必须在一个事务里——中途失败会留下两行同序，
       * 那时顺序由 created_at 兜底，表现是「点了上移，位置没动」。
       */
      db.transaction(() => {
        const t = now();
        const set = db.prepare(
          "UPDATE wiki_pages SET sort_order = ?, updated_at = ? WHERE id = ?",
        );
        set.run(other.sort_order, t, row.id);
        set.run(row.sort_order, t, other.id);
      })();
      return childRows(row.product_id, row.parent_id).map((r, i) =>
        build(r, i, null),
      );
    },

    productOf: (pageId) => rowOf(pageId).product_id,

    emptyCount: (productId) =>
      db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM wiki_pages WHERE product_id = ? AND content = ''",
        )
        .get(productId)?.n ?? 0,

    isEmpty: (productId) =>
      (db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM wiki_pages WHERE product_id = ?",
        )
        .get(productId)?.n ?? 0) === 0,

    reset(productId, force) {
      /*
       * 恢复出厂目录会 DELETE 整棵树。**默认只在没有任何正文时放行**——
       * 「恢复目录」听起来只动结构，用户不会预期它把写好的 13 章正文一起删了。
       * 确实想推倒重来的，前端会先问一次再带 force。
       */
      if (!force) {
        const written =
          db
            .prepare<[string], { n: number }>(
              "SELECT COUNT(*) AS n FROM wiki_pages WHERE product_id = ? AND content <> ''",
            )
            .get(productId)?.n ?? 0;
        if (written > 0)
          throw conflict(
            `已经有 ${String(written)} 页写了正文，恢复出厂目录会一起删掉。确认要这么做再重试。`,
          );
      }
      db.transaction(() => {
        db.prepare("DELETE FROM wiki_pages WHERE product_id = ?").run(
          productId,
        );
        const writeTree = (
          pages: readonly BuiltinWikiPage[],
          under: string | null,
        ): void => {
          for (const page of pages) {
            const id = insert(
              productId,
              under,
              { title: page.title, brief: page.brief, content: "" },
              "manual",
              null,
            );
            if (page.children !== undefined) writeTree(page.children, id);
          }
        };
        writeTree(BUILTIN_WIKI, null);
      })();
      return this.tree(productId);
    },

    applyOutline(productId, result, options) {
      const created: string[] = [];
      const skipped: string[] = [];
      db.transaction(() => {
        if (options.mode === "replace") {
          // replace 只清**没有正文**的页：写过的留着，让用户自己决定删不删。
          // 直接全删是「生成目录」这个动作不该有的破坏力。
          const keep = db
            .prepare<[string], { n: number }>(
              "SELECT COUNT(*) AS n FROM wiki_pages WHERE product_id = ? AND content <> ''",
            )
            .get(productId)?.n;
          db.prepare(
            "DELETE FROM wiki_pages WHERE product_id = ? AND content = ''",
          ).run(productId);
          if ((keep ?? 0) > 0)
            skipped.push(`${String(keep)} 页已写了正文，保留未动`);
        }
        const writeTree = (
          pages: readonly {
            title: string;
            brief: string;
            sources?: readonly string[];
            children?: readonly {
              title: string;
              brief: string;
              sources?: readonly string[];
            }[];
          }[],
          under: string | null,
        ): void => {
          for (const page of pages) {
            let id: string | null = null;
            try {
              id = insert(
                productId,
                under,
                {
                  title: page.title,
                  brief: page.brief,
                  content: "",
                  sources: [...(page.sources ?? [])],
                },
                "ai",
                options.sessionId,
              );
              created.push(page.title);
            } catch (error) {
              // 重名交给数据库判（索引是 COLLATE NOCASE，JS 的 toLowerCase 与它不等价）。
              if (
                error instanceof Error &&
                "code" in error &&
                error.code === "SQLITE_CONSTRAINT_UNIQUE"
              )
                skipped.push(`章节「${page.title}」已存在`);
              else throw error;
            }
            if (id !== null && page.children !== undefined)
              writeTree(page.children, id);
          }
        };
        writeTree(result.pages, null);
      })();
      return { created, skipped };
    },

    applyPage(pageId, result, options) {
      rowOf(pageId);
      db.prepare(
        "UPDATE wiki_pages SET content = ?, source = 'ai', session_id = ?, updated_at = ? WHERE id = ?",
      ).run(result.content, options.sessionId, now(), pageId);
      return this.page(pageId);
    },
  };
}
