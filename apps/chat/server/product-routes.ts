import type { FastifyInstance } from "fastify";

import type { Db } from "./db.js";
import {
  createCatalog,
  createLineSchema,
  createProductSchema,
  updateLineSchema,
  updateProductSchema,
} from "./products.js";

/**
 * 产品模块（一级菜单「产品」）的接口。错误形状与校验失败的处理沿用 createApp 的
 * 统一错误处理（HttpError / ZodError）。
 *
 *   GET    /api/product-lines                  产品线列表（每条带下面的产品）
 *   POST   /api/product-lines                  新建产品线
 *   PATCH  /api/product-lines/:id              改名 / 改描述
 *   DELETE /api/product-lines/:id              删除（下面还有产品时 409）
 *   POST   /api/product-lines/:id/products     在这条产品线下新建产品
 *   PATCH  /api/products/:id                   改名 / 改描述 / 换产品线
 *   DELETE /api/products/:id                   删除产品
 *
 * 列表一次返回全部：几十条的量级，不分页；前端每次改动后整体重取。
 */
export function registerProductRoutes(
  app: FastifyInstance,
  db: Db,
  now?: () => number,
  /**
   * 删产品时顺手清掉它名下测试环境的账号密码文件。
   *
   * `test_envs` 行由外键级联删，但凭据是 `<数据目录>/envs/<id>.json` 里的明文文件，
   * 数据库管不到它。不清理的话，账号密码会永远留在一个已经没人引用的文件里。
   */
  onDeleted?: (productId: string) => Promise<void>,
): void {
  const catalog = createCatalog(db, now);

  interface IdParams {
    Params: { id: string };
  }

  app.get("/api/product-lines", () => ({ lines: catalog.list() }));
  app.post("/api/product-lines", (request, reply) =>
    reply
      .code(201)
      .send(catalog.createLine(createLineSchema.parse(request.body))),
  );
  app.patch<IdParams>("/api/product-lines/:id", (request) =>
    catalog.updateLine(request.params.id, updateLineSchema.parse(request.body)),
  );
  app.delete<IdParams>("/api/product-lines/:id", (request, reply) => {
    catalog.deleteLine(request.params.id);
    return reply.code(204).send();
  });

  app.post<IdParams>("/api/product-lines/:id/products", (request, reply) =>
    reply
      .code(201)
      .send(
        catalog.createProduct(
          request.params.id,
          createProductSchema.parse(request.body),
        ),
      ),
  );
  app.patch<IdParams>("/api/products/:id", (request) =>
    catalog.updateProduct(
      request.params.id,
      updateProductSchema.parse(request.body),
    ),
  );
  app.delete<IdParams>("/api/products/:id", async (request, reply) => {
    const id = request.params.id;
    catalog.deleteProduct(id);
    // 记录已删；清凭据文件失败不该让接口报错（与删售前库同一条取舍）。
    await onDeleted?.(id).catch(() => undefined);
    return reply.code(204).send();
  });
}
