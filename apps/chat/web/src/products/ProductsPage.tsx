import { ART } from "../assets/art";
import { useEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Code2,
  Database,
  FolderOpen,
  Globe,
  LayoutTemplate,
  Library,
  ListChecks,
  Loader2,
  MessagesSquare,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  listChecks,
  startCompare,
  startDiscover,
  type Started,
} from "../analysis/api";
import { FolderPicker } from "../analysis/FolderPicker";
import { MultiPicker } from "../analysis/MultiPicker";
import { CODE_ROOT } from "../files/location";
import { listTemplates } from "../lifecycle/api";
import {
  createLine,
  createProduct,
  deleteLine,
  deleteProduct,
  listLines,
  updateLine,
  updateProduct,
  type Product,
  type ProductLine,
} from "./api";
import { EditDialog } from "./EditDialog";
import { EnvsDialog } from "./EnvsDialog";
import { RefsDialog } from "./RefsDialog";
import "./products.css";
import { Select } from "../ui/Select";

type Dialog =
  | { kind: "new-line" }
  | { kind: "edit-line"; line: ProductLine }
  | { kind: "new-product"; line: ProductLine }
  | { kind: "edit-product"; product: Product };

/**
 * 一级菜单「产品」→ 产品。产品线与产品的增删改查，并给产品绑定一份生命周期规范。
 *
 * 左边产品线列表，右边选中产品线的详情与它下面的产品。每次改动后整表重取
 * （量级是几十条），不在前端维护局部缓存。
 *
 * 这里读了生命周期规范的模板清单（「所属模板」下拉）——绑定本身就是两者的交集，
 * 这一条依赖避不开；其余部分两个页面互不依赖。
 */
export function ProductsPage({
  onAnalysis,
  onOpenProduct,
  onChat,
}: {
  /** 发起一次 AI 分析：外壳负责把人带到那条对话上，并把提示词发出去。 */
  onAnalysis: (started: Started) => void;
  /**
   * 打开一个产品的详情。
   *
   * 详情落在「图谱 → 生命线」：那里按阶段列出这个产品该交的产出物、缺哪个。
   * 点产品卡片与点「产出物」按钮都走这里。
   */
  onOpenProduct: (
    product: Product,
    target?: "lifeline" | "wiki" | "schema" | "pages",
  ) => void;
  /**
   * 开一条**属于这个产品**的对话（平台规范：事实依据）。
   *
   * 这条对话每轮都会自动从该产品的依据库里挑相关文件、连正文一起交给 AI。
   * 不给则不显示按钮（测试或别处复用本页时）。
   */
  onChat?: ((product: Product) => void) | undefined;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const lines = useQuery({ queryKey: ["lines"], queryFn: listLines });
  /** 「所属模板」下拉的选项。与生命周期规范页共用同一个 query key，改了模板这边跟着新。 */
  const templates = useQuery({
    queryKey: ["lifecycle-templates"],
    queryFn: listTemplates,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  /** 编辑产品时「所属产品线」的选择。 */
  const [targetLine, setTargetLine] = useState("");
  /** 新建 / 编辑产品时「所属模板」的选择。空串 = 不绑。 */
  const [targetTemplate, setTargetTemplate] = useState("");
  /** 页面级提示（如删除被拒的原因）。 */
  const [notice, setNotice] = useState<string | null>(null);
  /** 每个产品最近一次的产出物比对结果。一次取全部，不按产品发 N 个请求。 */
  const checks = useQuery({
    queryKey: ["product-checks"],
    queryFn: listChecks,
  });
  /** 正在选目录：discover = 识别产线与产品；bind* = 给产线 / 产品绑目录。 */
  const [picking, setPicking] = useState<
    | { kind: "discover" }
    | { kind: "bind-line"; line: ProductLine }
    | { kind: "bind"; product: Product }
    | { kind: "bind-code"; product: Product }
    /** 存 id 不存对象：每次增删后整表重取，弹窗要跟着显示最新的那份。 */
    | { kind: "refs"; productId: string }
    | { kind: "envs"; product: Product }
    | null
  >(null);
  /** 正在发起哪个产品的比对（按钮转圈用）。 */
  const [comparing, setComparing] = useState<string | null>(null);
  /** 展开「更多」菜单的产品 id。一次只开一个。 */
  const [more, setMore] = useState<string | null>(null);
  const moreRef = useRef<HTMLDivElement>(null);

  // 「更多」菜单点空白处关闭（菜单里的按钮点了会自己关，这条只管点到别处）。
  useEffect(() => {
    if (more === null) return;
    const onDown = (e: MouseEvent): void => {
      if (!moreRef.current?.contains(e.target as Node)) setMore(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [more]);

  const all = lines.data ?? [];
  const allTemplates = templates.data ?? [];
  const templateName = (id: string | null): string | null =>
    id === null ? null : (allTemplates.find((t) => t.id === id)?.name ?? null);
  const checkOf = (productId: string) =>
    (checks.data ?? []).find((c) => c.productId === productId);
  // 选中的产品线被删了（或还没选过）就落到第一条。
  const selected = all.find((l) => l.id === selectedId) ?? all[0];

  /** 发起一次产出物比对：建好分析会话后由外壳把人带到那条对话上。 */
  const compare = (product: Product): void => {
    setNotice(null);
    setComparing(product.id);
    void startCompare(product.id)
      .then(onAnalysis)
      .catch((cause: unknown) => {
        // 没绑模板 / 没绑目录会走这里（409），文案由服务端给，已经说清下一步做什么。
        setNotice(cause instanceof Error ? cause.message : "发起比对失败");
      })
      .finally(() => setComparing(null));
  };

  /** 「所属模板」表单项。新建与编辑共用。 */
  const templateField = (
    <label className="field">
      生命周期规范
      <Select
        value={targetTemplate}
        onChange={(v) => setTargetTemplate(v)}
        options={[
          { value: "", label: "暂不绑定" },
          ...allTemplates.map((t) => ({ value: t.id, label: t.name })),
        ]}
      />
      <span className="field-hint">
        绑定后就有了「这个产品该交哪些东西」的清单，后续让 AI
        比对文件时用它当标尺。
      </span>
    </label>
  );

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ["lines"] });
  const close = (): void => setDialog(null);
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "操作失败");
    }
    await refresh();
  };

  const removeLine = (line: ProductLine): void => {
    // 服务端也会拒（409），这里先拦住，免得先问「确定删除吗」再告诉你删不了。
    if (line.products.length > 0) {
      setNotice(
        `「${line.name}」下还有 ${String(line.products.length)} 个产品，先移走或删除它们`,
      );
      return;
    }
    if (window.confirm(`删除产品线「${line.name}」？`))
      void run(() => deleteLine(line.id));
  };
  const removeProduct = (product: Product): void => {
    if (window.confirm(`删除产品「${product.name}」？`))
      void run(() => deleteProduct(product.id));
  };

  return (
    <div className="products-page">
      <aside className="products-side">
        <header className="sidebar-head">
          <h1>产品线</h1>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="新建产品线"
            title="新建产品线"
            onClick={() => setDialog({ kind: "new-line" })}
          >
            <Plus size={16} />
          </button>
        </header>
        <nav className="line-list" aria-label="产品线列表">
          {all.map((line) => (
            <button
              key={line.id}
              type="button"
              className={`line-item${line.id === selected?.id ? " active" : ""}`}
              aria-current={line.id === selected?.id ? "true" : undefined}
              onClick={() => {
                setSelectedId(line.id);
                setNotice(null);
              }}
            >
              <span className="line-name">{line.name}</span>
              <span className="count">{line.products.length}</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="products-main" aria-label="产品线详情">
        {notice && (
          <div className="notice" role="alert">
            <span>{notice}</span>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setNotice(null)}
            >
              知道了
            </button>
          </div>
        )}

        {lines.isPending && (
          <p className="muted">
            <Loader2 size={14} className="spin" /> 读取中…
          </p>
        )}
        {lines.isError && (
          <p className="err-text">读取失败：{lines.error.message}</p>
        )}

        {lines.isSuccess && !selected && (
          <div className="products-empty">
            <img
              className="products-empty-art"
              src={ART.products.src}
              srcSet={ART.products.srcSet}
              alt=""
              aria-hidden="true"
              width={180}
              height={180}
            />
            <p>还没有产品线</p>
            <button
              type="button"
              className="btn primary"
              onClick={() => setDialog({ kind: "new-line" })}
            >
              <Plus size={14} /> 新建产品线
            </button>
          </div>
        )}

        {selected && (
          <>
            <header className="line-head">
              <div>
                <h2>{selected.name}</h2>
                {selected.description ? (
                  <p className="desc">{selected.description}</p>
                ) : (
                  <p className="muted">暂无描述</p>
                )}
              </div>
              <div className="row">
                <button
                  type="button"
                  className="btn"
                  title="读一个目录，自动识别里面有哪些产线与产品"
                  onClick={() => {
                    setNotice(null);
                    setPicking({ kind: "discover" });
                  }}
                >
                  <Sparkles size={13} /> AI 识别
                </button>
                {/* 产品线的绑定目录原来只有「AI 识别」能写进去，界面上改不掉——
                    识别选错一层就只能删了重建。和产品行一样给个文件夹图标。 */}
                <button
                  type="button"
                  className="btn"
                  title={
                    selected.folderPath === null
                      ? "绑定目录"
                      : `绑定的目录：${selected.folderPath}`
                  }
                  onClick={() => {
                    setNotice(null);
                    setPicking({ kind: "bind-line", line: selected });
                  }}
                >
                  <FolderOpen size={13} />
                  {selected.folderPath === null ? "绑定目录" : "改目录"}
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setDialog({ kind: "edit-line", line: selected })
                  }
                >
                  <Pencil size={13} /> 编辑
                </button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => removeLine(selected)}
                >
                  <Trash2 size={13} /> 删除
                </button>
              </div>
            </header>

            <section className="products-section">
              <header className="section-head">
                <h3>产品（{selected.products.length}）</h3>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => {
                    setTargetTemplate("");
                    setDialog({ kind: "new-product", line: selected });
                  }}
                >
                  <Plus size={14} /> 新建产品
                </button>
              </header>
              {selected.products.length === 0 ? (
                <p className="muted empty-row">这条产品线下还没有产品</p>
              ) : (
                <ul className="product-list" aria-label="产品列表">
                  {selected.products.map((product) => (
                    <li key={product.id} className="product">
                      {/*
                        整块可点：点名字进这个产品的「产出物」（图谱 → 生命线，按阶段列出
                        该交什么、缺什么）。原来这里是一排没有文字的图标，既看不出来能点、
                        也猜不出每个图标是什么，用户直接反馈过。
                      */}
                      <button
                        type="button"
                        className="product-open"
                        aria-label={`打开 ${product.name} 的产出物`}
                        title="打开这个产品的产出物"
                        onClick={() => onOpenProduct(product)}
                      >
                        <span className="product-titles">
                          <strong>{product.name}</strong>
                          {product.description && (
                            <span className="desc">{product.description}</span>
                          )}
                        </span>
                        <span className="product-meta">
                          <span className="product-template">
                            <ListChecks size={12} />
                            {templateName(product.templateId) ??
                              "未绑定生命周期规范"}
                          </span>
                          <span className="product-template">
                            <FolderOpen size={12} />
                            {product.folderPath ?? "未绑文档目录"}
                          </span>
                          <span className="product-template">
                            <Code2 size={12} />
                            {product.codePath ?? "未绑代码目录"}
                          </span>
                          {(product.refPaths ?? []).length > 0 && (
                            <span
                              className="product-template"
                              title={(product.refPaths ?? []).join("\n")}
                            >
                              <Library size={12} />
                              参考资料 {(product.refPaths ?? []).length} 条
                            </span>
                          )}
                          <CheckBadge check={checkOf(product.id)} />
                        </span>
                        <ChevronRight size={16} className="product-go" />
                      </button>

                      {/* 常用动作用文字写清楚；绑目录、编辑、删除这类低频操作收进「更多」。 */}
                      <div className="product-actions">
                        <button
                          type="button"
                          className="btn small"
                          onClick={() => onOpenProduct(product)}
                        >
                          <ListChecks size={14} /> 产出物
                        </button>
                        <button
                          type="button"
                          className="btn small"
                          onClick={() => onOpenProduct(product, "wiki")}
                        >
                          <BookOpen size={14} /> Wiki
                        </button>
                        <button
                          type="button"
                          className="btn small"
                          disabled={product.codePath === null}
                          title={
                            product.codePath === null
                              ? "先绑代码目录：表结构是从代码里读出来的"
                              : "看这个产品的表与关联（从代码读出，不连数据库）"
                          }
                          onClick={() => onOpenProduct(product, "schema")}
                        >
                          <Database size={14} /> 数据结构
                        </button>
                        <button
                          type="button"
                          className="btn small"
                          disabled={product.codePath === null}
                          title={
                            product.codePath === null
                              ? "先绑代码目录：页面清单是从前端代码里读出来的"
                              : "看这个产品有哪些页面、谁能进（从前端代码读出）"
                          }
                          onClick={() => onOpenProduct(product, "pages")}
                        >
                          <LayoutTemplate size={14} /> 页面
                        </button>
                        {onChat !== undefined && (
                          <button
                            type="button"
                            className="btn small"
                            title="开一条属于这个产品的对话：每轮自动带上它的事实依据"
                            onClick={() => onChat(product)}
                          >
                            <MessagesSquare size={14} /> 对话
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn small"
                          disabled={comparing === product.id}
                          title="让 AI 对照生命周期规范核对这个产品的产出物齐不齐"
                          onClick={() => compare(product)}
                        >
                          {comparing === product.id ? (
                            <Loader2 size={14} className="spin" />
                          ) : (
                            <Sparkles size={14} />
                          )}
                          AI 比对
                        </button>
                        {/* 宽行：低频操作直接摊开（CSS 容器查询决定显示哪一套） */}
                        <span className="product-inline">
                          <button
                            type="button"
                            className="btn small ghost"
                            aria-label={`给 ${product.name} 绑文档目录`}
                            title={product.folderPath ?? "还没绑文档目录"}
                            onClick={() => {
                              setNotice(null);
                              setPicking({ kind: "bind", product });
                            }}
                          >
                            <FolderOpen size={14} /> 文档目录
                          </button>
                          <button
                            type="button"
                            className="btn small ghost"
                            aria-label={`给 ${product.name} 绑代码目录`}
                            title={product.codePath ?? "还没绑代码目录"}
                            onClick={() => {
                              setNotice(null);
                              setPicking({ kind: "bind-code", product });
                            }}
                          >
                            <Code2 size={14} /> 代码目录
                          </button>
                          <button
                            type="button"
                            className="btn small ghost"
                            onClick={() => {
                              setNotice(null);
                              setPicking({
                                kind: "refs",
                                productId: product.id,
                              });
                            }}
                          >
                            <Library size={14} /> 参考资料
                          </button>
                          <button
                            type="button"
                            className="btn small ghost"
                            title="登记测试环境后，这个产品的对话里 AI 能自己打开真实页面看（只读）"
                            onClick={() => {
                              setNotice(null);
                              setPicking({ kind: "envs", product });
                            }}
                          >
                            <Globe size={14} /> 测试环境
                          </button>
                          <button
                            type="button"
                            className="btn small ghost"
                            aria-label={`编辑 ${product.name}`}
                            onClick={() => {
                              setTargetLine(product.lineId);
                              setTargetTemplate(product.templateId ?? "");
                              setDialog({ kind: "edit-product", product });
                            }}
                          >
                            <Pencil size={14} /> 编辑
                          </button>
                          <button
                            type="button"
                            className="btn small ghost danger-text"
                            aria-label={`删除 ${product.name}`}
                            onClick={() => removeProduct(product)}
                          >
                            <Trash2 size={14} /> 删除
                          </button>
                        </span>
                        <div
                          className="product-more"
                          ref={more === product.id ? moreRef : undefined}
                        >
                          <button
                            type="button"
                            className="btn small ghost"
                            aria-expanded={more === product.id}
                            aria-haspopup="menu"
                            onClick={() =>
                              setMore(more === product.id ? null : product.id)
                            }
                          >
                            更多 <ChevronDown size={14} />
                          </button>
                          {more === product.id && (
                            <div className="product-menu" role="menu">
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMore(null);
                                  setNotice(null);
                                  setPicking({ kind: "bind", product });
                                }}
                              >
                                <FolderOpen size={14} />
                                <span>
                                  绑定文档目录
                                  <em>{product.folderPath ?? "未绑"}</em>
                                </span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMore(null);
                                  setNotice(null);
                                  setPicking({ kind: "bind-code", product });
                                }}
                              >
                                <Code2 size={14} />
                                <span>
                                  绑定代码目录
                                  <em>{product.codePath ?? "未绑"}</em>
                                </span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMore(null);
                                  setNotice(null);
                                  setPicking({
                                    kind: "refs",
                                    productId: product.id,
                                  });
                                }}
                              >
                                <Library size={14} />
                                <span>
                                  参考资料
                                  <em>{(product.refPaths ?? []).length} 条</em>
                                </span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMore(null);
                                  setNotice(null);
                                  setPicking({ kind: "envs", product });
                                }}
                              >
                                <Globe size={14} />
                                <span>
                                  测试环境
                                  <em>AI 只读看页面</em>
                                </span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMore(null);
                                  setTargetLine(product.lineId);
                                  setTargetTemplate(product.templateId ?? "");
                                  setDialog({
                                    kind: "edit-product",
                                    product,
                                  });
                                }}
                              >
                                <Pencil size={14} />
                                <span>编辑</span>
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="danger"
                                onClick={() => {
                                  setMore(null);
                                  removeProduct(product);
                                }}
                              >
                                <Trash2 size={14} />
                                <span>删除</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </section>

      {dialog?.kind === "new-line" && (
        <EditDialog
          title="新建产品线"
          submitLabel="创建"
          onClose={close}
          onSubmit={async (fields) => {
            const line = await createLine(fields);
            await refresh();
            setSelectedId(line.id);
            close();
          }}
        />
      )}
      {dialog?.kind === "edit-line" && (
        <EditDialog
          title="编辑产品线"
          submitLabel="保存"
          initial={dialog.line}
          onClose={close}
          onSubmit={async (fields) => {
            await updateLine(dialog.line.id, fields);
            await refresh();
            close();
          }}
        />
      )}
      {dialog?.kind === "new-product" && (
        <EditDialog
          title={`在「${dialog.line.name}」下新建产品`}
          submitLabel="创建"
          onClose={close}
          extra={templateField}
          onSubmit={async (fields) => {
            await createProduct(dialog.line.id, {
              ...fields,
              templateId: targetTemplate,
            });
            await refresh();
            close();
          }}
        />
      )}
      {dialog?.kind === "edit-product" && (
        <EditDialog
          title="编辑产品"
          submitLabel="保存"
          initial={dialog.product}
          onClose={close}
          extra={
            <>
              <label className="field">
                所属产品线
                <Select
                  value={targetLine}
                  onChange={(v) => setTargetLine(v)}
                  options={all.map((l) => ({ value: l.id, label: l.name }))}
                />
              </label>
              {templateField}
              <p className="field-hint">
                绑定的目录在产品行上用文件夹图标改（那里能逐层点进去选，比在这里填路径不容易填错）。
              </p>
            </>
          }
          onSubmit={async (fields) => {
            await updateProduct(dialog.product.id, {
              ...fields,
              ...(targetLine !== dialog.product.lineId
                ? { lineId: targetLine }
                : {}),
              ...(targetTemplate !== (dialog.product.templateId ?? "")
                ? { templateId: targetTemplate }
                : {}),
            });
            await refresh();
            close();
          }}
        />
      )}

      {picking?.kind === "discover" && (
        <MultiPicker
          title="AI 识别产线与产品"
          hint="可以同时勾选多处：产品库文件夹（比如 /product-docs/products）、单份资料（比如能力地图）、代码库里的仓库。AI 会据此识别产线与产品，并给每个产品配好文档目录、代码目录和参考资料。没勾代码仓库时，会把代码库里所有仓库交给 AI 去对。识别完先给你确认，不会直接写进来。"
          initialPath="/"
          submitLabel="开始识别"
          onClose={() => setPicking(null)}
          onPick={async (paths) => {
            const started = await startDiscover(paths);
            setPicking(null);
            onAnalysis(started);
          }}
        />
      )}
      {picking?.kind === "bind-line" && (
        <FolderPicker
          title={`给产品线「${picking.line.name}」绑定目录`}
          hint="选到装着这条产线各个产品的那一层。「AI 识别产线与产品」默认从这里读。"
          initialPath={picking.line.folderPath ?? "/"}
          submitLabel="就绑这个"
          onClose={() => setPicking(null)}
          onPick={async (path) => {
            await updateLine(picking.line.id, { folderPath: path });
            await refresh();
            setPicking(null);
          }}
        />
      )}
      {picking?.kind === "bind-code" && (
        <FolderPicker
          title={`给「${picking.product.name}」绑定代码目录`}
          hint="选这个产品的代码目录（事实底座 → 代码 里上传的那份）。AI 分析功能架构时读的就是它。"
          initialPath={picking.product.codePath ?? CODE_ROOT}
          root={CODE_ROOT}
          submitLabel="就绑这个"
          onClose={() => setPicking(null)}
          onPick={async (path) => {
            await updateProduct(picking.product.id, { codePath: path });
            await refresh();
            setPicking(null);
          }}
        />
      )}
      {picking?.kind === "refs" &&
        (() => {
          const product = all
            .flatMap((l) => l.products)
            .find((p) => p.id === picking.productId);
          if (product === undefined) return null;
          return (
            <RefsDialog
              product={product}
              onClose={() => setPicking(null)}
              onSave={async (refPaths) => {
                await updateProduct(product.id, { refPaths });
                await refresh();
              }}
            />
          );
        })()}
      {picking?.kind === "envs" && (
        <EnvsDialog
          product={picking.product}
          onClose={() => setPicking(null)}
        />
      )}
      {picking?.kind === "bind" && (
        <FolderPicker
          title={`给「${picking.product.name}」绑定目录`}
          hint="选这个产品的文档目录。AI 比对产出物时读的就是它。"
          initialPath={picking.product.folderPath ?? "/"}
          submitLabel="就绑这个"
          onClose={() => setPicking(null)}
          onPick={async (path) => {
            await updateProduct(picking.product.id, { folderPath: path });
            await refresh();
            setPicking(null);
          }}
        />
      )}
    </div>
  );
}

/** 产品行上的「上次比对」。没比对过就不占位置——空状态不如不显示。 */
function CheckBadge({
  check,
}: {
  check:
    | {
        summary: { present: number; total: number; requiredGap: number };
        checkedAt: number;
      }
    | undefined;
}): React.JSX.Element | null {
  if (!check) return null;
  const { present, total, requiredGap } = check.summary;
  const when = new Date(check.checkedAt).toLocaleDateString("zh-CN");
  return (
    <span
      className={`pill ${requiredGap === 0 ? "ok" : "warn"}`}
      title={
        requiredGap === 0
          ? "必交项已齐"
          : `必交项还差 ${String(requiredGap)} 件`
      }
    >
      上次比对 {present}/{total} 齐 · {when}
    </span>
  );
}
