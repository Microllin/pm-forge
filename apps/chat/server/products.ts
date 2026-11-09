import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Db } from "./db.js";
import { conflict, notFound } from "./errors.js";
import { CODE_ROOT, normalizePath } from "./files/paths.js";
import { STAGING_ROOT, isStagingPath } from "./staging/paths.js";
import { translateUnique } from "./sql-util.js";

/**
 * 产品模块（一级菜单「产品」）：产品线与产品的仓储。两层、两张表，刻意不做通用树：
 *
 * 旧版把产品线 / 产品 / 模块 / 功能 / 需求塞进一张 tree_nodes，用 kind 区分，
 * 于是每个查询都得记得按 kind 过滤、每条写入都得校验「产品只能挂在产品线下」。
 * 分成两张表后这些约束由表结构本身保证（products.line_id 必须指向一条产品线），
 * 不存在「产品挂在产品下」这种状态。
 */

/* ── 输入校验 ───────────────────────────────────────────────────────── */

const name = (what: string) =>
  z
    .string({ error: `${what}名称必填` })
    .trim()
    .min(1, `${what}名称不能为空`)
    .max(80, `${what}名称最多 80 个字`);
const description = z.string().trim().max(2000, "描述最多 2000 个字");

/**
 * 绑定的目录路径。**要过 normalizePath**，不能只看「以 / 开头」——
 * 那样 `/a/../../etc` 这类能存进库，等到采集时才在 files 层报错，
 * 而用户已经以为绑好了。规范化在入口做，库里存的就是干净路径。
 */
const folderPath = z
  .string()
  .trim()
  .max(1000, "文件夹路径太长")
  .superRefine((v, ctx) => {
    if (v === "") return;
    if (!v.startsWith("/")) {
      ctx.addIssue({
        code: "custom",
        message: "路径要以 / 开头（事实底座里的路径）",
      });
      return;
    }
    try {
      if (isStagingPath(normalizePath(v)))
        ctx.addIssue({
          code: "custom",
          message: `不能绑定临时区（${STAGING_ROOT}）：那里是还没确认的 AI 产出，不是事实依据`,
        });
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "路径不合法（不能含 . 或 .. 等）",
      });
    }
  })
  .transform((v) => (v === "" ? "" : normalizePath(v)));

/** 代码目录还要在「事实底座 → 代码」那一层之内，不能指到文档库去。 */
const codePathField = folderPath.refine(
  (v) => v === "" || v === CODE_ROOT || v.startsWith(`${CODE_ROOT}/`),
  `代码目录要在 ${CODE_ROOT} 下（事实底座 → 代码）`,
);

/** 参考资料最多挂几条。每条在 wiki 里各占一份扫描预算，挂多了提示词会被撑爆。 */
export const MAX_REF_PATHS = 8;

/**
 * 参考资料：文档目录或单个文件，**不在代码库里**（代码走 codePath）。
 * 去重、去空，保持用户给的顺序——顺序就是采集优先级。
 */
const refPathsField = z
  .array(
    folderPath.refine(
      (v) => v === "" || !(v === CODE_ROOT || v.startsWith(`${CODE_ROOT}/`)),
      `参考资料放文档，代码请绑到代码目录（${CODE_ROOT} 下）`,
    ),
  )
  .max(MAX_REF_PATHS, `参考资料最多 ${String(MAX_REF_PATHS)} 条`)
  .transform((list) => [...new Set(list.filter((v) => v !== ""))]);

export const createLineSchema = z.object({
  name: name("产品线"),
  description: description.default(""),
  /** 绑定的文件夹（文件模块里的路径）。空串 = 不绑。 */
  folderPath: folderPath.optional(),
});
export const updateLineSchema = z
  .object({
    name: name("产品线").optional(),
    description: description.optional(),
    folderPath: folderPath.optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.folderPath !== undefined,
    "没有要修改的字段",
  );

export const createProductSchema = z.object({
  name: name("产品"),
  description: description.default(""),
  /** 绑定的生命周期规范模板。一个产品一个模板，空串表示不绑。 */
  templateId: z.string().trim().optional(),
  /** 绑定的文档目录。AI 比对产出物时读的就是它。 */
  folderPath: folderPath.optional(),
  /** 绑定的代码目录。AI 分析功能架构时读的就是它。 */
  codePath: codePathField.optional(),
  /** 参考资料（文档目录 / 文件），wiki 额外读它们。 */
  refPaths: refPathsField.optional(),
});
export const updateProductSchema = z
  .object({
    name: name("产品").optional(),
    description: description.optional(),
    /** 换产品线：移到目标产品线的末尾。 */
    lineId: z.string().min(1).optional(),
    /** 换模板；空串 = 解绑。 */
    templateId: z.string().trim().optional(),
    /** 换文档目录；空串 = 解绑。 */
    folderPath: folderPath.optional(),
    /** 换代码目录；空串 = 解绑。 */
    codePath: codePathField.optional(),
    /** 整组替换参考资料；空数组 = 清空。 */
    refPaths: refPathsField.optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.description !== undefined ||
      v.lineId !== undefined ||
      v.templateId !== undefined ||
      v.folderPath !== undefined ||
      v.codePath !== undefined ||
      v.refPaths !== undefined,
    "没有要修改的字段",
  );

/* ── 对外形状 ───────────────────────────────────────────────────────── */

export interface Product {
  id: string;
  lineId: string;
  name: string;
  description: string;
  /** 绑定的生命周期规范模板；null = 还没绑。 */
  templateId: string | null;
  /** 绑定的**文档**目录（事实底座 → 文件）；null = 还没绑。产出物比对读它。 */
  folderPath: string | null;
  /** 绑定的**代码**目录（事实底座 → 代码）；null = 还没绑。功能架构分析读它。 */
  codePath: string | null;
  /** 参考资料（事实底座 → 文件 里的目录或文件）。wiki 规划与写正文时额外读。 */
  refPaths: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ProductLine {
  id: string;
  name: string;
  description: string;
  folderPath: string | null;
  createdAt: number;
  updatedAt: number;
  products: Product[];
}

interface LineRow {
  id: string;
  name: string;
  description: string;
  folder_path: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}
interface ProductRow extends LineRow {
  line_id: string;
  template_id: string | null;
  code_path: string | null;
  ref_paths: string;
}

const splitLines = (v: string): string[] =>
  v.split("\n").filter((x) => x !== "");

const toProduct = (r: ProductRow): Product => ({
  id: r.id,
  lineId: r.line_id,
  name: r.name,
  description: r.description,
  templateId: r.template_id,
  folderPath: r.folder_path,
  codePath: r.code_path,
  refPaths: splitLines(r.ref_paths),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * 把唯一约束冲突翻成人话。名称唯一由数据库保证（见 db.ts），这里只负责翻译，
 * 不先查后写：先查后写在并发下会漏。
 */
export interface Catalog {
  list(): ProductLine[];
  createLine(input: z.input<typeof createLineSchema>): ProductLine;
  updateLine(id: string, input: z.input<typeof updateLineSchema>): ProductLine;
  deleteLine(id: string): void;
  createProduct(
    lineId: string,
    input: z.input<typeof createProductSchema>,
  ): Product;
  updateProduct(
    id: string,
    input: z.input<typeof updateProductSchema>,
  ): Product;
  deleteProduct(id: string): void;
}

export function createCatalog(db: Db, now: () => number = Date.now): Catalog {
  const lineRow = (id: string): LineRow => {
    const row = db
      .prepare<[string], LineRow>("SELECT * FROM product_lines WHERE id = ?")
      .get(id);
    if (!row) throw notFound("产品线不存在");
    return row;
  };
  const productRow = (id: string): ProductRow => {
    const row = db
      .prepare<[string], ProductRow>("SELECT * FROM products WHERE id = ?")
      .get(id);
    if (!row) throw notFound("产品不存在");
    return row;
  };
  const productsOf = (lineId: string): Product[] =>
    db
      .prepare<[string], ProductRow>(
        "SELECT * FROM products WHERE line_id = ? ORDER BY sort_order, created_at",
      )
      .all(lineId)
      .map(toProduct);
  const toLine = (r: LineRow): ProductLine => ({
    id: r.id,
    name: r.name,
    description: r.description,
    folderPath: r.folder_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    products: productsOf(r.id),
  });
  const nextLineOrder = (): number =>
    db
      .prepare<[], { n: number }>(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM product_lines",
      )
      .get()?.n ?? 1;
  const nextProductOrder = (lineId: string): number =>
    db
      .prepare<[string], { n: number }>(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM products WHERE line_id = ?",
      )
      .get(lineId)?.n ?? 1;
  const lineClash = (n: string) => `已有同名产品线「${n}」`;
  const productClash = (n: string) => `这条产品线下已有同名产品「${n}」`;
  /**
   * 模板绑定校验。外键只保证「指向的模板存在」，报出来是 SQLITE_CONSTRAINT_FOREIGNKEY，
   * 翻不成人话；这里先查一次给明确文案。空串按「解绑」处理，存 null。
   */
  const templateRef = (raw: string | undefined): string | null | undefined => {
    if (raw === undefined) return undefined;
    if (raw === "") return null;
    const hit = db
      .prepare<[string], { id: string }>(
        "SELECT id FROM lifecycle_templates WHERE id = ?",
      )
      .get(raw);
    if (!hit) throw notFound("绑定的生命周期规范模板不存在");
    return raw;
  };

  return {
    list: () =>
      db
        .prepare<[], LineRow>(
          "SELECT * FROM product_lines ORDER BY sort_order, created_at",
        )
        .all()
        .map(toLine),

    createLine(input) {
      const v = createLineSchema.parse(input);
      const id = randomUUID();
      const t = now();
      translateUnique(lineClash(v.name), () =>
        db
          .prepare(
            "INSERT INTO product_lines (id, name, description, folder_path, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            v.name,
            v.description,
            v.folderPath === undefined || v.folderPath === ""
              ? null
              : v.folderPath,
            nextLineOrder(),
            t,
            t,
          ),
      );
      return toLine(lineRow(id));
    },

    updateLine(id, input) {
      const v = updateLineSchema.parse(input);
      const row = lineRow(id);
      const next = {
        name: v.name ?? row.name,
        description: v.description ?? row.description,
        folderPath:
          v.folderPath === undefined
            ? row.folder_path
            : v.folderPath === ""
              ? null
              : v.folderPath,
      };
      translateUnique(lineClash(next.name), () =>
        db
          .prepare(
            "UPDATE product_lines SET name = ?, description = ?, folder_path = ?, updated_at = ? WHERE id = ?",
          )
          .run(next.name, next.description, next.folderPath, now(), id),
      );
      return toLine(lineRow(id));
    },

    deleteLine(id) {
      lineRow(id);
      const count =
        db
          .prepare<[string], { n: number }>(
            "SELECT COUNT(*) AS n FROM products WHERE line_id = ?",
          )
          .get(id)?.n ?? 0;
      if (count > 0)
        throw conflict(
          `这条产品线下还有 ${String(count)} 个产品，先移走或删除它们`,
        );
      db.prepare("DELETE FROM product_lines WHERE id = ?").run(id);
    },

    createProduct(lineId, input) {
      const v = createProductSchema.parse(input);
      lineRow(lineId);
      const template = templateRef(v.templateId) ?? null;
      const id = randomUUID();
      const t = now();
      translateUnique(productClash(v.name), () =>
        db
          .prepare(
            "INSERT INTO products (id, line_id, name, description, template_id, folder_path, code_path, ref_paths, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            id,
            lineId,
            v.name,
            v.description,
            template,
            v.folderPath === undefined || v.folderPath === ""
              ? null
              : v.folderPath,
            v.codePath === undefined || v.codePath === "" ? null : v.codePath,
            (v.refPaths ?? []).join("\n"),
            nextProductOrder(lineId),
            t,
            t,
          ),
      );
      return toProduct(productRow(id));
    },

    updateProduct(id, input) {
      const v = updateProductSchema.parse(input);
      const row = productRow(id);
      const moving = v.lineId !== undefined && v.lineId !== row.line_id;
      if (moving) lineRow(v.lineId ?? "");
      const template = templateRef(v.templateId);
      const next = {
        name: v.name ?? row.name,
        description: v.description ?? row.description,
        lineId: moving ? (v.lineId ?? row.line_id) : row.line_id,
        templateId: template === undefined ? row.template_id : template,
        folderPath:
          v.folderPath === undefined
            ? row.folder_path
            : v.folderPath === ""
              ? null
              : v.folderPath,
        codePath:
          v.codePath === undefined
            ? row.code_path
            : v.codePath === ""
              ? null
              : v.codePath,
        refPaths:
          v.refPaths === undefined ? row.ref_paths : v.refPaths.join("\n"),
      };
      translateUnique(productClash(next.name), () =>
        db
          .prepare(
            "UPDATE products SET name = ?, description = ?, line_id = ?, template_id = ?, folder_path = ?, code_path = ?, ref_paths = ?, sort_order = ?, updated_at = ? WHERE id = ?",
          )
          .run(
            next.name,
            next.description,
            next.lineId,
            next.templateId,
            next.folderPath,
            next.codePath,
            next.refPaths,
            // 换了产品线就排到目标的末尾；没换保持原位。
            moving ? nextProductOrder(next.lineId) : row.sort_order,
            now(),
            id,
          ),
      );
      return toProduct(productRow(id));
    },

    deleteProduct(id) {
      productRow(id);
      // 情报库按 JSON 存 product_ids（不在主迁移里、也没有外键），删产品时数据库不会帮我们清。
      // 不清的话这些条目会指向一个已不存在的产品：界面上显示「已删除的产品」，
      // 但不再匹配任何产品筛选，等于悄悄从使用者的视野里消失。清成「全局」更诚实。
      db.transaction(() => {
        db.prepare("DELETE FROM products WHERE id = ?").run(id);
        db.prepare(
          `UPDATE intel_items
              SET product_ids = (
                SELECT COALESCE(json_group_array(value), '[]')
                  FROM json_each(intel_items.product_ids) WHERE value <> ?
              ),
              updated_at = ?
            WHERE EXISTS (
              SELECT 1 FROM json_each(intel_items.product_ids) WHERE value = ?
            )`,
        ).run(id, now(), id);
      })();
    },
  };
}
