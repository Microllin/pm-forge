import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Check,
  ExternalLink,
  Link2,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  Radar,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import { listSessions } from "../api";
import { ChatView } from "../chat/ChatView";
import { MarkdownText } from "../chat/markdown";
import { listLines, type Product } from "../products/api";
import { Select } from "../ui/Select";
import {
  CONFIDENCE_LABEL,
  INTEL_CONFIDENCE,
  INTEL_KEY,
  INTEL_KINDS,
  KIND_LABEL,
  createIntel,
  deleteIntel,
  listIntel,
  setIntelStatus,
  startResearch,
  updateIntel,
  type IntelConfidence,
  type IntelInput,
  type IntelItem,
  type IntelKind,
} from "./api";
import "./intel.css";

/**
 * 一级菜单「市场情报」：竞品、市场、行业动态、合规等外部资料。
 *
 * 用户的原话：这些是 AI 写 PRD 时「应该考虑的，不是准则」。所以页面头上就把这句话说清，
 * 每条都摆出时效（观察日期、可能过时）和可信度——参考资料最怕的是被当成定论。
 *
 * 布局：左边分类与状态，中间按「对象」分组的条目，右边看 / 改 / 让 AI 调研。
 */

type View = IntelKind | "all" | "pending" | "stale" | "archived";
type Pane =
  | { mode: "view"; id: string }
  | { mode: "edit"; id: string }
  | { mode: "new" }
  | { mode: "research-start" }
  | { mode: "research"; sessionId: string; kickoff: string | null }
  | { mode: "none" };

const ALL = "__all__";
const GLOBAL = "__global__";

export function IntelPage({
  onOpenSession,
}: {
  onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const intel = useQuery({ queryKey: INTEL_KEY, queryFn: listIntel });
  const lines = useQuery({ queryKey: ["product-lines"], queryFn: listLines });
  const products = useMemo(
    () => (lines.data ?? []).flatMap((l) => l.products),
    [lines.data],
  );
  const productName = (id: string): string =>
    products.find((p) => p.id === id)?.name ?? "已删除的产品";

  const [view, setView] = useState<View>("all");
  const [product, setProduct] = useState<string>(ALL);
  const [query, setQuery] = useState("");
  const [pane, setPane] = useState<Pane>({ mode: "none" });
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: INTEL_KEY });

  const all = useMemo(() => intel.data ?? [], [intel.data]);
  const byProduct = all.filter(
    (i) =>
      product === ALL ||
      (product === GLOBAL
        ? i.productIds.length === 0
        : i.productIds.length === 0 || i.productIds.includes(product)),
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = {
      all: 0,
      pending: 0,
      stale: 0,
      archived: 0,
    };
    for (const k of INTEL_KINDS) c[k] = 0;
    for (const i of byProduct) {
      if (i.status === "archived") c.archived = (c.archived ?? 0) + 1;
      else if (i.status === "pending") c.pending = (c.pending ?? 0) + 1;
      else {
        c.all = (c.all ?? 0) + 1;
        c[i.kind] = (c[i.kind] ?? 0) + 1;
        if (i.stale) c.stale = (c.stale ?? 0) + 1;
      }
    }
    return c;
  }, [byProduct]);

  const q = query.trim().toLowerCase();
  const shown = byProduct.filter((i) => {
    const inView =
      view === "pending"
        ? i.status === "pending"
        : view === "archived"
          ? i.status === "archived"
          : i.status === "active" &&
            (view === "all" || (view === "stale" ? i.stale : i.kind === view));
    if (!inView) return false;
    if (q === "") return true;
    return [i.title, i.subject, i.summary, i.tags.join(" "), i.content].some(
      (t) => t.toLowerCase().includes(q),
    );
  });
  /** 按「对象」分组：同一个竞品 / 法规的几条放一起，才像一份档案。 */
  const groups = useMemo(() => {
    const map = new Map<string, IntelItem[]>();
    for (const i of shown) {
      const key = i.subject === "" ? "（未写对象）" : i.subject;
      map.set(key, [...(map.get(key) ?? []), i]);
    }
    return [...map.entries()].sort(
      (a, b) =>
        Math.max(...b[1].map((x) => x.updatedAt)) -
        Math.max(...a[1].map((x) => x.updatedAt)),
    );
  }, [shown]);

  const selected =
    pane.mode === "view" || pane.mode === "edit"
      ? all.find((i) => i.id === pane.id)
      : undefined;

  return (
    <div className="skills intel">
      <header className="skills-head">
        <div>
          <h2>市场情报</h2>
          <p className="muted small">
            竞品、市场、行业动态、合规等<strong>外部</strong>资料。AI 写
            PRD、Wiki 等产出时会自动带上相关条目做参考——
            <strong>是参考，不是准则</strong>
            ；描述我们自己的产品仍只看事实依据。 AI 提交的条目要你确认后才生效。
          </p>
        </div>
        <span className="row gap">
          <button
            type="button"
            className="btn"
            onClick={() => setPane({ mode: "research-start" })}
            title="说一个调研题目，AI 联网查完把发现逐条提交进来，待你确认"
          >
            <Sparkles size={13} /> AI 调研
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => setPane({ mode: "new" })}
          >
            <Plus size={13} /> 新建条目
          </button>
        </span>
      </header>
      {notice !== null && <p className="ok-text small">{notice}</p>}

      <div className="intel-browser">
        <nav className="intel-nav" aria-label="情报分类">
          <Select
            value={product}
            aria-label="按产品筛选"
            options={[
              { value: ALL, label: "全部产品" },
              { value: GLOBAL, label: "只看全局条目" },
              ...products.map((p: Product) => ({ value: p.id, label: p.name })),
            ]}
            onChange={setProduct}
          />
          <span className="intel-nav-title">分类</span>
          <NavItem
            label="全部"
            n={counts.all}
            on={view === "all"}
            onClick={() => setView("all")}
          />
          {INTEL_KINDS.map((k) => (
            <NavItem
              key={k}
              label={KIND_LABEL[k]}
              n={counts[k]}
              on={view === k}
              onClick={() => setView(k)}
            />
          ))}
          <span className="intel-nav-title">状态</span>
          <NavItem
            label="待确认"
            n={counts.pending}
            on={view === "pending"}
            tone={(counts.pending ?? 0) > 0 ? "ai" : undefined}
            onClick={() => setView("pending")}
          />
          <NavItem
            label="可能过时"
            n={counts.stale}
            on={view === "stale"}
            tone={(counts.stale ?? 0) > 0 ? "warn" : undefined}
            onClick={() => setView("stale")}
          />
          <NavItem
            label="已归档"
            n={counts.archived}
            on={view === "archived"}
            onClick={() => setView("archived")}
          />
        </nav>

        <section className="intel-list" aria-label="情报条目">
          <div className="skill-search">
            <Search size={13} />
            <input
              type="search"
              aria-label="搜索情报"
              placeholder="搜索标题、对象、标签、正文"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {intel.isPending && (
            <p className="muted small pad">
              <Loader2 size={13} className="spin" /> 读取中…
            </p>
          )}
          {intel.isError && (
            <p className="err-text small pad" role="alert">
              读不到情报：{intel.error.message}
              <button
                type="button"
                className="link-btn"
                onClick={() => void intel.refetch()}
              >
                重试
              </button>
            </p>
          )}
          {!intel.isPending && !intel.isError && shown.length === 0 && (
            <EmptyList view={view} hasAny={all.length > 0} />
          )}
          {groups.map(([subject, items]) => (
            <div key={subject} className="intel-group">
              <div className="intel-group-head">
                <span>{subject}</span>
                <span className="muted">{items.length}</span>
              </div>
              {items.map((i) => (
                <button
                  key={i.id}
                  type="button"
                  className={`skill-item${selected?.id === i.id ? " active" : ""}`}
                  onClick={() => setPane({ mode: "view", id: i.id })}
                >
                  <span className="skill-item-top">
                    <span className="skill-item-name">{i.title}</span>
                    <span className="skill-item-meta">
                      {i.status === "pending" && (
                        <span className="tag ai">待确认</span>
                      )}
                      {i.stale && <span className="tag warn">可能过时</span>}
                    </span>
                  </span>
                  <span className="muted small ellipsis">
                    {KIND_LABEL[i.kind]} · {i.observedAt ?? "日期不明"}
                    {i.summary === "" ? "" : ` — ${i.summary}`}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </section>

        <section className="skill-pane intel-pane">
          {pane.mode === "none" && <Intro />}
          {pane.mode === "view" && selected !== undefined && (
            <Detail
              item={selected}
              productName={productName}
              onEdit={() => setPane({ mode: "edit", id: selected.id })}
              onOpenSession={onOpenSession}
              onChanged={async (text) => {
                setNotice(text);
                await refresh();
              }}
              onDeleted={async () => {
                setPane({ mode: "none" });
                await refresh();
              }}
            />
          )}
          {(pane.mode === "edit" || pane.mode === "new") && (
            <Editor
              key={pane.mode === "edit" ? pane.id : "new"}
              item={pane.mode === "edit" ? selected : undefined}
              products={products}
              defaultKind={
                INTEL_KINDS.includes(view as IntelKind)
                  ? (view as IntelKind)
                  : "competitor"
              }
              defaultProduct={
                product === ALL || product === GLOBAL ? null : product
              }
              onCancel={() =>
                setPane(
                  selected === undefined
                    ? { mode: "none" }
                    : { mode: "view", id: selected.id },
                )
              }
              onSaved={async (saved) => {
                await refresh();
                setPane({ mode: "view", id: saved.id });
              }}
            />
          )}
          {pane.mode === "research-start" && (
            <ResearchStart
              products={products}
              defaultProduct={
                product === ALL || product === GLOBAL ? null : product
              }
              onCancel={() => setPane({ mode: "none" })}
              onStarted={(sessionId, kickoff) =>
                setPane({ mode: "research", sessionId, kickoff })
              }
            />
          )}
          {pane.mode === "research" && (
            <ResearchPanel
              sessionId={pane.sessionId}
              kickoff={pane.kickoff}
              onKicked={() => setPane({ ...pane, kickoff: null })}
              onClose={() => {
                setPane({ mode: "none" });
                setView("pending");
              }}
              onOpenSession={onOpenSession}
              onActivity={() => void refresh()}
            />
          )}
        </section>
      </div>
    </div>
  );
}

function NavItem({
  label,
  n,
  on,
  tone,
  onClick,
}: {
  label: string;
  n: number | undefined;
  on: boolean;
  tone?: "ai" | "warn" | undefined;
  onClick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={`intel-nav-item${on ? " on" : ""}`}
      aria-pressed={on}
      onClick={onClick}
    >
      <span>{label}</span>
      <span className={`intel-count${tone === undefined ? "" : ` ${tone}`}`}>
        {n ?? 0}
      </span>
    </button>
  );
}

function EmptyList({
  view,
  hasAny,
}: {
  view: View;
  hasAny: boolean;
}): React.JSX.Element {
  if (!hasAny)
    return (
      <p className="muted small pad">
        还没有情报。点「AI 调研」让 AI 查一个题目，或者「新建条目」手动记一条。
      </p>
    );
  return (
    <p className="muted small pad">
      {view === "pending"
        ? "没有待确认的条目。"
        : view === "stale"
          ? "没有过了复核日期的条目。"
          : "这里还没有条目。"}
    </p>
  );
}

function Intro(): React.JSX.Element {
  return (
    <div className="intel-intro">
      <Radar size={26} className="faint-icon" />
      <h3>情报怎么被用上</h3>
      <ol>
        <li>
          <strong>收进来</strong>：手动记，或让 AI
          调研（联网查完逐条提交，待你确认）。
          执行体里的市场调研员派活时也会提交到这里。
        </li>
        <li>
          <strong>自动参考</strong>：你在对话里写 PRD、方案、Wiki
          时，平台按话题挑出相关的几条， 标上「参考情报」随依据一起交给 AI。
        </li>
        <li>
          <strong>有时效</strong>
          ：每条写明观察日期、可信度；过了复核日期标「可能过时」，AI
          引用时会说出来。
        </li>
      </ol>
      <p className="muted small">
        情报只描述外部世界。我们自己的产品是什么样，仍以事实依据（文件、代码、真实页面）为准；
        必须照做的方法写在技能与生命周期规范里。
      </p>
    </div>
  );
}

function Detail({
  item,
  productName,
  onEdit,
  onOpenSession,
  onChanged,
  onDeleted,
}: {
  item: IntelItem;
  productName: (id: string) => string;
  onEdit: () => void;
  onOpenSession: (id: string) => void;
  onChanged: (notice: string) => Promise<void>;
  onDeleted: () => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const act = async (
    fn: () => Promise<unknown>,
    done: string,
  ): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      await onChanged(done);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="intel-detail">
      {item.status === "pending" && (
        <div className="intel-pending">
          <span>
            <Sparkles size={13} /> AI
            提交的条目，确认后才会被附给别的对话。先核对来源与日期。
          </span>
          <span className="row gap">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() =>
                void act(
                  () => setIntelStatus(item.id, "active"),
                  `已确认「${item.title}」`,
                )
              }
            >
              <Check size={13} /> 确认生效
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                if (!window.confirm(`丢弃「${item.title}」？`)) return;
                void deleteIntel(item.id).then(onDeleted);
              }}
            >
              <X size={13} /> 丢弃
            </button>
          </span>
        </div>
      )}
      <header className="skill-detail-head">
        <div className="skill-detail-title">
          <h3>{item.title}</h3>
          <div className="intel-chips">
            <span className="tag">{KIND_LABEL[item.kind]}</span>
            {item.subject !== "" && <span className="tag">{item.subject}</span>}
            <span className="tag">观察于 {item.observedAt ?? "日期不明"}</span>
            <span
              className={`tag${item.confidence === "inferred" ? " warn" : ""}`}
            >
              {CONFIDENCE_LABEL[item.confidence]}
            </span>
            {item.stale && (
              <span className="tag warn">
                <TriangleAlert size={11} /> 可能过时
              </span>
            )}
            {item.status === "archived" && <span className="tag">已归档</span>}
          </div>
        </div>
        <span className="row gap">
          <button type="button" className="btn" onClick={onEdit}>
            <Pencil size={13} /> 编辑
          </button>
          {item.status === "active" && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              title="归档后不再附给 AI，但留档可查"
              onClick={() =>
                void act(
                  () => setIntelStatus(item.id, "archived"),
                  `已归档「${item.title}」`,
                )
              }
            >
              <Archive size={13} /> 归档
            </button>
          )}
          {item.status === "archived" && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void act(
                  () => setIntelStatus(item.id, "active"),
                  `已恢复「${item.title}」`,
                )
              }
            >
              <RotateCcw size={13} /> 恢复
            </button>
          )}
          {item.status !== "pending" && (
            <button
              type="button"
              className="btn ghost icon"
              aria-label="删除"
              title="删除"
              onClick={() => {
                if (
                  !window.confirm(
                    `删除「${item.title}」？删除后找不回来；只是不想让 AI 参考的话用「归档」。`,
                  )
                )
                  return;
                void deleteIntel(item.id).then(onDeleted);
              }}
            >
              <Trash2 size={14} />
            </button>
          )}
        </span>
      </header>

      {item.summary !== "" && <p className="intel-summary">{item.summary}</p>}
      {item.content.trim() !== "" && (
        <section className="skill-md">
          <MarkdownText text={item.content} streaming={false} />
        </section>
      )}

      <dl className="intel-meta">
        <dt>来源</dt>
        <dd>
          {item.sources.length === 0 ? (
            <span className="warn-text">
              没写来源——AI 引用时会标「来源未注明」
            </span>
          ) : (
            <ul>
              {item.sources.map((s) => (
                <li key={s.url}>
                  {/* 只放行 http(s)，与 Markdown / Wiki 的渲染口径一致；
                      其他协议（data:、file: 等）退化成纯文本，不给点。 */}
                  {/^https?:\/\//i.test(s.url) ? (
                    <a href={s.url} target="_blank" rel="noreferrer noopener">
                      <Link2 size={12} /> {s.title ?? s.url}
                    </a>
                  ) : (
                    <span>
                      <Link2 size={12} /> {s.title ?? s.url}（非 http(s)
                      链接，不提供跳转）
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </dd>
        <dt>适用产品</dt>
        <dd>
          {item.productIds.length === 0
            ? "全局（所有产品都可能参考）"
            : item.productIds.map(productName).join("、")}
        </dd>
        {item.tags.length > 0 && (
          <>
            <dt>标签</dt>
            <dd>{item.tags.join("、")}</dd>
          </>
        )}
        <dt>复核</dt>
        <dd>
          {item.reviewAfter === null
            ? "不设复核日期"
            : `${new Date(item.reviewAfter).toLocaleDateString("zh-CN")} 之后复核`}
        </dd>
        <dt>来历</dt>
        <dd>
          {item.origin === "ai" ? "AI 提交" : "手动记录"} ·{" "}
          {new Date(item.updatedAt).toLocaleString("zh-CN")} 更新
          {item.sessionId !== null && (
            <button
              type="button"
              className="link-btn"
              onClick={() => onOpenSession(item.sessionId ?? "")}
            >
              <MessageSquare size={12} /> 看调研过程
            </button>
          )}
        </dd>
      </dl>
    </article>
  );
}

const REVIEW_OPTIONS = [
  { value: "0", label: "不设复核" },
  { value: "3", label: "3 个月后复核" },
  { value: "6", label: "6 个月后复核" },
  { value: "12", label: "12 个月后复核" },
] as const;

/** 来源一行一个：「标题 | 链接」或只写链接。 */
const parseSources = (text: string): { title?: string; url: string }[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const at = l.lastIndexOf("|");
      if (at < 0) return { url: l };
      const title = l.slice(0, at).trim();
      return { url: l.slice(at + 1).trim(), ...(title ? { title } : {}) };
    });

function Editor({
  item,
  products,
  defaultKind,
  defaultProduct,
  onCancel,
  onSaved,
}: {
  item: IntelItem | undefined;
  products: Product[];
  defaultKind: IntelKind;
  defaultProduct: string | null;
  onCancel: () => void;
  onSaved: (saved: IntelItem) => Promise<void>;
}): React.JSX.Element {
  const [kind, setKind] = useState<IntelKind>(item?.kind ?? defaultKind);
  const [subject, setSubject] = useState(item?.subject ?? "");
  const [title, setTitle] = useState(item?.title ?? "");
  const [summary, setSummary] = useState(item?.summary ?? "");
  const [content, setContent] = useState(item?.content ?? "");
  const [sources, setSources] = useState(
    (item?.sources ?? [])
      .map((s) => (s.title ? `${s.title} | ${s.url}` : s.url))
      .join("\n"),
  );
  const [tags, setTags] = useState((item?.tags ?? []).join("，"));
  const [productIds, setProductIds] = useState<string[]>(
    item?.productIds ?? (defaultProduct === null ? [] : [defaultProduct]),
  );
  const [observedAt, setObservedAt] = useState(
    item?.observedAt ?? new Date().toISOString().slice(0, 7),
  );
  const [confidence, setConfidence] = useState<IntelConfidence>(
    item?.confidence ?? "single",
  );
  const [review, setReview] = useState<string>(
    item === undefined ? "6" : "keep",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    const months = Number(review);
    const input: IntelInput = {
      kind,
      subject,
      title,
      summary,
      content,
      sources: parseSources(sources),
      tags: tags.split(/[,，、\s]+/).filter(Boolean),
      productIds,
      observedAt: observedAt.trim() === "" ? null : observedAt.trim(),
      reviewAfter:
        review === "keep"
          ? (item?.reviewAfter ?? null)
          : months > 0
            ? Date.now() + months * 30 * 24 * 3600 * 1000
            : null,
      confidence,
    };
    try {
      await onSaved(
        item === undefined
          ? await createIntel(input)
          : await updateIntel(item.id, input),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="intel-editor"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h3>{item === undefined ? "新建情报" : "编辑情报"}</h3>
      <div className="intel-form-row">
        <label className="field">
          分类
          <Select
            value={kind}
            aria-label="分类"
            options={INTEL_KINDS.map((k) => ({
              value: k,
              label: KIND_LABEL[k],
            }))}
            onChange={setKind}
          />
        </label>
        <label className="field">
          对象
          <input
            value={subject}
            placeholder="竞品名 / 法规名 / 细分市场"
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>
      </div>
      <label className="field">
        标题
        <input
          value={title}
          required
          placeholder="一句话说这是什么发现"
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label className="field">
        一句话结论
        <input
          value={summary}
          placeholder="写 PRD 的人最该知道的那一句"
          onChange={(e) => setSummary(e.target.value)}
        />
      </label>
      <label className="field">
        正文（Markdown）
        <textarea
          className="skill-editor intel-content"
          value={content}
          spellCheck={false}
          placeholder={"事实与数据在前；「对我们的启示」单列，并注明是推断。"}
          onChange={(e) => setContent(e.target.value)}
        />
      </label>
      <label className="field">
        来源（一行一个：标题 | 链接，或只写链接）
        <textarea
          rows={3}
          value={sources}
          placeholder="定价页 | https://example.com/pricing"
          onChange={(e) => setSources(e.target.value)}
        />
      </label>
      <div className="intel-form-row">
        <label className="field">
          观察日期
          <input
            value={observedAt}
            placeholder="2026-10"
            onChange={(e) => setObservedAt(e.target.value)}
          />
          <span className="field-hint">这条情报说的是哪个时间的情况</span>
        </label>
        <label className="field">
          可信度
          <Select
            value={confidence}
            aria-label="可信度"
            options={INTEL_CONFIDENCE.map((c) => ({
              value: c,
              label: CONFIDENCE_LABEL[c],
            }))}
            onChange={setConfidence}
          />
        </label>
        <label className="field">
          复核
          <Select
            value={review}
            aria-label="复核"
            options={[
              ...(item === undefined
                ? []
                : [
                    {
                      value: "keep",
                      label:
                        item.reviewAfter === null
                          ? "保持：不设"
                          : `保持：${new Date(item.reviewAfter).toLocaleDateString("zh-CN")}`,
                    },
                  ]),
              ...REVIEW_OPTIONS,
            ]}
            onChange={setReview}
          />
        </label>
      </div>
      <label className="field">
        标签（逗号分隔）
        <input
          value={tags}
          placeholder="定价，AI，企业版"
          onChange={(e) => setTags(e.target.value)}
        />
      </label>
      <fieldset className="intel-products">
        <legend>适用产品（都不勾 = 全局）</legend>
        {products.length === 0 && (
          <span className="muted small">还没有产品</span>
        )}
        {products.map((p) => (
          <label key={p.id} className="check-field">
            <input
              type="checkbox"
              checked={productIds.includes(p.id)}
              onChange={(e) =>
                setProductIds((ids) =>
                  e.target.checked
                    ? [...ids, p.id]
                    : ids.filter((x) => x !== p.id),
                )
              }
            />
            {p.name}
          </label>
        ))}
      </fieldset>
      <footer className="skill-foot">
        <span className="row gap">
          <button
            type="submit"
            className="btn primary"
            disabled={saving || title.trim() === ""}
          >
            {saving ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Save size={13} />
            )}{" "}
            保存
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            <X size={13} /> 取消
          </button>
        </span>
        {error !== null && <span className="err-text small">{error}</span>}
      </footer>
    </form>
  );
}

const TOPIC_EXAMPLES = [
  "飞书文档、语雀、Notion 的 AI 写作功能与定价对比",
  "国内生成式 AI 服务上线需要满足哪些备案与合规要求",
  "2026 年 AI 产品经理工具的市场规模与主要玩家",
];

function ResearchStart({
  products,
  defaultProduct,
  onCancel,
  onStarted,
}: {
  products: Product[];
  defaultProduct: string | null;
  onCancel: () => void;
  onStarted: (sessionId: string, kickoff: string) => void;
}): React.JSX.Element {
  const [topic, setTopic] = useState("");
  const [kind, setKind] = useState<IntelKind | typeof ALL>(ALL);
  const [productId, setProductId] = useState<string>(defaultProduct ?? GLOBAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="intel-editor"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        startResearch({
          topic,
          ...(kind === ALL ? {} : { kind }),
          productId: productId === GLOBAL ? null : productId,
        })
          .then((r) => onStarted(r.sessionId, r.kickoff))
          .catch((err: unknown) => {
            setError(err instanceof Error ? err.message : "开不起来");
            setBusy(false);
          });
      }}
    >
      <h3>
        <Sparkles size={15} /> AI 调研
      </h3>
      <p className="muted small">
        AI 会联网查（当前模型支持时），把每个发现提交成一条情报，
        <strong>待你确认</strong>
        ；过程是一条真对话，可以随时追问。
      </p>
      <label className="field">
        调研什么？
        <textarea
          rows={3}
          value={topic}
          autoFocus
          placeholder="说清对象和你关心的维度，比如：竞品 X 的企业版功能和定价"
          onChange={(e) => setTopic(e.target.value)}
        />
      </label>
      <div className="intel-examples">
        {TOPIC_EXAMPLES.map((t) => (
          <button
            key={t}
            type="button"
            className="presales-agent-chip"
            onClick={() => setTopic(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="intel-form-row">
        <label className="field">
          侧重
          <Select
            value={kind}
            aria-label="侧重"
            options={[
              { value: ALL, label: "不限" },
              ...INTEL_KINDS.map((k) => ({ value: k, label: KIND_LABEL[k] })),
            ]}
            onChange={setKind}
          />
        </label>
        <label className="field">
          服务于
          <Select
            value={productId}
            aria-label="服务于哪个产品"
            options={[
              { value: GLOBAL, label: "不限产品（全局）" },
              ...products.map((p) => ({ value: p.id, label: p.name })),
            ]}
            onChange={setProductId}
          />
          <span className="field-hint">
            选了产品，AI 会结合它的事实依据判断哪些和它有关
          </span>
        </label>
      </div>
      <footer className="skill-foot">
        <span className="row gap">
          <button
            type="submit"
            className="btn primary"
            disabled={busy || topic.trim().length < 2}
          >
            {busy ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Sparkles size={13} />
            )}{" "}
            开始调研
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
        </span>
        {error !== null && <span className="err-text small">{error}</span>}
      </footer>
    </form>
  );
}

function ResearchPanel({
  sessionId,
  kickoff,
  onKicked,
  onClose,
  onOpenSession,
  onActivity,
}: {
  sessionId: string;
  kickoff: string | null;
  onKicked: () => void;
  onClose: () => void;
  onOpenSession: (id: string) => void;
  /** AI 在干活：提交的条目要尽快出现在左边。 */
  onActivity: () => void;
}): React.JSX.Element {
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: listSessions,
    refetchInterval: 3000,
  });
  const streaming = (sessions.data ?? []).some(
    (s) => s.id === sessionId && s.streaming,
  );
  const activity = useRef(onActivity);
  useEffect(() => {
    activity.current = onActivity;
  }, [onActivity]);
  const was = useRef(false);
  useEffect(() => {
    if (streaming) {
      was.current = true;
      const t = window.setInterval(() => activity.current(), 4000);
      return () => window.clearInterval(t);
    }
    if (was.current) {
      was.current = false;
      activity.current();
    }
    return undefined;
  }, [streaming]);

  return (
    <div className="intel-research">
      <header className="intel-research-head">
        <strong>
          <Sparkles size={14} /> AI 调研{streaming ? " · 正在查…" : ""}
        </strong>
        <span className="row gap">
          <button
            type="button"
            className="btn ghost icon"
            title="在对话页打开"
            aria-label="在对话页打开"
            onClick={() => onOpenSession(sessionId)}
          >
            <ExternalLink size={14} />
          </button>
          <button type="button" className="btn" onClick={onClose}>
            看待确认的条目
          </button>
        </span>
      </header>
      <div className="intel-research-body">
        <ChatView
          key={sessionId}
          sessionId={sessionId}
          autoSend={kickoff ?? undefined}
          onAutoSent={onKicked}
        />
      </div>
    </div>
  );
}
