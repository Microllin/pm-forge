import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Db } from "./db.js";
import type {
  PresalesTemplateItem,
  PresalesTemplates,
} from "./presales-templates.js";
import { splitLines } from "./sql-util.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { translateUnique } from "./sql-util.js";

/**
 * 售前材料库（一级菜单「售前」）。
 *
 * 三层：库 → 材料槽位 → 版本。
 * - **槽位**是「这个产品应该有一份什么材料」，由体系模板一次铺好；
 * - **版本**是「实际做出了几版」，每版可挂一个文件；
 * - 没有现行版的槽位就是**缺口**。
 *
 * 为什么槽位要单独一张表：`同一产品同一材料只能有一份现行版` 这条规矩靠
 * 应用层每次查一遍很容易在并发或漏改时破掉。落成部分唯一索引
 * （每个槽位最多一条 status='current'）之后，库层面就发不出错版本。
 */

/* ── 阶段与状态 ─────────────────────────────────────────────────────── */

export const STAGES = [
  "contact",
  "discovery",
  "proposal",
  "handover",
  "internal",
] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABEL: Record<Stage, string> = {
  contact: "初步接触",
  discovery: "需求摸底",
  proposal: "方案与报价",
  handover: "移交交付",
  internal: "参考底稿（对内）",
};

/**
 * 四态 + 唯一现行版：
 *   draft 草稿 → review 待核（写完待过合规）→ current 可对外 / archived 已归档。
 * 「可对外」与「对内」是两件正交的事：对内材料也可以有现行版。
 */
export const STATUSES = ["draft", "review", "current", "archived"] as const;
export type VersionStatus = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<VersionStatus, string> = {
  draft: "草稿",
  review: "待核",
  current: "可对外",
  archived: "已归档",
};

/* ── 模板 ────────────────────────────────────────────────────────────
 *
 * 材料清单由「售前模板」决定（见 presales-templates.ts）。这里只做「模板条目 →
 * 槽位」的投影：建库与补齐模板都走它。模板删了，库与它的材料照旧，只是没有来源可补。
 */

/* ── 输入校验 ───────────────────────────────────────────────────────── */

/**
 * 阶段代号来自库绑的售前模板（S1–S5 或自定义），不再是固定枚举。
 * 原来这里还卡着迁移 12 之前的 contact / discovery…，界面发来的 S1 一律 400，
 * 「新增材料」和改阶段都用不了。
 */
const stageField = z
  .string()
  .trim()
  .min(1, "阶段不能为空")
  .max(20, "阶段代号最多 20 个字");
const statusField = z.enum(STATUSES);
const audienceField = z.enum(["external", "internal"]);

export const createLibSchema = z.object({
  /** 绑定的产品（产品模块里的 products.id）。省略 / 空串 = 建公司级库。 */
  productId: z.string().trim().optional(),
  name: z.string().trim().max(120, "库名最多 120 个字").optional(),
  summary: z.string().trim().max(2000, "说明最多 2000 个字").optional(),
  /** 用哪个售前模板铺材料；省略 = 产品库用「标准售前模板」、公司级库用「公司级材料」。 */
  templateId: z.string().trim().optional(),
});

export const updateLibSchema = z
  .object({
    name: z.string().trim().min(1, "库名不能为空").max(120).optional(),
    summary: z.string().trim().max(2000).optional(),
    status: z.enum(["active", "retired"]).optional(),
  })
  .refine(
    (v) =>
      v.name !== undefined || v.summary !== undefined || v.status !== undefined,
    "没有要修改的字段",
  );

export const createSlotSchema = z.object({
  title: z.string().trim().min(1, "材料名称不能为空").max(120),
  stage: stageField,
  priority: z.boolean().optional(),
  audience: audienceField.optional(),
});

export const updateSlotSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    stage: stageField.optional(),
    priority: z.boolean().optional(),
    audience: audienceField.optional(),
    /**
     * 对应模板里的哪一项：模板条目 id；`"-"` = 明确标成「模板外」；
     * null = 交回自动（按名称 / 别名对号）。
     */
    templateItemId: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.stage !== undefined ||
      v.priority !== undefined ||
      v.audience !== undefined ||
      v.templateItemId !== undefined,
    "没有要修改的字段",
  );

/** 「模板外」的哨兵值。见迁移 15。 */
export const OUTSIDE_TEMPLATE = "-";

export const createVersionSchema = z.object({
  version: z.string().trim().min(1, "版本号必填").max(40),
  status: statusField.optional(),
  releasedAt: z.string().trim().max(40).optional(),
  note: z.string().trim().max(2000).optional(),
  /** 上传到文件库之后的路径。先建版本再传文件，两步走——上传走原始字节流。 */
  filePath: z.string().trim().max(1000).optional(),
  fileName: z.string().trim().max(255).optional(),
  fileSize: z.number().int().min(0).optional(),
});

export const updateVersionSchema = z
  .object({
    version: z.string().trim().min(1).max(40).optional(),
    releasedAt: z.string().trim().max(40).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .refine(
    (v) =>
      v.version !== undefined ||
      v.releasedAt !== undefined ||
      v.note !== undefined,
    "没有要修改的字段",
  );

/* ── 对外形状 ───────────────────────────────────────────────────────── */

export interface PresalesVersion {
  id: string;
  slotId: string;
  /** 所属库。上传文件时要拼路径，单独查一次不如带上。 */
  libId: string;
  version: string;
  status: VersionStatus;
  releasedAt: string | null;
  note: string;
  filePath: string | null;
  fileName: string | null;
  fileSize: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PresalesSlot {
  id: string;
  libId: string;
  itemKey: string;
  stage: Stage;
  title: string;
  priority: boolean;
  audience: "external" | "internal";
  /**
   * 说明与检查要点。对上了模板条目就**实时取模板的**（改模板 = 改审阅标准）；
   * 没对上的用条目自己留的那份。
   */
  guide: string;
  checkpoints: string[];
  fileHints: string[];
  /**
   * 和模板的关系：
   * - linked    对上了模板里的一项（templateItem 有值）；
   * - outside   人明确标成模板外；
   * - unmatched 库绑了模板，但按名称 / 别名对不上；
   * - none      库没绑模板，无从谈起。
   */
  link: "linked" | "outside" | "unmatched" | "none";
  templateItem: TemplateItemRef | null;
  /** 新到旧。 */
  versions: PresalesVersion[];
  /** 现行版；null = 缺口。 */
  current: PresalesVersion | null;
}

export interface PresalesLib {
  id: string;
  productId: string | null;
  /** 绑定的产品还在不在（产品被删后库保留，只是标出来）。 */
  productExists: boolean;
  name: string;
  summary: string;
  status: "active" | "retired";
  /** 绑定的售前模板；null = 模板已删或建库时没选。 */
  templateId: string | null;
  templateName: string | null;
  slotCount: number;
  coveredCount: number;
  criticalGapCount: number;
  inProgressCount: number;
  createdAt: number;
  updatedAt: number;
}

/** 模板条目的精简引用（带上它在模板里属于哪个阶段）。 */
export interface TemplateItemRef {
  id: string;
  name: string;
  stageCode: string;
  stageLabel: string;
  required: boolean;
  audience: "external" | "internal";
}

export interface PresalesLibDetail {
  lib: PresalesLib;
  slots: PresalesSlot[];
  /** 模板要求、库里没有任何条目对上的材料。库没绑模板时为空。 */
  templateGaps: TemplateItemRef[];
}

interface LibRow {
  id: string;
  product_id: string | null;
  template_id: string | null;
  name: string;
  summary: string;
  status: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface SlotRow {
  id: string;
  lib_id: string;
  item_key: string;
  stage: string;
  title: string;
  priority: number;
  audience: string;
  guide: string;
  checkpoints: string;
  file_hints: string;
  template_item_id: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  id: string;
  slot_id: string;
  /** 由 JOIN 带出来的所属库。 */
  lib_id: string;
  version: string;
  status: string;
  released_at: string | null;
  note: string;
  file_path: string | null;
  file_name: string | null;
  file_size: number | null;
  created_at: number;
  updated_at: number;
}

const toVersion = (r: VersionRow): PresalesVersion => ({
  id: r.id,
  slotId: r.slot_id,
  libId: r.lib_id,
  version: r.version,
  status: r.status as VersionStatus,
  releasedAt: r.released_at,
  note: r.note,
  filePath: r.file_path,
  fileName: r.file_name,
  fileSize: r.file_size,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** 模板条目摊平后带上阶段。对号、补齐、审阅标准都用它。 */
interface FlatItem extends PresalesTemplateItem {
  stageCode: string;
  stageLabel: string;
}

const refOf = (item: FlatItem): TemplateItemRef => ({
  id: item.id,
  name: item.name,
  stageCode: item.stageCode,
  stageLabel: item.stageLabel,
  required: item.required,
  audience: item.audience,
});

interface Resolved {
  link: PresalesSlot["link"];
  item: FlatItem | null;
}

const toSlot = (
  r: SlotRow,
  versions: PresalesVersion[],
  resolved: Resolved = { link: "none", item: null },
): PresalesSlot => {
  const item = resolved.item;
  return {
    id: r.id,
    libId: r.lib_id,
    itemKey: r.item_key,
    stage: r.stage as Stage,
    title: r.title,
    priority: r.priority === 1,
    audience: r.audience as "external" | "internal",
    guide: item?.guide ?? r.guide,
    checkpoints: item?.checkpoints ?? splitLines(r.checkpoints),
    fileHints: item?.fileHints ?? splitLines(r.file_hints),
    link: resolved.link,
    templateItem: item === null ? null : refOf(item),
    versions,
    current: versions.find((v) => v.status === "current") ?? null,
  };
};

/**
 * 名称归一：大小写、空白、全角括号都不算区别。
 * 「常见问题回答（FAQ）」与「常见问题回答(FAQ)」是同一类材料。
 */
export const normalizeName = (s: string): string =>
  s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/（/g, "(")
    .replace(/）/g, ")");

/**
 * 条目对号：每个条目对上模板里的哪一项。纯函数，便于单测。
 *
 * 顺序有讲究：先认**已经写下的 id**（人手动对过的、或之前自动对上的），它们先占位；
 * 再给剩下的按名称 / 别名自动配。一项模板条目只配一个条目——同一类材料在一本库里
 * 本来就只该有一份，第二份宁可标「对不上」让人看见，也不要两份都挂在同一项下。
 */
export function resolveLinks(
  slots: readonly {
    id: string;
    title: string;
    templateItemId: string | null;
  }[],
  items: readonly FlatItem[],
): {
  byslot: Map<string, Resolved>;
  autoLinked: Map<string, string>;
  gaps: FlatItem[];
} {
  const byId = new Map(items.map((i) => [i.id, i]));
  const claimed = new Set<string>();
  const byslot = new Map<string, Resolved>();
  const autoLinked = new Map<string, string>();
  const pending: (typeof slots)[number][] = [];

  for (const s of slots) {
    if (items.length === 0) {
      byslot.set(s.id, { link: "none", item: null });
      continue;
    }
    if (s.templateItemId === OUTSIDE_TEMPLATE) {
      byslot.set(s.id, { link: "outside", item: null });
      continue;
    }
    const item =
      s.templateItemId === null ? undefined : byId.get(s.templateItemId);
    if (item !== undefined && !claimed.has(item.id)) {
      claimed.add(item.id);
      byslot.set(s.id, { link: "linked", item });
    } else pending.push(s);
  }

  for (const s of pending) {
    const key = normalizeName(s.title);
    const item = items.find(
      (i) =>
        !claimed.has(i.id) &&
        [i.name, ...i.aliases].some((n) => normalizeName(n) === key),
    );
    if (item === undefined) {
      byslot.set(s.id, { link: "unmatched", item: null });
      continue;
    }
    claimed.add(item.id);
    byslot.set(s.id, { link: "linked", item });
    if (s.templateItemId !== item.id) autoLinked.set(s.id, item.id);
  }

  return {
    byslot,
    autoLinked,
    gaps: items.filter((i) => !claimed.has(i.id)),
  };
}

/**
 * 槽位键 = 材料名。
 *
 * 以前把中文标题 ASCII 化后当键，中文标题会退化成随机的 «custom-xxxx»，
 * 既不可读也不稳定（同一条模板重建一次键就变）。库里对键只有「同一本库内唯一」
 * 这一条要求，直接存名字最直观。
 */
function slotKeyFrom(title: string): string {
  return title.trim();
}

export interface Catalog {
  list(): PresalesLib[];
  get(id: string): PresalesLibDetail | undefined;
  create(input: z.infer<typeof createLibSchema>): PresalesLibDetail;
  update(id: string, input: z.infer<typeof updateLibSchema>): PresalesLib;
  /** 换绑模板（只影响「补齐模板」的来源，不动已有材料）。 */
  setTemplate(id: string, templateId: string | null): void;
  remove(id: string): string[];
  /** 按库绑定的模板补槽位，只加不删。返回新增条数。 */
  syncTemplate(id: string): number;
  addSlot(libId: string, input: z.infer<typeof createSlotSchema>): PresalesSlot;
  updateSlot(id: string, input: z.infer<typeof updateSlotSchema>): void;
  /**
   * 删材料条目。返回这个条目下所有版本的文件路径，交给调用方删盘——
   * 版本行由外键级联删，文件不在数据库里，不删就永远留在盘上。
   */
  removeSlot(id: string): string[];
  addVersion(
    slotId: string,
    input: z.infer<typeof createVersionSchema>,
  ): PresalesVersion;
  updateVersion(id: string, input: z.infer<typeof updateVersionSchema>): void;
  setVersionStatus(id: string, status: VersionStatus): void;
  removeVersion(id: string): PresalesVersion;
  versionOf(id: string): PresalesVersion | undefined;
  /** 单个槽位（含版本与模板对号）。上传 / 删文件、AI 审阅都要知道它属于哪本库、当前是哪一版。 */
  slotOf(id: string): PresalesSlot | undefined;
  /** 上传完文件后把路径 / 名字 / 大小写回版本。 */
  attachFile(
    versionId: string,
    file: { path: string; name: string; size: number },
  ): PresalesVersion;
}

export function createCatalog(
  db: Db,
  now: () => number = Date.now,
  templates?: PresalesTemplates,
): Catalog {
  const libRow = (id: string): LibRow | undefined =>
    db
      .prepare<[string], LibRow>("SELECT * FROM presales_libs WHERE id = ?")
      .get(id);

  const slotRow = (id: string): SlotRow | undefined =>
    db
      .prepare<[string], SlotRow>("SELECT * FROM presales_slots WHERE id = ?")
      .get(id);

  /** 版本行连同它的库 id 一起取：上传 / 下载文件要按库分目录。 */
  const versionRow = (id: string): VersionRow | undefined =>
    db
      .prepare<[string], VersionRow>(
        `SELECT v.*, s.lib_id
           FROM presales_versions v
           JOIN presales_slots s ON s.id = v.slot_id
          WHERE v.id = ?`,
      )
      .get(id);

  const versionsOf = (slotId: string): PresalesVersion[] =>
    db
      .prepare<[string], VersionRow>(
        `SELECT v.*, s.lib_id
           FROM presales_versions v
           JOIN presales_slots s ON s.id = v.slot_id
          WHERE v.slot_id = ?
          ORDER BY v.created_at DESC, v.rowid DESC`,
      )
      .all(slotId)
      .map(toVersion);

  const slotRowsOf = (libId: string): SlotRow[] =>
    db
      .prepare<[string], SlotRow>(
        "SELECT * FROM presales_slots WHERE lib_id = ? ORDER BY sort_order, rowid",
      )
      .all(libId);

  /** 库绑的模板摊平成条目；模板没了（或没绑）就是空。 */
  const flatItemsOf = (templateId: string | null): FlatItem[] => {
    if (templateId === null || templates === undefined) return [];
    let tpl: ReturnType<PresalesTemplates["get"]>;
    try {
      tpl = templates.get(templateId);
    } catch {
      return [];
    }
    return tpl.stages.flatMap((stage) =>
      stage.items.map((item) => ({
        ...item,
        stageCode: stage.code,
        stageLabel: stage.label,
      })),
    );
  };

  /**
   * 对号并把自动对上的写回库（自愈：恢复出厂后条目 id 全变，下次读的时候按名字重新对上）。
   * 只写「这次新对上的」，人手动对过的不碰。
   */
  const linkedSlotsOf = (
    libId: string,
  ): { slots: PresalesSlot[]; gaps: TemplateItemRef[] } => {
    const lib = libRow(libId);
    const rows = slotRowsOf(libId);
    const items = flatItemsOf(lib?.template_id ?? null);
    const { byslot, autoLinked, gaps } = resolveLinks(
      rows.map((r) => ({
        id: r.id,
        title: r.title,
        templateItemId: r.template_item_id,
      })),
      items,
    );
    if (autoLinked.size > 0) {
      const write = db.prepare(
        "UPDATE presales_slots SET template_item_id = ? WHERE id = ?",
      );
      db.transaction(() => {
        for (const [slotId, itemId] of autoLinked) write.run(itemId, slotId);
      })();
    }
    return {
      slots: rows.map((r) => toSlot(r, versionsOf(r.id), byslot.get(r.id))),
      gaps: gaps.map(refOf),
    };
  };

  const slotsOf = (libId: string): PresalesSlot[] =>
    slotRowsOf(libId).map((r) => toSlot(r, versionsOf(r.id)));

  const productExists = (productId: string | null): boolean =>
    productId === null ||
    db
      .prepare<[string], { id: string }>("SELECT id FROM products WHERE id = ?")
      .get(productId) !== undefined;

  const toLib = (r: LibRow, slots: PresalesSlot[]): PresalesLib => ({
    id: r.id,
    productId: r.product_id,
    productExists: productExists(r.product_id),
    name: r.name,
    summary: r.summary,
    status: r.status as "active" | "retired",
    templateId: r.template_id,
    templateName:
      r.template_id === null
        ? null
        : (templates?.get(r.template_id).name ?? null),
    slotCount: slots.length,
    coveredCount: slots.filter((s) => s.current !== null).length,
    criticalGapCount: slots.filter((s) => s.priority && s.current === null)
      .length,
    inProgressCount: slots.filter(
      (s) =>
        s.current === null &&
        s.versions.some((v) => v.status === "draft" || v.status === "review"),
    ).length,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const nextOrder = (table: string): number => {
    const row = db
      .prepare<[], { v: number | null }>(
        `SELECT MAX(sort_order) AS v FROM ${table}`,
      )
      .get();
    return (row?.v ?? 0) + 1;
  };

  const productName = (productId: string): string | undefined =>
    db
      .prepare<[string], { name: string }>(
        "SELECT name FROM products WHERE id = ?",
      )
      .get(productId)?.name;

  /**
   * 铺模板条目成槽位。
   *
   * 去重按**名称**而不是键：模板允许用户改名，键会跟着变；而「同类材料在同一个
   * 库里只该有一份」这个语义始终成立。已有的条目原样保留——补模板永远不覆盖
   * 人已经登记过的材料。
   */
  const insertSlots = (
    libId: string,
    items: readonly (PresalesTemplateItem & { stage: string })[],
  ): number => {
    // 先对一次号：已经对上的模板条目不再补（名称改过也认，靠的是 id）。
    const linked = new Set(
      linkedSlotsOf(libId)
        .slots.map((s) => s.templateItem?.id)
        .filter((id): id is string => id !== undefined),
    );
    // 去重把别名算上：老库里叫「需求摸底表」，模板改叫「需求调研表」，
    // 它们是同一类材料，不该再补一份。整份清单在内存里比对，不查库。
    const existing = new Set(
      db
        .prepare<[string], { title: string }>(
          "SELECT title FROM presales_slots WHERE lib_id = ?",
        )
        .all(libId)
        .map((r) => r.title.trim().toLowerCase()),
    );
    const covered = (item: PresalesTemplateItem): boolean =>
      linked.has(item.id) ||
      [item.name, ...item.aliases].some((n) =>
        existing.has(n.trim().toLowerCase()),
      );

    const stamp = now();
    let order = nextOrder("presales_slots");
    let added = 0;
    const insert = db.prepare(
      `INSERT INTO presales_slots
         (id, lib_id, item_key, stage, title, priority, audience,
          guide, checkpoints, file_hints, template_item_id, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const item of items) {
      if (covered(item)) continue;
      insert.run(
        randomUUID(),
        libId,
        slotKeyFrom(item.name),
        item.stage,
        item.name,
        item.required ? 1 : 0,
        item.audience,
        item.guide,
        item.checkpoints.join("\n"),
        item.fileHints.join("\n"),
        item.id,
        order,
        stamp,
        stamp,
      );
      existing.add(item.name.trim().toLowerCase());
      order += 1;
      added += 1;
    }
    return added;
  };

  /** 模板的条目摊平成「阶段代号 → 材料」的形状，供 insertSlots 用。 */
  const itemsOf = (
    templateId: string,
  ): (PresalesTemplateItem & { stage: string })[] => {
    const tpl = templates?.get(templateId);
    if (tpl === undefined) return [];
    return tpl.stages.flatMap((stage) =>
      stage.items.map((item) => ({ ...item, stage: stage.code })),
    );
  };

  const touchLib = (libId: string): void => {
    db.prepare("UPDATE presales_libs SET updated_at = ? WHERE id = ?").run(
      now(),
      libId,
    );
  };

  return {
    list() {
      return db
        .prepare<[], LibRow>(
          "SELECT * FROM presales_libs ORDER BY sort_order, rowid",
        )
        .all()
        .map((r) => toLib(r, slotsOf(r.id)));
    },

    get(id) {
      const row = libRow(id);
      if (row === undefined) return undefined;
      const { slots, gaps } = linkedSlotsOf(id);
      return { lib: toLib(row, slots), slots, templateGaps: gaps };
    },

    create(input) {
      const productId =
        input.productId === undefined || input.productId === ""
          ? null
          : input.productId;
      const stamp = now();
      const name =
        input.name ??
        (productId === null
          ? "公司级材料"
          : (productName(productId) ?? "未命名产品"));
      if (productId !== null && productName(productId) === undefined) {
        throw notFound("产品不存在");
      }
      const id = randomUUID();
      // 一个产品只该有一本库：否则同一产品会分裂出两份「现行版」。
      translateUnique("这个产品已经有售前库了", () => {
        db.prepare(
          `INSERT INTO presales_libs
             (id, product_id, name, summary, status, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?, ?)`,
        ).run(
          id,
          productId,
          name,
          input.summary ?? "",
          nextOrder("presales_libs"),
          stamp,
          stamp,
        );
      });
      // 模板来源：显式指定 > 按库种类取出厂模板 > 空（允许建一本空库，回头再加）。
      const templateId =
        input.templateId !== undefined && input.templateId !== ""
          ? input.templateId
          : templates?.byBuiltinKey(productId === null ? "company" : "product")
              ?.id;
      if (templateId !== undefined) {
        db.prepare("UPDATE presales_libs SET template_id = ? WHERE id = ?").run(
          templateId,
          id,
        );
        insertSlots(id, itemsOf(templateId));
      }
      const created = this.get(id);
      if (created === undefined) throw notFound("建库后读取失败");
      return created;
    },

    update(id, input) {
      const row = libRow(id);
      if (row === undefined) throw notFound("售前库不存在");
      db.prepare(
        `UPDATE presales_libs
            SET name = ?, summary = ?, status = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.name ?? row.name,
        input.summary ?? row.summary,
        input.status ?? row.status,
        now(),
        id,
      );
      return toLib(libRow(id) ?? row, slotsOf(id));
    },

    remove(id) {
      const row = libRow(id);
      if (row === undefined) throw notFound("售前库不存在");
      // 先把文件路径交回调用方删磁盘：库记录删完就查不到了。
      const paths = db
        .prepare<[string], { file_path: string | null }>(
          `SELECT v.file_path
             FROM presales_versions v
             JOIN presales_slots s ON s.id = v.slot_id
            WHERE s.lib_id = ? AND v.file_path IS NOT NULL`,
        )
        .all(id)
        .map((r) => r.file_path)
        .filter((p): p is string => p !== null);
      db.prepare("DELETE FROM presales_libs WHERE id = ?").run(id);
      return paths;
    },

    syncTemplate(id) {
      const row = libRow(id);
      if (row === undefined) throw notFound("售前库不存在");
      if (row.template_id === null) {
        throw badRequest("这本库没绑售前模板，先去「售前模板」选一个");
      }
      const added = insertSlots(id, itemsOf(row.template_id));
      touchLib(id);
      return added;
    },

    setTemplate(id, templateId) {
      if (libRow(id) === undefined) throw notFound("售前库不存在");
      if (templateId !== null && templates?.get(templateId) === undefined) {
        throw notFound("售前模板不存在");
      }
      db.transaction(() => {
        db.prepare(
          "UPDATE presales_libs SET template_id = ?, updated_at = ? WHERE id = ?",
        ).run(templateId, now(), id);
        // 换了模板，旧的对号（指向旧模板的条目 id）全部作废，交回自动重新对。
        db.prepare(
          "UPDATE presales_slots SET template_item_id = NULL WHERE lib_id = ?",
        ).run(id);
      })();
      linkedSlotsOf(id);
    },

    addSlot(libId, input) {
      const lib = libRow(libId);
      if (lib === undefined) throw notFound("售前库不存在");
      const id = randomUUID();
      const stamp = now();
      // 模板条目按 item_key 去重，自定义条目按**标题**去重：
      // 中文标题 ASCII 化后往往是空串，两条「模型资源价格表」会拿到两个不同的
      // 随机 key，只靠唯一索引拦不住。同名材料在同一个库里本来就不该有两份。
      const dup = db
        .prepare<[string, string], { id: string }>(
          "SELECT id FROM presales_slots WHERE lib_id = ? AND title = ? COLLATE NOCASE",
        )
        .get(libId, input.title);
      if (dup !== undefined) throw conflict("这个材料条目已经有了");
      translateUnique("这个材料条目已经有了", () => {
        db.prepare(
          `INSERT INTO presales_slots
             (id, lib_id, item_key, stage, title, priority, audience, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          libId,
          slotKeyFrom(input.title),
          input.stage,
          input.title,
          input.priority === true ? 1 : 0,
          input.audience ?? "external",
          nextOrder("presales_slots"),
          stamp,
          stamp,
        );
      });
      touchLib(libId);
      const row = slotRow(id);
      if (row === undefined) throw notFound("建条目后读取失败");
      return toSlot(row, []);
    },

    updateSlot(id, input) {
      const row = slotRow(id);
      if (row === undefined) throw notFound("材料条目不存在");
      let itemId = row.template_item_id;
      if (input.templateItemId !== undefined) {
        itemId = input.templateItemId;
        if (itemId !== null && itemId !== OUTSIDE_TEMPLATE) {
          const lib = libRow(row.lib_id);
          const target = flatItemsOf(lib?.template_id ?? null).find(
            (i) => i.id === itemId,
          );
          if (target === undefined)
            throw badRequest("这一项不在这本库绑的模板里");
          // 一项模板条目只挂一个条目：抢过来，原来挂着的那条交回自动。
          db.prepare(
            "UPDATE presales_slots SET template_item_id = NULL WHERE lib_id = ? AND template_item_id = ? AND id <> ?",
          ).run(row.lib_id, itemId, id);
        }
      }
      db.prepare(
        `UPDATE presales_slots
            SET title = ?, stage = ?, priority = ?, audience = ?, template_item_id = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.title ?? row.title,
        input.stage ?? row.stage,
        input.priority === undefined ? row.priority : input.priority ? 1 : 0,
        input.audience ?? row.audience,
        itemId,
        now(),
        id,
      );
      touchLib(row.lib_id);
    },

    removeSlot(id) {
      const row = slotRow(id);
      if (row === undefined) throw notFound("材料条目不存在");
      // 先取文件路径：版本行删掉之后就查不到它们了，文件会永远留在盘上，
      // 而界面上写的是「文件一起删掉，无法恢复」。
      const paths = db
        .prepare<[string], { file_path: string | null }>(
          "SELECT file_path FROM presales_versions WHERE slot_id = ?",
        )
        .all(id)
        .map((r) => r.file_path)
        .filter((p): p is string => p !== null && p !== "");
      db.prepare("DELETE FROM presales_slots WHERE id = ?").run(id);
      touchLib(row.lib_id);
      return paths;
    },

    addVersion(slotId, input) {
      const slot = slotRow(slotId);
      if (slot === undefined) throw notFound("材料条目不存在");
      const stamp = now();
      const status = input.status ?? "draft";
      const id = randomUUID();
      const run = db.transaction(() => {
        // 「唯一现行版」的应用层一半：先把旧的转归档再插。库上的部分唯一索引
        // 是另一半，漏了这里会直接撞约束报错，而不是悄悄多出一份现行版。
        if (status === "current") {
          db.prepare(
            "UPDATE presales_versions SET status = 'archived', updated_at = ? WHERE slot_id = ? AND status = 'current'",
          ).run(stamp, slotId);
        }
        db.prepare(
          `INSERT INTO presales_versions
             (id, slot_id, version, status, released_at, note, file_path, file_name, file_size, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          slotId,
          input.version,
          status,
          input.releasedAt ?? null,
          input.note ?? "",
          input.filePath ?? null,
          input.fileName ?? null,
          input.fileSize ?? null,
          stamp,
          stamp,
        );
        touchLib(slot.lib_id);
      });
      run();
      const row = versionRow(id);
      if (row === undefined) throw notFound("建版本后读取失败");
      return toVersion(row);
    },

    updateVersion(id, input) {
      const row = versionRow(id);
      if (row === undefined) throw notFound("版本不存在");
      db.prepare(
        `UPDATE presales_versions
            SET version = ?, released_at = ?, note = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        input.version ?? row.version,
        input.releasedAt ?? row.released_at,
        input.note ?? row.note,
        now(),
        id,
      );
    },

    setVersionStatus(id, status) {
      const row = versionRow(id);
      if (row === undefined) throw notFound("版本不存在");
      const stamp = now();
      db.transaction(() => {
        if (status === "current") {
          db.prepare(
            "UPDATE presales_versions SET status = 'archived', updated_at = ? WHERE slot_id = ? AND status = 'current'",
          ).run(stamp, row.slot_id);
        }
        db.prepare(
          "UPDATE presales_versions SET status = ?, updated_at = ? WHERE id = ?",
        ).run(status, stamp, id);
      })();
    },

    removeVersion(id) {
      const row = versionRow(id);
      if (row === undefined) throw notFound("版本不存在");
      db.prepare("DELETE FROM presales_versions WHERE id = ?").run(id);
      return toVersion(row);
    },

    slotOf(id) {
      const row = slotRow(id);
      if (row === undefined) return undefined;
      return linkedSlotsOf(row.lib_id).slots.find((s) => s.id === id);
    },

    versionOf(id) {
      const row = versionRow(id);
      return row === undefined ? undefined : toVersion(row);
    },

    attachFile(versionId, file) {
      const row = versionRow(versionId);
      if (row === undefined) throw notFound("版本不存在");
      db.prepare(
        `UPDATE presales_versions
            SET file_path = ?, file_name = ?, file_size = ?, updated_at = ?
          WHERE id = ?`,
      ).run(file.path, file.name, file.size, now(), versionId);
      const next = versionRow(versionId);
      if (next === undefined) throw notFound("写文件后读取失败");
      return toVersion(next);
    },
  };
}

/** 供路由校验「这个文件名能不能挂上去」用。 */
export const isAllowedFileName = (name: string): boolean => {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return true; // 没后缀也允许：素材可能叫「白皮书」
  return name.slice(dot).length <= 12;
};

export { conflict };
