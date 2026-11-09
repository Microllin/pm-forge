import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "./db.js";
import { notFound } from "./errors.js";
import { createCatalog } from "./products.js";
import { createPageSchema, createWiki, updatePageSchema } from "./wiki.js";

/**
 * 产品 wiki（产品菜单下的二级页「Wiki」）的接口。
 *
 *   GET    /api/products/:id/wiki          整棵章节树（**不带正文**）
 *   POST   /api/products/:id/wiki          手写加一章 / 一节
 *   POST   /api/products/:id/wiki/reset    恢复出厂目录
 *   GET    /api/wiki-pages/:id             单页（带正文 + 面包屑）
 *   PATCH  /api/wiki-pages/:id             改标题 / 提纲 / 正文
 *   DELETE /api/wiki-pages/:id             删（CASCADE 带走子节）
 *   POST   /api/wiki-pages/:id/move        同层上移 / 下移
 *
 * 树接口不带正文是刻意的，见 wiki.ts 文件头。
 */
export function registerWikiRoutes(app: FastifyInstance, db: Db): void {
  const wiki = createWiki(db);
  const catalog = createCatalog(db);

  /**
   * 产品不存在要 404。
   *
   * 不校验的话 GET 对任意 id 都回空树（看起来像「这个产品还没建 wiki」，
   * 而实际是产品本身不存在），POST 则撞外键报 SQLITE_CONSTRAINT_FOREIGNKEY
   * ——那个错误码没有被翻译，落到兜底 500。
   * （上一轮评审在 features 路由上踩过同一个坑。）
   */
  const productOr404 = (id: string): void => {
    const hit = catalog
      .list()
      .flatMap((l) => l.products)
      .find((p) => p.id === id);
    if (!hit) throw notFound("产品不存在");
  };

  app.get<{ Params: { id: string } }>("/api/products/:id/wiki", (request) => {
    productOr404(request.params.id);
    return { pages: wiki.tree(request.params.id) };
  });

  app.post<{ Params: { id: string } }>(
    "/api/products/:id/wiki",
    (request, reply) => {
      productOr404(request.params.id);
      return reply
        .code(201)
        .send(
          wiki.create(request.params.id, createPageSchema.parse(request.body)),
        );
    },
  );

  // body 过 zod：无 body 的 POST 下 Fastify 给的是 null，直接读属性会 TypeError → 500。
  const resetBody = z.object({ force: z.boolean().default(false) });
  app.post<{ Params: { id: string } }>(
    "/api/products/:id/wiki/reset",
    (request) => {
      productOr404(request.params.id);
      const { force } = resetBody.parse(request.body ?? {});
      return { pages: wiki.reset(request.params.id, force) };
    },
  );

  app.get<{ Params: { id: string } }>("/api/wiki-pages/:id", (request) =>
    wiki.page(request.params.id),
  );

  app.patch<{ Params: { id: string } }>("/api/wiki-pages/:id", (request) =>
    wiki.update(request.params.id, updatePageSchema.parse(request.body)),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/wiki-pages/:id",
    (request, reply) => {
      wiki.remove(request.params.id);
      return reply.code(204).send();
    },
  );

  const moveBody = z.object({ delta: z.union([z.literal(-1), z.literal(1)]) });
  app.post<{ Params: { id: string } }>(
    "/api/wiki-pages/:id/move",
    (request) => ({
      pages: wiki.move(request.params.id, moveBody.parse(request.body).delta),
    }),
  );
}
