import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Db } from "./db.js";
import { badRequest, notFound } from "./errors.js";
import {
  BUILTIN_PRESALES_TEMPLATES,
  type BuiltinPresalesStage,
} from "./presales-template-builtin.js";
import { normalizeLines, splitLines, translateUnique } from "./sql-util.js";

/**
 * 售前模板库：模板 → 阶段 → 材料。可建、可改、可复制、可恢复出厂。
 *
 * 和生命周期规范是同一个思路，区别是材料多了「对内 / 对外」——这是售前材料
 * 最要紧的一个属性（报价底线发错就是事故），所以从模板层就定下来。
 */

/* ── 输入校验 ───────────────────────────────────────────────────────── */

const text = (what: string, max: number) =>
  z
    .string({ error: `${what}必填` })
    .trim()
    .min(1, `${what}不能为空`)
    .max(max, `${what}最多 ${String(max)} 个字`);
const optional = (what: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${what}最多 ${String(max)} 个字`);

export const createPresalesTemplateSchema = z.object({
  name: text("模板名称", 80),
  description: optional("模板说明", 2000).default(""),
});
export const updatePresalesTemplateSchema = z
  .object({
    name: text("模板名称", 80).optional(),
    description: optional("模板说明", 2000).optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.description !== undefined,
    "没有要修改的字段",
  );

export const presalesStageInputSchema = z.object({
  code: text("阶段代号", 20),
  label: text("阶段名称", 80),
  question: optional("这一阶段客户在问什么", 200).default(""),
});
export const updatePresalesStageSchema = presalesStageInputSchema
  .partial()
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "没有要修改的字段",
  );

export const presalesItemInputSchema = z.object({
  name: text("材料名称", 80),
  aliases: optional("别名", 500).default(""),
  required: z.boolean().default(true),
  audience: z.enum(["external", "internal"]).default("external"),
  guide: optional("说明", 2000).default(""),
  checkpoints: optional("检查要点", 4000).default(""),
  fileHints: optional("文件线索", 500).default(""),
});
export const updatePresalesItemSchema = z
  .object({
    name: text("材料名称", 80).optional(),
    aliases: optional("别名", 500).optional(),
    required: z.boolean().optional(),
    audience: z.enum(["external", "internal"]).optional(),
    guide: optional("说明", 2000).optional(),
    checkpoints: optional("检查要点", 4000).optional(),
    fileHints: optional("文件线索", 500).optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "没有要修改的字段",
  );

/* ── 对外形状 ───────────────────────────────────────────────────────── */

export interface PresalesTemplateItem {
  id: string;
  stageId: string;
  name: string;
  /** 旧名 / 别名：补模板按名字去重时一并算上，避免重复铺材料。 */
  aliases: string[];
  required: boolean;
  audience: "external" | "internal";
  guide: string;
  checkpoints: string[];
  fileHints: string[];
}

export interface PresalesTemplateStage {
  id: string;
  code: string;
  label: string;
  question: string;
  items: PresalesTemplateItem[];
}

export interface PresalesTemplate {
  id: string;
  name: string;
  description: string;
  /** 出厂模板的标识；自建模板为 null。只决定能否「恢复出厂」，不限制编辑。 */
  builtinKey: "product" | "company" | null;
  stages: PresalesTemplateStage[];
  /** 有几本售前库在用它。删除保护与界面提示都靠它。 */
  libCount: number;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  builtin_key: string | null;
}
interface StageRow {
  id: string;
  template_id: string;
  code: string;
  label: string;
  question: string;
}
interface ItemRow {
  id: string;
  stage_id: string;
  name: string;
  aliases: string;
  required: number;
  audience: string;
  guide: string;
  checkpoints: string;
  file_hints: string;
}

export interface PresalesTemplates {
  list(): PresalesTemplate[];
  get(id: string): PresalesTemplate;
  /** 按出厂标识找模板（建库时的默认值）。被删了返回 undefined。 */
  byBuiltinKey(key: "product" | "company"): PresalesTemplate | undefined;
  create(input: z.input<typeof createPresalesTemplateSchema>): PresalesTemplate;
  update(
    id: string,
    input: z.input<typeof updatePresalesTemplateSchema>,
  ): PresalesTemplate;
  remove(id: string): void;
  duplicate(id: string): PresalesTemplate;
  reset(id: string): PresalesTemplate;
  addStage(
    templateId: string,
    input: z.input<typeof presalesStageInputSchema>,
  ): PresalesTemplate;
  updateStage(
    id: string,
    input: z.input<typeof updatePresalesStageSchema>,
  ): PresalesTemplate;
  removeStage(id: string): PresalesTemplate;
  moveStage(id: string, delta: -1 | 1): PresalesTemplate;
  addItem(
    stageId: string,
    input: z.input<typeof presalesItemInputSchema>,
  ): PresalesTemplate;
  updateItem(
    id: string,
    input: z.input<typeof updatePresalesItemSchema>,
  ): PresalesTemplate;
  removeItem(id: string): PresalesTemplate;
  /** 出厂模板缺哪个就补哪个。按 builtin_key 判，删光了也会补回来。 */
  seedBuiltins(): void;
}

export function createPresalesTemplates(
  db: Db,
  now: () => number = Date.now,
): PresalesTemplates {
  const templateRow = (id: string): TemplateRow => {
    const row = db
      .prepare<[string], TemplateRow>(
        "SELECT * FROM presales_templates WHERE id = ?",
      )
      .get(id);
    if (!row) throw notFound("售前模板不存在");
    return row;
  };
  const stageRow = (id: string): StageRow => {
    const row = db
      .prepare<[string], StageRow>(
        "SELECT * FROM presales_template_stages WHERE id = ?",
      )
      .get(id);
    if (!row) throw notFound("阶段不存在");
    return row;
  };
  const itemRow = (id: string): ItemRow => {
    const row = db
      .prepare<[string], ItemRow>(
        "SELECT * FROM presales_template_items WHERE id = ?",
      )
      .get(id);
    if (!row) throw notFound("材料不存在");
    return row;
  };

  const toItem = (r: ItemRow): PresalesTemplateItem => ({
    id: r.id,
    stageId: r.stage_id,
    name: r.name,
    aliases: splitLines(r.aliases),
    required: r.required === 1,
    audience: r.audience === "internal" ? "internal" : "external",
    guide: r.guide,
    checkpoints: splitLines(r.checkpoints),
    fileHints: splitLines(r.file_hints),
  });
  const toStage = (r: StageRow): PresalesTemplateStage => ({
    id: r.id,
    code: r.code,
    label: r.label,
    question: r.question,
    items: db
      .prepare<[string], ItemRow>(
        "SELECT * FROM presales_template_items WHERE stage_id = ? ORDER BY sort_order, rowid",
      )
      .all(r.id)
      .map(toItem),
  });
  const toTemplate = (r: TemplateRow): PresalesTemplate => ({
    id: r.id,
    name: r.name,
    description: r.description,
    builtinKey:
      r.builtin_key === "product" || r.builtin_key === "company"
        ? r.builtin_key
        : null,
    stages: db
      .prepare<[string], StageRow>(
        "SELECT * FROM presales_template_stages WHERE template_id = ? ORDER BY sort_order, rowid",
      )
      .all(r.id)
      .map(toStage),
    libCount:
      db
        .prepare<[string], { n: number }>(
          "SELECT COUNT(*) AS n FROM presales_libs WHERE template_id = ?",
        )
        .get(r.id)?.n ?? 0,
  });
  const read = (id: string): PresalesTemplate => toTemplate(templateRow(id));

  const nextOrder = (table: string, where = "", arg?: string): number =>
    (arg === undefined
      ? db
          .prepare<[], { n: number }>(
            `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM ${table}`,
          )
          .get()
      : db
          .prepare<[string], { n: number }>(
            `SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM ${table} WHERE ${where} = ?`,
          )
          .get(arg)
    )?.n ?? 1;

  const insertStages = (
    templateId: string,
    stages: readonly BuiltinPresalesStage[] | readonly PresalesTemplateStage[],
  ): void => {
    const t = now();
    stages.forEach((stage, si) => {
      const stageId = randomUUID();
      db.prepare(
        "INSERT INTO presales_template_stages (id, template_id, code, label, question, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        stageId,
        templateId,
        stage.code,
        stage.label,
        stage.question,
        si + 1,
        t,
        t,
      );
      stage.items.forEach((item, ii) => {
        db.prepare(
          `INSERT INTO presales_template_items
             (id, stage_id, name, aliases, required, audience, guide, checkpoints, file_hints, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          stageId,
          item.name,
          ("aliases" in item ? (item.aliases ?? []) : []).join("\n"),
          item.required ? 1 : 0,
          item.audience,
          item.guide,
          item.checkpoints.join("\n"),
          item.fileHints.join("\n"),
          ii + 1,
          t,
          t,
        );
      });
    });
  };

  const touch = (templateId: string): void => {
    db.prepare("UPDATE presales_templates SET updated_at = ? WHERE id = ?").run(
      now(),
      templateId,
    );
  };

  const api: PresalesTemplates = {
    list() {
      return db
        .prepare<[], TemplateRow>(
          "SELECT * FROM presales_templates ORDER BY sort_order, rowid",
        )
        .all()
        .map(toTemplate);
    },

    get: read,

    byBuiltinKey(key) {
      const row = db
        .prepare<[string], TemplateRow>(
          "SELECT * FROM presales_templates WHERE builtin_key = ? ORDER BY sort_order LIMIT 1",
        )
        .get(key);
      return row === undefined ? undefined : toTemplate(row);
    },

    create(input) {
      const parsed = createPresalesTemplateSchema.parse(input);
      const id = randomUUID();
      const t = now();
      translateUnique(`已有同名模板「${parsed.name}」`, () => {
        db.prepare(
          "INSERT INTO presales_templates (id, name, description, builtin_key, sort_order, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        ).run(
          id,
          parsed.name,
          parsed.description,
          nextOrder("presales_templates"),
          t,
          t,
        );
      });
      return read(id);
    },

    update(id, input) {
      const row = templateRow(id);
      const parsed = updatePresalesTemplateSchema.parse(input);
      translateUnique(`已有同名模板「${parsed.name ?? ""}」`, () => {
        db.prepare(
          "UPDATE presales_templates SET name = ?, description = ?, updated_at = ? WHERE id = ?",
        ).run(
          parsed.name ?? row.name,
          parsed.description ?? row.description,
          now(),
          id,
        );
      });
      return read(id);
    },

    remove(id) {
      templateRow(id);
      // 在用的模板也允许删：库的 template_id 会被置空，库与它的材料不受影响。
      db.prepare("DELETE FROM presales_templates WHERE id = ?").run(id);
    },

    duplicate(id) {
      const source = read(id);
      let name = `${source.name} 副本`;
      for (let n = 2; ; n += 1) {
        const taken = db
          .prepare<[string], { id: string }>(
            "SELECT id FROM presales_templates WHERE name = ? COLLATE NOCASE",
          )
          .get(name);
        if (taken === undefined) break;
        name = `${source.name} 副本 ${String(n)}`;
      }
      const copyId = randomUUID();
      const t = now();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO presales_templates (id, name, description, builtin_key, sort_order, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)",
        ).run(
          copyId,
          name,
          source.description,
          nextOrder("presales_templates"),
          t,
          t,
        );
        insertStages(copyId, source.stages);
      })();
      return read(copyId);
    },

    reset(id) {
      const row = templateRow(id);
      const seed = BUILTIN_PRESALES_TEMPLATES.find(
        (tpl) => tpl.key === row.builtin_key,
      );
      if (seed === undefined) throw badRequest("只有出厂模板能恢复出厂内容");
      db.transaction(() => {
        db.prepare(
          "DELETE FROM presales_template_stages WHERE template_id = ?",
        ).run(id);
        db.prepare(
          "UPDATE presales_templates SET description = ?, updated_at = ? WHERE id = ?",
        ).run(seed.description, now(), id);
        insertStages(id, seed.stages);
      })();
      return read(id);
    },

    addStage(templateId, input) {
      templateRow(templateId);
      const parsed = presalesStageInputSchema.parse(input);
      const t = now();
      translateUnique(`这个模板里已有阶段「${parsed.code}」`, () => {
        db.prepare(
          "INSERT INTO presales_template_stages (id, template_id, code, label, question, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          randomUUID(),
          templateId,
          parsed.code,
          parsed.label,
          parsed.question,
          nextOrder("presales_template_stages", "template_id", templateId),
          t,
          t,
        );
      });
      touch(templateId);
      return read(templateId);
    },

    updateStage(id, input) {
      const row = stageRow(id);
      const parsed = updatePresalesStageSchema.parse(input);
      translateUnique(`这个模板里已有阶段「${parsed.code ?? ""}」`, () => {
        db.prepare(
          "UPDATE presales_template_stages SET code = ?, label = ?, question = ?, updated_at = ? WHERE id = ?",
        ).run(
          parsed.code ?? row.code,
          parsed.label ?? row.label,
          parsed.question ?? row.question,
          now(),
          id,
        );
      });
      touch(row.template_id);
      return read(row.template_id);
    },

    removeStage(id) {
      const row = stageRow(id);
      db.prepare("DELETE FROM presales_template_stages WHERE id = ?").run(id);
      touch(row.template_id);
      return read(row.template_id);
    },

    moveStage(id, delta) {
      const row = stageRow(id);
      const siblings = db
        .prepare<[string], { id: string }>(
          "SELECT id FROM presales_template_stages WHERE template_id = ? ORDER BY sort_order, rowid",
        )
        .all(row.template_id)
        .map((r) => r.id);
      const from = siblings.indexOf(id);
      const to = from + delta;
      if (to >= 0 && to < siblings.length) {
        [siblings[from], siblings[to]] = [
          siblings[to] ?? id,
          siblings[from] ?? id,
        ];
        db.transaction(() => {
          siblings.forEach((sid, i) => {
            db.prepare(
              "UPDATE presales_template_stages SET sort_order = ? WHERE id = ?",
            ).run(i + 1, sid);
          });
        })();
        touch(row.template_id);
      }
      return read(row.template_id);
    },

    addItem(stageId, input) {
      const stage = stageRow(stageId);
      const parsed = presalesItemInputSchema.parse(input);
      const t = now();
      translateUnique(`这个阶段下已有材料「${parsed.name}」`, () => {
        db.prepare(
          `INSERT INTO presales_template_items
             (id, stage_id, name, aliases, required, audience, guide, checkpoints, file_hints, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          randomUUID(),
          stageId,
          parsed.name,
          normalizeLines(parsed.aliases),
          parsed.required ? 1 : 0,
          parsed.audience,
          parsed.guide,
          normalizeLines(parsed.checkpoints),
          normalizeLines(parsed.fileHints),
          nextOrder("presales_template_items", "stage_id", stageId),
          t,
          t,
        );
      });
      touch(stage.template_id);
      return read(stage.template_id);
    },

    updateItem(id, input) {
      const row = itemRow(id);
      const stage = stageRow(row.stage_id);
      const parsed = updatePresalesItemSchema.parse(input);
      translateUnique(`这个阶段下已有材料「${parsed.name ?? ""}」`, () => {
        db.prepare(
          `UPDATE presales_template_items
              SET name = ?, aliases = ?, required = ?, audience = ?, guide = ?, checkpoints = ?, file_hints = ?, updated_at = ?
            WHERE id = ?`,
        ).run(
          parsed.name ?? row.name,
          parsed.aliases === undefined
            ? row.aliases
            : normalizeLines(parsed.aliases),
          parsed.required === undefined
            ? row.required
            : parsed.required
              ? 1
              : 0,
          parsed.audience ?? row.audience,
          parsed.guide ?? row.guide,
          parsed.checkpoints === undefined
            ? row.checkpoints
            : normalizeLines(parsed.checkpoints),
          parsed.fileHints === undefined
            ? row.file_hints
            : normalizeLines(parsed.fileHints),
          now(),
          id,
        );
      });
      touch(stage.template_id);
      return read(stage.template_id);
    },

    removeItem(id) {
      const row = itemRow(id);
      const stage = stageRow(row.stage_id);
      db.prepare("DELETE FROM presales_template_items WHERE id = ?").run(id);
      touch(stage.template_id);
      return read(stage.template_id);
    },

    seedBuiltins() {
      for (const seed of BUILTIN_PRESALES_TEMPLATES) {
        const exists = db
          .prepare<[string], { id: string }>(
            "SELECT id FROM presales_templates WHERE builtin_key = ?",
          )
          .get(seed.key);
        if (exists !== undefined) {
          // 已播种过的：只补别名，不动用户改过的名字 / 说明 / 条目。
          // 别名是「补模板去重」的依据，早先播种的模板里没有它，
          // 不补的话老库一补模板就会多出重复材料。
          const fill = db.prepare(
            "UPDATE presales_template_items SET aliases = ? WHERE stage_id IN (SELECT id FROM presales_template_stages WHERE template_id = ?) AND name = ? AND aliases = ''",
          );
          for (const stage of seed.stages) {
            for (const item of stage.items) {
              const aliases = (item.aliases ?? []).join("\n");
              if (aliases !== "") fill.run(aliases, exists.id, item.name);
            }
          }
          continue;
        }
        const id = randomUUID();
        const t = now();
        // 名字撞了（用户自己建过同名模板）就加后缀，不让播种失败。
        let name = seed.name;
        for (let n = 2; ; n += 1) {
          const taken = db
            .prepare<[string], { id: string }>(
              "SELECT id FROM presales_templates WHERE name = ? COLLATE NOCASE",
            )
            .get(name);
          if (taken === undefined) break;
          name = `${seed.name}（出厂 ${String(n)}）`;
        }
        db.transaction(() => {
          db.prepare(
            "INSERT INTO presales_templates (id, name, description, builtin_key, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(
            id,
            name,
            seed.description,
            seed.key,
            nextOrder("presales_templates"),
            t,
            t,
          );
          insertStages(id, seed.stages);
        })();
      }
    },
  };
  return api;
}
