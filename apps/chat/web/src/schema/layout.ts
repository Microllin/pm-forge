import type { RelationKind, SchemaRelation, SchemaTable } from "./api";

/**
 * 数据结构图（ER 图）的布局。**纯函数，不碰 React Flow、不碰 DOM**——能直接单测。
 *
 * ## 为什么不一次画全
 *
 * 真实仓库一个子系统就有 172 张表，一屏 172 个方块谁也看不清。所以：
 * - 表少（≤ ALL_LIMIT）时画全部；
 * - 表多时只画**选中的表 + 与它们直接相连的表**（一跳），人从左侧清单里点着往外扩。
 *
 * ## 摆法
 *
 * 不引 dagre（理由同 graph/layout.ts 开头）：一跳邻域的结构是确定的——
 * 选中的表居中一列；它们**指向**的表（外键所在的一方 → 被指向的一方）放右边，
 * **指向它们**的表放左边。读起来就是「左边依赖中间，中间依赖右边」。
 */

export const ALL_LIMIT = 30;
export const NODE_WIDTH = 248;
const HEAD_H = 46;
const ROW_H = 19;
const FOOT_H = 22;
const PAD = 10;
const COL_GAP = 120;
const ROW_GAP = 28;
/** 节点上最多列几个字段；其余收成「还有 N 个字段」，点开抽屉看全。 */
export const MAX_ROWS = 8;
/** 一跳邻居每列最多几张表。 */
export const MAX_PER_COL = 8;

export const KIND_LABEL: Record<RelationKind, string> = {
  "many-to-one": "多对一",
  "one-to-one": "一对一",
  "many-to-many": "多对多",
};

export interface TableNodeData {
  kind: "table";
  table: SchemaTable;
  /** 节点上露出的字段：主键与外键优先，其余按定义顺序补到 MAX_ROWS。 */
  rows: { name: string; type: string; key: "pk" | "fk" | null }[];
  hidden: number;
  /** 被人选中的（不是一跳邻居）。 */
  focused: boolean;
  /** 这张表的关联里，有多少条连向画面之外的表。 */
  offscreen: number;
}

export interface SchemaLayout {
  nodes: {
    id: string;
    position: { x: number; y: number };
    width: number;
    height: number;
    data: TableNodeData;
  }[];
  edges: {
    id: string;
    source: string;
    target: string;
    label: string;
    kind: RelationKind;
  }[];
  /** 画全部还是只画选中的一跳。 */
  mode: "all" | "focus";
}

export const nodeId = (table: string): string => `t:${table}`;

function rowsOf(
  table: SchemaTable,
  fkFields: ReadonlySet<string>,
): Pick<TableNodeData, "rows" | "hidden"> {
  const keyOf = (f: SchemaTable["fields"][number]): "pk" | "fk" | null =>
    f.flags.includes("主键") ? "pk" : fkFields.has(f.name) ? "fk" : null;
  const keyed = table.fields.filter((f) => keyOf(f) !== null);
  const rest = table.fields.filter((f) => keyOf(f) === null);
  const shown = [...keyed, ...rest].slice(0, MAX_ROWS);
  return {
    rows: shown.map((f) => ({ name: f.name, type: f.type, key: keyOf(f) })),
    hidden: table.fields.length - shown.length,
  };
}

export const nodeHeight = (rows: number, hidden: number): number =>
  HEAD_H + rows * ROW_H + (hidden > 0 ? FOOT_H : 0) + PAD;

/** 与选中集合直接相连的表名（不含选中的）。 */
export function neighborsOf(
  relations: readonly SchemaRelation[],
  focus: ReadonlySet<string>,
): { left: Set<string>; right: Set<string> } {
  const left = new Set<string>();
  const right = new Set<string>();
  for (const r of relations) {
    if (focus.has(r.from) && !focus.has(r.to)) right.add(r.to);
    if (focus.has(r.to) && !focus.has(r.from)) left.add(r.from);
  }
  // 两边都沾的放右边（被依赖的一方更像「基础表」）。
  for (const t of right) left.delete(t);
  return { left, right };
}

export function schemaLayout(
  tables: readonly SchemaTable[],
  relations: readonly SchemaRelation[],
  focus: ReadonlySet<string>,
): SchemaLayout {
  const byName = new Map(tables.map((t) => [t.name, t]));
  const mode: SchemaLayout["mode"] =
    tables.length <= ALL_LIMIT && focus.size === 0 ? "all" : "focus";

  let columns: string[][];
  if (mode === "all") {
    // 按关联数排：连得多的在前，大致能把核心表聚到左上。
    const degree = new Map<string, number>();
    for (const r of relations) {
      degree.set(r.from, (degree.get(r.from) ?? 0) + 1);
      degree.set(r.to, (degree.get(r.to) ?? 0) + 1);
    }
    const sorted = [...tables]
      .map((t) => t.name)
      .sort(
        (a, b) =>
          (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : 1),
      );
    const perCol = Math.max(1, Math.ceil(Math.sqrt(sorted.length / 1.6)));
    columns = [];
    for (let i = 0; i < sorted.length; i += perCol)
      columns.push(sorted.slice(i, i + perCol));
  } else {
    const picked = [...focus].filter((n) => byName.has(n)).sort();
    const { left, right } = neighborsOf(relations, new Set(picked));
    // 枢纽表（users、groups）一跳就连着二三十张表，排成一列缩小后谁也看不清：
    // 每列最多 MAX_PER_COL 张，多的往外再开一列（左边往左长，右边往右长）。
    const chunk = (names: string[]): string[][] => {
      const out: string[][] = [];
      for (let i = 0; i < names.length; i += MAX_PER_COL)
        out.push(names.slice(i, i + MAX_PER_COL));
      return out;
    };
    columns = [
      ...chunk([...left].sort()).reverse(),
      picked,
      ...chunk([...right].sort()),
    ].filter((c) => c.length > 0);
  }

  const visible = new Set(columns.flat());
  const fkByTable = new Map<string, Set<string>>();
  for (const r of relations) {
    if (r.field === null) continue;
    const set = fkByTable.get(r.from) ?? new Set<string>();
    set.add(r.field);
    fkByTable.set(r.from, set);
  }

  const nodes: SchemaLayout["nodes"] = [];
  // 各列垂直居中对齐：最高的那一列定基线。
  const heights = columns.map((col) =>
    col.reduce((sum, name) => {
      const t = byName.get(name);
      if (t === undefined) return sum;
      const { rows, hidden } = rowsOf(t, fkByTable.get(name) ?? new Set());
      return sum + nodeHeight(rows.length, hidden) + ROW_GAP;
    }, -ROW_GAP),
  );
  const tallest = Math.max(0, ...heights);
  columns.forEach((col, ci) => {
    let y = (tallest - (heights[ci] ?? 0)) / 2;
    for (const name of col) {
      const table = byName.get(name);
      if (table === undefined) continue;
      const { rows, hidden } = rowsOf(table, fkByTable.get(name) ?? new Set());
      const height = nodeHeight(rows.length, hidden);
      const offscreen = relations.filter(
        (r) =>
          (r.from === name && !visible.has(r.to)) ||
          (r.to === name && !visible.has(r.from)),
      ).length;
      nodes.push({
        id: nodeId(name),
        position: { x: ci * (NODE_WIDTH + COL_GAP), y },
        width: NODE_WIDTH,
        height,
        data: {
          kind: "table",
          table,
          rows,
          hidden,
          focused: focus.has(name),
          offscreen,
        },
      });
      y += height + ROW_GAP;
    }
  });

  const edges: SchemaLayout["edges"] = [];
  const seen = new Set<string>();
  for (const r of relations) {
    if (!visible.has(r.from) || !visible.has(r.to) || r.from === r.to) continue;
    // 焦点模式下两张邻居表之间的线不画：它们不是这次要看的，画了只会乱。
    if (mode === "focus" && !focus.has(r.from) && !focus.has(r.to)) continue;
    const id = `${r.from}.${r.field ?? r.label ?? ""}->${r.to}`;
    if (seen.has(id)) continue;
    seen.add(id);
    edges.push({
      id,
      source: nodeId(r.from),
      target: nodeId(r.to),
      label: `${r.field ?? r.label ?? ""} · ${KIND_LABEL[r.kind]}`,
      kind: r.kind,
    });
  }
  return { nodes, edges, mode };
}

/** 左侧清单的搜索：表名、实体名、表说明、字段名都算。 */
export function matchTable(table: SchemaTable, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return (
    table.name.toLowerCase().includes(q) ||
    table.entity.toLowerCase().includes(q) ||
    (table.comment ?? "").toLowerCase().includes(q) ||
    table.fields.some(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        (f.comment ?? "").toLowerCase().includes(q),
    )
  );
}
