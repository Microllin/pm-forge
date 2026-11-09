import type { FastifyInstance } from "fastify";

import { notFound } from "../../errors.js";
import type { Catalog } from "../../products.js";
import type { SchemaIndex, Subsystem } from "./index.js";

/**
 * 产品 → 数据结构（ER 图）的接口。
 *
 *   GET /api/products/:id/schema           这个产品代码目录下的子系统清单（不带表）
 *   GET /api/products/:id/schema/tables    某个子系统的全部表与关联（?root=子系统根目录）
 *
 * 分两步取：一个代码仓可能有五六个子系统、几百张表，清单先出来，人选了再取整张图。
 * 与交给 AI 的是**同一份解析结果**（evidence/schema/index.ts），图上看到的就是 AI 拿到的。
 */

const summaryOf = (s: Subsystem) => ({
  root: s.root,
  label: s.label,
  format: s.format,
  alsoHas: s.alsoHas,
  files: s.files,
  tables: s.model.tables.length,
  relations: s.model.relations.length,
  unparsed: s.model.unparsed,
});

export function registerSchemaRoutes(
  app: FastifyInstance,
  deps: { catalog: Catalog; schema: SchemaIndex },
): void {
  const productOr404 = (id: string) => {
    const product = deps.catalog
      .list()
      .flatMap((l) => l.products)
      .find((p) => p.id === id);
    if (product === undefined) throw notFound("产品不存在");
    return product;
  };

  app.get<{ Params: { id: string } }>(
    "/api/products/:id/schema",
    async (request) => {
      const product = productOr404(request.params.id);
      if (product.codePath === null) return { codePath: null, subsystems: [] };
      const subs = await deps.schema.subsystems(product.codePath);
      return { codePath: product.codePath, subsystems: subs.map(summaryOf) };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { root?: string } }>(
    "/api/products/:id/schema/tables",
    async (request) => {
      const product = productOr404(request.params.id);
      if (product.codePath === null) throw notFound("这个产品还没绑代码目录");
      const subs = await deps.schema.subsystems(product.codePath);
      // 只认这个产品代码目录下解析出来的子系统：root 是查找键，不是任意路径。
      const sub = subs.find((s) => s.root === request.query.root);
      if (sub === undefined) throw notFound("没有这个子系统");
      return {
        ...summaryOf(sub),
        tableList: sub.model.tables,
        relationList: sub.model.relations,
      };
    },
  );
}
