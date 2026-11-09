import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Boxes, CircleSlash, FolderOpen, ListChecks } from "lucide-react";

import {
  STATUS_LABEL,
  type ArtifactNodeData,
  type Density,
  type FeatureNodeData,
  type LaneNodeData,
  type ProductNodeData,
} from "./layout";

/**
 * 图谱的三种节点。
 *
 * **全部 memo**：画布平移缩放时 React Flow 会高频重渲染，不 memo 每个节点都跟着跑
 * （老规范里「列表行组件必须 memo」是同一条理由，这里节点数量级更大）。
 *
 * 泳道是 React Flow 的分组节点，不是 HTML 覆盖层——参考的运维控制台的 TopologyCanvas.vue
 * 注释里记着他们踩过的坑：「HTML 覆盖层追 X6 transform 会错位」。分组节点与业务节点
 * 共享同一个坐标系，不存在这个问题。
 */

/** 密度条。未比对时整条置灰并写「未比对」，不画成 0%——那会被读成「全缺」。 */
function DensityBar({ density }: { density: Density }): React.JSX.Element {
  if (density.unknown)
    return (
      <div className="density">
        <div className="density-bar">
          <span className="density-seg unknown" style={{ flex: 1 }} />
        </div>
        <span className="density-text muted">未比对</span>
      </div>
    );
  const { present, partial, missing, total, requiredGap } = density;
  return (
    <div className="density">
      <div className="density-bar">
        {present > 0 && (
          <span className="density-seg present" style={{ flex: present }} />
        )}
        {partial > 0 && (
          <span className="density-seg partial" style={{ flex: partial }} />
        )}
        {missing > 0 && (
          <span className="density-seg missing" style={{ flex: missing }} />
        )}
      </div>
      <span className="density-text">
        {present}/{total} 齐
        {requiredGap > 0 && (
          <span className="density-gap"> · 必交差 {requiredGap}</span>
        )}
      </span>
    </div>
  );
}

export const LaneNode = memo(function LaneNode({
  data,
}: NodeProps & { data: LaneNodeData }): React.JSX.Element {
  return (
    <div className={`g-lane ${data.tone}`}>
      {/*
        生命线主干连的是泳道本身，所以句柄挂在这里。
        刻意抬到标题行的高度（默认在泳道垂直中点）：那样主干会沿着阶段标题横穿，
        读起来是一条时间轴；挂在中点的话只是「盒子之间的几截短线」，看不出是一条线。
      */}
      <Handle
        type="target"
        position={Position.Left}
        isConnectable={false}
        style={{ top: 26 }}
      />
      <Handle
        type="source"
        position={Position.Right}
        isConnectable={false}
        style={{ top: 26 }}
      />
      <div className="g-lane-head">
        <strong>{data.label}</strong>
        {data.sub !== "" && <span className="muted small">{data.sub}</span>}
      </div>
    </div>
  );
});

export const ProductNode = memo(function ProductNode({
  data,
  selected,
}: NodeProps & { data: ProductNodeData }): React.JSX.Element {
  return (
    <div className={`g-card g-product${selected ? " selected" : ""}`}>
      <div className="g-card-head">
        <Boxes size={14} className="faint" />
        <strong>{data.product.name}</strong>
      </div>
      <DensityBar density={data.density} />
      {data.blockers.length > 0 && (
        <span className="g-blockers">{data.blockers.join(" · ")}</span>
      )}
    </div>
  );
});

export const ArtifactNode = memo(function ArtifactNode({
  data,
  selected,
}: NodeProps & { data: ArtifactNodeData }): React.JSX.Element {
  return (
    <div
      className={`g-card g-artifact ${data.status}${selected ? " selected" : ""}`}
    >
      <div className="g-card-head">
        <span className={`g-dot ${data.status}`} aria-hidden="true" />
        <strong title={data.artifact}>{data.artifact}</strong>
      </div>
      <div className="g-artifact-meta">
        <span className="muted small">
          {STATUS_LABEL[data.status]}
          {data.required ? " · 必交" : " · 选填"}
        </span>
        {data.status === "partial" && data.finding !== undefined && (
          <span className="muted small">
            漏 {data.finding.missedCheckpoints.length} 条
          </span>
        )}
      </div>
    </div>
  );
});

/** 产品没绑模板时生命线画不出来——给一个说清下一步的占位，而不是空白画布。 */
export function NoTemplate({
  productName,
}: {
  productName: string;
}): React.JSX.Element {
  return (
    <div className="g-empty">
      <CircleSlash size={28} className="faint" />
      <p>「{productName}」还没绑生命周期规范</p>
      <p className="muted small">
        回「产品」标签，编辑这个产品选一份模板；没有模板就画不出它该走哪些阶段。
      </p>
      <p className="muted small">
        <ListChecks size={12} /> 绑模板 → <FolderOpen size={12} /> 绑目录 → AI
        比对，三步做完这张图才有颜色。
      </p>
    </div>
  );
}

/**
 * 功能架构树的节点。
 *
 * 右下角那个计数不是装饰：**0 表示「还没往下拆过」**，是提示用户这里可以点
 * 「向下拆一层」；有数字表示已经拆过。没有它，叶子节点与「拆完发现没有子功能」
 * 的节点长得一模一样。
 */
export const FeatureNode = memo(function FeatureNode({
  data,
  selected,
}: NodeProps & { data: FeatureNodeData }): React.JSX.Element {
  const { node, childCount } = data;
  return (
    <div className={`g-card g-feature${selected ? " selected" : ""}`}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      <div className="g-card-head">
        <span className="g-level">L{node.level}</span>
        <strong title={node.name}>{node.name}</strong>
        {node.source === "manual" && <span className="tag">手改</span>}
      </div>
      {node.duty !== "" && <p className="g-feature-duty">{node.duty}</p>}
      <div className="g-feature-meta">
        <span className="muted small">
          {node.evidence.length > 0
            ? `${String(node.evidence.length)} 处代码证据`
            : "无代码证据"}
        </span>
        <span className={`muted small${childCount === 0 ? " g-leaf" : ""}`}>
          {childCount === 0 ? "未拆下级" : `${String(childCount)} 个子功能`}
        </span>
      </div>
    </div>
  );
});
