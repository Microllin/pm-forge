import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { notFound } from "../../errors.js";
import type { Catalog } from "../../products.js";
import type { EnvStore } from "./envs.js";
import type { SnapshotStore } from "./snapshots.js";

/**
 * 页面快照库的接口（事实底座里的第三处，与文件库 / 代码库并列）。
 *
 *   GET  /api/products/:id/snapshots                 全部版本（最新在前，含版本标记）
 *   GET  /api/products/:id/snapshots/:snapId         某一版的明细（每页截图与文字）
 *   POST /api/products/:id/snapshots/capture { envId, frontendRoot? }  SSE 采集一版
 *
 * 版本标记来自代码仓库的 git（提交 / 分支 / 标签 / PR 号），在快照里随版本一起存。
 */
export type SnapshotService = SnapshotStore;

export function registerSnapshotRoutes(
  app: FastifyInstance,
  deps: { catalog: Catalog; snapshots: SnapshotStore; envs: EnvStore },
): void {
  const productOr404 = (id: string) => {
    const p = deps.catalog
      .list()
      .flatMap((l) => l.products)
      .find((x) => x.id === id);
    if (p === undefined) throw notFound("产品不存在");
    return p;
  };

  app.get<{ Params: { id: string } }>(
    "/api/products/:id/snapshots",
    async (request) => {
      productOr404(request.params.id);
      return { snapshots: await deps.snapshots.list(request.params.id) };
    },
  );

  app.get<{ Params: { id: string; snapId: string } }>(
    "/api/products/:id/snapshots/:snapId",
    async (request) => {
      productOr404(request.params.id);
      const s = await deps.snapshots.get(
        request.params.id,
        request.params.snapId,
      );
      if (s === null) throw notFound("没有这一版快照");
      return s;
    },
  );

  const captureBody = z.object({
    envId: z.string().trim().min(1),
    frontendRoot: z.string().trim().min(1).nullable().optional(),
  });

  /** 开始采集：**立即返回任务状态**，采集在服务端后台跑，关掉页面也继续。 */
  app.post<{ Params: { id: string } }>(
    "/api/products/:id/snapshots/capture",
    async (request, reply) => {
      productOr404(request.params.id);
      const body = captureBody.parse(request.body ?? {});
      const job = await deps.snapshots.start({
        productId: request.params.id,
        frontendRoot: body.frontendRoot ?? null,
        envId: body.envId,
      });
      return reply.code(202).send({ job });
    },
  );

  /** 当前进度（页面关掉后再打开，靠它把进度接上）。 */
  app.get<{ Params: { id: string } }>(
    "/api/products/:id/snapshots/job",
    (request) => {
      productOr404(request.params.id);
      return { job: deps.snapshots.status(request.params.id) };
    },
  );

  /** 停止采集：已采的页保留，但不生成这一版快照。 */
  app.post<{ Params: { id: string } }>(
    "/api/products/:id/snapshots/cancel",
    async (request) => {
      productOr404(request.params.id);
      return { cancelled: await deps.snapshots.cancel(request.params.id) };
    },
  );
}
