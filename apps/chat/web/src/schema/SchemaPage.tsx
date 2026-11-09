import { memo, useEffect, useMemo, useState } from "react";
import {
  Database,
  KeyRound,
  Link2,
  Loader2,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import { listLines, type Product } from "../products/api";
import { Select } from "../ui/Select";
import {
  getSubsystem,
  listSubsystems,
  type SchemaFormat,
  type SchemaRelation,
  type SchemaTable,
} from "./api";
import {
  ALL_LIMIT,
  KIND_LABEL,
  matchTable,
  schemaLayout,
  type TableNodeData,
} from "./layout";
import "./schema.css";

/**
 * 产品 → 数据结构（ER 图）。
 *
 * 数据从产品绑定的代码目录里**读**出来（ent / Prisma / SQL 迁移脚本），不连数据库；
 * 与对话里交给 AI 的「数据结构」依据是同一份解析结果——图上看到的就是 AI 拿到的。
 *
 * 三栏：左边表清单（可搜）、中间关系图、右边选中表的字段详情。表多时图上只画选中的
 * 表和它的一跳邻居（见 layout.ts），在清单里点表、或在图上双击邻居，往外扩。
 */

const FORMAT_LABEL: Record<SchemaFormat, string> = {
  ent: "ent 定义",
  prisma: "Prisma 定义",
  sql: "SQL 迁移脚本",
};
const FIT = { padding: 0.15, maxZoom: 1.1 };

/** 默认导出：外壳 lazy 加载（React Flow 单独分块，同 GraphPage）。 */
export default function SchemaPage({
  productId,
}: {
  productId?: string;
}): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <SchemaInner {...(productId === undefined ? {} : { productId })} />
    </ReactFlowProvider>
  );
}

function SchemaInner({ productId }: { productId?: string }): React.JSX.Element {
  const lines = useQuery({ queryKey: ["lines"], queryFn: listLines });
  const products = useMemo(
    () =>
      (lines.data ?? []).flatMap((l) =>
        l.products.map((p) => ({ product: p, lineName: l.name })),
      ),
    [lines.data],
  );
  const [chosen, setChosen] = useState<string | null>(productId ?? null);
  // 没指定时默认第一个绑了代码目录的产品：没绑的产品这一页什么都画不出来。
  const current: Product | null = useMemo(() => {
    const hit = products.find((p) => p.product.id === chosen)?.product;
    if (hit !== undefined) return hit;
    return (
      products.find((p) => p.product.codePath !== null)?.product ??
      products[0]?.product ??
      null
    );
  }, [products, chosen]);

  const subsystems = useQuery({
    queryKey: ["schema", current?.id],
    queryFn: () => listSubsystems(current?.id ?? ""),
    enabled: current !== null && current.codePath !== null,
  });
  const [root, setRoot] = useState<string | null>(null);
  const subs = useMemo(
    () => subsystems.data?.subsystems ?? [],
    [subsystems.data],
  );
  const sub = subs.find((s) => s.root === root) ?? subs[0] ?? null;
  const detail = useQuery({
    queryKey: ["schema-tables", current?.id, sub?.root],
    queryFn: () => getSubsystem(current?.id ?? "", sub?.root ?? ""),
    enabled: current !== null && sub !== null,
  });

  return (
    <div className="s-page">
      <header className="g-toolbar">
        <div className="g-toolbar-title">
          <Database size={15} className="faint" />
          <strong>数据结构</strong>
          <span className="muted small">
            从代码里读出的表与关联，不连数据库；对话里 AI 拿到的也是这一份。
          </span>
        </div>
        <div className="g-toolbar-actions">
          <Select
            className="input sm"
            aria-label="选择产品"
            value={current?.id ?? ""}
            placeholder="选择产品"
            options={products.map((p) => ({
              value: p.product.id,
              label: `${p.lineName} / ${p.product.name}${p.product.codePath === null ? "（未绑代码）" : ""}`,
            }))}
            onChange={(v) => {
              setChosen(v);
              setRoot(null);
            }}
          />
          {subs.length > 0 && (
            <Select
              className="input sm"
              aria-label="选择子系统"
              value={sub?.root ?? ""}
              options={subs.map((s) => ({
                value: s.root,
                label: `${s.label}（${String(s.tables)} 张表）`,
              }))}
              onChange={(v) => setRoot(v)}
            />
          )}
        </div>
      </header>

      {sub !== null && (
        <p className="g-notice muted small">
          取自{FORMAT_LABEL[sub.format]}
          {sub.alsoHas.includes("sql") && sub.format !== "sql"
            ? "，另并入只在 SQL 迁移脚本里建的表"
            : ""}
          ，读了 {sub.files} 份文件 · {sub.tables} 张表 · {sub.relations}{" "}
          条关联。关联只画代码里声明了的，没画线不代表业务上没关系。
          {sub.unparsed.count > 0 && (
            <span className="s-warn" title={sub.unparsed.samples.join("\n")}>
              <TriangleAlert size={12} /> 有 {sub.unparsed.count}{" "}
              处写法没认出来，涉及的字段可能缺失
            </span>
          )}
        </p>
      )}

      {/* key：换产品 / 换子系统时整块重建，选中与搜索自然清零。 */}
      <Diagram
        key={`${current?.id ?? ""}|${sub?.root ?? ""}`}
        tables={detail.data?.tableList}
        relations={detail.data?.relationList}
        loading={
          lines.isPending ||
          subsystems.isFetching ||
          (sub !== null && detail.isPending)
        }
        error={subsystems.error ?? detail.error}
        product={current}
        noSchema={subsystems.isSuccess && subs.length === 0}
      />
    </div>
  );
}

/** 表清单 + 关系图 + 字段抽屉。选中、搜索这些状态只属于当前这一个子系统。 */
function Diagram({
  tables: rawTables,
  relations: rawRelations,
  loading,
  error,
  product,
  noSchema,
}: {
  tables: SchemaTable[] | undefined;
  relations: SchemaRelation[] | undefined;
  loading: boolean;
  error: Error | null;
  product: Product | null;
  noSchema: boolean;
}): React.JSX.Element {
  const [focus, setFocus] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const tables = useMemo(() => rawTables ?? [], [rawTables]);
  const relations = useMemo(() => rawRelations ?? [], [rawRelations]);
  const listed = useMemo(
    () =>
      tables
        .filter((t) => matchTable(t, query))
        .sort((a, b) => (a.name < b.name ? -1 : 1)),
    [tables, query],
  );
  const layout = useMemo(
    () => schemaLayout(tables, relations, focus),
    [tables, relations, focus],
  );
  const nodes: Node[] = useMemo(
    () =>
      layout.nodes.map((n) => ({
        id: n.id,
        type: "table",
        position: n.position,
        width: n.width,
        height: n.height,
        data: n.data as unknown as Record<string, unknown>,
        selected: n.data.table.name === selected,
        draggable: true,
      })),
    [layout.nodes, selected],
  );
  const edges: Edge[] = useMemo(
    () =>
      layout.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        type: "smoothstep",
        className: `s-edge ${e.kind}`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
      })),
    [layout.edges],
  );

  const { fitView } = useReactFlow();
  useEffect(() => {
    // 节点换了一批：等 React Flow 量完尺寸再适配视野。
    const t = window.setTimeout(() => void fitView(FIT), 30);
    return () => window.clearTimeout(t);
  }, [layout.nodes.length, focus, fitView]);

  const toggle = (name: string): void => {
    setFocus((prev) => {
      const next = new Set(prev);
      if (!next.delete(name)) next.add(name);
      return next;
    });
    setSelected(name);
  };
  const selectedTable =
    selected === null
      ? null
      : (tables.find((t) => t.name === selected) ?? null);

  return (
    <div className="s-body">
      <aside className="s-list" aria-label="表清单">
        <label className="g-search">
          <Search size={13} className="faint" />
          <input
            value={query}
            placeholder="按表名、字段、说明找"
            aria-label="搜索表"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {focus.size > 0 && (
          <button
            type="button"
            className="btn small ghost"
            onClick={() => {
              setFocus(new Set());
              setSelected(null);
            }}
          >
            清掉选中（{focus.size}）
          </button>
        )}
        <ul>
          {listed.map((t) => (
            <li key={t.name}>
              <button
                type="button"
                className={focus.has(t.name) ? "on" : ""}
                aria-pressed={focus.has(t.name)}
                title={t.comment ?? t.name}
                onClick={() => toggle(t.name)}
              >
                <span className="s-list-name">{t.name}</span>
                <span className="muted small">{t.fields.length}</span>
              </button>
            </li>
          ))}
        </ul>
        {tables.length > 0 && listed.length === 0 && (
          <p className="muted small pad">没有匹配的表</p>
        )}
      </aside>

      <div className="g-canvas">
        <Canvas
          loading={loading}
          error={error}
          product={product}
          noSchema={noSchema}
          needFocus={layout.mode === "focus" && focus.size === 0}
          total={tables.length}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            fitView
            fitViewOptions={FIT}
            minZoom={0.15}
            maxZoom={1.6}
            nodesConnectable={false}
            onNodeClick={(_e, node) => setSelected(node.id.slice("t:".length))}
            onNodeDoubleClick={(_e, node) => {
              // 双击邻居 = 把它也加进选中，往外扩一跳。
              const name = node.id.slice("t:".length);
              if (!focus.has(name) && layout.mode === "focus") toggle(name);
            }}
            onPaneClick={() => setSelected(null)}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        </Canvas>
      </div>

      {selectedTable !== null && (
        <TableDrawer
          table={selectedTable}
          relations={relations}
          focused={focus.has(selectedTable.name)}
          onToggle={() => toggle(selectedTable.name)}
          onJump={(name) => {
            setFocus((prev) => new Set([...prev, name]));
            setSelected(name);
          }}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/** 画布的几种「没有图」：要说清是哪一种、下一步做什么，而不是一块空白。 */
function Canvas({
  loading,
  error,
  product,
  noSchema,
  needFocus,
  total,
  children,
}: {
  loading: boolean;
  error: Error | null;
  product: Product | null;
  noSchema: boolean;
  needFocus: boolean;
  total: number;
  children: React.ReactNode;
}): React.JSX.Element {
  if (loading)
    return (
      <div className="g-empty">
        <Loader2 size={20} className="spin faint" />
        <p className="muted small">读取代码里的表结构…</p>
      </div>
    );
  if (error !== null)
    return (
      <div className="g-empty">
        <p className="err-text">读取失败：{error.message}</p>
      </div>
    );
  if (product === null)
    return (
      <div className="g-empty">
        <Database size={28} className="faint" />
        <p>还没有产品</p>
        <p className="muted small">
          先去「产品」标签建产品，并给它绑代码目录。
        </p>
      </div>
    );
  if (product.codePath === null)
    return (
      <div className="g-empty">
        <Database size={28} className="faint" />
        <p>「{product.name}」还没绑代码目录</p>
        <p className="muted small">
          表结构是从代码里读的。去「产品」标签给它绑一个代码目录（事实底座 →
          代码库里的仓库或其中的子目录）。
        </p>
      </div>
    );
  if (noSchema)
    return (
      <div className="g-empty">
        <Database size={28} className="faint" />
        <p>代码目录里没找到表结构定义</p>
        <p className="muted small">
          目前认三种写法：ent（Go，ent/schema 目录）、Prisma（.prisma 文件）、
          SQL 迁移脚本（migrations 目录里的 .sql）。
        </p>
      </div>
    );
  if (needFocus)
    return (
      <div className="g-empty">
        <Link2 size={28} className="faint" />
        <p>这个子系统有 {total} 张表</p>
        <p className="muted small">
          超过 {ALL_LIMIT}{" "}
          张一屏看不清。从左边清单（可以搜）点几张表，图上会画出它们和直接相连的表；
          在图上双击相连的表，可以继续往外扩。
        </p>
      </div>
    );
  return <>{children}</>;
}

const TableNode = memo(function TableNode({
  data,
  selected,
}: NodeProps & { data: TableNodeData }): React.JSX.Element {
  const { table, rows, hidden, focused, offscreen } = data;
  return (
    <div
      className={`s-node${focused ? " focused" : ""}${selected ? " selected" : ""}`}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <div className="s-node-head">
        <strong title={table.name}>{table.name}</strong>
        <span className="muted small" title={table.comment ?? undefined}>
          {table.comment?.split("\n")[0] ??
            (table.entity !== table.name ? table.entity : "")}
        </span>
      </div>
      <ul className="s-node-rows">
        {rows.map((r) => (
          <li key={r.name}>
            <span className={`s-key ${r.key ?? ""}`}>
              {r.key === "pk" ? "PK" : r.key === "fk" ? "FK" : ""}
            </span>
            <span className="s-col">{r.name}</span>
            <span className="s-type">{r.type}</span>
          </li>
        ))}
      </ul>
      {(hidden > 0 || offscreen > 0) && (
        <div className="s-node-foot muted small">
          {hidden > 0 && `还有 ${String(hidden)} 个字段`}
          {hidden > 0 && offscreen > 0 && " · "}
          {offscreen > 0 && `${String(offscreen)} 条关联在图外`}
        </div>
      )}
    </div>
  );
});

const NODE_TYPES = { table: TableNode };

function TableDrawer({
  table,
  relations,
  focused,
  onToggle,
  onJump,
  onClose,
}: {
  table: SchemaTable;
  relations: readonly SchemaRelation[];
  focused: boolean;
  onToggle: () => void;
  onJump: (table: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const out = relations.filter((r) => r.from === table.name);
  const inbound = relations.filter(
    (r) => r.to === table.name && r.from !== table.name,
  );
  return (
    <aside className="g-drawer" aria-label={`表 ${table.name} 的详情`}>
      <header className="g-drawer-head">
        <h3>{table.name}</h3>
        <button
          type="button"
          className="icon-btn ghost"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {table.entity !== table.name && (
        <p className="muted small">代码里的实体名：{table.entity}</p>
      )}
      {table.comment !== null && (
        <section className="g-drawer-section">
          <h4>说明</h4>
          <p className="s-pre">{table.comment}</p>
        </section>
      )}
      <section className="g-drawer-section">
        <h4>字段（{table.fields.length}）</h4>
        <ul className="s-fields">
          {table.fields.map((f) => (
            <li key={f.name}>
              <div>
                {f.flags.includes("主键") && (
                  <KeyRound size={11} className="s-pk" aria-label="主键" />
                )}
                <code>{f.name}</code>
                <span className="s-type">
                  {f.type}
                  {f.nullable ? " · 可空" : ""}
                </span>
              </div>
              {f.flags.filter((x) => x !== "主键").length > 0 && (
                <div className="muted small">
                  {f.flags.filter((x) => x !== "主键").join(" · ")}
                </div>
              )}
              {f.comment !== null && (
                <div className="s-note small">{f.comment}</div>
              )}
            </li>
          ))}
        </ul>
      </section>
      {out.length + inbound.length > 0 && (
        <section className="g-drawer-section">
          <h4>关联</h4>
          <ul className="s-rels">
            {out.map((r) => (
              <li key={`o-${r.field ?? ""}-${r.to}-${r.label ?? ""}`}>
                <code>{r.field ?? "（无外键字段）"}</code> →{" "}
                <button
                  type="button"
                  className="link"
                  onClick={() => onJump(r.to)}
                >
                  {r.to}
                </button>
                <span className="muted small"> {KIND_LABEL[r.kind]}</span>
              </li>
            ))}
            {inbound.map((r) => (
              <li key={`i-${r.from}-${r.field ?? ""}-${r.label ?? ""}`}>
                <button
                  type="button"
                  className="link"
                  onClick={() => onJump(r.from)}
                >
                  {r.from}
                </button>
                {r.field === null ? "" : <code>.{r.field}</code>} → 本表
                <span className="muted small"> {KIND_LABEL[r.kind]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="g-drawer-section">
        <h4>来源</h4>
        <code>{table.source}</code>
      </section>
      <footer className="g-drawer-foot">
        <button type="button" className="btn" onClick={onToggle}>
          {focused ? "从图上移出" : "加到图上"}
        </button>
      </footer>
    </aside>
  );
}
