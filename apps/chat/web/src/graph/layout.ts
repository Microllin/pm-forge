import type { FeatureNode, Finding, StoredCheck } from "../analysis/api";
import type { Template } from "../lifecycle/api";
import type { Product, ProductLine } from "../products/api";

/**
 * 图谱的布局计算。**纯函数，不碰 React Flow、不碰 DOM** —— 所以能直接单测。
 *
 * ## 为什么自己算布局，不引 dagre
 *
 * 老版本 `apps/web/src/products/graph-view.tsx` 第 23 行留过一条实测结论：
 * 「层级树是『列 = 深度、同列纵向堆叠、父居子中点』的确定排布，后序遍历一次算完，
 * 没有可求解的东西；通用 DAG 布局反而会打乱层次。」
 *
 * 我们这两张图都是层级树（产品线→产品 / 阶段→产出物），不是任意 DAG：
 * 泳道的行列位置由分组决定，组内顺序由 sort_order 决定，没有交叉边要优化。
 * 引 dagre 只会把「L0.1 在 L0.2 左边」这种确定关系交给布局器去猜。
 *
 * 参考的运维控制台的那张拓扑用 dagre 是因为它要排的是**机器之间的真实依赖**（有环、有跨区边），
 * 那才需要求解器。两件事不一样。
 */

/** 产出物的四档状态。前三档来自比对，`unknown` = 还没比对过。 */
export type NodeStatus = "present" | "partial" | "missing" | "unknown";

/** 状态文案。放这里而不是节点组件里：组件文件只导出组件，否则 react-refresh 失效。 */
export const STATUS_LABEL: Record<NodeStatus, string> = {
  present: "齐",
  partial: "不全",
  missing: "缺",
  unknown: "未比对",
};

export interface Density {
  present: number;
  partial: number;
  missing: number;
  total: number;
  requiredGap: number;
  /** 还没比对过：界面上要明确说「不知道」，不能画成 0% 让人误读成「全缺」。 */
  unknown: boolean;
}

export interface ProductNodeData {
  kind: "product";
  product: Product;
  lineName: string;
  templateName: string | null;
  density: Density;
  /** 没绑模板 / 没绑目录 / 没比对过——卡片上要直说缺哪一步。 */
  blockers: string[];
}

export interface ArtifactNodeData {
  kind: "artifact";
  productId: string;
  stageCode: string;
  stageLabel: string;
  artifact: string;
  required: boolean;
  guide: string;
  checkpoints: string[];
  status: NodeStatus;
  finding: Finding | undefined;
}

export interface LaneNodeData {
  kind: "lane";
  label: string;
  sub: string;
  tone: "brand" | "neutral";
}

export type GraphNodeData =
  ProductNodeData | ArtifactNodeData | LaneNodeData | FeatureNodeData;

export interface LaidOutNode {
  id: string;
  type: "lane" | "product" | "artifact" | "feature";
  position: { x: number; y: number };
  width: number;
  height: number;
  data: GraphNodeData;
  parentId?: string;
}

export interface LaidOutEdge {
  id: string;
  source: string;
  target: string;
  /** 生命线主干（阶段之间）画实线，归属关系不画边——靠分组表达。 */
  kind: "lifeline";
}

export interface Layout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  /** 一个都没画出来时，界面要说清是「本来就没有」还是「被筛掉了」。 */
  empty: "none" | "filtered" | null;
}

/* ── 尺寸。改这里就等于改布局，不要在组件里再写一套。 ── */
const PRODUCT_W = 236;
const PRODUCT_H = 112;
const ARTIFACT_W = 200;
const ARTIFACT_H = 68;
const GAP = 16;
/** 泳道之间的间距。生命线有十几列，这个值直接决定「一屏能看几个阶段」。 */
const LANE_GAP = 28;
const LANE_PAD = 14;
const LANE_HEAD = 52;
/** 全景图里一条泳道横着放几个产品，超了换行。 */
const PRODUCTS_PER_ROW = 4;

/* ── 状态与密度 ── */

/** 比对结果里这件产出物的结论；没比对过是 unknown（不是 missing）。 */
export function statusOf(
  check: StoredCheck | undefined,
  artifact: string,
): { status: NodeStatus; finding: Finding | undefined } {
  if (!check) return { status: "unknown", finding: undefined };
  const finding = check.findings.find((f) => f.artifact === artifact);
  return { status: finding?.status ?? "missing", finding };
}

export function densityOf(
  check: StoredCheck | undefined,
  totalFallback: number,
): Density {
  if (!check)
    return {
      present: 0,
      partial: 0,
      missing: 0,
      total: totalFallback,
      requiredGap: 0,
      unknown: true,
    };
  return { ...check.summary, unknown: false };
}

/** 卡片上直说「还差哪一步」。顺序就是该做的顺序。 */
export function blockersOf(
  product: Product,
  check: StoredCheck | undefined,
): string[] {
  const out: string[] = [];
  if (product.templateId === null) out.push("未绑规范模板");
  if (product.folderPath === null) out.push("未绑目录");
  if (out.length === 0 && !check) out.push("还没比对过");
  return out;
}

/* ── 筛选 ── */

export interface GraphFilter {
  /** 只看这些状态。空集 = 不筛。 */
  statuses: ReadonlySet<NodeStatus>;
  /** 只看必交项。 */
  requiredOnly: boolean;
}

export const NO_FILTER: GraphFilter = {
  statuses: new Set(),
  requiredOnly: false,
};

export const filterActive = (f: GraphFilter): boolean =>
  f.statuses.size > 0 || f.requiredOnly;

const keep = (
  f: GraphFilter,
  status: NodeStatus,
  required: boolean,
): boolean => {
  if (f.requiredOnly && !required) return false;
  if (f.statuses.size > 0 && !f.statuses.has(status)) return false;
  return true;
};

/* ── 全景图：泳道 = 产品线，节点 = 产品 ── */

export function overviewLayout(
  lines: ProductLine[],
  templates: Template[],
  checks: StoredCheck[],
  filter: GraphFilter = NO_FILTER,
): Layout {
  const nodes: LaidOutNode[] = [];
  const templateById = new Map(templates.map((t) => [t.id, t]));
  const checkOf = (id: string) => checks.find((c) => c.productId === id);
  let y = 0;
  /** 库里本来就有没有东西。与「被筛掉了」必须分开——空态文案要说的话完全不同。 */
  const anyProduct = lines.some((l) => l.products.length > 0);

  for (const line of lines) {
    // 产品层面的筛选按「这个产品有没有命中状态的产出物」判：
    // 筛「只看缺的」时，一个全齐的产品不该还占着位置。
    const shown = line.products.filter((p) => {
      if (!filterActive(filter)) return true;
      const template =
        p.templateId === null ? null : templateById.get(p.templateId);
      const check = checkOf(p.id);
      if (!template) return false;
      return template.stages.some((s) =>
        s.artifacts.some((a) =>
          keep(filter, statusOf(check, a.name).status, a.required),
        ),
      );
    });
    if (shown.length === 0) continue;

    const rows = Math.ceil(shown.length / PRODUCTS_PER_ROW);
    const cols = Math.min(shown.length, PRODUCTS_PER_ROW);
    const laneW = LANE_PAD * 2 + cols * PRODUCT_W + (cols - 1) * GAP;
    const laneH = LANE_HEAD + LANE_PAD + rows * PRODUCT_H + (rows - 1) * GAP;
    const laneId = `lane:${line.id}`;
    nodes.push({
      id: laneId,
      type: "lane",
      position: { x: 0, y },
      width: laneW,
      height: laneH,
      data: {
        kind: "lane",
        label: line.name,
        sub: `${String(line.products.length)} 个产品${line.folderPath === null ? "" : ` · ${line.folderPath}`}`,
        tone: "brand",
      },
    });

    shown.forEach((product, i) => {
      const col = i % PRODUCTS_PER_ROW;
      const row = Math.floor(i / PRODUCTS_PER_ROW);
      const template =
        product.templateId === null
          ? null
          : templateById.get(product.templateId);
      const check = checkOf(product.id);
      const total =
        template?.stages.reduce((n, s) => n + s.artifacts.length, 0) ?? 0;
      nodes.push({
        id: `product:${product.id}`,
        type: "product",
        parentId: laneId,
        position: {
          x: LANE_PAD + col * (PRODUCT_W + GAP),
          y: LANE_HEAD + row * (PRODUCT_H + GAP),
        },
        width: PRODUCT_W,
        height: PRODUCT_H,
        data: {
          kind: "product",
          product,
          lineName: line.name,
          templateName: template?.name ?? null,
          density: densityOf(check, total),
          blockers: blockersOf(product, check),
        },
      });
    });

    y += laneH + LANE_GAP;
  }

  return {
    nodes,
    edges: [],
    empty:
      nodes.length > 0
        ? null
        : anyProduct && filterActive(filter)
          ? "filtered"
          : "none",
  };
}

/* ── 生命线：泳道 = 阶段（横向排开），节点 = 产出物 ── */

export function lifelineLayout(
  product: Product,
  template: Template,
  check: StoredCheck | undefined,
  filter: GraphFilter = NO_FILTER,
): Layout {
  const nodes: LaidOutNode[] = [];
  const edges: LaidOutEdge[] = [];
  let x = 0;
  let lastLaneId: string | null = null;
  const anyArtifact = template.stages.some((s) => s.artifacts.length > 0);

  const columns = template.stages.map((stage) => {
    const shown = stage.artifacts.filter((a) =>
      keep(filter, statusOf(check, a.name).status, a.required),
    );
    return { stage, shown };
  });
  /**
   * **泳道各自贴合内容，不强制等高。**
   *
   * 曾经做过等高，理由是「参差不齐会让横向一条线的读法消失」。但主干后来挂到了
   * 阶段标题那一行（见 nodes.tsx 的 Handle style.top），线本身就在顶部横穿——
   * 等高这个理由随之失效，剩下的只有代价：大多数阶段只有 1 件产出物，按最高的
   * 那列（2 件）拉平，等于每列都白占半屏，11 列下来就是一整屏。
   */
  const laneHeight = (rows: number): number =>
    LANE_HEAD + LANE_PAD + Math.max(rows, 1) * (ARTIFACT_H + GAP);
  const laneW = LANE_PAD * 2 + ARTIFACT_W;

  for (const { stage, shown } of columns) {
    // 空列也画（只要没被筛没）：阶段本身就是事实，「这一阶段一件都没有」是重要信息。
    if (filterActive(filter) && shown.length === 0) continue;
    const laneId = `stage:${stage.id}`;
    nodes.push({
      id: laneId,
      type: "lane",
      position: { x, y: 0 },
      width: laneW,
      height: laneHeight(shown.length),
      data: {
        kind: "lane",
        label: `${stage.code} ${stage.label}`,
        sub: stage.question,
        tone: "neutral",
      },
    });
    if (lastLaneId !== null)
      edges.push({
        id: `edge:${lastLaneId}->${laneId}`,
        source: lastLaneId,
        target: laneId,
        kind: "lifeline",
      });
    lastLaneId = laneId;

    shown.forEach((a, i) => {
      const { status, finding } = statusOf(check, a.name);
      nodes.push({
        id: `artifact:${a.id}`,
        type: "artifact",
        parentId: laneId,
        position: { x: LANE_PAD, y: LANE_HEAD + i * (ARTIFACT_H + GAP) },
        width: ARTIFACT_W,
        height: ARTIFACT_H,
        data: {
          kind: "artifact",
          productId: product.id,
          stageCode: stage.code,
          stageLabel: stage.label,
          artifact: a.name,
          required: a.required,
          guide: a.guide,
          checkpoints: a.checkpoints,
          status,
          finding,
        },
      });
    });

    x += laneW + LANE_GAP;
  }

  return {
    nodes,
    edges,
    empty:
      nodes.length > 0
        ? null
        : anyArtifact && filterActive(filter)
          ? "filtered"
          : "none",
  };
}

/* ── 功能架构树：列 = 层级，同列纵向堆叠，父居子中点 ── */

export interface FeatureNodeData {
  kind: "feature";
  node: FeatureNode;
  /** 这一支下有几个子功能。0 = 叶子，界面上提示「可以往下拆」。 */
  childCount: number;
}

const FEATURE_W = 228;
const FEATURE_H = 76;
/** 列间距要给够：父居子中点时连线是斜的，太窄会糊成一团。 */
const COL_GAP = 88;
const ROW_GAP = 14;

/**
 * 架构树的布局。
 *
 * 排布规则就是老版本 `apps/web/src/products/graph-view.tsx` 第 23 行那句：
 * **列 = 深度、同列纵向堆叠、父居子中点，后序遍历一次算完**。
 * 叶子按出现顺序领一个纵向槽位，父节点取它孩子的中点——这是确定排布，
 * 没有可求解的东西，所以不引 dagre（引了反而会打乱层次）。
 */
export function architectureLayout(
  features: readonly FeatureNode[],
  filter: { search: string } = { search: "" },
): Layout {
  const nodes: LaidOutNode[] = [];
  const edges: LaidOutEdge[] = [];
  const hasAny = features.length > 0;

  const needle = filter.search.trim().toLowerCase();
  /** 命中：自己或任一后代命中。整支保留——只留命中的那个节点会让树断成碎片。 */
  const hit = (node: FeatureNode): boolean => {
    if (needle === "") return true;
    if (
      node.name.toLowerCase().includes(needle) ||
      node.duty.toLowerCase().includes(needle)
    )
      return true;
    return node.children.some(hit);
  };

  /** 下一个可用的纵向槽位（以行为单位，最后再乘行高）。 */
  let nextRow = 0;

  const place = (node: FeatureNode, depth: number): number => {
    const kids = node.children.filter(hit);
    let center: number;
    if (kids.length === 0) {
      center = nextRow;
      nextRow += 1;
    } else {
      const centers = kids.map((k) => place(k, depth + 1));
      const first = centers[0] ?? 0;
      const last = centers[centers.length - 1] ?? 0;
      center = (first + last) / 2;
    }
    nodes.push({
      id: `feature:${node.id}`,
      type: "feature",
      position: {
        x: depth * (FEATURE_W + COL_GAP),
        y: center * (FEATURE_H + ROW_GAP),
      },
      width: FEATURE_W,
      height: FEATURE_H,
      data: { kind: "feature", node, childCount: node.children.length },
    });
    for (const kid of kids)
      edges.push({
        id: `edge:${node.id}->${kid.id}`,
        source: `feature:${node.id}`,
        target: `feature:${kid.id}`,
        kind: "lifeline",
      });
    return center;
  };

  for (const root of features.filter(hit)) place(root, 0);

  return {
    nodes,
    edges,
    empty:
      nodes.length > 0 ? null : hasAny && needle !== "" ? "filtered" : "none",
  };
}
