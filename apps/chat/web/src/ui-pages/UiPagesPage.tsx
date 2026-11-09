import { useMemo, useState } from "react";
import {
  ArrowRight,
  FileCode2,
  LayoutTemplate,
  Loader2,
  Lock,
  Search,
  TriangleAlert,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { listLines, type Product } from "../products/api";
import { Select } from "../ui/Select";
import {
  getFrontend,
  listFrontends,
  type FrontendSummary,
  type RouterFormat,
  type UiPage,
} from "./api";
import {
  TITLE_FROM_LABEL,
  accessKind,
  groupPages,
  shortPath,
  type AccessFilter,
} from "./group";
import "./ui-pages.css";

/**
 * 产品 → 页面（前端视角）。
 *
 * 从产品绑定的代码目录里**读**出每个前端有哪些页面（路由表 / 页面目录），不启动任何前端；
 * 与对话里交给 AI 的「页面清单」是同一份解析结果。
 *
 * 两栏：左边按菜单分组的页面清单（可搜、可按访问权限筛），右边选中页面的详情。
 */

const FORMAT_LABEL: Record<RouterFormat, string> = {
  "vue-router": "Vue Router 路由表",
  "react-router": "React Router 路由",
  nuxt: "Nuxt 页面目录",
  next: "Next 页面目录",
};
const ACCESS_CHOICES: { id: AccessFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "public", label: "不用登录" },
  { id: "login", label: "登录可见" },
  { id: "admin", label: "限角色 / 管理员" },
];

export function UiPagesPage({
  productId,
  onOpenFile,
}: {
  productId?: string;
  /** 打开组件源文件（事实底座 → 代码库）。 */
  onOpenFile?: (path: string) => void;
}): React.JSX.Element {
  const lines = useQuery({ queryKey: ["lines"], queryFn: listLines });
  const products = useMemo(
    () =>
      (lines.data ?? []).flatMap((l) =>
        l.products.map((p) => ({ product: p, lineName: l.name })),
      ),
    [lines.data],
  );
  const [chosen, setChosen] = useState<string | null>(productId ?? null);
  const current: Product | null = useMemo(() => {
    const hit = products.find((p) => p.product.id === chosen)?.product;
    if (hit !== undefined) return hit;
    return (
      products.find((p) => p.product.codePath !== null)?.product ??
      products[0]?.product ??
      null
    );
  }, [products, chosen]);

  const frontends = useQuery({
    queryKey: ["ui-frontends", current?.id],
    queryFn: () => listFrontends(current?.id ?? ""),
    enabled: current !== null && current.codePath !== null,
  });
  const fes = useMemo(() => frontends.data?.frontends ?? [], [frontends.data]);
  const [root, setRoot] = useState<string | null>(null);
  const fe = fes.find((f) => f.root === root) ?? fes[0] ?? null;
  const detail = useQuery({
    queryKey: ["ui-pages", current?.id, fe?.root],
    queryFn: () => getFrontend(current?.id ?? "", fe?.root ?? ""),
    enabled: current !== null && fe !== null,
  });

  return (
    <div className="u-page">
      <header className="u-toolbar">
        <div className="u-toolbar-title">
          <LayoutTemplate size={15} className="faint" />
          <strong>页面</strong>
          <span className="muted small">
            从前端代码里读出的页面清单，不启动前端；对话里 AI 拿到的也是这一份。
          </span>
        </div>
        <div className="u-toolbar-actions">
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
          {fes.length > 0 && (
            <Select
              className="input sm"
              aria-label="选择前端"
              value={fe?.root ?? ""}
              options={fes.map((f) => ({
                value: f.root,
                label: `${f.label}（${String(f.pages)} 页）`,
              }))}
              onChange={(v) => setRoot(v)}
            />
          )}
        </div>
      </header>

      {fe !== null && <Notice fe={fe} />}

      <Body
        key={`${current?.id ?? ""}|${fe?.root ?? ""}`}
        loading={
          lines.isPending ||
          frontends.isFetching ||
          (fe !== null && detail.isPending)
        }
        error={frontends.error ?? detail.error}
        product={current}
        empty={frontends.isSuccess && fes.length === 0}
        pages={detail.data?.pageList}
        codeRoot={current?.codePath ?? ""}
        {...(onOpenFile === undefined ? {} : { onOpenFile })}
      />
    </div>
  );
}

function Notice({ fe }: { fe: FrontendSummary }): React.JSX.Element {
  return (
    <p className="u-notice muted small">
      取自{FORMAT_LABEL[fe.format]}（{shortPath(fe.entry, fe.root)}）·{" "}
      {fe.pages} 个页面
      {fe.redirects > 0 ? ` · 另有 ${String(fe.redirects)} 条只做跳转` : ""}
      。这是代码里登记的页面，不代表都在菜单里露出。
      {fe.untitled > 0 && (
        <span className="u-warn">
          <TriangleAlert size={12} /> {fe.untitled} 个页面没取到标题
        </span>
      )}
      {fe.unparsed.count > 0 && (
        <span className="u-warn" title={fe.unparsed.samples.join("\n")}>
          <TriangleAlert size={12} /> 有 {fe.unparsed.count}{" "}
          处路由写法没认出来，可能漏页
        </span>
      )}
    </p>
  );
}

function Body({
  loading,
  error,
  product,
  empty,
  pages: raw,
  codeRoot,
  onOpenFile,
}: {
  loading: boolean;
  error: Error | null;
  product: Product | null;
  empty: boolean;
  pages: UiPage[] | undefined;
  codeRoot: string;
  onOpenFile?: (path: string) => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [access, setAccess] = useState<AccessFilter>("all");
  const [showRedirects, setShowRedirects] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const pages = useMemo(() => raw ?? [], [raw]);
  const groups = useMemo(
    () => groupPages(pages, { query, access, showRedirects }),
    [pages, query, access, showRedirects],
  );
  const shown = groups.reduce((n, g) => n + g.pages.length, 0);
  const page =
    selected === null ? null : (pages.find((p) => p.path === selected) ?? null);

  if (loading)
    return (
      <div className="u-empty">
        <Loader2 size={20} className="spin faint" />
        <p className="muted small">读取前端代码里的页面…</p>
      </div>
    );
  if (error !== null)
    return (
      <div className="u-empty">
        <p className="err-text">读取失败：{error.message}</p>
      </div>
    );
  if (product === null)
    return (
      <div className="u-empty">
        <LayoutTemplate size={28} className="faint" />
        <p>还没有产品</p>
        <p className="muted small">
          先去「产品」标签建产品，并给它绑代码目录。
        </p>
      </div>
    );
  if (product.codePath === null)
    return (
      <div className="u-empty">
        <LayoutTemplate size={28} className="faint" />
        <p>「{product.name}」还没绑代码目录</p>
        <p className="muted small">
          页面清单是从前端代码里读的。去「产品」标签给它绑一个代码目录。
        </p>
      </div>
    );
  if (empty)
    return (
      <div className="u-empty">
        <LayoutTemplate size={28} className="faint" />
        <p>代码目录里没找到前端页面</p>
        <p className="muted small">
          目前认四种写法：Vue Router 路由表、React Router 的 &lt;Route&gt;、Nuxt
          的 pages 目录、Next 的 app / pages 目录。
        </p>
      </div>
    );

  return (
    <div className="u-body">
      <section className="u-list" aria-label="页面清单">
        <div className="u-filters">
          <label className="u-search">
            <Search size={13} className="faint" />
            <input
              value={query}
              placeholder="按标题、路径、组件找"
              aria-label="搜索页面"
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          <span className="seg" role="group" aria-label="按访问权限筛选">
            {ACCESS_CHOICES.map((c) => (
              <button
                key={c.id}
                type="button"
                className={access === c.id ? "on" : ""}
                aria-pressed={access === c.id}
                onClick={() => setAccess(c.id)}
              >
                {c.label}
              </button>
            ))}
          </span>
          <label className="u-check small">
            <input
              type="checkbox"
              checked={showRedirects}
              onChange={(e) => setShowRedirects(e.target.checked)}
            />
            显示只做跳转的
          </label>
          <span className="muted small">{shown} 个</span>
        </div>
        {groups.length === 0 ? (
          <p className="muted small pad">当前筛选下没有页面</p>
        ) : (
          groups.map((g) => (
            <div key={g.key} className="u-group">
              <h4>
                {g.label}
                <span className="muted small">{g.pages.length}</span>
              </h4>
              <ul>
                {g.pages.map((p) => (
                  <li key={p.path}>
                    <button
                      type="button"
                      className={p.path === selected ? "on" : ""}
                      aria-pressed={p.path === selected}
                      onClick={() => setSelected(p.path)}
                    >
                      <span className="u-title">
                        {p.title ?? (
                          <span className="faint">（没取到标题）</span>
                        )}
                      </span>
                      <code className="u-path">{p.path}</code>
                      <span className="u-badges">
                        {p.redirect !== null && (
                          <span className="tag">跳转</span>
                        )}
                        {accessKind(p) === "admin" && (
                          <span className="tag warn">
                            <Lock size={10} /> 限权限
                          </span>
                        )}
                        {accessKind(p) === "public" && p.redirect === null && (
                          <span className="tag">公开</span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
      </section>
      {page !== null && (
        <PageDrawer
          page={page}
          codeRoot={codeRoot}
          onClose={() => setSelected(null)}
          onJump={(path) => setSelected(path)}
          {...(onOpenFile === undefined ? {} : { onOpenFile })}
        />
      )}
    </div>
  );
}

function PageDrawer({
  page,
  codeRoot,
  onClose,
  onJump,
  onOpenFile,
}: {
  page: UiPage;
  codeRoot: string;
  onClose: () => void;
  onJump: (path: string) => void;
  onOpenFile?: (path: string) => void;
}): React.JSX.Element {
  return (
    <aside className="u-drawer" aria-label={`页面 ${page.path} 的详情`}>
      <header className="u-drawer-head">
        <h3>{page.title ?? "（没取到标题）"}</h3>
        <button
          type="button"
          className="icon-btn ghost"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      <code className="u-drawer-path">{page.path}</code>
      <dl className="u-dl">
        {page.section !== null && (
          <>
            <dt>菜单</dt>
            <dd>{page.section}</dd>
          </>
        )}
        <dt>谁能进</dt>
        <dd>
          {page.access.length === 0
            ? "代码里没写访问要求"
            : page.access.join(" · ")}
        </dd>
        {page.redirect !== null && (
          <>
            <dt>跳转到</dt>
            <dd>
              {page.redirect.startsWith("/") ? (
                <button
                  type="button"
                  className="u-link"
                  onClick={() => onJump(page.redirect ?? "")}
                >
                  {page.redirect} <ArrowRight size={12} />
                </button>
              ) : (
                page.redirect
              )}
            </dd>
          </>
        )}
        {page.aliases.length > 0 && (
          <>
            <dt>别名</dt>
            <dd>
              {page.aliases.map((a) => (
                <code key={a}>{a} </code>
              ))}
            </dd>
          </>
        )}
        <dt>标题来源</dt>
        <dd>
          {page.titleFrom === null
            ? "没取到"
            : TITLE_FROM_LABEL[page.titleFrom]}
          {page.titleKey !== null && page.titleFrom !== "i18n" && (
            <span className="muted small">
              （文案键 <code>{page.titleKey}</code> 没查到中文）
            </span>
          )}
        </dd>
        {page.name !== null && (
          <>
            <dt>路由名</dt>
            <dd>
              <code>{page.name}</code>
            </dd>
          </>
        )}
      </dl>
      <section className="u-drawer-section">
        <h4>页面组件</h4>
        {page.component === null ? (
          <p className="muted small">没解析出组件文件</p>
        ) : onOpenFile === undefined ? (
          <code>{shortPath(page.component, codeRoot)}</code>
        ) : (
          <button
            type="button"
            className="u-link"
            title="在「事实底座 → 代码库」里打开"
            onClick={() => onOpenFile(page.component ?? "")}
          >
            <FileCode2 size={13} />
            {shortPath(page.component, codeRoot)}
          </button>
        )}
      </section>
      <section className="u-drawer-section">
        <h4>定义在</h4>
        <code>{shortPath(page.source, codeRoot)}</code>
      </section>
    </aside>
  );
}
