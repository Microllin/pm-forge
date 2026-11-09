import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Loader2,
  MinusCircle,
  X,
} from "lucide-react";

import { WikiArticle } from "../wiki/WikiArticle";
import type {
  AiFeature,
  ApplyLine,
  ArchitectureResult,
  CompareResult,
  DiscoveredProduct,
  DiscoverResult,
  Finding,
  OutlinePage,
  WikiOutlineResult,
  WikiPageResult,
} from "./api";
import { Select } from "../ui/Select";

/**
 * Esc 关闭。各结果面板共用。
 *
 * 这些面板挂了 `role="dialog" aria-modal="true"`，等于承诺了 Esc 可关、焦点不外泄；
 * 不实现的话键盘用户按 Esc 没反应。仓里另外四个弹窗都做了，这里补齐。
 */
function useEscape(onClose: () => void, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, enabled]);
}

/**
 * 确认表里一个产品的事实依据：代码目录 + 参考资料，可逐条去掉；
 * AI 给了但服务端没采用的（找不到、放错地方）单独列出来，不悄悄丢。
 */
function EvidenceRows({
  code,
  refs,
  dropped,
  disabled,
  onRemove,
}: {
  code: string;
  refs: string[];
  dropped: { path: string; why: string }[];
  disabled: boolean;
  onRemove: (what: "code" | "ref", path: string) => void;
}): React.JSX.Element {
  const item = (what: "code" | "ref", path: string): React.JSX.Element => (
    <li key={`${what}:${path}`}>
      <span className="tag">{what === "code" ? "代码" : "参考"}</span>
      <code className="review-path">{path}</code>
      <button
        type="button"
        className="icon-btn ghost"
        aria-label={`去掉 ${path}`}
        disabled={disabled}
        onClick={() => onRemove(what, path)}
      >
        <X size={12} />
      </button>
    </li>
  );
  return (
    <div className="review-evidence">
      <ul aria-label="事实依据">
        {code === "" ? (
          <li className="muted small">
            <span className="tag">代码</span>
            未对上代码目录，可之后在产品卡片上绑
          </li>
        ) : (
          item("code", code)
        )}
        {refs.map((r) => item("ref", r))}
      </ul>
      {dropped.length > 0 && (
        <p className="review-reason warn">
          <AlertTriangle size={12} /> 没采用：
          {dropped.map((d) => `${d.path}（${d.why}）`).join("；")}
        </p>
      )}
    </div>
  );
}

/**
 * 识别结果确认表。
 *
 * **AI 的识别结果一律先过这张表再落库**，不静默写。理由很具体：这次实测它把
 * `accountcenter` / `skillcenter` 正确地放进了 `uncertain`（它们确实只是轻量占位），
 * 但换一个仓库它完全可能把 `docs/` 当成产品——而产品台账是后面所有工作的根，
 * 脏了比空着更费事。
 *
 * 所以这里的默认值是「勾上 AI 有把握的，不勾 uncertain 里的」，名字与描述当场可改。
 */
export function DiscoverReview({
  result,
  templates,
  busy,
  onApply,
  onClose,
}: {
  result: DiscoverResult;
  templates: { id: string; name: string }[];
  busy: boolean;
  onApply: (lines: ApplyLine[]) => void;
  onClose: () => void;
}): React.JSX.Element {
  /** 勾选与就地编辑都存在这里，key 是「产线下标」或「产线下标:产品下标」。 */
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () =>
      new Set(
        result.lines.flatMap((line, li) => [
          String(li),
          ...line.products.map((_p, pi) => `${String(li)}:${String(pi)}`),
        ]),
      ),
  );
  const [names, setNames] = useState<Record<string, string>>({});
  /** 人在表里去掉的依据路径，key 同上，值是「code:路径」或「ref:路径」。 */
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const dropKey = (key: string, what: "code" | "ref", path: string): string =>
    `${key}|${what}:${path}`;
  const removePath = (id: string): void =>
    setRemoved((prev) => new Set(prev).add(id));
  const codeOf = (key: string, p: DiscoveredProduct): string => {
    const code = p.codePath ?? "";
    return code === "" || removed.has(dropKey(key, "code", code)) ? "" : code;
  };
  const refsOf = (key: string, p: DiscoveredProduct): string[] =>
    (p.refPaths ?? []).filter((r) => !removed.has(dropKey(key, "ref", r)));
  /** 整批统一绑哪个模板。逐个绑太碎，而初始化时它们几乎总是同一套规范。 */
  const [templateId, setTemplateId] = useState("");
  useEscape(onClose, !busy);

  const nameOf = (key: string, fallback: string): string =>
    names[key] ?? fallback;
  const toggle = (key: string): void =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const chosen: ApplyLine[] = result.lines
    .map((line, li) => ({ line, li }))
    .filter(({ li }) => picked.has(String(li)))
    .map(({ line, li }) => ({
      name: nameOf(String(li), line.name),
      description: line.description,
      folderPath: line.folderPath,
      products: line.products
        .map((p, pi) => ({ p, key: `${String(li)}:${String(pi)}` }))
        .filter(({ key }) => picked.has(key))
        .map(({ p, key }) => ({
          name: nameOf(key, p.name),
          description: p.description,
          folderPath: p.folderPath,
          codePath: codeOf(key, p),
          refPaths: refsOf(key, p),
          templateId,
        })),
    }));
  const productCount = chosen.reduce((n, l) => n + l.products.length, 0);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="dialog wide" role="dialog" aria-modal="true">
        <header className="dialog-head">
          <h2>识别结果</h2>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <p className="field-hint">
          勾上要建的，名字可以当场改，AI
          建议的代码目录和参考资料可以逐条去掉。不勾的不会建，也不会留痕——改完点下面的按钮才写入。已有的同名产品只补空着的依据，不改别的。
        </p>

        <div className="review-list">
          {result.lines.length === 0 && (
            <p className="muted small">这一轮没识别出任何产品线。</p>
          )}
          {result.lines.map((line, li) => {
            const lineKey = String(li);
            const lineOn = picked.has(lineKey);
            return (
              <div
                key={lineKey}
                className={`review-line${lineOn ? "" : " off"}`}
              >
                <label className="review-row">
                  <input
                    type="checkbox"
                    checked={lineOn}
                    onChange={() => toggle(lineKey)}
                  />
                  <span className="tag">产品线</span>
                  <input
                    className="review-name"
                    aria-label={`产品线名称 ${line.name}`}
                    value={nameOf(lineKey, line.name)}
                    maxLength={80}
                    onChange={(e) =>
                      setNames((n) => ({ ...n, [lineKey]: e.target.value }))
                    }
                  />
                </label>
                {line.reason !== "" && (
                  <p className="review-reason">依据：{line.reason}</p>
                )}

                {line.products.map((product, pi) => {
                  const key = `${lineKey}:${String(pi)}`;
                  const on = picked.has(key);
                  return (
                    <div
                      key={key}
                      className={`review-product${on ? "" : " off"}`}
                    >
                      <label className="review-row">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!lineOn}
                          onChange={() => toggle(key)}
                        />
                        <input
                          className="review-name"
                          aria-label={`产品名称 ${product.name}`}
                          value={nameOf(key, product.name)}
                          maxLength={80}
                          onChange={(e) =>
                            setNames((n) => ({ ...n, [key]: e.target.value }))
                          }
                        />
                        {product.folderPath !== "" && (
                          <code className="review-path">
                            {product.folderPath}
                          </code>
                        )}
                      </label>
                      {product.description !== "" && (
                        <p className="review-reason">{product.description}</p>
                      )}
                      <EvidenceRows
                        code={codeOf(key, product)}
                        refs={refsOf(key, product)}
                        dropped={product.droppedPaths ?? []}
                        disabled={!on}
                        onRemove={(what, path) =>
                          removePath(dropKey(key, what, path))
                        }
                      />
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        {result.uncertain.length > 0 && (
          <div className="review-uncertain">
            <h4>
              <AlertTriangle size={13} /> AI 拿不准的（默认没有建）
            </h4>
            <ul>
              {result.uncertain.map((u, i) => (
                <li key={`${String(i)}-${u}`}>{u}</li>
              ))}
            </ul>
            <p className="field-hint">
              这些要你自己拍板。可以直接在对话里追问它，然后再点一次「查看识别结果」。
            </p>
          </div>
        )}

        <label className="field">
          给这批产品统一绑一份生命周期规范
          <Select
            value={templateId}
            onChange={(v) => setTemplateId(v)}
            options={[
              { value: "", label: "暂不绑定" },
              ...templates.map((t) => ({ value: t.id, label: t.name })),
            ]}
          />
          <span className="field-hint">
            绑了才能做下一步的「AI 比对产出物」。之后也能在编辑产品里单个改。
          </span>
        </label>

        <footer className="dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || chosen.length === 0}
            onClick={() => onApply(chosen)}
          >
            {busy && <Loader2 size={13} className="spin" />}建 {chosen.length}{" "}
            条产品线 / {productCount} 个产品
          </button>
        </footer>
      </div>
    </div>
  );
}

const STATUS_META: Record<
  Finding["status"],
  { label: string; icon: React.ReactNode; cls: string }
> = {
  present: {
    label: "齐",
    icon: <CheckCircle2 size={13} />,
    cls: "ok",
  },
  partial: {
    label: "不全",
    icon: <MinusCircle size={13} />,
    cls: "warn",
  },
  missing: {
    label: "缺",
    icon: <CircleSlash size={13} />,
    cls: "bad",
  },
};

/**
 * 比对报告。按阶段分组，必交项排在前面。
 *
 * 「不全」这一档是这份报告的价值所在：它答得出「有这份 PR-FAQ，但第 10 项 Appetite
 * 和第 12 项『为什么是我们』没写」，而不只是打个勾。所以 missedCheckpoints 一定要显示。
 */
export function CompareReport({
  result,
  productName,
  busy,
  onSave,
  onClose,
}: {
  result: CompareResult;
  productName: string;
  busy: boolean;
  onSave: () => void;
  onClose: () => void;
}): React.JSX.Element {
  useEscape(onClose, !busy);
  const { summary, findings } = result;
  const byStage = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.stageCode} ${f.stageLabel}`;
    byStage.set(key, [...(byStage.get(key) ?? []), f]);
  }

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="dialog wide" role="dialog" aria-modal="true">
        <header className="dialog-head">
          <h2>
            {productName} · 对照「{result.templateName}」
          </h2>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="report-summary">
          <span className="pill ok">齐 {summary.present}</span>
          <span className="pill warn">不全 {summary.partial}</span>
          <span className="pill bad">缺 {summary.missing}</span>
          <span className="muted small">
            共 {summary.total} 件
            {summary.requiredGap > 0
              ? ` · 其中必交项还差 ${String(summary.requiredGap)} 件`
              : " · 必交项已齐"}
          </span>
        </div>

        <div className="report-list">
          {[...byStage.entries()].map(([stage, items]) => (
            <section key={stage} className="report-stage">
              <h4>{stage}</h4>
              {items.map((f) => {
                const meta = STATUS_META[f.status];
                return (
                  <div
                    key={`${f.stageCode}-${f.artifact}`}
                    className="report-item"
                  >
                    <div className="report-item-head">
                      <span className={`pill ${meta.cls}`}>
                        {meta.icon} {meta.label}
                      </span>
                      <strong>{f.artifact}</strong>
                      {f.required ? (
                        <span className="tag">必交</span>
                      ) : (
                        <span className="tag">选填</span>
                      )}
                    </div>
                    {f.missedCheckpoints.length > 0 && (
                      <div className="report-missed">
                        <span className="muted small">没答到的要点</span>
                        <ol>
                          {f.missedCheckpoints.map((c, ci) => (
                            <li key={`${String(ci)}-${c}`}>{c}</li>
                          ))}
                        </ol>
                      </div>
                    )}
                    {f.files.length > 0 && (
                      <p className="report-files">
                        {f.files.map((file, fi) => (
                          <code key={`${String(fi)}-${file}`}>{file}</code>
                        ))}
                      </p>
                    )}
                    {f.note !== "" && <p className="report-note">{f.note}</p>}
                  </div>
                );
              })}
            </section>
          ))}
        </div>

        <footer className="dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={onSave}
          >
            {busy && <Loader2 size={13} className="spin" />}
            存为这个产品的最新比对结果
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * 功能架构分析结果的确认面板。
 *
 * 与识别产线那张表不同，这里**不做逐条勾选**：功能树是嵌套的，勾掉一个父节点
 * 要连带处理它的子树，交互复杂度远超收益。这里只做「看清楚再决定要不要整批写入」，
 * 写进去之后再逐个改——节点本来就能编辑与删除。
 *
 * 但有一件事必须在写入前说清：**replace 模式会覆盖掉手改过的节点**，
 * 所以 `manualAtRisk` 要点名，不能笼统地警告「会覆盖」。
 */
export function ArchitectureReview({
  result,
  busy,
  onApply,
  onClose,
}: {
  result: ArchitectureResult;
  busy: boolean;
  onApply: () => void;
  onClose: () => void;
}): React.JSX.Element {
  useEscape(onClose, !busy);
  const count = (nodes: readonly AiFeature[]): number =>
    nodes.reduce((n, f) => n + 1 + count(f.children), 0);
  const total = count(result.features);

  const render = (
    nodes: readonly AiFeature[],
    depth = 0,
  ): React.JSX.Element[] =>
    nodes.flatMap((f) => [
      <div
        key={`${String(depth)}-${f.name}`}
        className="review-feature"
        style={{ marginLeft: depth * 18 }}
      >
        <div className="review-row">
          <span className="g-level">L{depth + 1}</span>
          <strong>{f.name}</strong>
        </div>
        {f.duty !== "" && <p className="review-reason">{f.duty}</p>}
        {f.evidence.length > 0 && (
          <p className="review-evidence">
            {f.evidence.map((e, ei) => (
              <code key={`${String(ei)}-${e}`}>{e}</code>
            ))}
          </p>
        )}
      </div>,
      ...render(f.children, depth + 1),
    ]);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="dialog wide" role="dialog" aria-modal="true">
        <header className="dialog-head">
          <h2>
            分析结果 · {total} 个功能
            {result.mode === "replace" ? "（将覆盖这一支）" : ""}
          </h2>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        {result.manualAtRisk.length > 0 && (
          <div className="review-uncertain">
            <h4>
              <AlertTriangle size={13} /> 这些是你手改过的，会被覆盖掉
            </h4>
            <ul>
              {result.manualAtRisk.map((n, i) => (
                <li key={`${String(i)}-${n}`}>{n}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="review-list">
          {result.features.length === 0 ? (
            <p className="muted small">这一轮没分析出任何功能。</p>
          ) : (
            render(result.features)
          )}
        </div>

        {result.uncertain.length > 0 && (
          <div className="review-uncertain">
            <h4>
              <AlertTriangle size={13} /> AI 拿不准的（不会写进去）
            </h4>
            <ul>
              {result.uncertain.map((u, i) => (
                <li key={`${String(i)}-${u}`}>{u}</li>
              ))}
            </ul>
            <p className="field-hint">
              可以直接在对话里追问它，然后再点一次「查看分析结果」。
            </p>
          </div>
        )}

        <footer className="dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || result.features.length === 0}
            onClick={onApply}
          >
            {busy && <Loader2 size={13} className="spin" />}
            {result.mode === "replace"
              ? `覆盖写入 ${String(total)} 个功能`
              : `写入 ${String(total)} 个功能`}
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ── 产品 Wiki：目录方案 ───────────────────────────────────────────── */

/**
 * 「生成目录」的确认面板。
 *
 * 这一步**只确认结构不确认内容**——正文还没写。所以面板给的是
 * 「会建哪些章、每章打算写什么」，而不是预览。
 */
export function WikiOutlineReview({
  result,
  busy,
  onApply,
  onClose,
}: {
  result: WikiOutlineResult;
  busy: boolean;
  onApply: () => void;
  onClose: () => void;
}): React.JSX.Element {
  useEscape(onClose, !busy);
  const count = (pages: readonly OutlinePage[]): number =>
    pages.reduce((n, p) => n + 1 + count(p.children ?? []), 0);
  const total = count(result.pages);

  const render = (
    pages: readonly OutlinePage[],
    depth = 0,
    prefix = "",
  ): React.JSX.Element[] =>
    pages.flatMap((p, i) => {
      const number =
        depth === 0
          ? String(i + 1).padStart(2, "0")
          : `${prefix}.${String(i + 1)}`;
      return [
        <div
          key={`${number}-${p.title}`}
          className="review-feature"
          style={{ marginLeft: depth * 18 }}
        >
          <div className="review-row">
            <span className="g-level">{number}</span>
            <strong>{p.title}</strong>
          </div>
          {p.brief !== "" && <p className="review-reason">{p.brief}</p>}
        </div>,
        ...render(p.children ?? [], depth + 1, number),
      ];
    });

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="dialog wide" role="dialog" aria-modal="true">
        <header className="dialog-head">
          <h2>目录方案 · {total} 章</h2>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <p className="field-hint">
          这一步只定目录，正文还没写。确认之后在左边逐章点「让 AI
          写」，或者自己手写。
        </p>

        {result.mode === "replace" && (
          <div className="review-uncertain">
            <h4>
              <AlertTriangle size={13} /> 这是一次重新规划
            </h4>
            <ul>
              <li>
                还没写正文的章节会被清掉，换成下面这套。
                {result.written > 0
                  ? `已经写了正文的 ${String(result.written)} 章会保留，不动它们。`
                  : ""}
              </li>
            </ul>
          </div>
        )}

        <div className="review-list">
          {result.pages.length === 0 ? (
            <p className="muted small">这一轮没规划出任何章节。</p>
          ) : (
            render(result.pages)
          )}
        </div>

        {result.uncertain.length > 0 && (
          <div className="review-uncertain">
            <h4>
              <AlertTriangle size={13} /> 因为缺事实源而没规划的
            </h4>
            <ul>
              {result.uncertain.map((u, i) => (
                <li key={`${String(i)}-${u}`}>{u}</li>
              ))}
            </ul>
          </div>
        )}

        <footer className="dialog-foot">
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={onClose}
          >
            先不管
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy || result.pages.length === 0}
            onClick={onApply}
          >
            {busy && <Loader2 size={13} className="spin" />}
            建这 {total} 章
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ── 产品 Wiki：正文 ───────────────────────────────────────────────── */

/**
 * 「写这一页」的确认面板。
 *
 * 这里**必须给全文预览**，不能只给字数——正文是最终交付物，
 * 让用户在没看过的情况下点「应用」，等于让他事后才发现写歪了。
 * 预览直接用 wiki 的渲染组件，所见即所得。
 */
export function WikiPageReview({
  result,
  busy,
  onApply,
  onClose,
}: {
  result: WikiPageResult;
  busy: boolean;
  onApply: () => void;
  onClose: () => void;
}): React.JSX.Element {
  useEscape(onClose, !busy);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <div className="dialog wide" role="dialog" aria-modal="true">
        <header className="dialog-head">
          <h2>
            {result.pageTitle} · {result.content.length} 字
          </h2>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        {result.hadContent && (
          <div className="review-uncertain">
            <h4>
              <AlertTriangle size={13} /> 这一章已经有正文了
            </h4>
            <ul>
              <li>应用会直接覆盖它。想留着旧的就先关掉这个框。</li>
            </ul>
          </div>
        )}

        {result.gaps.length > 0 && (
          <div className="review-uncertain">
            <h4>
              <AlertTriangle size={13} /> 事实源里没有、所以没写的部分
            </h4>
            <ul>
              {result.gaps.map((g, i) => (
                <li key={`${String(i)}-${g}`}>{g}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="review-list wiki-preview">
          <WikiArticle markdown={result.content} />
        </div>

        {result.sources.length > 0 && (
          <p className="review-evidence">
            事实出处：
            {result.sources.map((s, i) => (
              <code key={`${String(i)}-${s}`}>{s}</code>
            ))}
          </p>
        )}

        <footer className="dialog-foot">
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={onClose}
          >
            不满意，去追问
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            onClick={onApply}
          >
            {busy && <Loader2 size={13} className="spin" />}
            {result.hadContent ? "覆盖这一章" : "写进这一章"}
          </button>
        </footer>
      </div>
    </div>
  );
}
