import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Code2,
  Filter,
  Loader2,
  Maximize2,
  Network,
  Plus,
  Search,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import {
  deleteFeature,
  listChecks,
  listFeatures,
  startArchitecture,
  startCompare,
  type Started,
} from "../analysis/api";
import { listTemplates } from "../lifecycle/api";
import { listLines } from "../products/api";
import { FeatureDialog } from "./FeatureDialog";
import { GraphDrawer } from "./GraphDrawer";
import {
  NO_FILTER,
  architectureLayout,
  filterActive,
  lifelineLayout,
  overviewLayout,
  type FeatureNodeData,
  type GraphFilter,
  type GraphNodeData,
  type Layout,
  type NodeStatus,
} from "./layout";
import {
  ArtifactNode,
  FeatureNode,
  LaneNode,
  NoTemplate,
  ProductNode,
} from "./nodes";
import "./graph.css";

/**
 * 产品 → 图谱。三张图，一个壳：
 *
 * - **产品全景**：泳道 = 产品线，卡片 = 产品（按产出物齐备度着色）。答「哪个产品欠得多」。
 * - **生命线**：阶段 L0.1→L5.2 横向排开，产出物挂在阶段下。答「欠在哪一步」。
 * - **功能架构**：AI 读代码分析出的一级/二级/三级…功能树。答「这产品到底有哪些功能」。
 *
 * 前两张的数据在前端组装（产品线 / 模板 / 比对三个现成查询）；第三张走
 * `/api/products/:id/features`，因为它是独立的一棵树、不是现有数据的投影。
 *
 * 布局见 layout.ts（纯函数、可单测）。这里只负责交给 React Flow 并处理交互。
 */
const NODE_TYPES = {
  lane: LaneNode,
  product: ProductNode,
  artifact: ArtifactNode,
  feature: FeatureNode,
};

/** 生命线的筛选只有两个维度：状态、是否必交。 */
const STATUS_CHOICES: { id: NodeStatus; label: string }[] = [
  { id: "missing", label: "缺" },
  { id: "partial", label: "不全" },
  { id: "present", label: "齐" },
  { id: "unknown", label: "未比对" },
];

/**
 * 适应窗口的参数。**`minZoom` 是关键**：生命线有十几列、三千多像素宽，
 * 不设下限时 fitView 会缩到 0.45 倍——全在屏幕里，但一个字都看不清。
 * 宁可只露出前几个阶段让人横着拖，也不要给一张糊的全图。
 *
 * 放模块级：它是常量，放渲染体里每帧新建一个对象。
 */
const FIT = { padding: 0.12, minZoom: 0.62, duration: 200 };

/** 钻进某个产品后看哪一张图。 */
interface Focus {
  kind: "lifeline" | "architecture";
  productId: string;
}

/**
 * 默认导出而不是具名：外壳用 `lazy(() => import(...))` 把它单独分块。
 * React Flow 约 190 KB，而图谱只是五个菜单里的一个标签。
 */
export default function GraphPage({
  onAnalysis,
  productId,
}: {
  /** 发起 AI 分析：交给外壳带到对话上，与产品页同一条路径。 */
  onAnalysis: (started: Started) => void;
  /**
   * 打开时直接钻进这个产品的生命线。产品页点卡片进来走这条：
   * 「这个产品该交什么、还缺什么」是产品页上最常问的问题，不该让人到了图谱再点一次。
   */
  productId?: string;
}): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <GraphInner
        onAnalysis={onAnalysis}
        {...(productId === undefined ? {} : { productId })}
      />
    </ReactFlowProvider>
  );
}

function GraphInner({
  onAnalysis,
  productId,
}: {
  onAnalysis: (started: Started) => void;
  productId?: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const lines = useQuery({ queryKey: ["lines"], queryFn: listLines });
  const templates = useQuery({
    queryKey: ["lifecycle-templates"],
    queryFn: listTemplates,
  });
  const checks = useQuery({
    queryKey: ["product-checks"],
    queryFn: listChecks,
  });
  const { fitView, zoomTo } = useReactFlow();

  const [focus, setFocus] = useState<Focus | null>(
    productId === undefined ? null : { kind: "lifeline", productId },
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<GraphFilter>(NO_FILTER);
  /** 架构图的关键字过滤（功能多了以后按名字 / 职责找）。 */
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState<
    | { mode: "new"; parent: FeatureNodeData | null }
    | { mode: "edit"; node: FeatureNodeData }
    | null
  >(null);

  // `?? []` 直接写在渲染体里会每帧产出一个新数组，下面几个 useMemo 的依赖就永远在变
  // （lint 会直接报「memoization could not be preserved」）。各自 memo 一次，空数组引用才稳。
  const allLines = useMemo(() => lines.data ?? [], [lines.data]);
  const allTemplates = useMemo(() => templates.data ?? [], [templates.data]);
  const allChecks = useMemo(() => checks.data ?? [], [checks.data]);

  const focusId = focus?.productId ?? null;
  /** 架构树只在钻进架构图时才取。 */
  const features = useQuery({
    queryKey: ["features", focusId],
    queryFn: () => listFeatures(focusId ?? ""),
    enabled: focus?.kind === "architecture" && focusId !== null,
  });
  const featureTree = useMemo(() => features.data ?? [], [features.data]);

  const target = useMemo(() => {
    if (focusId === null) return null;
    const product = allLines
      .flatMap((l) => l.products)
      .find((p) => p.id === focusId);
    if (product === undefined) return null;
    const templateId = product.templateId;
    return {
      product,
      template:
        templateId === null
          ? null
          : (allTemplates.find((t) => t.id === templateId) ?? null),
      check: allChecks.find((c) => c.productId === product.id),
    };
  }, [focusId, allLines, allTemplates, allChecks]);

  const pending =
    lines.isPending ||
    templates.isPending ||
    checks.isPending ||
    (focus?.kind === "architecture" && features.isPending);

  const layout: Layout = useMemo(() => {
    if (focus === null || target === null)
      return overviewLayout(allLines, allTemplates, allChecks, filter);
    if (focus.kind === "architecture")
      return architectureLayout(featureTree, { search });
    if (target.template === null) return { nodes: [], edges: [], empty: null };
    return lifelineLayout(
      target.product,
      target.template,
      target.check,
      filter,
    );
  }, [
    focus,
    target,
    allLines,
    allTemplates,
    allChecks,
    filter,
    featureTree,
    search,
  ]);

  const nodes: Node[] = useMemo(
    () =>
      layout.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data as unknown as Record<string, unknown>,
        width: n.width,
        height: n.height,
        selected: n.id === selected,
        // 泳道不可选不可拖：它是容器，点它应该穿透到背景（= 取消选中）。
        selectable: n.type !== "lane",
        draggable: false,
        ...(n.parentId === undefined
          ? {}
          : { parentId: n.parentId, extent: "parent" as const }),
      })),
    [layout.nodes, selected],
  );
  const edges: Edge[] = useMemo(
    () =>
      layout.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: "smoothstep",
        animated: false,
        className: `g-edge ${e.kind}`,
      })),
    [layout.edges],
  );

  const selectedData: GraphNodeData | null = useMemo(() => {
    const hit = layout.nodes.find((n) => n.id === selected);
    return hit && hit.data.kind !== "lane" ? hit.data : null;
  }, [layout.nodes, selected]);

  // 换视图 / 换筛选后重新适应：节点位置全变了，留在原视口多半看的是空白。
  // 推迟一拍等 React Flow 把新节点量好尺寸。**timer 要能被清掉**：
  // 组件卸载后再跑 fitView，React Flow 实例已销毁。
  const refitTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (refitTimer.current !== null) window.clearTimeout(refitTimer.current);
    },
    [],
  );
  const refit = (): void => {
    if (refitTimer.current !== null) window.clearTimeout(refitTimer.current);
    refitTimer.current = window.setTimeout(() => void fitView(FIT), 0);
  };

  const go = (next: Focus | null): void => {
    setFocus(next);
    setSelected(null);
    setNotice(null);
    refit();
  };

  /** 发起一次 AI 分析（比对 / 架构），统一的忙碌与报错处理。 */
  const run = (start: () => Promise<Started>): void => {
    setBusy(true);
    setNotice(null);
    void start()
      .then(onAnalysis)
      .catch((cause: unknown) => {
        // 没绑模板 / 没绑目录 / 没绑代码目录都会走这里（409），文案由服务端给。
        setNotice(cause instanceof Error ? cause.message : "发起分析失败");
      })
      .finally(() => setBusy(false));
  };

  const refreshFeatures = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ["features", focusId] });

  const removeFeature = (data: FeatureNodeData): void => {
    const extra =
      data.childCount > 0
        ? `它下面的 ${String(data.childCount)} 个子功能会一并删除。`
        : "";
    if (!window.confirm(`删除功能「${data.node.name}」？${extra}`)) return;
    void deleteFeature(data.node.id)
      .then(refreshFeatures)
      .then(() => setSelected(null))
      .catch((cause: unknown) => {
        setNotice(cause instanceof Error ? cause.message : "删除失败");
      });
  };

  const toggleStatus = (id: NodeStatus): void =>
    setFilter((f) => {
      const statuses = new Set(f.statuses);
      if (!statuses.delete(id)) statuses.add(id);
      return { ...f, statuses };
    });

  const architecture = focus?.kind === "architecture";

  return (
    <div className="g-page">
      <header className="g-toolbar">
        {focus === null || target === null ? (
          <div className="g-toolbar-title">
            <Network size={15} className="faint" />
            <strong>产品全景</strong>
            <span className="muted small">
              泳道是产品线，卡片是产品；颜色来自最近一次产出物比对。点卡片看详情，双击钻进去。
            </span>
          </div>
        ) : (
          <div className="g-toolbar-title">
            <button type="button" className="btn" onClick={() => go(null)}>
              <ArrowLeft size={13} /> 全景
            </button>
            <strong>
              {target.product.name} · {architecture ? "功能架构" : "生命线"}
            </strong>
            <span className="seg" role="group" aria-label="切换这个产品的视图">
              <button
                type="button"
                className={architecture ? "" : "on"}
                aria-pressed={!architecture}
                onClick={() =>
                  go({ kind: "lifeline", productId: target.product.id })
                }
              >
                生命线
              </button>
              <button
                type="button"
                className={architecture ? "on" : ""}
                aria-pressed={architecture}
                onClick={() =>
                  go({ kind: "architecture", productId: target.product.id })
                }
              >
                功能架构
              </button>
            </span>
          </div>
        )}

        <div className="g-toolbar-actions">
          {architecture ? (
            <>
              <label className="g-search">
                <Search size={13} className="faint" />
                <input
                  value={search}
                  placeholder="按功能名或职责找"
                  aria-label="搜索功能"
                  onChange={(e) => {
                    setSearch(e.target.value);
                    refit();
                  }}
                />
              </label>
              <button
                type="button"
                className="btn"
                disabled={busy}
                title="手工加一个一级功能"
                onClick={() => setEditing({ mode: "new", parent: null })}
              >
                <Plus size={13} /> 加一级功能
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy || target === null}
                title="让 AI 读代码，分析出一级功能"
                onClick={() => {
                  if (target !== null)
                    run(() =>
                      startArchitecture({ productId: target.product.id }),
                    );
                }}
              >
                {busy ? (
                  <Loader2 size={13} className="spin" />
                ) : (
                  <Code2 size={13} />
                )}
                AI 分析一级功能
              </button>
            </>
          ) : (
            <>
              <span className="seg" role="group" aria-label="按状态筛选">
                {STATUS_CHOICES.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className={filter.statuses.has(c.id) ? "on" : ""}
                    aria-pressed={filter.statuses.has(c.id)}
                    onClick={() => {
                      toggleStatus(c.id);
                      refit();
                    }}
                  >
                    {c.label}
                  </button>
                ))}
              </span>
              <button
                type="button"
                className={`btn${filter.requiredOnly ? " ghost active" : ""}`}
                aria-pressed={filter.requiredOnly}
                onClick={() => {
                  setFilter((f) => ({ ...f, requiredOnly: !f.requiredOnly }));
                  refit();
                }}
              >
                <Filter size={13} /> 只看必交
              </button>
            </>
          )}
          <button
            type="button"
            className="btn"
            aria-label="适应窗口"
            onClick={() => void fitView(FIT)}
          >
            <Maximize2 size={13} /> 适应
          </button>
          <button
            type="button"
            className="btn"
            title="按实际大小看（1:1）"
            onClick={() => void zoomTo(1, { duration: 200 })}
          >
            1:1
          </button>
        </div>
      </header>

      {notice !== null && (
        <p className="g-notice err-text" role="alert">
          {notice}
        </p>
      )}

      <div className="g-body">
        <div className="g-canvas">
          {pending && (
            <p className="g-empty muted">
              <Loader2 size={16} className="spin" /> 读取中…
            </p>
          )}
          {!pending &&
            focus?.kind === "lifeline" &&
            target?.template === null && (
              <NoTemplate productName={target.product.name} />
            )}
          {!pending && layout.empty === "none" && (
            <div className="g-empty">
              {architecture ? (
                <>
                  <Code2 size={28} className="faint" />
                  <p>还没有功能架构</p>
                  <p className="muted small">
                    点右上角「AI 分析一级功能」——它会读这个产品绑的代码目录，
                    分析出一级功能；之后每个节点都能再往下拆。
                  </p>
                  {target?.product.codePath === null && (
                    <p className="g-gap-text small">
                      这个产品还没绑代码目录。先去「事实底座 →
                      代码」上传代码库， 再在「产品」标签里给它指一个目录。
                    </p>
                  )}
                </>
              ) : (
                <>
                  <Network size={28} className="faint" />
                  <p>还没有可画的东西</p>
                  <p className="muted small">
                    先去「产品」标签建产品线与产品（或让 AI
                    识别一遍），给产品绑上规范模板，这张图才有内容。
                  </p>
                </>
              )}
            </div>
          )}
          {!pending && layout.empty === "filtered" && (
            <div className="g-empty">
              <Filter size={28} className="faint" />
              <p>当前筛选下没有东西</p>
              <p className="muted small">
                {/* 「筛掉了」和「本来就没有」必须区分：前者该提示去掉筛选，后者该提示去建数据 */}
                有内容，但都不满足当前的筛选条件。
              </p>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setFilter(NO_FILTER);
                  setSearch("");
                  refit();
                }}
              >
                清掉筛选
              </button>
            </div>
          )}
          {!pending && layout.nodes.length > 0 && (
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={NODE_TYPES}
              fitView
              fitViewOptions={FIT}
              minZoom={0.3}
              maxZoom={1.6}
              nodesConnectable={false}
              onNodeClick={(_e, node) => setSelected(node.id)}
              onPaneClick={() => setSelected(null)}
              onNodeDoubleClick={(_e, node) => {
                // 双击产品 = 钻进它的生命线。单击只选中——双击才是「钻下去」，
                // 否则想看详情的人会被动跳走。
                if (node.id.startsWith("product:"))
                  go({
                    kind: "lifeline",
                    productId: node.id.slice("product:".length),
                  });
              }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
              <Controls showInteractive={false} />
            </ReactFlow>
          )}
        </div>

        {selectedData !== null && (
          <GraphDrawer
            node={selectedData}
            onClose={() => setSelected(null)}
            onOpenLifeline={
              selectedData.kind === "product"
                ? (id) => go({ kind: "lifeline", productId: id })
                : undefined
            }
            onOpenArchitecture={
              selectedData.kind === "product"
                ? (id) => go({ kind: "architecture", productId: id })
                : undefined
            }
            busy={busy}
            onCompare={
              selectedData.kind === "product"
                ? (productId) => run(() => startCompare(productId))
                : undefined
            }
            onExpand={
              selectedData.kind === "feature"
                ? (nodeId) =>
                    run(() =>
                      startArchitecture({
                        productId: selectedData.node.productId,
                        nodeId,
                        mode: "append",
                      }),
                    )
                : undefined
            }
            onReanalyze={
              selectedData.kind === "feature"
                ? (nodeId) =>
                    run(() =>
                      startArchitecture({
                        productId: selectedData.node.productId,
                        nodeId,
                        mode: "replace",
                      }),
                    )
                : undefined
            }
            onEditFeature={
              selectedData.kind === "feature"
                ? (node) => setEditing({ mode: "edit", node })
                : undefined
            }
            onDeleteFeature={
              selectedData.kind === "feature" ? removeFeature : undefined
            }
          />
        )}
      </div>

      {(filterActive(filter) || search.trim() !== "") && (
        <p className="g-notice muted small">
          <Filter size={12} /> 筛选生效中：被筛掉的节点已
          <strong>退出布局</strong>
          （不是变灰）—— 剩下的是真实排布，不是一张残缺的图。
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setFilter(NO_FILTER);
              setSearch("");
              refit();
            }}
          >
            清掉
          </button>
        </p>
      )}

      {busy && (
        <p className="g-notice muted small">
          <Loader2 size={12} className="spin" /> 正在建分析会话…
        </p>
      )}

      {editing !== null && focusId !== null && (
        <FeatureDialog
          productId={focusId}
          {...(editing.mode === "edit"
            ? { node: editing.node.node }
            : { parentId: editing.parent?.node.id })}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            await refreshFeatures();
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
