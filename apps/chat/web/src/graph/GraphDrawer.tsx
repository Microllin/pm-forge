import {
  ClipboardCheck,
  Code2,
  FolderOpen,
  ListChecks,
  Network,
  Pencil,
  RefreshCw,
  Scissors,
  Trash2,
  X,
} from "lucide-react";

import {
  STATUS_LABEL,
  type ArtifactNodeData,
  type FeatureNodeData,
  type ProductNodeData,
} from "./layout";

/**
 * 详情抽屉 —— 这就是「产品 wiki」那一半。
 *
 * 图谱回答「哪里不对」，抽屉回答「到底是什么、凭什么这么判、下一步做什么」。
 * 两者不分家（参考的运维控制台也是这个结构：拓扑 + EntitySnapshotDrawer）。
 *
 * 抽屉里**不重复节点上已经显示的东西**，只放节点放不下的：写作指引、判定要点全文、
 * 漏了哪几条、证据文件、AI 的备注。
 */
export function GraphDrawer({
  node,
  onClose,
  busy = false,
  onOpenLifeline,
  onOpenArchitecture,
  onCompare,
  onExpand,
  onReanalyze,
  onEditFeature,
  onDeleteFeature,
}: {
  node: ProductNodeData | ArtifactNodeData | FeatureNodeData;
  onClose: () => void;
  /** 有分析在发起中。按钮要变 disabled 而不是整个消失——消失会让布局在点击那一刻跳。 */
  busy?: boolean | undefined;
  /** 产品抽屉里的「看它的生命线」。 */
  onOpenLifeline?: ((productId: string) => void) | undefined;
  /** 产品抽屉里的「看它的功能架构」。 */
  onOpenArchitecture?: ((productId: string) => void) | undefined;
  /** 产品抽屉里的「让 AI 比对一次」。 */
  onCompare?: ((productId: string) => void) | undefined;
  /** 功能节点：向下拆一层（只补不覆盖）。 */
  onExpand?: ((nodeId: string) => void) | undefined;
  /** 功能节点：重新分析这一支（覆盖）。 */
  onReanalyze?: ((nodeId: string) => void) | undefined;
  onEditFeature?: ((node: FeatureNodeData) => void) | undefined;
  onDeleteFeature?: ((node: FeatureNodeData) => void) | undefined;
}): React.JSX.Element {
  const title =
    node.kind === "product"
      ? node.product.name
      : node.kind === "artifact"
        ? node.artifact
        : node.node.name;
  return (
    <aside className="g-drawer" aria-label="详情">
      <header className="g-drawer-head">
        <h3>{title}</h3>
        <button
          type="button"
          className="icon-btn ghost"
          aria-label="关闭详情"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>

      {node.kind === "product" && (
        <ProductBody
          data={node}
          busy={busy}
          onOpenLifeline={onOpenLifeline}
          onOpenArchitecture={onOpenArchitecture}
          onCompare={onCompare}
        />
      )}
      {node.kind === "artifact" && <ArtifactBody data={node} />}
      {node.kind === "feature" && (
        <FeatureBody
          data={node}
          busy={busy}
          onExpand={onExpand}
          onReanalyze={onReanalyze}
          onEdit={onEditFeature}
          onDelete={onDeleteFeature}
        />
      )}
    </aside>
  );
}

function ProductBody({
  data,
  busy,
  onOpenLifeline,
  onOpenArchitecture,
  onCompare,
}: {
  data: ProductNodeData;
  busy: boolean;
  onOpenLifeline?: ((productId: string) => void) | undefined;
  onOpenArchitecture?: ((productId: string) => void) | undefined;
  onCompare?: ((productId: string) => void) | undefined;
}): React.JSX.Element {
  const { product, density } = data;
  return (
    <>
      <dl className="kv">
        <dt>所属产品线</dt>
        <dd>{data.lineName}</dd>
        <dt>生命周期规范</dt>
        <dd>{data.templateName ?? <span className="muted">未绑定</span>}</dd>
        <dt>文档目录</dt>
        <dd>
          {product.folderPath === null ? (
            <span className="muted">未绑定</span>
          ) : (
            <code>{product.folderPath}</code>
          )}
        </dd>
        <dt>代码目录</dt>
        <dd>
          {product.codePath === null ? (
            <span className="muted">未绑定</span>
          ) : (
            <code>{product.codePath}</code>
          )}
        </dd>
        <dt>产出物</dt>
        <dd>
          {density.unknown ? (
            <span className="muted">还没比对过</span>
          ) : (
            <>
              齐 {density.present} · 不全 {density.partial} · 缺{" "}
              {density.missing}（共 {density.total}）
              {density.requiredGap > 0 && (
                <>
                  <br />
                  <span className="g-gap-text">
                    必交项还差 {density.requiredGap} 件
                  </span>
                </>
              )}
            </>
          )}
        </dd>
      </dl>

      {product.description !== "" && (
        <section className="g-drawer-section">
          <h4>定位</h4>
          <p className="desc">{product.description}</p>
        </section>
      )}

      {data.blockers.length > 0 && (
        <section className="g-drawer-section">
          <h4>还差这几步</h4>
          <ul className="g-blocker-list">
            {data.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </section>
      )}

      <footer className="g-drawer-foot">
        {onOpenLifeline !== undefined && (
          <button
            type="button"
            className="btn"
            disabled={product.templateId === null}
            title={
              product.templateId === null ? "先绑一份生命周期规范" : undefined
            }
            onClick={() => onOpenLifeline(product.id)}
          >
            <Network size={13} /> 看它的生命线
          </button>
        )}
        {onOpenArchitecture !== undefined && (
          <button
            type="button"
            className="btn"
            onClick={() => onOpenArchitecture(product.id)}
          >
            <Code2 size={13} /> 看它的功能架构
          </button>
        )}
        {onCompare !== undefined && (
          <button
            type="button"
            className="btn primary"
            disabled={
              busy || product.templateId === null || product.folderPath === null
            }
            title={
              product.templateId === null
                ? "先绑一份生命周期规范"
                : product.folderPath === null
                  ? "先绑一个文档目录"
                  : undefined
            }
            onClick={() => onCompare(product.id)}
          >
            <ClipboardCheck size={13} /> 让 AI 比对一次
          </button>
        )}
      </footer>
    </>
  );
}

function ArtifactBody({ data }: { data: ArtifactNodeData }): React.JSX.Element {
  const finding = data.finding;
  return (
    <>
      <div className="g-drawer-tags">
        <span className={`pill ${toneOf(data.status)}`}>
          {STATUS_LABEL[data.status]}
        </span>
        <span className="tag">{data.required ? "必交" : "选填"}</span>
        <span className="tag">
          {data.stageCode} {data.stageLabel}
        </span>
      </div>

      {data.status === "unknown" && (
        <p className="muted small">
          这个产品还没比对过，所以不知道这件在不在。回产品行点
          <ClipboardCheck size={11} /> 跑一次比对。
        </p>
      )}

      {data.guide !== "" && (
        <section className="g-drawer-section">
          <h4>写作指引</h4>
          <p className="desc">{data.guide}</p>
        </section>
      )}

      {finding !== undefined && finding.missedCheckpoints.length > 0 && (
        <section className="g-drawer-section">
          <h4>没答到的要点</h4>
          <ol className="g-missed">
            {finding.missedCheckpoints.map((c, i) => (
              <li key={`${String(i)}-${c}`}>{c}</li>
            ))}
          </ol>
        </section>
      )}

      {data.checkpoints.length > 0 && (
        <section className="g-drawer-section">
          <h4>全部判定要点（{data.checkpoints.length} 条）</h4>
          <ol className="g-checkpoints">
            {data.checkpoints.map((c, i) => (
              <li
                key={`${String(i)}-${c}`}
                className={
                  finding?.missedCheckpoints.includes(c) === true
                    ? "missed"
                    : undefined
                }
              >
                {c}
              </li>
            ))}
          </ol>
        </section>
      )}

      {finding !== undefined && finding.files.length > 0 && (
        <section className="g-drawer-section">
          <h4>判断依据的文件</h4>
          <ul className="g-files">
            {finding.files.map((f, i) => (
              <li key={`${String(i)}-${f}`}>
                <FolderOpen size={12} className="faint" />
                <code>{f}</code>
              </li>
            ))}
          </ul>
        </section>
      )}

      {finding?.note !== undefined && finding.note !== "" && (
        <section className="g-drawer-section">
          <h4>AI 的备注</h4>
          <p className="muted small">{finding.note}</p>
        </section>
      )}

      {finding?.judged === false && (
        <p className="g-gap-text small">
          <ListChecks size={12} /> 上一轮比对里模型没给这件的结论，按「缺」计。
        </p>
      )}
    </>
  );
}

const toneOf = (status: ArtifactNodeData["status"]): string =>
  status === "present"
    ? "ok"
    : status === "partial"
      ? "warn"
      : status === "missing"
        ? "bad"
        : "mild";

/**
 * 功能节点的抽屉。两个 AI 动作在这里，而不是画在节点上：
 * 节点已经有名称 / 职责 / 证据数 / 子功能数四行信息，再塞两个按钮会挤成一团，
 * 而且画布缩放时按钮会小到点不中。
 */
function FeatureBody({
  data,
  busy,
  onExpand,
  onReanalyze,
  onEdit,
  onDelete,
}: {
  data: FeatureNodeData;
  busy: boolean;
  onExpand?: ((nodeId: string) => void) | undefined;
  onReanalyze?: ((nodeId: string) => void) | undefined;
  onEdit?: ((node: FeatureNodeData) => void) | undefined;
  onDelete?: ((node: FeatureNodeData) => void) | undefined;
}): React.JSX.Element {
  const { node, childCount } = data;
  return (
    <>
      <div className="g-drawer-tags">
        <span className="tag">第 {node.level} 层</span>
        <span className="tag">
          {childCount === 0 ? "未拆下级" : `${String(childCount)} 个子功能`}
        </span>
        {node.source === "manual" && <span className="pill warn">手改过</span>}
      </div>

      {node.duty !== "" ? (
        <section className="g-drawer-section">
          <h4>职责</h4>
          <p className="desc">{node.duty}</p>
        </section>
      ) : (
        <p className="muted small">
          没写职责。说不清「它为谁做了什么」的条目，多半不是一个功能。
        </p>
      )}

      <section className="g-drawer-section">
        <h4>代码证据</h4>
        {node.evidence.length === 0 ? (
          <p className="muted small">
            没有代码证据。这会有两个后果：无法复查 AI 凭什么这么判；
            「向下拆一层」时只能重扫整个代码目录，又慢又容易带进别的分支。
          </p>
        ) : (
          <ul className="g-files">
            {node.evidence.map((e, i) => (
              <li key={`${String(i)}-${e}`}>
                <Code2 size={12} className="faint" />
                <code>{e}</code>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="g-drawer-foot">
        {onExpand !== undefined && (
          <button
            type="button"
            className="btn primary"
            title="只分析它的直接子功能，已有的不动"
            disabled={busy}
            onClick={() => onExpand(node.id)}
          >
            <Scissors size={13} /> 向下拆一层
          </button>
        )}
        {onReanalyze !== undefined && (
          <button
            type="button"
            className="btn"
            title={
              childCount === 0
                ? "这一支下还没有子功能，直接用「向下拆一层」就行"
                : "重新分析这一支，用新结果覆盖现有的子功能"
            }
            disabled={busy || childCount === 0}
            onClick={() => onReanalyze(node.id)}
          >
            <RefreshCw size={13} /> 重新分析这一支
          </button>
        )}
        {onEdit !== undefined && (
          <button type="button" className="btn" onClick={() => onEdit(data)}>
            <Pencil size={13} /> 编辑
          </button>
        )}
        {onDelete !== undefined && (
          <button
            type="button"
            className="btn danger"
            onClick={() => onDelete(data)}
          >
            <Trash2 size={13} /> 删除
          </button>
        )}
      </footer>
    </>
  );
}
