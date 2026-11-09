import { describe, expect, it } from "vitest";

import type { FeatureNode, StoredCheck } from "../analysis/api";
import type { Template } from "../lifecycle/api";
import type { Product, ProductLine } from "../products/api";
import {
  NO_FILTER,
  architectureLayout,
  blockersOf,
  densityOf,
  lifelineLayout,
  overviewLayout,
  statusOf,
  type GraphFilter,
} from "./layout";

/**
 * 图谱的布局是纯函数，所以这里不碰 DOM、不挂 React Flow。
 *
 * 真正要钉住的是几条**看不出来的口径**：没比对过 ≠ 全缺、筛空了 ≠ 本来就没有、
 * 筛选是真重排不是变灰、空阶段照画。这几条错了界面不会报错，只会悄悄骗人。
 */

const product = (over: Partial<Product> = {}): Product => ({
  id: "p1",
  lineId: "l1",
  name: "Alpha",
  description: "",
  templateId: "t1",
  folderPath: "/alpha",
  codePath: "/代码库/alpha",
  refPaths: [],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const line = (over: Partial<ProductLine> = {}): ProductLine => ({
  id: "l1",
  name: "L1",
  description: "",
  folderPath: null,
  createdAt: 1,
  updatedAt: 1,
  products: [product()],
  ...over,
});

const artifact = (name: string, required = true) => ({
  id: `a-${name}`,
  stageId: "s1",
  name,
  required,
  guide: "",
  checkpoints: [],
  fileHints: [],
  createdAt: 1,
  updatedAt: 1,
});

const template = (stages: Template["stages"]): Template => ({
  id: "t1",
  name: "T",
  description: "",
  builtin: false,
  createdAt: 1,
  updatedAt: 1,
  productCount: 1,
  stages,
});

const stage = (
  code: string,
  artifacts: ReturnType<typeof artifact>[],
): Template["stages"][number] => ({
  id: `s-${code}`,
  templateId: "t1",
  code,
  label: `${code} 阶段`,
  question: "",
  createdAt: 1,
  updatedAt: 1,
  artifacts,
});

const check = (
  findings: { artifact: string; status: "present" | "partial" | "missing" }[],
): StoredCheck => ({
  productId: "p1",
  templateId: "t1",
  sessionId: null,
  folderPath: "/alpha",
  summary: {
    total: findings.length,
    present: findings.filter((f) => f.status === "present").length,
    partial: findings.filter((f) => f.status === "partial").length,
    missing: findings.filter((f) => f.status === "missing").length,
    requiredGap: findings.filter((f) => f.status !== "present").length,
  },
  findings: findings.map((f) => ({
    stageCode: "L1",
    stageLabel: "阶段",
    artifact: f.artifact,
    required: true,
    status: f.status,
    files: [],
    missedCheckpoints: [],
    note: "",
    judged: true,
  })),
  checkedAt: 1,
});

const onlyMissing: GraphFilter = {
  statuses: new Set(["missing"]),
  requiredOnly: false,
};

describe("状态与密度", () => {
  it("没比对过是 unknown，不是 missing——这两件事在界面上必须分开说", () => {
    expect(statusOf(undefined, "想法卡").status).toBe("unknown");
    const d = densityOf(undefined, 13);
    expect(d).toMatchObject({ unknown: true, total: 13, present: 0 });
  });

  it("比对过但这件没出现在 findings 里，按 missing（服务端也是这个口径）", () => {
    expect(
      statusOf(check([{ artifact: "别的", status: "present" }]), "想法卡"),
    ).toMatchObject({ status: "missing" });
  });

  it("卡片上的「还差哪一步」按该做的顺序给，且绑全了只剩「还没比对过」", () => {
    expect(
      blockersOf(product({ templateId: null, folderPath: null }), undefined),
    ).toEqual(["未绑规范模板", "未绑目录"]);
    expect(blockersOf(product(), undefined)).toEqual(["还没比对过"]);
    expect(blockersOf(product(), check([]))).toEqual([]);
  });
});

describe("全景图", () => {
  const t = template([stage("L1", [artifact("想法卡")])]);

  it("泳道是产品线、卡片是产品，且卡片挂在泳道下（分组节点，不是覆盖层）", () => {
    const { nodes } = overviewLayout([line()], [t], []);
    const lane = nodes.find((n) => n.type === "lane");
    const card = nodes.find((n) => n.type === "product");
    expect(lane?.id).toBe("lane:l1");
    expect(card?.parentId).toBe("lane:l1");
    // 子节点坐标是相对父节点的，必须落在泳道内
    expect(card?.position.x).toBeGreaterThan(0);
    expect(card?.position.y).toBeGreaterThan(0);
  });

  it("多条产品线纵向堆叠，不重叠", () => {
    const second = line({
      id: "l2",
      name: "L2",
      products: [product({ id: "p2", lineId: "l2", name: "Beta" })],
    });
    const { nodes } = overviewLayout([line(), second], [t], []);
    const lanes = nodes.filter((n) => n.type === "lane");
    expect(lanes).toHaveLength(2);
    const [a, b] = lanes;
    expect(b?.position.y).toBeGreaterThanOrEqual(
      (a?.position.y ?? 0) + (a?.height ?? 0),
    );
  });

  it("一条泳道里超过 4 个产品就换行，泳道跟着变高", () => {
    const many = line({
      products: Array.from({ length: 6 }, (_, i) =>
        product({ id: `p${String(i)}`, name: `P${String(i)}` }),
      ),
    });
    const { nodes } = overviewLayout([many], [t], []);
    const lane = nodes.find((n) => n.type === "lane");
    const cards = nodes.filter((n) => n.type === "product");
    expect(cards).toHaveLength(6);
    // 第 5 个（下标 4）换到第二行
    expect(cards[4]?.position.y).toBeGreaterThan(cards[0]?.position.y ?? 0);
    expect(cards[4]?.position.x).toBe(cards[0]?.position.x);
    expect(lane?.height).toBeGreaterThan(200);
  });

  it("筛「只看缺的」时，全齐的产品整个退出布局——不是变灰", () => {
    const allGood = check([{ artifact: "想法卡", status: "present" }]);
    const { nodes, empty } = overviewLayout(
      [line()],
      [t],
      [allGood],
      onlyMissing,
    );
    expect(nodes).toHaveLength(0);
    // 「被筛掉了」和「本来就没有」要分开：空态文案完全不同
    expect(empty).toBe("filtered");
  });

  it("库里本来就没产品：empty 是 none 而不是 filtered", () => {
    expect(overviewLayout([line({ products: [] })], [t], []).empty).toBe(
      "none",
    );
  });

  it("没绑模板的产品在筛选生效时判不出状态，按不命中处理", () => {
    const bare = line({ products: [product({ templateId: null })] });
    expect(overviewLayout([bare], [t], [], onlyMissing).nodes).toHaveLength(0);
    // 不筛时照样画出来（卡片上会写「未绑规范模板」）
    expect(
      overviewLayout([bare], [t], [], NO_FILTER).nodes.filter(
        (n) => n.type === "product",
      ),
    ).toHaveLength(1);
  });
});

describe("生命线", () => {
  const t = template([
    stage("L0.1", [artifact("想法卡")]),
    stage("L0.2", [artifact("PR-FAQ"), artifact("附件", false)]),
    stage("L1", []),
  ]);

  it("阶段横向排开，阶段之间连成一条主干", () => {
    const { nodes, edges } = lifelineLayout(product(), t, undefined);
    const lanes = nodes.filter((n) => n.type === "lane");
    expect(lanes.map((l) => l.data.kind === "lane" && l.data.label)).toEqual([
      "L0.1 L0.1 阶段",
      "L0.2 L0.2 阶段",
      "L1 L1 阶段",
    ]);
    // x 递增、y 相同 = 横着排
    expect(lanes[1]?.position.x).toBeGreaterThan(lanes[0]?.position.x ?? 0);
    expect(lanes.every((l) => l.position.y === 0)).toBe(true);
    // 主干是 n-1 条边
    expect(edges).toHaveLength(2);
    expect(edges[0]).toMatchObject({ kind: "lifeline" });
  });

  it("泳道顶部对齐、高度随自己的内容走（主干在标题行，不靠等高）", () => {
    const { nodes } = lifelineLayout(product(), t, undefined);
    const lanes = nodes.filter((n) => n.type === "lane");
    // 顶部对齐是「一条生命线」的视觉依据——主干沿标题横穿
    expect(lanes.every((l) => l.position.y === 0)).toBe(true);
    // L0.2 有 2 件、L0.1 有 1 件 → 前者更高。等高会让单件的阶段白占半屏
    const [first, second] = lanes;
    expect(second?.height).toBeGreaterThan(first?.height ?? 0);
  });

  it("空阶段照画：「这一阶段一件都没有」本身就是要看的信息", () => {
    const { nodes } = lifelineLayout(product(), t, undefined);
    const empty = nodes.find((n) => n.type === "lane" && n.id === "stage:s-L1");
    expect(empty).toBeDefined();
    expect(nodes.filter((n) => n.parentId === "stage:s-L1")).toHaveLength(0);
  });

  it("没比对过时每件都是 unknown，不是 missing", () => {
    const { nodes } = lifelineLayout(product(), t, undefined);
    const arts = nodes.filter((n) => n.type === "artifact");
    expect(arts).toHaveLength(3);
    expect(
      arts.every(
        (a) => a.data.kind === "artifact" && a.data.status === "unknown",
      ),
    ).toBe(true);
  });

  it("「只看必交」把选填项排除掉，连它所在的空列也一起退出", () => {
    const { nodes } = lifelineLayout(product(), t, undefined, {
      statuses: new Set(),
      requiredOnly: true,
    });
    const names = nodes
      .filter((n) => n.type === "artifact")
      .map((n) => (n.data.kind === "artifact" ? n.data.artifact : ""));
    expect(names).toEqual(["想法卡", "PR-FAQ"]);
    // L1 本来就没产出物，筛选生效时不占位置
    expect(nodes.some((n) => n.id === "stage:s-L1")).toBe(false);
  });

  it("筛掉全部时 empty 是 filtered，模板本来就空才是 none", () => {
    const filtered = lifelineLayout(product(), t, undefined, onlyMissing);
    expect(filtered.nodes).toHaveLength(0);
    expect(filtered.empty).toBe("filtered");

    const bare = lifelineLayout(
      product(),
      template([stage("L1", [])]),
      undefined,
    );
    expect(bare.empty).toBe(null); // 空阶段照画，所以不算空图
  });

  it("比对结果直接映到节点上，partial 带着 finding 一起给（抽屉要用）", () => {
    const c = check([
      { artifact: "想法卡", status: "present" },
      { artifact: "PR-FAQ", status: "partial" },
    ]);
    const { nodes } = lifelineLayout(product(), t, c);
    const byName = new Map(
      nodes
        .filter((n) => n.data.kind === "artifact")
        .map((n) => [
          n.data.kind === "artifact" ? n.data.artifact : "",
          n.data.kind === "artifact" ? n.data : null,
        ]),
    );
    expect(byName.get("想法卡")?.status).toBe("present");
    expect(byName.get("PR-FAQ")?.status).toBe("partial");
    expect(byName.get("PR-FAQ")?.finding).toBeDefined();
    // findings 里没提到的那件，按 missing
    expect(byName.get("附件")?.status).toBe("missing");
  });
});

describe("功能架构树", () => {
  const feat = (
    name: string,
    children: FeatureNode[] = [],
    over: Partial<FeatureNode> = {},
  ): FeatureNode => ({
    id: `f-${name}`,
    productId: "p1",
    parentId: null,
    name,
    duty: "",
    evidence: [],
    source: "ai",
    sessionId: null,
    level: 1,
    children,
    ...over,
  });

  it("列 = 层级：同一层 x 相同，下一层 x 更大", () => {
    const { nodes } = architectureLayout([
      feat("接入", [feat("Key 管理"), feat("配额")]),
    ]);
    const byName = new Map(
      nodes.map((n) => [n.data.kind === "feature" ? n.data.node.name : "", n]),
    );
    const root = byName.get("接入");
    const a = byName.get("Key 管理");
    const b = byName.get("配额");
    expect(a?.position.x).toBe(b?.position.x);
    expect(a?.position.x).toBeGreaterThan(root?.position.x ?? 0);
  });

  it("父居子中点——这是「层级树不引 dagre」的那条排布规则", () => {
    const { nodes } = architectureLayout([
      feat("接入", [feat("A"), feat("B"), feat("C")]),
    ]);
    const y = (name: string) =>
      nodes.find((n) => n.data.kind === "feature" && n.data.node.name === name)
        ?.position.y ?? 0;
    // 三个孩子纵向依次排开，父亲落在首尾的正中间
    expect(y("B")).toBeGreaterThan(y("A"));
    expect(y("C")).toBeGreaterThan(y("B"));
    expect(y("接入")).toBeCloseTo((y("A") + y("C")) / 2, 5);
  });

  it("多棵一级功能的子树不重叠（叶子按出现顺序各领一个槽位）", () => {
    const { nodes } = architectureLayout([
      feat("甲", [feat("甲1"), feat("甲2")]),
      feat("乙", [feat("乙1")]),
    ]);
    const y = (name: string) =>
      nodes.find((n) => n.data.kind === "feature" && n.data.node.name === name)
        ?.position.y ?? 0;
    expect(y("乙1")).toBeGreaterThan(y("甲2"));
  });

  it("边是父 → 子，条数 = 节点数 - 根数", () => {
    const { nodes, edges } = architectureLayout([
      feat("甲", [feat("甲1", [feat("甲1a")])]),
      feat("乙"),
    ]);
    expect(nodes).toHaveLength(4);
    expect(edges).toHaveLength(2);
    // 后序遍历：深的那条先产出，所以断言「存在」而不是「第一条就是」
    expect(edges.map((e) => `${e.source}->${e.target}`)).toEqual(
      expect.arrayContaining([
        "feature:f-甲->feature:f-甲1",
        "feature:f-甲1->feature:f-甲1a",
      ]),
    );
  });

  it("搜索命中时整支保留——只留命中的那个会把树打成碎片", () => {
    const { nodes } = architectureLayout(
      [feat("接入", [feat("Key 管理"), feat("配额")]), feat("计费")],
      { search: "key" },
    );
    const names = nodes.map((n) =>
      n.data.kind === "feature" ? n.data.node.name : "",
    );
    // 命中 Key 管理 → 它的父「接入」要在（否则它悬空）
    expect(names).toContain("接入");
    expect(names).toContain("Key 管理");
    // 同层没命中的兄弟与别的支不画
    expect(names).not.toContain("配额");
    expect(names).not.toContain("计费");
  });

  it("搜不到是 filtered，本来就没有是 none", () => {
    expect(architectureLayout([feat("甲")], { search: "zzz" }).empty).toBe(
      "filtered",
    );
    expect(architectureLayout([]).empty).toBe("none");
  });

  it("childCount 来自真实子节点数——0 表示「还没往下拆过」", () => {
    const { nodes } = architectureLayout([feat("甲", [feat("甲1")])]);
    const get = (name: string) =>
      nodes.find((n) => n.data.kind === "feature" && n.data.node.name === name)
        ?.data;
    expect(get("甲")?.kind === "feature" && get("甲")).toMatchObject({
      childCount: 1,
    });
    expect(get("甲1")?.kind === "feature" && get("甲1")).toMatchObject({
      childCount: 0,
    });
  });
});
