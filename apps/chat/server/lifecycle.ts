import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Db } from "./db.js";
import { conflict, notFound } from "./errors.js";
import { BUILTIN_TEMPLATE, type BuiltinTemplate } from "./lifecycle-builtin.js";
import { normalizeLines, splitLines, translateUnique } from "./sql-util.js";

/**
 * 生命周期规范（产品菜单下的二级页）：模板库的仓储。
 *
 * 一个模板 = 一套「这类产品从 0 到 1 该走哪些阶段、每个阶段该交什么」。
 * 三层 模板 → 阶段 → 产出物，层级由外键保证，与 products.ts 同一个口径：
 * 不做通用树，不靠应用层守「产出物只能挂在阶段下」。
 *
 * 读是整树读（一个模板连阶段带产出物一次返回）：模板规模是十几个阶段、
 * 二十来个产出物，分着读只会让前端拼装逻辑变复杂。
 */

/* ── 输入校验 ───────────────────────────────────────────────────────── */

const trimmed = (what: string, max: number) =>
  z
    .string({ error: `${what}必填` })
    .trim()
    .min(1, `${what}不能为空`)
    .max(max, `${what}最多 ${String(max)} 个字`);

const optionalText = (what: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${what}最多 ${String(max)} 个字`);

export const createTemplateSchema = z.object({
  name: trimmed("模板名称", 80),
  description: optionalText("模板说明", 2000).default(""),
});
export const updateTemplateSchema = z
  .object({
    name: trimmed("模板名称", 80).optional(),
    description: optionalText("模板说明", 2000).optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.description !== undefined,
    "没有要修改的字段",
  );

export const createStageSchema = z.object({
  code: trimmed("阶段代号", 20),
  label: trimmed("阶段名称", 80),
  question: optionalText("这一阶段回答的问题", 200).default(""),
});
export const updateStageSchema = z
  .object({
    code: trimmed("阶段代号", 20).optional(),
    label: trimmed("阶段名称", 80).optional(),
    question: optionalText("这一阶段回答的问题", 200).optional(),
  })
  .refine(
    (v) =>
      v.code !== undefined || v.label !== undefined || v.question !== undefined,
    "没有要修改的字段",
  );

const artifactFields = {
  name: trimmed("产出物名称", 80),
  required: z.boolean(),
  guide: optionalText("写作指引", 2000),
  checkpoints: optionalText("判定要点", 4000),
  fileHints: optionalText("文件线索", 500),
};

export const createArtifactSchema = z.object({
  ...artifactFields,
  required: artifactFields.required.default(true),
  guide: artifactFields.guide.default(""),
  checkpoints: artifactFields.checkpoints.default(""),
  fileHints: artifactFields.fileHints.default(""),
});
export const updateArtifactSchema = z
  .object({
    name: artifactFields.name.optional(),
    required: artifactFields.required.optional(),
    guide: artifactFields.guide.optional(),
    checkpoints: artifactFields.checkpoints.optional(),
    fileHints: artifactFields.fileHints.optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "没有要修改的字段",
  );

/* ── 对外形状 ───────────────────────────────────────────────────────── */

export interface Artifact {
  id: string;
  stageId: string;
  name: string;
  required: boolean;
  guide: string;
  /** 判定要点：AI 比对时逐条核的清单。 */
  checkpoints: string[];
  /** 文件线索：文件名 / 路径关键词，用来先缩小扫描面。 */
  fileHints: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Stage {
  id: string;
  templateId: string;
  code: string;
  label: string;
  question: string;
  createdAt: number;
  updatedAt: number;
  artifacts: Artifact[];
}

export interface Template {
  id: string;
  name: string;
  description: string;
  /** 出厂模板：只决定能否「恢复出厂内容」，不限制编辑。 */
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
  stages: Stage[];
  /** 有多少个产品绑了它。删除保护与界面提示都用它。 */
  productCount: number;
}

interface TemplateRow {
  id: string;
  name: string;
  description: string;
  builtin: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
}
interface StageRow {
  id: string;
  template_id: string;
  code: string;
  label: string;
  question: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}
interface ArtifactRow {
  id: string;
  stage_id: string;
  name: string;
  required: number;
  guide: string;
  checkpoints: string;
  file_hints: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

export interface Lifecycle {
  list(): Template[];
  get(id: string): Template;
  createTemplate(input: z.input<typeof createTemplateSchema>): Template;
  updateTemplate(
    id: string,
    input: z.input<typeof updateTemplateSchema>,
  ): Template;
  deleteTemplate(id: string): void;
  /** 复制成一个新模板（名字后缀「副本」，撞名时递增）。 */
  duplicateTemplate(id: string): Template;
  /** 把出厂模板的层与产出物整体换回出厂内容；非出厂模板拒绝。 */
  resetTemplate(id: string): Template;

  createStage(
    templateId: string,
    input: z.input<typeof createStageSchema>,
  ): Template;
  updateStage(id: string, input: z.input<typeof updateStageSchema>): Template;
  deleteStage(id: string): Template;
  /** 上移 / 下移一个阶段。拖拽排序未做，先给可用的最小操作。 */
  moveStage(id: string, delta: -1 | 1): Template;

  createArtifact(
    stageId: string,
    input: z.input<typeof createArtifactSchema>,
  ): Template;
  updateArtifact(
    id: string,
    input: z.input<typeof updateArtifactSchema>,
  ): Template;
  deleteArtifact(id: string): Template;

  /** 库里一条模板都没有时灌出厂模板。只认「整库为空」，删光了就不再自己长回来。 */
  seedIfEmpty(): void;
}

export function createLifecycle(
  db: Db,
  now: () => number = Date.now,
): Lifecycle {
  /* ── 读 ── */

  const templateRow = (id: string): TemplateRow => {
    const row = db
      .prepare<[string], TemplateRow>(
        "SELECT * FROM lifecycle_templates WHERE id = ?",
      )
      .get(id);
    if (!row) throw notFound("模板不存在");
    return row;
  };
  const stageRow = (id: string): StageRow => {
    const row = db
      .prepare<[string], StageRow>(
        "SELECT * FROM lifecycle_stages WHERE id = ?",
      )
      .get(id);
    if (!row) throw notFound("阶段不存在");
    return row;
  };
  const artifactRow = (id: string): ArtifactRow => {
    const row = db
      .prepare<[string], ArtifactRow>(
        "SELECT * FROM lifecycle_artifacts WHERE id = ?",
      )
      .get(id);
    if (!row) throw notFound("产出物不存在");
    return row;
  };

  const toArtifact = (r: ArtifactRow): Artifact => ({
    id: r.id,
    stageId: r.stage_id,
    name: r.name,
    required: r.required === 1,
    guide: r.guide,
    checkpoints: splitLines(r.checkpoints),
    fileHints: splitLines(r.file_hints),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });
  const toStage = (r: StageRow): Stage => ({
    id: r.id,
    templateId: r.template_id,
    code: r.code,
    label: r.label,
    question: r.question,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    artifacts: db
      .prepare<[string], ArtifactRow>(
        "SELECT * FROM lifecycle_artifacts WHERE stage_id = ? ORDER BY sort_order, created_at",
      )
      .all(r.id)
      .map(toArtifact),
  });
  const countProducts = (templateId: string): number =>
    db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM products WHERE template_id = ?",
      )
      .get(templateId)?.n ?? 0;
  const toTemplate = (r: TemplateRow): Template => ({
    id: r.id,
    name: r.name,
    description: r.description,
    builtin: r.builtin === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    stages: db
      .prepare<[string], StageRow>(
        "SELECT * FROM lifecycle_stages WHERE template_id = ? ORDER BY sort_order, created_at",
      )
      .all(r.id)
      .map(toStage),
    productCount: countProducts(r.id),
  });

  const read = (id: string): Template => toTemplate(templateRow(id));

  /* ── 排序号 ── */

  const nextTemplateOrder = (): number =>
    db
      .prepare<[], { n: number }>(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM lifecycle_templates",
      )
      .get()?.n ?? 1;
  const nextStageOrder = (templateId: string): number =>
    db
      .prepare<[string], { n: number }>(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM lifecycle_stages WHERE template_id = ?",
      )
      .get(templateId)?.n ?? 1;
  const nextArtifactOrder = (stageId: string): number =>
    db
      .prepare<[string], { n: number }>(
        "SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM lifecycle_artifacts WHERE stage_id = ?",
      )
      .get(stageId)?.n ?? 1;

  const nameClash = (n: string) => `已有同名模板「${n}」`;
  const codeClash = (c: string) => `这个模板里已有阶段「${c}」`;
  const artifactClash = (n: string) => `这个阶段下已有产出物「${n}」`;

  /* ── 写入整棵模板（播种 / 复制 / 恢复出厂共用） ── */

  const insertStages = (
    templateId: string,
    stages: BuiltinTemplate["stages"],
  ): void => {
    const t = now();
    stages.forEach((stage, si) => {
      const stageId = randomUUID();
      db.prepare(
        "INSERT INTO lifecycle_stages (id, template_id, code, label, question, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
      stage.artifacts.forEach((a, ai) => {
        db.prepare(
          "INSERT INTO lifecycle_artifacts (id, stage_id, name, required, guide, checkpoints, file_hints, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ).run(
          randomUUID(),
          stageId,
          a.name,
          a.required ? 1 : 0,
          a.guide,
          a.checkpoints.join("\n"),
          a.fileHints.join("\n"),
          ai + 1,
          t,
          t,
        );
      });
    });
  };

  /** 「副本」「副本 2」「副本 3」……直到不撞名。 */
  const freeName = (base: string): string => {
    const taken = (n: string): boolean =>
      db
        .prepare<[string], { id: string }>(
          "SELECT id FROM lifecycle_templates WHERE name = ? COLLATE NOCASE",
        )
        .get(n) !== undefined;
    if (!taken(base)) return base;
    for (let i = 2; i < 100; i += 1) {
      const candidate = `${base} ${String(i)}`;
      if (!taken(candidate)) return candidate;
    }
    throw conflict("同名模板太多了，先改个名字");
  };

  return {
    list: () =>
      db
        .prepare<[], TemplateRow>(
          "SELECT * FROM lifecycle_templates ORDER BY sort_order, created_at",
        )
        .all()
        .map(toTemplate),

    get: read,

    createTemplate(input) {
      const v = createTemplateSchema.parse(input);
      const id = randomUUID();
      const t = now();
      translateUnique(nameClash(v.name), () =>
        db
          .prepare(
            "INSERT INTO lifecycle_templates (id, name, description, builtin, sort_order, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
          )
          .run(id, v.name, v.description, nextTemplateOrder(), t, t),
      );
      return read(id);
    },

    updateTemplate(id, input) {
      const v = updateTemplateSchema.parse(input);
      const row = templateRow(id);
      const next = {
        name: v.name ?? row.name,
        description: v.description ?? row.description,
      };
      translateUnique(nameClash(next.name), () =>
        db
          .prepare(
            "UPDATE lifecycle_templates SET name = ?, description = ?, updated_at = ? WHERE id = ?",
          )
          .run(next.name, next.description, now(), id),
      );
      return read(id);
    },

    deleteTemplate(id) {
      const row = templateRow(id);
      const count = countProducts(id);
      if (count > 0)
        throw conflict(
          `还有 ${String(count)} 个产品绑着「${row.name}」，先给它们换个模板或解绑`,
        );
      // 阶段与产出物是 CASCADE：模板没了，它的层与产出物没有独立意义。
      db.prepare("DELETE FROM lifecycle_templates WHERE id = ?").run(id);
    },

    duplicateTemplate(id) {
      const source = read(id);
      const copyId = randomUUID();
      const t = now();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO lifecycle_templates (id, name, description, builtin, sort_order, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
        ).run(
          copyId,
          freeName(`${source.name} 副本`),
          source.description,
          nextTemplateOrder(),
          t,
          t,
        );
        insertStages(
          copyId,
          source.stages.map((s) => ({
            code: s.code,
            label: s.label,
            question: s.question,
            artifacts: s.artifacts.map((a) => ({
              name: a.name,
              required: a.required,
              guide: a.guide,
              checkpoints: a.checkpoints,
              fileHints: a.fileHints,
            })),
          })),
        );
      })();
      return read(copyId);
    },

    resetTemplate(id) {
      const row = templateRow(id);
      if (row.builtin !== 1)
        throw conflict(
          "只有出厂模板能恢复出厂内容；自建模板没有「出厂」这个状态",
        );
      db.transaction(() => {
        // 阶段 CASCADE 带走产出物，再按出厂内容整体重建。
        db.prepare("DELETE FROM lifecycle_stages WHERE template_id = ?").run(
          id,
        );
        db.prepare(
          "UPDATE lifecycle_templates SET name = ?, description = ?, updated_at = ? WHERE id = ?",
        ).run(BUILTIN_TEMPLATE.name, BUILTIN_TEMPLATE.description, now(), id);
        insertStages(id, BUILTIN_TEMPLATE.stages);
      })();
      return read(id);
    },

    createStage(templateId, input) {
      const v = createStageSchema.parse(input);
      templateRow(templateId);
      const t = now();
      translateUnique(codeClash(v.code), () =>
        db
          .prepare(
            "INSERT INTO lifecycle_stages (id, template_id, code, label, question, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            randomUUID(),
            templateId,
            v.code,
            v.label,
            v.question,
            nextStageOrder(templateId),
            t,
            t,
          ),
      );
      return read(templateId);
    },

    updateStage(id, input) {
      const v = updateStageSchema.parse(input);
      const row = stageRow(id);
      const next = {
        code: v.code ?? row.code,
        label: v.label ?? row.label,
        question: v.question ?? row.question,
      };
      translateUnique(codeClash(next.code), () =>
        db
          .prepare(
            "UPDATE lifecycle_stages SET code = ?, label = ?, question = ?, updated_at = ? WHERE id = ?",
          )
          .run(next.code, next.label, next.question, now(), id),
      );
      return read(row.template_id);
    },

    deleteStage(id) {
      const row = stageRow(id);
      db.prepare("DELETE FROM lifecycle_stages WHERE id = ?").run(id);
      return read(row.template_id);
    },

    moveStage(id, delta) {
      const row = stageRow(id);
      const siblings = db
        .prepare<[string], StageRow>(
          "SELECT * FROM lifecycle_stages WHERE template_id = ? ORDER BY sort_order, created_at",
        )
        .all(row.template_id);
      const at = siblings.findIndex((s) => s.id === id);
      const to = at + delta;
      if (at < 0 || to < 0 || to >= siblings.length)
        return read(row.template_id);
      // 整段重排而不是交换两个 sort_order：历史数据里 sort_order 可能有并列，
      // 交换法在并列时会原地打转。
      const reordered = [...siblings];
      const [moved] = reordered.splice(at, 1);
      if (moved) reordered.splice(to, 0, moved);
      const t = now();
      db.transaction(() => {
        reordered.forEach((s, i) => {
          db.prepare(
            "UPDATE lifecycle_stages SET sort_order = ?, updated_at = ? WHERE id = ?",
          ).run(i + 1, t, s.id);
        });
      })();
      return read(row.template_id);
    },

    createArtifact(stageId, input) {
      const v = createArtifactSchema.parse(input);
      const stage = stageRow(stageId);
      const t = now();
      translateUnique(artifactClash(v.name), () =>
        db
          .prepare(
            "INSERT INTO lifecycle_artifacts (id, stage_id, name, required, guide, checkpoints, file_hints, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            randomUUID(),
            stageId,
            v.name,
            v.required ? 1 : 0,
            v.guide,
            normalizeLines(v.checkpoints),
            normalizeLines(v.fileHints),
            nextArtifactOrder(stageId),
            t,
            t,
          ),
      );
      return read(stage.template_id);
    },

    updateArtifact(id, input) {
      const v = updateArtifactSchema.parse(input);
      const row = artifactRow(id);
      const stage = stageRow(row.stage_id);
      const next = {
        name: v.name ?? row.name,
        required: v.required ?? row.required === 1,
        guide: v.guide ?? row.guide,
        checkpoints:
          v.checkpoints === undefined
            ? row.checkpoints
            : normalizeLines(v.checkpoints),
        fileHints:
          v.fileHints === undefined
            ? row.file_hints
            : normalizeLines(v.fileHints),
      };
      translateUnique(artifactClash(next.name), () =>
        db
          .prepare(
            "UPDATE lifecycle_artifacts SET name = ?, required = ?, guide = ?, checkpoints = ?, file_hints = ?, updated_at = ? WHERE id = ?",
          )
          .run(
            next.name,
            next.required ? 1 : 0,
            next.guide,
            next.checkpoints,
            next.fileHints,
            now(),
            id,
          ),
      );
      return read(stage.template_id);
    },

    deleteArtifact(id) {
      const row = artifactRow(id);
      const stage = stageRow(row.stage_id);
      db.prepare("DELETE FROM lifecycle_artifacts WHERE id = ?").run(id);
      return read(stage.template_id);
    },

    seedIfEmpty() {
      const existing =
        db
          .prepare<[], { n: number }>(
            "SELECT COUNT(*) AS n FROM lifecycle_templates",
          )
          .get()?.n ?? 0;
      if (existing > 0) return;
      const id = randomUUID();
      const t = now();
      db.transaction(() => {
        db.prepare(
          "INSERT INTO lifecycle_templates (id, name, description, builtin, sort_order, created_at, updated_at) VALUES (?, ?, ?, 1, 1, ?, ?)",
        ).run(id, BUILTIN_TEMPLATE.name, BUILTIN_TEMPLATE.description, t, t);
        insertStages(id, BUILTIN_TEMPLATE.stages);
      })();
    },
  };
}
