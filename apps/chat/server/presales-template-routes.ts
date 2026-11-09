import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  createPresalesTemplateSchema,
  presalesItemInputSchema,
  presalesStageInputSchema,
  updatePresalesItemSchema,
  updatePresalesStageSchema,
  updatePresalesTemplateSchema,
  type PresalesTemplates,
} from "./presales-templates.js";

/**
 * 售前模板的接口。形状与「生命周期规范」一致：
 *
 *   GET    /api/presales-templates                    模板清单（含阶段与材料）
 *   POST   /api/presales-templates                    新建
 *   PATCH  /api/presales-templates/:id                改名 / 改说明
 *   DELETE /api/presales-templates/:id                删除（在用的库会解绑，不影响材料）
 *   POST   /api/presales-templates/:id/duplicate      复制
 *   POST   /api/presales-templates/:id/reset          恢复出厂内容（仅出厂模板）
 *   POST   /api/presales-templates/:id/stages         加阶段
 *   PATCH  /api/presales-stages/:id                   改阶段
 *   DELETE /api/presales-stages/:id                   删阶段（连带它的材料）
 *   POST   /api/presales-stages/:id/move              上移 / 下移
 *   POST   /api/presales-stages/:id/items             加材料
 *   PATCH  /api/presales-items/:id                    改材料
 *   DELETE /api/presales-items/:id                    删材料
 *
 * 全部返回整棵模板：改一处就整体重取，前端不必自己拼局部状态。
 */
const idParams = z.object({ id: z.string() });
const moveBody = z.object({ delta: z.union([z.literal(-1), z.literal(1)]) });

export function registerPresalesTemplateRoutes(
  app: FastifyInstance,
  templates: PresalesTemplates,
): void {
  app.get("/api/presales-templates", () => ({ templates: templates.list() }));

  app.post("/api/presales-templates", (request, reply) =>
    reply
      .code(201)
      .send(templates.create(createPresalesTemplateSchema.parse(request.body))),
  );

  app.patch<{ Params: { id: string } }>(
    "/api/presales-templates/:id",
    (request) =>
      templates.update(
        idParams.parse(request.params).id,
        updatePresalesTemplateSchema.parse(request.body),
      ),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/presales-templates/:id",
    (request, reply) => {
      templates.remove(idParams.parse(request.params).id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/presales-templates/:id/duplicate",
    (request, reply) =>
      reply
        .code(201)
        .send(templates.duplicate(idParams.parse(request.params).id)),
  );

  app.post<{ Params: { id: string } }>(
    "/api/presales-templates/:id/reset",
    (request) => templates.reset(idParams.parse(request.params).id),
  );

  app.post<{ Params: { id: string } }>(
    "/api/presales-templates/:id/stages",
    (request, reply) =>
      reply
        .code(201)
        .send(
          templates.addStage(
            idParams.parse(request.params).id,
            presalesStageInputSchema.parse(request.body),
          ),
        ),
  );

  app.patch<{ Params: { id: string } }>("/api/presales-stages/:id", (request) =>
    templates.updateStage(
      idParams.parse(request.params).id,
      updatePresalesStageSchema.parse(request.body),
    ),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/presales-stages/:id",
    (request) => templates.removeStage(idParams.parse(request.params).id),
  );

  app.post<{ Params: { id: string } }>(
    "/api/presales-stages/:id/move",
    (request) => {
      const { delta } = moveBody.parse(request.body);
      return templates.moveStage(idParams.parse(request.params).id, delta);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/presales-stages/:id/items",
    (request, reply) =>
      reply
        .code(201)
        .send(
          templates.addItem(
            idParams.parse(request.params).id,
            presalesItemInputSchema.parse(request.body),
          ),
        ),
  );

  app.patch<{ Params: { id: string } }>("/api/presales-items/:id", (request) =>
    templates.updateItem(
      idParams.parse(request.params).id,
      updatePresalesItemSchema.parse(request.body),
    ),
  );

  app.delete<{ Params: { id: string } }>("/api/presales-items/:id", (request) =>
    templates.removeItem(idParams.parse(request.params).id),
  );
}
