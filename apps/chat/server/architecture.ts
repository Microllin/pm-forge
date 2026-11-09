import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Db } from "./db.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { normalizeLines, splitLines, translateUnique } from "./sql-util.js";

/**
 * 产品功能架构树：一级 / 二级 / 三级…功能，由 AI 读代码分析出来，也允许手改。
 *
 * ## 两条不显然的设计
 *
 * **① 节点带「代码证据」。** 没有它就无法复查「AI 凭什么说这是一个功能」，
 * 也无法把「向下拆一层」的扫描面收窄到这一支——那样每次展开都得重扫整个仓库。
 *
 * **② 节点记 `source`（ai / manual）。** 用户点「重新分析这一支」时，要能说清
 * 「会覆盖掉你手改过的这 3 个」而不是笼统地警告「会覆盖」。手改过的节点是用户
 * 的判断，值得单独点名。
 */

/* ── 输入校验 ───────────────────────────────────────────────────────── */

/** 层级护栏。真实架构树到不了这个深度；超了说明数据有环。 */
const MAX_DEPTH = 32;

const nodeName = z
  .string({ error: "功能名称必填" })
  .trim()
  .min(1, "功能名称不能为空")
  .max(120, "功能名称最多 120 个字");
const duty = z.string().trim().max(1000, "职责最多 1000 个字");
const evidence = z.string().trim().max(2000, "代码证据最多 2000 个字");

export const createNodeSchema = z.object({
  name: nodeName,
  duty: duty.default(""),
  evidence: evidence.default(""),
  /** 挂在谁下面；空串 / 缺省 = 一级功能。 */
  parentId: z.string().trim().optional(),
});
export const updateNodeSchema = z
  .object({
    name: nodeName.optional(),
    duty: duty.optional(),
    evidence: evidence.optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "没有要修改的字段",
  );

/**
 * AI 一轮分析产出的节点。**最多嵌套两层**（一次拆到孙级也接受，再深就不要了）。
 *
 * 写成有限层数而不是 `z.lazy` 自递归：自递归没有深度上限，模型给一个深嵌套 JSON
 * 就能让 zod 解析或下面的 writeTree 爆栈（表现是 500，查不出原因）。
 * 提示词本来也只要一到两层，限死与承诺一致。
 */
const aiLeaf = z.object({
  name: nodeName,
  duty: duty.default(""),
  evidence: z.array(z.string().trim().max(500)).default([]),
  children: z.tuple([]).default([]),
});
const aiNode = z.object({
  name: nodeName,
  duty: duty.default(""),
  evidence: z.array(z.string().trim().max(500)).default([]),
  children: z.array(aiLeaf).default([]),
});
export interface AiNode {
  name: string;
  duty: string;
  evidence: string[];
  children: { name: string; duty: string; evidence: string[] }[];
}

export const architectureResultSchema = z.object({
  features: z.array(aiNode).default([]),
  /** 拿不准的放这里，不要硬塞进 features。 */
  uncertain: z.array(z.string().trim().max(500)).default([]),
});
export type ArchitectureResult = z.infer<typeof architectureResultSchema>;

/* ── 对外形状 ───────────────────────────────────────────────────────── */

export interface FeatureNode {
  id: string;
  productId: string;
  parentId: string | null;
  name: string;
  duty: string;
  /** 代码证据（文件 / 目录指针），一行一条。 */
  evidence: string[];
  source: "ai" | "manual";
  /** 产生它的那次分析会话；可点回去看 AI 当时怎么判的。 */
  sessionId: string | null;
  /** 1 = 一级功能。 */
  level: number;
  children: FeatureNode[];
}

interface NodeRow {
  id: string;
  product_id: string;
  parent_id: string | null;
  name: string;
  duty: string;
  evidence: string;
  source: string;
  session_id: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface Architecture {
  /** 整棵树（一级功能在顶层，children 递归）。 */
  tree(productId: string): FeatureNode[];
  node(id: string): FeatureNode;
  /** 从根到这个节点的路径（含自己），用于提示词里交代「现在在拆哪一支」。 */
  pathOf(id: string): FeatureNode[];
  createNode(
    productId: string,
    input: z.input<typeof createNodeSchema>,
  ): FeatureNode;
  updateNode(id: string, input: z.input<typeof updateNodeSchema>): FeatureNode;
  deleteNode(id: string): void;
  /**
   * 把一轮 AI 结果并进树里。
   *
   * - `mode: "append"`（向下拆一层）：只补不覆盖，**已存在的同名节点跳过**。
   * - `mode: "replace"`（重新分析这一支）：先删掉 parent 下的全部子节点再写。
   *
   * 返回新建与跳过的名字，界面上要如实报出来。
   */
  apply(
    productId: string,
    parentId: string | null,
    result: ArchitectureResult,
    options: { mode: "append" | "replace"; sessionId: string },
  ): { created: string[]; skipped: string[] };
  /** 某个父节点下手改过的子节点名。重新分析前要点名警告。 */
  manualChildren(parentId: string | null, productId: string): string[];
}

export function createArchitecture(
  db: Db,
  now: () => number = Date.now,
): Architecture {
  const rowOf = (id: string): NodeRow => {
    const row = db
      .prepare<[string], NodeRow>("SELECT * FROM feature_nodes WHERE id = ?")
      .get(id);
    if (!row) throw notFound("功能节点不存在");
    return row;
  };

  /**
   * 某个父节点下的子节点。
   *
   * **`product_id` 这个条件不能省**：少了它，`POST /api/products/A/features` 传一个
   * 属于产品 B 的 parentId，就能插出一条 `product_id=A, parent_id=<B 的节点>` 的记录
   * ——它会出现在 B 的树里却带着 A 的 productId，删 A 时被 CASCADE 带走，
   * B 的树凭空少一支。（这个漏洞在评审中被实测复现过。）
   */
  const childRows = (productId: string, parentId: string | null): NodeRow[] =>
    parentId === null
      ? db
          .prepare<[string], NodeRow>(
            "SELECT * FROM feature_nodes WHERE product_id = ? AND parent_id IS NULL ORDER BY sort_order, created_at",
          )
          .all(productId)
      : db
          .prepare<[string, string], NodeRow>(
            "SELECT * FROM feature_nodes WHERE product_id = ? AND parent_id = ? ORDER BY sort_order, created_at",
          )
          .all(productId, parentId);

  /** 校验父节点存在**且属于这个产品**。写入前必过。 */
  const parentOr400 = (productId: string, parentId: string): NodeRow => {
    const row = rowOf(parentId);
    if (row.product_id !== productId)
      throw badRequest("父功能不属于这个产品，不能挂到它下面");
    return row;
  };

  const build = (row: NodeRow, level: number): FeatureNode => ({
    id: row.id,
    productId: row.product_id,
    parentId: row.parent_id,
    name: row.name,
    duty: row.duty,
    evidence: splitLines(row.evidence),
    source: row.source === "manual" ? "manual" : "ai",
    sessionId: row.session_id,
    level,
    children: childRows(row.product_id, row.id).map((c) => build(c, level + 1)),
  });

  const nextOrder = (productId: string, parentId: string | null): number =>
    (parentId === null
      ? db
          .prepare<[string], { n: number }>(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM feature_nodes WHERE product_id = ? AND parent_id IS NULL",
          )
          .get(productId)
      : db
          .prepare<[string], { n: number }>(
            "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM feature_nodes WHERE parent_id = ?",
          )
          .get(parentId)
    )?.n ?? 1;

  const clash = (n: string) => `同一层下已有功能「${n}」`;

  /** 插一个节点（不管重名，由调用方决定是跳过还是报错）。 */
  const insert = (
    productId: string,
    parentId: string | null,
    node: { name: string; duty: string; evidence: string },
    source: "ai" | "manual",
    sessionId: string | null,
  ): string => {
    const id = randomUUID();
    const t = now();
    db.prepare(
      "INSERT INTO feature_nodes (id, product_id, parent_id, name, duty, evidence, source, session_id, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      id,
      productId,
      parentId,
      node.name,
      node.duty,
      node.evidence,
      source,
      sessionId,
      nextOrder(productId, parentId),
      t,
      t,
    );
    return id;
  };

  return {
    tree: (productId) => childRows(productId, null).map((r) => build(r, 1)),

    node: (id) => {
      const row = rowOf(id);
      // level 要真算：提示词里「现在在拆第几层」是重要上下文。
      let level = 1;
      let cursor: NodeRow = row;
      while (cursor.parent_id !== null) {
        cursor = rowOf(cursor.parent_id);
        level += 1;
        // 现在的接口构造不出环（没有 reparent / move），但万一数据被外部改过
        // 或将来加了移动功能，这个 while 会无限循环并一直发查询 —— 服务卡死。
        // 一行护栏把「卡死」换成「报错」。
        if (level > MAX_DEPTH)
          throw conflict("功能层级异常（疑似成环），请检查数据");
      }
      return build(row, level);
    },

    pathOf: (id) => {
      const chain: NodeRow[] = [];
      let cursor: NodeRow | null = rowOf(id);
      while (cursor !== null) {
        chain.unshift(cursor);
        if (chain.length > MAX_DEPTH)
          throw conflict("功能层级异常（疑似成环），请检查数据");
        cursor = cursor.parent_id === null ? null : rowOf(cursor.parent_id);
      }
      return chain.map((r, i) => ({
        id: r.id,
        productId: r.product_id,
        parentId: r.parent_id,
        name: r.name,
        duty: r.duty,
        evidence: splitLines(r.evidence),
        source: r.source === "manual" ? "manual" : "ai",
        sessionId: r.session_id,
        level: i + 1,
        // 路径只用来交代上下文，不需要带子树（带了会在提示词里重复整棵树）。
        children: [],
      }));
    },

    createNode(productId, input) {
      const v = createNodeSchema.parse(input);
      const parentId =
        v.parentId === undefined || v.parentId === "" ? null : v.parentId;
      if (parentId !== null) parentOr400(productId, parentId);
      const id = translateUnique(clash(v.name), () =>
        insert(
          productId,
          parentId,
          {
            name: v.name,
            duty: v.duty,
            evidence: normalizeLines(v.evidence),
          },
          "manual",
          null,
        ),
      );
      return this.node(id);
    },

    updateNode(id, input) {
      const v = updateNodeSchema.parse(input);
      const row = rowOf(id);
      const next = {
        name: v.name ?? row.name,
        duty: v.duty ?? row.duty,
        evidence:
          v.evidence === undefined ? row.evidence : normalizeLines(v.evidence),
      };
      translateUnique(clash(next.name), () =>
        db
          .prepare(
            // 手改过就记成 manual：重新分析这一支时要能点名「会覆盖你改过的这几个」。
            "UPDATE feature_nodes SET name = ?, duty = ?, evidence = ?, source = 'manual', updated_at = ? WHERE id = ?",
          )
          .run(next.name, next.duty, next.evidence, now(), id),
      );
      return this.node(id);
    },

    deleteNode(id) {
      rowOf(id);
      // 子节点是 CASCADE：子功能脱离父功能没有意义。
      db.prepare("DELETE FROM feature_nodes WHERE id = ?").run(id);
    },

    apply(productId, parentId, result, options) {
      if (parentId !== null) parentOr400(productId, parentId);
      const created: string[] = [];
      const skipped: string[] = [];

      /**
       * 重名判定**交给数据库**，不在 JS 里比。
       *
       * 原来用 `name.toLowerCase()` 比，而索引是 `COLLATE NOCASE`——**两者不等价**：
       * NOCASE 只折叠 ASCII A–Z，JS 的 toLowerCase 连 `Ärger`/`ärger` 一起折。
       * 结果是这类名字在 JS 看来「已存在」而数据库认为不同，于是报告里说
       * 「跳过（重名）」但树里根本没有那一条——报告自相矛盾且查不出原因。
       */
      const writeTree = (
        nodes: readonly {
          name: string;
          duty: string;
          evidence: string[];
          children?: readonly {
            name: string;
            duty: string;
            evidence: string[];
          }[];
        }[],
        under: string | null,
      ): void => {
        for (const node of nodes) {
          let id: string | null = null;
          try {
            id = insert(
              productId,
              under,
              {
                name: node.name,
                duty: node.duty,
                evidence: normalizeLines(node.evidence.join("\n")),
              },
              "ai",
              options.sessionId,
            );
            created.push(node.name);
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "SQLITE_CONSTRAINT_UNIQUE"
            ) {
              skipped.push(node.name);
            } else throw error;
          }
          if (
            id !== null &&
            node.children !== undefined &&
            node.children.length > 0
          )
            writeTree(node.children, id);
        }
      };

      db.transaction(() => {
        if (options.mode === "replace") {
          // 整支重来：先清空这个父节点下的全部子节点（CASCADE 带走更深的）。
          if (parentId === null)
            db.prepare(
              "DELETE FROM feature_nodes WHERE product_id = ? AND parent_id IS NULL",
            ).run(productId);
          else
            db.prepare("DELETE FROM feature_nodes WHERE parent_id = ?").run(
              parentId,
            );
        }
        writeTree(result.features, parentId);
      })();

      return { created, skipped };
    },

    /**
     * 这一支下手改过的节点——**整棵子树，不只一层**。
     *
     * replace 会 `DELETE` 掉该父节点下的子节点，CASCADE 把更深的一起带走。
     * 原来只查一层：用户在三级功能上手改的那些，确认框里一条都不显示，点下去全没了。
     * 这个方法的全部意义就是「说清会覆盖掉哪几个」，漏报等于白做。
     *
     * 返回带路径（`父 / 子`），光给名字在深层时看不出是哪一个。
     */
    manualChildren: (parentId, productId) => {
      const out: string[] = [];
      const walk = (
        pid: string | null,
        trail: string[],
        depth: number,
      ): void => {
        if (depth > MAX_DEPTH) return;
        for (const row of childRows(productId, pid)) {
          const path = [...trail, row.name];
          if (row.source === "manual") out.push(path.join(" / "));
          walk(row.id, path, depth + 1);
        }
      };
      walk(parentId, [], 0);
      return out;
    },
  };
}
