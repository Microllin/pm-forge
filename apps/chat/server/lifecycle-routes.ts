import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "./db.js";
import {
  createArtifactSchema,
  createLifecycle,
  createStageSchema,
  createTemplateSchema,
  updateArtifactSchema,
  updateStageSchema,
  updateTemplateSchema,
} from "./lifecycle.js";

/**
 * 生命周期规范（产品菜单下的二级页「生命周期规范」）的接口。
 *
 *   GET    /api/lifecycle-templates                     模板列表（整树：阶段 + 产出物）
 *   POST   /api/lifecycle-templates                     新建空模板
 *   PATCH  /api/lifecycle-templates/:id                 改名 / 改说明
 *   DELETE /api/lifecycle-templates/:id                 删除（还有产品绑着时 409）
 *   POST   /api/lifecycle-templates/:id/duplicate       复制为新模板
 *   POST   /api/lifecycle-templates/:id/reset           恢复出厂内容（仅出厂模板）
 *   POST   /api/lifecycle-templates/:id/stages          加阶段
 *   PATCH  /api/lifecycle-stages/:id                    改阶段
 *   DELETE /api/lifecycle-stages/:id                    删阶段（连带产出物）
 *   POST   /api/lifecycle-stages/:id/move               上移 / 下移
 *   POST   /api/lifecycle-stages/:id/artifacts          加产出物
 *   PATCH  /api/lifecycle-artifacts/:id                 改产出物
 *   DELETE /api/lifecycle-artifacts/:id                 删产出物
 *
 * 除列表与删除外，一律返回**改动后的整棵模板**：前端不必自己把变更拼回树里，
 * 也不会出现「局部更新成功但树上还是旧的」这种状态。
 */
export function registerLifecycleRoutes(
  app: FastifyInstance,
  db: Db,
  now?: () => number,
): void {
  const lifecycle = createLifecycle(db, now);
  lifecycle.seedIfEmpty();

  interface IdParams {
    Params: { id: string };
  }

  app.get("/api/lifecycle-templates", () => ({
    templates: lifecycle.list(),
  }));
  app.post("/api/lifecycle-templates", (request, reply) =>
    reply
      .code(201)
      .send(lifecycle.createTemplate(createTemplateSchema.parse(request.body))),
  );
  app.patch<IdParams>("/api/lifecycle-templates/:id", (request) =>
    lifecycle.updateTemplate(
      request.params.id,
      updateTemplateSchema.parse(request.body),
    ),
  );
  app.delete<IdParams>("/api/lifecycle-templates/:id", (request, reply) => {
    lifecycle.deleteTemplate(request.params.id);
    return reply.code(204).send();
  });
  app.post<IdParams>(
    "/api/lifecycle-templates/:id/duplicate",
    (request, reply) =>
      reply.code(201).send(lifecycle.duplicateTemplate(request.params.id)),
  );
  app.post<IdParams>("/api/lifecycle-templates/:id/reset", (request) =>
    lifecycle.resetTemplate(request.params.id),
  );

  app.post<IdParams>("/api/lifecycle-templates/:id/stages", (request, reply) =>
    reply
      .code(201)
      .send(
        lifecycle.createStage(
          request.params.id,
          createStageSchema.parse(request.body),
        ),
      ),
  );
  app.patch<IdParams>("/api/lifecycle-stages/:id", (request) =>
    lifecycle.updateStage(
      request.params.id,
      updateStageSchema.parse(request.body),
    ),
  );
  app.delete<IdParams>("/api/lifecycle-stages/:id", (request) =>
    lifecycle.deleteStage(request.params.id),
  );
  // body 过 zod：无 body 的 POST 下 Fastify 给的是 null，直接读 .delta 会 TypeError → 500。
  // 顺带把 delta 收敛成 -1 / 1 两个值，与 moveStage 的签名一致（原来任何值都当 +1）。
  const moveBody = z.object({ delta: z.union([z.literal(-1), z.literal(1)]) });
  app.post<IdParams>("/api/lifecycle-stages/:id/move", (request) =>
    lifecycle.moveStage(request.params.id, moveBody.parse(request.body).delta),
  );

  app.post<IdParams>("/api/lifecycle-stages/:id/artifacts", (request, reply) =>
    reply
      .code(201)
      .send(
        lifecycle.createArtifact(
          request.params.id,
          createArtifactSchema.parse(request.body),
        ),
      ),
  );
  app.patch<IdParams>("/api/lifecycle-artifacts/:id", (request) =>
    lifecycle.updateArtifact(
      request.params.id,
      updateArtifactSchema.parse(request.body),
    ),
  );
  app.delete<IdParams>("/api/lifecycle-artifacts/:id", (request) =>
    lifecycle.deleteArtifact(request.params.id),
  );
}
