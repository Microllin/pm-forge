/**
 * 产品 Wiki 页（产品 → Wiki）。
 *
 * 三栏：**左 = 章节树，中 = 正文，右 = 本页目录**。
 * 这个布局不是抄来的样子货——它对应三种不同的导航需求：
 * 左栏回答「这本书有什么」，右栏回答「这一章有什么」，中间是内容本身。
 * 少任何一栏都会把另一栏撑成混合体（常见的错法是把章节和小节混在一棵树里，
 * 结果十三章展开后有上百个条目，谁也找不着）。
 *
 * 一个产品一本 wiki，所以顶部要先选产品——和图谱页同一个心智。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { Started } from "../analysis/api";
import { startWikiOutline, startWikiPage } from "../analysis/api";
import { listLines } from "../products/api";
import {
  createWikiPage,
  deleteWikiPage,
  getWikiPage,
  listWiki,
  moveWikiPage,
  resetWiki,
  updateWikiPage,
  type WikiNode,
} from "./api";
import { extractHeadings } from "./headings";
import { SourcesBar } from "./SourcesBar";
import { WikiArticle } from "./WikiArticle";
import "./wiki.css";
import { Select } from "../ui/Select";

export function WikiPageView({
  onAnalysis,
  productId: initialProductId,
}: {
  /** 发起分析后跳到对话页去看过程。与图谱页同一个出口。 */
  onAnalysis: (started: Started) => void;
  /** 打开时选中这个产品（产品页的「Wiki」入口带过来）。 */
  productId?: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const lines = useQuery({ queryKey: ["lines"], queryFn: listLines });
  const products = useMemo(
    // 单独 useMemo 包住：直接写 `lines.data ?? []` 会让下游的 memo 每次都失效
    // （`??` 每次新建一个数组）。这个坑在图谱页踩过。
    () => (lines.data ?? []).flatMap((l) => l.products),
    [lines.data],
  );

  /*
   * 选中的产品**派生，不用 effect 兜底**。
   *
   * 写成 `useEffect(() => setProductId(first))` 会在首帧渲染一次空状态再立刻重渲染
   * （lint 的 "cascading renders" 说的就是它），用户看到的是一次闪动。
   * 这里改成：存「用户选了谁」，渲染时现算「实际用谁」——产品还没到、
   * 或者选中的那个被删了，就落到第一个。
   */
  const [picked, setPicked] = useState(initialProductId ?? "");
  const productId =
    picked !== "" && products.some((p) => p.id === picked)
      ? picked
      : (products[0]?.id ?? "");
  const product = products.find((p) => p.id === productId);
  const tree = useQuery({
    queryKey: ["wiki", productId],
    queryFn: () => listWiki(productId),
    enabled: productId !== "",
  });
  const pages = useMemo(() => tree.data ?? [], [tree.data]);

  const [pickedPage, setPickedPage] = useState("");
  const flat = useMemo(() => flatten(pages), [pages]);
  /** 同理派生：换产品、删章节之后，选中项自动落回第一章，不经过一帧空状态。 */
  const pageId =
    pickedPage !== "" && flat.some((p) => p.id === pickedPage)
      ? pickedPage
      : (flat[0]?.id ?? "");

  const page = useQuery({
    queryKey: ["wiki-page", pageId],
    queryFn: () => getWikiPage(pageId),
    enabled: pageId !== "",
  });

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState<{ parentId: string | null } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  /** 哪些章被折叠了。默认全展开——十三章的目录展开也就几十行，折起来反而要多点一次。 */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggleChapter = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  /** 选中某一页时顺手展开它所在的章，否则选中项藏在折叠里，看不见自己在哪。 */
  const revealChapter = (id: string): void => {
    const parentId = flat.find((p) => p.id === id)?.parentId;
    if (parentId === null || parentId === undefined) return;
    setCollapsed((prev) => {
      if (!prev.has(parentId)) return prev;
      const next = new Set(prev);
      next.delete(parentId);
      return next;
    });
  };

  const run = (job: () => Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    void job()
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "操作失败");
      })
      .finally(() => setBusy(false));
  };

  const refreshTree = () =>
    queryClient.invalidateQueries({ queryKey: ["wiki", productId] });

  const save = useMutation({
    mutationFn: (text: string) => updateWikiPage(pageId, { content: text }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["wiki-page", pageId] }),
        refreshTree(),
      ]);
      setEditing(false);
      setNotice("已保存");
    },
    onError: (cause: Error) => setError(cause.message),
  });

  /**
   * 有未保存的编辑时拦一下。
   *
   * 上一轮评审里，事实底座就是因为「切页面时没人认识 dirty」而静默丢编辑的。
   * 这里的切页、切产品、关编辑都走同一个闸，不留第二条路径。
   */
  const dirty = editing && draft !== (page.data?.content ?? "");
  const leaveOk = (): boolean =>
    !dirty || window.confirm("这一章有未保存的修改，放弃吗？");
  const goPage = (id: string): void => {
    if (!leaveOk()) return;
    setEditing(false);
    setNotice(null);
    setPickedPage(id);
    revealChapter(id);
  };

  const startEdit = (): void => {
    setDraft(page.data?.content ?? "");
    setEditing(true);
    setNotice(null);
  };

  const headings = useMemo(
    () => extractHeadings(page.data?.content ?? ""),
    [page.data?.content],
  );

  /**
   * 能不能再上 / 下移。按**同层**算，不是按压平后的全局顺序：
   * 服务端的 move 就是同层交换，按全局算会让「第 2 章的最后一节」显示成可下移，
   * 点下去报「已经到头了」。
   */
  const siblings = useMemo(() => {
    const self = flat.find((p) => p.id === pageId);
    if (self === undefined) return [];
    return self.parentId === null
      ? pages
      : (pages.find((p) => p.id === self.parentId)?.children ?? []);
  }, [flat, pageId, pages]);
  const myIndex = siblings.findIndex((p) => p.id === pageId);
  const atTop = myIndex <= 0;
  const atBottom = myIndex < 0 || myIndex === siblings.length - 1;

  const empty = !tree.isPending && pages.length === 0;

  return (
    <div className="wiki-page">
      <header className="wiki-top">
        <div className="wiki-pick">
          <BookOpen size={15} className="faint" />
          <Select
            aria-label="选择产品"
            value={productId}
            onChange={(v) => {
              if (!leaveOk()) return;
              setEditing(false);
              setPicked(v);
            }}
            options={[
              ...(products.length === 0
                ? [{ value: "", label: "还没有产品" }]
                : []),
              ...products.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </div>
        <div className="row">
          <button
            type="button"
            className="btn"
            disabled={busy || product === undefined}
            title="读产品绑定的文档与代码目录，规划一本 wiki 的目录"
            onClick={() =>
              run(async () => {
                const started = await startWikiOutline({
                  productId,
                  mode: pages.length === 0 ? "append" : "replace",
                });
                onAnalysis(started);
              })
            }
          >
            <Sparkles size={13} />
            {pages.length === 0 ? "AI 规划目录" : "AI 重新规划目录"}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || product === undefined}
            title="用出厂的 13 章目录起一个骨架，然后自己写"
            onClick={() =>
              run(async () => {
                try {
                  await resetWiki(productId);
                } catch (cause) {
                  // 服务端先用 409 拦一次（有写好的正文会被删），确认后再带 force。
                  const message =
                    cause instanceof Error ? cause.message : "恢复失败";
                  if (!message.includes("正文")) throw cause;
                  if (!window.confirm(`${message}\n\n确定继续吗？`)) return;
                  await resetWiki(productId, true);
                }
                await refreshTree();
                setNotice("已套用出厂目录");
              })
            }
          >
            <RotateCcw size={13} /> 出厂目录
          </button>
        </div>
      </header>

      {error !== null && (
        <p className="wiki-notice err-text" role="alert">
          {error}
        </p>
      )}
      {notice !== null && (
        <p className="wiki-notice" role="status">
          {notice}
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭提示"
            onClick={() => setNotice(null)}
          >
            <X size={13} />
          </button>
        </p>
      )}

      <div className="wiki-body">
        <nav className="wiki-tree" aria-label="章节">
          <div className="wiki-tree-head">
            <span className="muted small">{product?.name ?? "—"}</span>
            <button
              type="button"
              className="icon-btn ghost"
              aria-label="加一章"
              title="加一章"
              disabled={product === undefined}
              onClick={() => setAdding({ parentId: null })}
            >
              <Plus size={14} />
            </button>
          </div>
          {tree.isPending && productId !== "" && (
            <p className="muted small">
              <Loader2 size={13} className="spin" /> 读取中…
            </p>
          )}
          {empty && (
            <p className="muted small wiki-tree-empty">
              还没有章节。上面「AI
              规划目录」让它读事实源排一本，或者「出厂目录」 起个骨架自己写。
            </p>
          )}
          <ul className="wiki-chapters">
            {pages.map((p) => (
              <ChapterItem
                key={p.id}
                node={p}
                activeId={pageId}
                collapsed={collapsed}
                onToggle={toggleChapter}
                onPick={goPage}
                onAddChild={(id) => setAdding({ parentId: id })}
              />
            ))}
          </ul>
        </nav>

        <main className="wiki-main">
          {page.isPending && pageId !== "" && (
            <p className="muted">
              <Loader2 size={14} className="spin" /> 读取中…
            </p>
          )}
          {page.data !== undefined && (
            <>
              <header className="wiki-article-head">
                <div>
                  {/* 面包屑只在有上级时给：顶层章的面包屑就是它自己，
                      和下面的标题一字不差地重复一遍，纯噪声。 */}
                  {page.data.path.length > 1 && (
                    <p className="wiki-crumbs">
                      {page.data.path.slice(0, -1).map((c) => (
                        <span key={c.id}>
                          {c.number} {c.title}
                        </span>
                      ))}
                    </p>
                  )}
                  <h1>
                    {page.data.number} {page.data.title}
                  </h1>
                  {page.data.brief !== "" && (
                    <p className="wiki-brief">{page.data.brief}</p>
                  )}
                  <SourcesBar
                    sources={page.data.sources}
                    onSave={async (next) => {
                      await updateWikiPage(pageId, { sources: next });
                      await queryClient.invalidateQueries({
                        queryKey: ["wiki-page", pageId],
                      });
                      await refreshTree();
                    }}
                  />
                </div>
                <div className="row">
                  {editing ? (
                    <>
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => {
                          if (!leaveOk()) return;
                          setEditing(false);
                        }}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="btn primary"
                        disabled={save.isPending}
                        onClick={() => save.mutate(draft)}
                      >
                        {save.isPending ? (
                          <Loader2 size={13} className="spin" />
                        ) : (
                          <Save size={13} />
                        )}
                        保存
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy}
                        title="读事实源给这一章写正文"
                        onClick={() =>
                          run(async () => {
                            const started = await startWikiPage(pageId);
                            onAnalysis(started);
                          })
                        }
                      >
                        <Sparkles size={13} />
                        {page.data.length === 0 ? "让 AI 写" : "让 AI 重写"}
                      </button>
                      <button type="button" className="btn" onClick={startEdit}>
                        <Pencil size={13} /> 编辑
                      </button>
                      <button
                        type="button"
                        className="icon-btn ghost"
                        aria-label="上移"
                        title="上移"
                        disabled={busy || atTop}
                        onClick={() =>
                          run(async () => {
                            await moveWikiPage(pageId, -1);
                            await refreshTree();
                          })
                        }
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn ghost"
                        aria-label="下移"
                        title="下移"
                        disabled={busy || atBottom}
                        onClick={() =>
                          run(async () => {
                            await moveWikiPage(pageId, 1);
                            await refreshTree();
                          })
                        }
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        type="button"
                        className="icon-btn ghost danger"
                        aria-label="删除这一章"
                        title="删除这一章"
                        disabled={busy}
                        onClick={() =>
                          run(async () => {
                            if (
                              !window.confirm(
                                `删除「${page.data.title}」？它下面的小节会一起删掉。`,
                              )
                            )
                              return;
                            await deleteWikiPage(pageId);
                            await refreshTree();
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              </header>

              {editing ? (
                <textarea
                  className="wiki-editor"
                  value={draft}
                  spellCheck={false}
                  placeholder={
                    "用 Markdown 写。小节用 ## / ###（右边的目录是从它们抽的）。\n结论可以标 [已核实] / [待核实] / [未覆盖]。"
                  }
                  onChange={(e) => setDraft(e.target.value)}
                />
              ) : page.data.content === "" ? (
                <div className="wiki-empty">
                  <AlertTriangle size={26} className="faint" />
                  <p>这一章还没有正文。</p>
                  {/* 提纲**不在这里重复**：标题下面那行已经是它了（wiki-brief）。 */}
                  <p className="muted small">
                    点上面「让 AI 写」读事实源生成，或者「编辑」自己写。
                  </p>
                </div>
              ) : (
                <WikiArticle markdown={page.data.content} />
              )}
            </>
          )}
          {pageId === "" && !tree.isPending && (
            <div className="wiki-empty">
              <BookOpen size={26} className="faint" />
              <p>先在左边建章节，或者让 AI 规划一份目录。</p>
            </div>
          )}
        </main>

        <aside className="wiki-toc" aria-label="本页目录">
          {/* 一页都没选中时右栏什么也不说：那时并不存在「本页」，
              写「本页还没有小节」是在描述一个不存在的东西。 */}
          {pageId === "" ? null : headings.length === 0 ? (
            <p className="muted small">（本页还没有小节）</p>
          ) : (
            <>
              <h4>目录</h4>
              <ul>
                {headings.map((h) => (
                  <li key={h.id} className={h.level === 3 ? "sub" : ""}>
                    <a href={`#${h.id}`}>{h.text}</a>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      </div>

      {adding !== null && (
        <AddDialog
          parentTitle={
            adding.parentId === null
              ? null
              : (flat.find((p) => p.id === adding.parentId)?.title ?? null)
          }
          onClose={() => setAdding(null)}
          onSubmit={async (fields) => {
            const created = await createWikiPage(productId, {
              ...fields,
              parentId: adding.parentId,
            });
            await refreshTree();
            setAdding(null);
            setPickedPage(created.id);
          }}
        />
      )}
    </div>
  );
}

/**
 * 章节树的一项。章可以折叠；节直接列。
 *
 * **折叠状态由父组件持有**（`collapsed` 集合），不是每项自己 useState。
 * 自己存的话「选中项移进一个已折叠的章」就只能靠 effect 或在 render 里改 ref 来展开
 * ——两者 lint 都会拦，而且确实是反模式。父组件知道选中项变化，
 * 顺手把那一章从 collapsed 里拿掉即可，不需要任何副作用。
 */
function ChapterItem({
  node,
  activeId,
  collapsed,
  onToggle,
  onPick,
  onAddChild,
}: {
  node: WikiNode;
  activeId: string;
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onPick: (id: string) => void;
  onAddChild: (id: string) => void;
}): React.JSX.Element {
  const open = !collapsed.has(node.id);

  return (
    <li>
      <div className={`wiki-item${node.id === activeId ? " active" : ""}`}>
        {node.children.length > 0 ? (
          <button
            type="button"
            className="wiki-caret"
            aria-label={open ? "折叠" : "展开"}
            onClick={() => onToggle(node.id)}
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        ) : (
          <span className="wiki-caret" />
        )}
        <button
          type="button"
          className="wiki-link"
          onClick={() => onPick(node.id)}
        >
          <span className="wiki-no">{node.number}</span>
          <span className="wiki-title">{node.title}</span>
          {/* 「待写」要显眼：一本十三章的 wiki 里，没写的那几章是下一步要干的活。 */}
          {node.length === 0 && <span className="wiki-todo">待写</span>}
        </button>
        {node.parentId === null && (
          <button
            type="button"
            className="icon-btn ghost wiki-add"
            aria-label={`在「${node.title}」下加一节`}
            title="加一节"
            onClick={() => onAddChild(node.id)}
          >
            <Plus size={12} />
          </button>
        )}
      </div>
      {open && node.children.length > 0 && (
        <ul className="wiki-sections">
          {node.children.map((c) => (
            <ChapterItem
              key={c.id}
              node={c}
              activeId={activeId}
              collapsed={collapsed}
              onToggle={onToggle}
              onPick={onPick}
              onAddChild={onAddChild}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function AddDialog({
  parentTitle,
  onSubmit,
  onClose,
}: {
  parentTitle: string | null;
  onSubmit: (fields: { title: string; brief: string }) => Promise<void>;
  onClose: () => void;
}): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          void onSubmit({ title: title.trim(), brief: brief.trim() })
            .catch((cause: unknown) => {
              setError(cause instanceof Error ? cause.message : "创建失败");
            })
            .finally(() => setBusy(false));
        }}
      >
        <header className="dialog-head">
          <h2>
            {parentTitle === null ? "加一章" : `在「${parentTitle}」下加一节`}
          </h2>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <label className="field">
          标题
          <input
            ref={inputRef}
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="field">
          这一章写什么
          <textarea
            rows={3}
            maxLength={2000}
            placeholder="选填。写成祈使句——让 AI 写正文时它是输入，不是摘要。"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
        </label>
        {error !== null && (
          <p className="err-text" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-foot">
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || title.trim() === ""}
          >
            {busy && <Loader2 size={13} className="spin" />}
            创建
          </button>
        </footer>
      </form>
    </div>
  );
}

function flatten(nodes: readonly WikiNode[]): WikiNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.children)]);
}
