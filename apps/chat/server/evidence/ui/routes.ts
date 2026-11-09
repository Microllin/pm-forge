import type { FastifyInstance } from "fastify";

import { notFound } from "../../errors.js";
import type { Catalog } from "../../products.js";
import type { Frontend, UiIndex } from "./index.js";

/**
 * 产品 → 页面（前端视角）的接口。
 *
 *   GET /api/products/:id/ui            这个产品代码目录下的前端清单（不带页面）
 *   GET /api/products/:id/ui/pages      某个前端的全部页面（?root=前端根目录）
 *
 * 与 schema/routes.ts 同一套：先列、再取；只认该产品代码目录下解析出来的前端。
 * 与交给 AI 的是同一份解析结果。
 */

const summaryOf = (f: Frontend) => ({
  root: f.root,
  label: f.label,
  format: f.format,
  entry: f.entry,
  pages: f.pages.filter((p) => p.redirect === null).length,
  redirects: f.pages.filter((p) => p.redirect !== null).length,
  untitled: f.pages.filter((p) => p.title === null && p.redirect === null)
    .length,
  messages: f.messages,
  unparsed: f.unparsed,
});

export function registerUiRoutes(
  app: FastifyInstance,
  deps: { catalog: Catalog; ui: UiIndex },
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
    "/api/products/:id/ui",
    async (request) => {
      const product = productOr404(request.params.id);
      if (product.codePath === null) return { codePath: null, frontends: [] };
      const fes = await deps.ui.frontends(product.codePath);
      return { codePath: product.codePath, frontends: fes.map(summaryOf) };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { root?: string } }>(
    "/api/products/:id/ui/pages",
    async (request) => {
      const product = productOr404(request.params.id);
      if (product.codePath === null) throw notFound("这个产品还没绑代码目录");
      const fes = await deps.ui.frontends(product.codePath);
      const fe = fes.find((f) => f.root === request.query.root);
      if (fe === undefined) throw notFound("没有这个前端");
      return { ...summaryOf(fe), pageList: fe.pages };
    },
  );
}
