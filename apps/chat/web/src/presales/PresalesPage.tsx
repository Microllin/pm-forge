import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  ListPlus,
  Loader2,
  Pencil,
  Plus,
  ScanSearch,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
  Wand2,
} from "lucide-react";

import { createRequest, json } from "../http";
import { listLines } from "../products/api";
import {
  aiKey,
  getAi,
  listTemplates,
  reviewable,
  startReview,
  templatesKey,
  type ReviewBrief,
} from "./ai-api";
import { AgentPanel } from "./AgentPanel";
import {
  agentKey,
  deleteVersion,
  getAgent,
  promoteVersion,
  setAutoReview,
  type Todo,
  type TodoAction,
} from "./agent-api";
import { ImportDialog } from "./ImportDialog";
import { TodoPanel } from "./TodoPanel";
import { MaterialPreview } from "./MaterialPreview";
import { ReviewPanel } from "./ReviewPanel";
import { RunDialog, RunSection } from "./RunPanel";
import { TemplateBinding } from "./TemplateBinding";
import { Select } from "../ui/Select";

/**
 * 售前材料库（一级菜单「售前」）。
 *
 * 这一页回答三件事：
 *   ① 每个产品的售前材料齐不齐（缺口在哪、哪些是高优先级缺口）；
 *   ② 每份材料现在哪一版、谁能拿到什么（对外 / 对内、唯一现行版）；
 *   ③ 材料文件在哪、能不能直接下载。
 *
 * 和「产品」页的区别：产品页管产品线 / 产品与它们的生命周期，这里管
 * **出货用的物料**——白皮书、PPT、报价单、POC 方案各是哪一版。
 */

/** 阶段代号。具体有哪几个、叫什么，由库绑的售前模板决定（见 detail.stages）。 */
type Stage = string;

const STATUS_LABEL = {
  draft: "草稿",
  review: "待核",
  current: "可对外",
  archived: "已归档",
} as const;
type Status = keyof typeof STATUS_LABEL;

interface Version {
  id: string;
  slotId: string;
  version: string;
  status: Status;
  releasedAt: string | null;
  note: string;
  filePath: string | null;
  fileName: string | null;
  fileSize: number | null;
  createdAt: number;
  updatedAt: number;
  /** 文件库里这份文件还在不在（详情接口现算）。 */
  fileExists?: boolean;
}

interface Slot {
  id: string;
  libId: string;
  itemKey: string;
  stage: Stage;
  title: string;
  priority: boolean;
  audience: "external" | "internal";
  /** 说明与检查要点：对上模板条目时实时取模板的。 */
  guide: string;
  checkpoints: string[];
  /** 与模板的关系；none = 库没绑模板。 */
  link: "linked" | "outside" | "unmatched" | "none";
  templateItem: { id: string; name: string; stageLabel: string } | null;
  versions: Version[];
  current: Version | null;
}

interface TemplateGap {
  id: string;
  name: string;
  stageCode: string;
  stageLabel: string;
  required: boolean;
  audience: "external" | "internal";
}

interface Lib {
  templateId: string | null;
  templateName: string | null;
  id: string;
  productId: string | null;
  productExists: boolean;
  name: string;
  summary: string;
  status: "active" | "retired";
  slotCount: number;
  coveredCount: number;
  criticalGapCount: number;
  inProgressCount: number;
}

interface Detail {
  lib: Lib;
  /** 阶段清单来自库绑的模板（代号 + 名称），筛选与排序都用它。 */
  stages: { code: string; label: string }[];
  slots: Slot[];
  /** 模板要求、库里没有任何条目对上的材料。 */
  templateGaps: TemplateGap[];
}

const requestApi = createRequest("/api");

const LIBS_KEY = ["presales"] as const;
const libKey = (id: string) => ["presales", id] as const;

const listLibs = () =>
  requestApi<{ libs: Lib[] }>("/presales").then((r) => r.libs);
const getLib = (id: string) => requestApi<Detail>(`/presales/${id}`);
const createLib = (body: unknown) =>
  requestApi<Detail>("/presales", { method: "POST", ...json(body) });
const deleteLib = (id: string) =>
  requestApi<undefined>(`/presales/${id}`, { method: "DELETE" });
/** 按库绑定的模板补齐材料（只加不删）。 */
const syncTemplate = (id: string) =>
  requestApi<Detail & { added: number }>(`/presales/${id}/slots/sync`, {
    method: "POST",
    ...json({}),
  });
const addSlot = (libId: string, body: unknown) =>
  requestApi<Slot>(`/presales/${libId}/slots`, {
    method: "POST",
    ...json(body),
  });
const updateSlot = (id: string, body: unknown) =>
  requestApi<undefined>(`/presales/slots/${id}`, {
    method: "PATCH",
    ...json(body),
  });
const fileUrl = (id: string) => `/api/presales/versions/${id}/file`;

/** 删这一类的文件：从文件库删掉，条目变回缺口。 */
const deleteSlotFile = (slotId: string) =>
  requestApi<undefined>(`/presales/slots/${slotId}/file`, { method: "DELETE" });

/** 改文件名：文件库里同步改名。 */
const renameFile = (versionId: string, name: string) =>
  requestApi<Version>(`/presales/versions/${versionId}/rename`, {
    method: "POST",
    ...json({ name }),
  });

/** 上传 / 替换：写进文件库，成为现行版；替换时旧文件从文件库删掉。 */
async function uploadToSlot(slotId: string, file: File): Promise<Version> {
  const res = await fetch(
    `/api/presales/slots/${slotId}/upload?name=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    },
  );
  if (!res.ok) {
    let message = `上传失败（${String(res.status)}）`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      // 非 JSON 错误体：用兜底文案。
    }
    throw new Error(message);
  }
  return (await res.json()) as Version;
}

function errorText(e: unknown, fallback: string): string {
  if (!(e instanceof Error)) return fallback;
  // 服务端错误体是 { error: { code, message } }，request() 会抛成 Error(message)。
  return e.message === "" ? fallback : e.message;
}

/** 助手栏开 / 关存本机：下次打开还是上次的样子。 */
const AGENT_OPEN_KEY = "pmforge-chat.presales-agent-open";
const readAgentOpen = (): boolean => {
  try {
    return localStorage.getItem(AGENT_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
};

/** 递给助手的一句话。清单上「让助手起草」等按钮经它交给右侧助手。 */
export type Ask = (text: string) => void;

export function PresalesPage({
  onOpenSession,
}: {
  /** 审阅 / 复盘的每一步都是真对话：从这里跳过去看过程、追问。 */
  onOpenSession?: (sessionId: string) => void;
} = {}): React.JSX.Element {
  const queryClient = useQueryClient();
  const libs = useQuery({ queryKey: LIBS_KEY, queryFn: listLibs });
  const [selected, setSelected] = useState<string | null>(null);
  const list = libs.data ?? [];
  const activeId =
    selected !== null && list.some((l) => l.id === selected)
      ? selected
      : (list[0]?.id ?? null);
  const activeLib = list.find((l) => l.id === activeId);

  const [agentOpen, setAgentOpenState] = useState(readAgentOpen);
  const setAgentOpen = (open: boolean): void => {
    setAgentOpenState(open);
    try {
      localStorage.setItem(AGENT_OPEN_KEY, open ? "1" : "0");
    } catch {
      // 存不下就只在本次生效。
    }
  };
  /** 待递给助手的话；助手发出去后清掉。记着是对哪本库说的：换了库就不递。 */
  const [outbox, setOutbox] = useState<{
    id: number;
    text: string;
    libId: string;
  }>();
  const ask: Ask = (text) => {
    if (activeId === null) return;
    setAgentOpen(true);
    setOutbox({ id: Date.now(), text, libId: activeId });
  };

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: LIBS_KEY });
  };

  return (
    <div className="presales">
      <aside className="presales-rail">
        <div className="presales-rail-head">
          <h2>售前库</h2>
          <NewLibDialog onCreated={refresh} />
        </div>
        <p className="muted presales-rail-note">
          每个产品一本库，按售前模板（标准）逐项对照实际文件；没有现行版的就是缺口。
        </p>
        {libs.isPending ? (
          <p className="muted small pad">加载中…</p>
        ) : list.length === 0 ? (
          <p className="muted small pad">
            还没有售前库。点右上角「建库」，选一个产品，系统会按模板铺好材料清单。
          </p>
        ) : (
          <ul className="presales-lib-list">
            {list.map((lib) => (
              <li key={lib.id}>
                <button
                  className={`presales-lib${lib.id === activeId ? " active" : ""}`}
                  onClick={() => {
                    setSelected(lib.id);
                  }}
                >
                  <span className="presales-lib-name">
                    {lib.name}
                    {lib.productId === null && <em className="tag">公司级</em>}
                    {!lib.productExists && (
                      <em className="tag warn">产品已移除</em>
                    )}
                    {lib.status === "retired" && (
                      <em className="tag">已停推广</em>
                    )}
                  </span>
                  <span className="presales-lib-meta">
                    已备 {lib.coveredCount}/{lib.slotCount}
                    {lib.criticalGapCount > 0 && (
                      <b className="presales-gap">
                        {" "}
                        · 缺 {lib.criticalGapCount} 项重点
                      </b>
                    )}
                  </span>
                  <span className="presales-bar" aria-hidden="true">
                    <span
                      style={{
                        width:
                          lib.slotCount === 0
                            ? "0%"
                            : `${String(Math.round((lib.coveredCount / lib.slotCount) * 100))}%`,
                      }}
                    />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <main className="presales-main">
        {activeId === null ? (
          <p className="muted small pad">选左边一本库开始。</p>
        ) : (
          <LibDetail
            key={activeId}
            libId={activeId}
            onChanged={refresh}
            onOpenSession={onOpenSession}
            onAsk={ask}
            agentOpen={agentOpen}
            onOpenAgent={() => setAgentOpen(true)}
          />
        )}
      </main>

      {activeId !== null && activeLib !== undefined && agentOpen && (
        <AgentPanel
          key={activeId}
          libId={activeId}
          libName={activeLib.name}
          outbox={outbox?.libId === activeId ? outbox : undefined}
          onOutboxSent={() => setOutbox(undefined)}
          onCollapse={() => setAgentOpen(false)}
          onOpenSession={onOpenSession}
        />
      )}
    </div>
  );
}

function NewLibDialog({
  onCreated,
}: {
  onCreated: () => void;
}): React.JSX.Element {
  const lines = useQuery({ queryKey: ["lines"], queryFn: listLines });
  const tplList = useQuery({
    queryKey: ["presales-templates"],
    queryFn: () =>
      requestApi<{ templates: { id: string; name: string }[] }>(
        "/presales-templates",
      ).then((r) => r.templates),
  });
  const templates = tplList.data ?? [];
  const [open, setOpen] = useState(false);
  const [productId, setProductId] = useState("company");
  const [templateId, setTemplateId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const products = (lines.data ?? []).flatMap((l) =>
    l.products.map((p) => ({ ...p, lineName: l.name })),
  );

  const submit = (): void => {
    setBusy(true);
    setError(null);
    createLib({
      ...(productId === "company" ? {} : { productId }),
      ...(templateId === "" ? {} : { templateId }),
    })
      .then(() => {
        setOpen(false);
        onCreated();
      })
      .catch((e: unknown) => {
        setError(errorText(e, "建库失败"));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <button
        className="btn primary"
        onClick={() => {
          setOpen(true);
          setError(null);
        }}
      >
        <Plus size={14} /> 建库
      </button>
      {open && (
        <div className="presales-scrim" role="dialog" aria-modal="true">
          <div className="presales-dialog">
            <h3>新建售前库</h3>
            <label className="field">
              绑定产品
              <Select
                value={productId}
                onChange={(v) => {
                  setProductId(v);
                }}
                options={[
                  { value: "company", label: "公司级（不隶属单一产品）" },
                  ...products.map((p) => ({
                    value: p.id,
                    label: `${p.name}（${p.lineName}）`,
                  })),
                ]}
              />
            </label>
            <label className="field">
              材料模板
              <Select
                value={templateId}
                onChange={(v) => {
                  setTemplateId(v);
                }}
                options={[
                  { value: "", label: "按库种类自动选（产品→标准售前模板）" },
                  ...templates.map((t) => ({ value: t.id, label: t.name })),
                ]}
              />
            </label>
            {error !== null && (
              <p className="presales-error">
                <TriangleAlert size={13} /> {error}
              </p>
            )}
            <div className="presales-actions">
              <button className="btn primary" disabled={busy} onClick={submit}>
                {busy ? "建库中…" : "建库"}
              </button>
              <button
                className="btn"
                onClick={() => {
                  setOpen(false);
                }}
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function LibDetail({
  libId,
  onChanged,
  onOpenSession,
  onAsk,
  agentOpen,
  onOpenAgent,
}: {
  libId: string;
  onChanged: () => void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  onAsk: Ask;
  agentOpen: boolean;
  onOpenAgent: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: libKey(libId),
    queryFn: () => getLib(libId),
  });
  // AI 状态：有任务在跑就两秒拉一次，跑完停。
  const ai = useQuery({
    queryKey: aiKey(libId),
    queryFn: () => getAi(libId),
    refetchInterval: (q) => (q.state.data?.busy === true ? 2000 : false),
  });
  /** 巡检待办与助手会话。规则算的，不花额度；清单一变就重算。 */
  const agent = useQuery({
    queryKey: agentKey(libId),
    queryFn: () => getAgent(libId),
  });
  const templates = useQuery({
    queryKey: templatesKey,
    queryFn: listTemplates,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [reviewing, setReviewing] = useState<{
    slotId: string;
    jobId: string;
  } | null>(null);
  /** 待办点「上传 / 去对号 / 预览草稿」：把那一行滚到眼前并高亮（n 变一次滚一次）。 */
  const [focus, setFocus] = useState<{
    slotId: string;
    edit: boolean;
    n: number;
  } | null>(null);

  const refresh = (): void => {
    onChanged();
    void queryClient.invalidateQueries({ queryKey: libKey(libId) });
    void queryClient.invalidateQueries({ queryKey: agentKey(libId) });
  };

  // 后台任务跑完（busy 由真变假）：修订稿等新版本要反映到材料清单上。
  const wasBusy = useRef(false);
  const nowBusy = ai.data?.busy === true;
  useEffect(() => {
    if (wasBusy.current !== nowBusy) {
      // 开跑与跑完都要重算待办（「还没审过」→「审阅中」→「N 条待定」）。
      void queryClient.invalidateQueries({ queryKey: agentKey(libId) });
    }
    if (wasBusy.current && !nowBusy) {
      onChanged();
      void queryClient.invalidateQueries({ queryKey: libKey(libId) });
    }
    wasBusy.current = nowBusy;
  }, [nowBusy, libId, onChanged, queryClient]);

  const reviews = ai.data?.reviews ?? {};

  const openReview = (slotId: string, fresh = false): void => {
    const existing = reviews[slotId];
    if (existing !== undefined && !fresh) {
      setReviewing({ slotId, jobId: existing.id });
      return;
    }
    setError(null);
    startReview(slotId)
      .then((job) => {
        setReviewing({ slotId, jobId: job.id });
        void queryClient.invalidateQueries({ queryKey: aiKey(libId) });
        void queryClient.invalidateQueries({ queryKey: agentKey(libId) });
      })
      .catch((e: unknown) => {
        setError(errorText(e, "发起审阅失败"));
      });
  };

  const run = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    fn()
      .then(refresh)
      .catch((e: unknown) => {
        setError(errorText(e, "操作失败"));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  if (detail.isPending) return <p className="muted small pad">加载中…</p>;
  if (detail.data === undefined) {
    return (
      <p className="presales-error pad">
        <TriangleAlert size={13} /> 读不到这本库，刷新试试。
      </p>
    );
  }

  const { lib } = detail.data;
  const aiRun = ai.data?.run ?? null;
  const tpl = (templates.data ?? []).find((t) => t.id === lib.templateId);
  const templateItems = (tpl?.stages ?? []).flatMap((st) =>
    st.items.map((i) => ({ id: i.id, name: i.name, stageLabel: st.label })),
  );
  const reviewingSlot =
    reviewing === null
      ? undefined
      : detail.data.slots.find((s) => s.id === reviewing.slotId);

  /** 模板缺口加进清单：名字取模板的，自动对上号。 */
  const addGap = (gap: TemplateGap): Promise<Slot> =>
    addSlot(libId, {
      title: gap.name,
      stage: gap.stageCode,
      priority: gap.required,
      audience: gap.audience,
    });

  const draftPrompt = (title: string): string =>
    `请为「${title}」起草一份草稿：先看模板对这一项的说明与检查要点，再读同库相关材料保持口径一致，用 presales_write_draft 存成草稿，最后告诉我还有哪些待核实。`;

  const onTodo = (todo: Todo, action: TodoAction): void => {
    const slot =
      todo.slotId === null
        ? undefined
        : detail.data.slots.find((s) => s.id === todo.slotId);
    switch (action) {
      case "add": {
        const gap = detail.data.templateGaps.find((g) => g.id === todo.gapId);
        if (gap !== undefined) run(() => addGap(gap));
        return;
      }
      case "review":
        if (slot !== undefined) openReview(slot.id, true);
        return;
      case "open-review":
        if (slot !== undefined) openReview(slot.id);
        return;
      case "draft":
        if (slot !== undefined) onAsk(draftPrompt(slot.title));
        return;
      case "upload":
      case "promote":
      case "link":
        if (slot !== undefined)
          setFocus({
            slotId: slot.id,
            edit: action === "link",
            n: Date.now(),
          });
        return;
    }
  };

  return (
    <div className="presales-detail">
      <header className="presales-head">
        <div>
          <h2>
            {lib.name}
            {lib.productId === null && <em className="tag">公司级</em>}
            {!lib.productExists && <em className="tag warn">产品已移除</em>}
          </h2>
          <p className="muted">
            共 {lib.slotCount} 类材料，已备 {lib.coveredCount} 类
            {lib.inProgressCount > 0 &&
              `，${String(lib.inProgressCount)} 类做了一半`}
            {lib.criticalGapCount > 0 && (
              <b className="presales-gap">
                ，{lib.criticalGapCount} 类高优先级仍是缺口
              </b>
            )}
            。
          </p>
        </div>
        <div className="presales-head-actions">
          {!agentOpen && (
            <button
              className="btn ai"
              title="打开右侧的售前助手：它看得见这本库与模板标准，能读材料、发起审阅、起草缺口"
              onClick={onOpenAgent}
            >
              <Bot size={13} /> 售前助手
            </button>
          )}
          <button
            className="btn"
            disabled={aiRun?.status === "running"}
            title={
              aiRun?.status === "running"
                ? "这本库正在复盘"
                : "整套材料过一遍：抽口径台账 → 跨材料比对 → 每份出修订清单（先预览用量再确认）"
            }
            onClick={() => {
              setPlanning(true);
            }}
          >
            <Wand2 size={13} /> AI 体系复盘
          </button>
          <button
            className="btn"
            title="选一个文件夹，让 AI 从里面挑出每类材料最合适的一版"
            onClick={() => {
              setImporting(true);
            }}
          >
            <ScanSearch size={13} /> 从文件夹识别
          </button>
          <button
            className="btn danger"
            disabled={busy}
            onClick={() => {
              if (
                !window.confirm(
                  `删除「${lib.name}」整本售前库？材料文件也会一起删掉，无法恢复。`,
                )
              ) {
                return;
              }
              run(() => deleteLib(libId));
            }}
          >
            <Trash2 size={13} /> 删库
          </button>
        </div>
      </header>

      <TemplateBinding
        libId={libId}
        isCompany={lib.productId === null}
        templateId={lib.templateId}
        templateName={lib.templateName}
        slots={detail.data.slots}
        gaps={detail.data.templateGaps}
        busy={busy}
        onSync={() => {
          run(() => syncTemplate(libId));
        }}
        onChanged={refresh}
      />

      {error !== null && (
        <p className="presales-error">
          <TriangleAlert size={13} /> {error}
        </p>
      )}

      {agent.data !== undefined && (
        <TodoPanel
          todos={agent.data.todos}
          autoReview={agent.data.autoReview}
          onAutoReview={(on) => {
            void setAutoReview(libId, on).then(() =>
              queryClient.invalidateQueries({ queryKey: agentKey(libId) }),
            );
          }}
          onAction={onTodo}
        />
      )}

      {aiRun !== null && (
        <RunSection
          libId={libId}
          run={aiRun}
          onOpenSession={onOpenSession}
          onChanged={refresh}
        />
      )}

      <SlotTable
        libId={libId}
        slots={detail.data.slots}
        stages={detail.data.stages}
        templateGaps={detail.data.templateGaps}
        hasTemplate={lib.templateId !== null}
        templateItems={templateItems}
        reviews={reviews}
        adding={adding}
        focus={focus}
        onAddingChange={setAdding}
        onChanged={refresh}
        onError={setError}
        onReview={openReview}
        onAddGap={(gap, thenDraft) => {
          run(async () => {
            await addGap(gap);
            if (thenDraft) onAsk(draftPrompt(gap.name));
          });
        }}
        onDraft={(title) => onAsk(draftPrompt(title))}
      />

      {planning && (
        <RunDialog
          libId={libId}
          onClose={() => {
            setPlanning(false);
          }}
          onStarted={() => {
            void queryClient.invalidateQueries({ queryKey: aiKey(libId) });
          }}
        />
      )}

      {reviewing !== null && reviewingSlot !== undefined && (
        <ReviewPanel
          key={reviewing.jobId}
          jobId={reviewing.jobId}
          libId={libId}
          slotId={reviewing.slotId}
          slotTitle={reviewingSlot.title}
          onOpenSession={onOpenSession}
          onClose={() => {
            setReviewing(null);
          }}
          onChanged={refresh}
        />
      )}

      {importing && (
        <ImportDialog
          libId={libId}
          onClose={() => {
            setImporting(false);
          }}
          onDone={refresh}
        />
      )}
    </div>
  );
}

function AddSlotForm({
  libId,
  stages,
  onDone,
  onCancel,
}: {
  libId: string;
  stages: { code: string; label: string }[];
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [title, setTitle] = useState("");
  const [stage, setStage] = useState<Stage>(stages[0]?.code ?? "S1");
  const [priority, setPriority] = useState(false);
  const [audience, setAudience] = useState<"external" | "internal">("external");
  const [busy, setBusy] = useState(false);

  return (
    <div className="presales-form">
      <div className="field-row">
        <label className="field">
          材料名称
          <input
            value={title}
            placeholder="如：模型资源价格表"
            onChange={(e) => {
              setTitle(e.target.value);
            }}
          />
        </label>
        <label className="field">
          阶段
          <Select
            value={stage}
            onChange={(v) => {
              setStage(v);
            }}
            options={stages.map((s) => ({ value: s.code, label: s.label }))}
          />
        </label>
        <label className="field">
          给谁看
          <Select
            value={audience}
            onChange={(v) => {
              setAudience(v === "internal" ? "internal" : "external");
            }}
            options={[
              { value: "external", label: "对外" },
              { value: "internal", label: "对内" },
            ]}
          />
        </label>
      </div>
      <label className="presales-check">
        <input
          type="checkbox"
          checked={priority}
          onChange={(e) => {
            setPriority(e.target.checked);
          }}
        />
        高优先级（缺口会算进「重点缺口」）
      </label>
      <div className="presales-actions">
        <button
          className="btn primary"
          disabled={busy || title.trim() === ""}
          onClick={() => {
            setBusy(true);
            void addSlot(libId, {
              title: title.trim(),
              stage,
              priority,
              audience,
            })
              .then(onDone)
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          添加
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

/**
 * 材料清单 = 标准（模板）逐项对照实际（文件）。
 *
 * 按模板的阶段分组，组内每一行是模板里的一项：左边「标准要求」（名称、说明、检查要点），
 * 右边「实际文件」与状态。模板要求、库里还没建的直接作为缺口行出现在它该在的阶段里；
 * 模板外多出来的条目放到最底下一组。没绑模板时退化成按阶段列出全部条目。
 *
 * 铺满宽度；容器窄到一行放不下时，各行拆成两行（见样式里的容器查询），不缩字、不横向滚动。
 */
function SlotTable({
  libId,
  slots,
  stages,
  templateGaps,
  hasTemplate,
  templateItems,
  reviews,
  adding,
  focus,
  onAddingChange,
  onChanged,
  onError,
  onReview,
  onAddGap,
  onDraft,
}: {
  libId: string;
  slots: Slot[];
  /** 阶段代号与名称，来自模板。 */
  stages: { code: string; label: string }[];
  /** 模板要求、库里没有条目的。 */
  templateGaps: TemplateGap[];
  hasTemplate: boolean;
  /** 库绑的模板里有哪些条目（「编辑」里手动对号用）。 */
  templateItems: TemplateItemOption[];
  /** 每份材料最近一次 AI 审阅。 */
  reviews: Record<string, ReviewBrief>;
  adding: boolean;
  focus: { slotId: string; edit: boolean; n: number } | null;
  onAddingChange: (adding: boolean) => void;
  onChanged: () => void;
  onError: (message: string) => void;
  onReview: (slotId: string) => void;
  onAddGap: (gap: TemplateGap, thenDraft: boolean) => void;
  onDraft: (title: string) => void;
}): React.JSX.Element {
  // 空串 = 全部阶段。不用 "all" 字面量：阶段代号来自模板，理论上可能撞上。
  const [stage, setStage] = useState("");
  const [onlyGap, setOnlyGap] = useState(false);
  const [keyword, setKeyword] = useState("");

  const q = keyword.trim().toLowerCase();
  const slotVisible = (slot: Slot): boolean => {
    if (stage !== "" && slot.stage !== stage) return false;
    if (onlyGap && slot.current !== null && slot.current.fileExists !== false)
      return false;
    if (q !== "") {
      const hay = `${slot.title} ${slot.current?.fileName ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };
  const gapVisible = (gap: TemplateGap): boolean =>
    (stage === "" || gap.stageCode === stage) &&
    (q === "" || gap.name.toLowerCase().includes(q));

  /** 模板外的条目沉底；没绑模板时没有「模板外」这回事，全部按阶段放。 */
  const outside = (slot: Slot): boolean =>
    hasTemplate && slot.link === "outside";
  const known = new Set(stages.map((x) => x.code));

  const groups = useMemo(() => {
    const out: {
      key: string;
      label: string;
      slots: Slot[];
      gaps: TemplateGap[];
      total: number;
      covered: number;
    }[] = stages.map((st) => {
      const all = slots.filter((x) => x.stage === st.code && !outside(x));
      const gaps = templateGaps.filter((g) => g.stageCode === st.code);
      return {
        key: st.code,
        label: st.label,
        slots: all
          .filter(slotVisible)
          .sort((a, b) => Number(b.priority) - Number(a.priority)),
        gaps: gaps.filter(gapVisible),
        total: all.length + gaps.length,
        covered: all.filter((x) => x.current !== null).length,
      };
    });
    const rest = slots.filter((x) => outside(x) || !known.has(x.stage));
    if (rest.length > 0)
      out.push({
        key: "__outside",
        label: hasTemplate ? "模板外（标准里没有这一项）" : "其他阶段",
        slots: rest.filter(slotVisible),
        gaps: [],
        total: rest.length,
        covered: rest.filter((x) => x.current !== null).length,
      });
    return out;
    // slotVisible / gapVisible 只依赖下面这些。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, stages, templateGaps, hasTemplate, stage, onlyGap, q]);

  const gapCount =
    slots.filter((s) => s.current === null || s.current.fileExists === false)
      .length + templateGaps.length;
  const empty = groups.every((g) => g.slots.length + g.gaps.length === 0);

  return (
    <div className="presales-list-wrap">
      <div className="presales-toolbar">
        <Select
          className="input sm"
          value={stage}
          aria-label="按阶段筛选"
          onChange={(v) => {
            setStage(v);
          }}
          options={[
            { value: "", label: "全部阶段" },
            ...stages.map((s) => ({ value: s.code, label: s.label })),
          ]}
        />
        <label className="presales-check">
          <input
            type="checkbox"
            checked={onlyGap}
            onChange={(e) => {
              setOnlyGap(e.target.checked);
            }}
          />
          只看缺口（{gapCount}）
        </label>
        <input
          className="input sm presales-search"
          placeholder="搜材料名 / 文件名"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
          }}
        />
        <span className="presales-toolbar-spacer" />
        <button
          className="btn primary"
          onClick={() => {
            onAddingChange(true);
          }}
        >
          <Plus size={13} /> 新增材料
        </button>
      </div>

      {adding && (
        <AddSlotForm
          libId={libId}
          stages={stages}
          onDone={() => {
            onAddingChange(false);
            onChanged();
          }}
          onCancel={() => {
            onAddingChange(false);
          }}
        />
      )}

      <div className="presales-list" role="table" aria-label="标准与实际对照">
        <div className="presales-list-head" role="row">
          <span role="columnheader" className="c-std">
            标准要求（模板）
          </span>
          <span role="columnheader" className="c-aud">
            对内 / 对外
          </span>
          <span role="columnheader" className="c-file">
            实际文件
          </span>
          <span role="columnheader" className="c-status">
            状态
          </span>
          <span role="columnheader" className="c-ai">
            AI 审阅
          </span>
          <span role="columnheader" className="c-ops">
            操作
          </span>
        </div>
        {empty && (
          <p className="muted presales-list-empty">
            {slots.length === 0 && templateGaps.length === 0
              ? "这本库还没有材料条目，先绑模板或「新增材料」。"
              : "没有符合条件的材料。"}
          </p>
        )}
        {groups.map((g) =>
          g.slots.length + g.gaps.length === 0 ? null : (
            <div key={g.key} role="rowgroup" className="presales-group">
              <div className="presales-group-head" role="row">
                <span role="cell">
                  {g.label}
                  <span className="muted small">
                    {" "}
                    · 已备 {g.covered}/{g.total}
                  </span>
                </span>
              </div>
              {g.slots.map((slot) => (
                <SlotRow
                  key={slot.id}
                  slot={slot}
                  stages={stages}
                  templateItems={templateItems}
                  review={reviews[slot.id]}
                  focus={focus?.slotId === slot.id ? focus : null}
                  onChanged={onChanged}
                  onError={onError}
                  onReview={onReview}
                  onDraft={onDraft}
                />
              ))}
              {g.gaps.map((gap) => (
                <GapRow key={gap.id} gap={gap} onAdd={onAddGap} />
              ))}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/** 模板要求、库里还没建的一项。 */
function GapRow({
  gap,
  onAdd,
}: {
  gap: TemplateGap;
  onAdd: (gap: TemplateGap, thenDraft: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="presales-list-row is-gap is-missing" role="row">
      <span role="cell" className="c-std">
        {gap.required && <b title="必备">★</b>}
        <span className="presales-std">
          <span className="presales-ellipsis">{gap.name}</span>
          <span className="muted small presales-ellipsis">
            模板要求，库里还没有这一项
          </span>
        </span>
      </span>
      <span role="cell" className="c-aud">
        <em className={`tag${gap.audience === "internal" ? " warn" : ""}`}>
          {gap.audience === "internal" ? "对内" : "对外"}
        </em>
      </span>
      <span role="cell" className="c-file">
        <span className="muted">—</span>
      </span>
      <span role="cell" className="c-status">
        <span className="pill danger">未建</span>
      </span>
      <span role="cell" className="c-ai">
        <span className="muted">—</span>
      </span>
      <span role="cell" className="c-ops">
        <button
          type="button"
          className="btn ghost"
          title="按模板这一项建条目，之后可上传文件"
          onClick={() => onAdd(gap, false)}
        >
          <ListPlus size={12} /> 加入清单
        </button>
        <button
          type="button"
          className="btn ghost ai"
          title="建条目，并让右侧售前助手照模板起草一份草稿"
          onClick={() => onAdd(gap, true)}
        >
          <Wand2 size={12} /> 助手起草
        </button>
      </span>
    </div>
  );
}

interface TemplateItemOption {
  id: string;
  name: string;
  stageLabel: string;
}

function SlotRow({
  slot,
  stages,
  templateItems,
  review,
  focus,
  onChanged,
  onError,
  onReview,
  onDraft,
}: {
  slot: Slot;
  stages: { code: string; label: string }[];
  templateItems: TemplateItemOption[];
  review: ReviewBrief | undefined;
  /** 待办点过来的：滚到眼前、高亮，「去对号」时顺手打开编辑。 */
  focus: { edit: boolean; n: number } | null;
  onChanged: () => void;
  onError: (message: string) => void;
  onReview: (slotId: string) => void;
  onDraft: (title: string) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  /** 正在预览哪一版（现行版或某份草稿）。 */
  const [previewing, setPreviewing] = useState<Version | null>(null);
  const [showStd, setShowStd] = useState(false);
  const [flash, setFlash] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focus === null) return;
    rowRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    const edit = focus.edit;
    const on = window.setTimeout(() => {
      setFlash(true);
      if (edit) setEditing(true);
    }, 0);
    const off = window.setTimeout(() => setFlash(false), 1600);
    return () => {
      window.clearTimeout(on);
      window.clearTimeout(off);
    };
  }, [focus?.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = slot.current;
  const drafts = slot.versions.filter(
    (v) => v.status === "draft" || v.status === "review",
  );
  const pending = drafts.length > 0;
  const file = current?.fileName != null ? current : null;

  const promote = (v: Version): void => {
    if (
      !window.confirm(
        `把「${v.fileName ?? v.version}」设为可对外？${current !== null ? "\n\n现行版会自动归档。" : ""}`,
      )
    )
      return;
    setBusy(true);
    promoteVersion(v.id)
      .then(onChanged)
      .catch((e: unknown) => {
        onError(errorText(e, "设为可对外失败"));
      })
      .finally(() => {
        setBusy(false);
      });
  };
  const dropDraft = (v: Version): void => {
    if (
      !window.confirm(
        `删掉草稿「${v.fileName ?? v.version}」？文件也会从文件库删掉。`,
      )
    )
      return;
    setBusy(true);
    deleteVersion(v.id)
      .then(onChanged)
      .catch((e: unknown) => {
        onError(errorText(e, "删除失败"));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const remove = (): void => {
    if (
      !window.confirm(
        `删除文件「${file?.fileName ?? slot.title}」？\n\n会从文件库里删掉，不可恢复；「${slot.title}」这一类会变回缺口。`,
      )
    ) {
      return;
    }
    setBusy(true);
    deleteSlotFile(slot.id)
      .then(onChanged)
      .catch((e: unknown) => {
        onError(errorText(e, "删除失败"));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const upload = (picked: File): void => {
    setBusy(true);
    uploadToSlot(slot.id, picked)
      .then(onChanged)
      .catch((e: unknown) => {
        onError(errorText(e, "上传失败"));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <>
      <div
        ref={rowRef}
        className={`presales-list-row${current === null || file?.fileExists === false ? " is-gap" : ""}${flash ? " is-flash" : ""}`}
        role="row"
      >
        <span role="cell" className="c-std">
          {slot.priority && <b title="高优先级">★</b>}
          <span className="presales-std">
            <span className="presales-ellipsis" title={slot.title}>
              {slot.title}
            </span>
            {(slot.guide !== "" || slot.checkpoints.length > 0) && (
              <button
                type="button"
                className="presales-std-toggle muted small"
                aria-expanded={showStd}
                title={slot.guide}
                onClick={() => setShowStd((v) => !v)}
              >
                {showStd ? (
                  <ChevronDown size={11} />
                ) : (
                  <ChevronRight size={11} />
                )}
                <span className="presales-ellipsis">
                  {slot.checkpoints.length > 0
                    ? `检查要点 ${String(slot.checkpoints.length)} 条`
                    : "标准说明"}
                  {slot.guide !== "" && ` · ${slot.guide}`}
                </span>
              </button>
            )}
          </span>
          {slot.link === "unmatched" && (
            <em
              className="tag warn"
              title="按名称和别名都没对上模板里的任何一项：在「编辑」里手动指定，或标成模板外"
            >
              对不上模板
            </em>
          )}
          {slot.link === "outside" && (
            <em className="tag" title="已标为模板外：不受模板检查要点约束">
              模板外
            </em>
          )}
        </span>
        <span role="cell" className="c-aud">
          <em className={`tag${slot.audience === "internal" ? " warn" : ""}`}>
            {slot.audience === "internal" ? "对内" : "对外"}
          </em>
        </span>
        <span role="cell" className="c-file">
          {file !== null && file.fileExists === false ? (
            <span className="presales-file-missing" title={file.filePath ?? ""}>
              <TriangleAlert size={12} />
              <span className="presales-ellipsis">
                {file.fileName}（文件已不在文件库）
              </span>
            </span>
          ) : file !== null ? (
            <button
              className="presales-file-link"
              title={`预览：${file.fileName ?? ""}`}
              onClick={() => {
                setPreviewing(file);
              }}
            >
              <Eye size={13} />
              <span className="presales-ellipsis">{file.fileName}</span>
            </button>
          ) : (
            <span className="muted">未关联文件</span>
          )}
          {drafts.map((v) => (
            <span key={v.id} className="presales-draft">
              <em className="tag ai">草稿</em>
              <button
                type="button"
                className="presales-file-link"
                title={`预览草稿：${v.fileName ?? ""}${v.note !== "" ? `（${v.note}）` : ""}`}
                onClick={() => setPreviewing(v)}
              >
                <span className="presales-ellipsis">
                  {v.fileName ?? v.version}
                </span>
              </button>
              <button
                type="button"
                className="btn ghost xs"
                disabled={busy}
                title="预览没问题就设为可对外（现行版自动归档）"
                onClick={() => promote(v)}
              >
                <CheckCircle2 size={12} /> 设为可对外
              </button>
              <button
                type="button"
                className="btn ghost xs"
                disabled={busy}
                aria-label="删掉草稿"
                title="删掉草稿"
                onClick={() => dropDraft(v)}
              >
                <Trash2 size={12} />
              </button>
            </span>
          ))}
        </span>
        <span role="cell" className="c-status">
          {current === null ? (
            <span className="pill warn">{pending ? "做了一半" : "缺口"}</span>
          ) : (
            <span className="pill ok">{STATUS_LABEL[current.status]}</span>
          )}
        </span>
        <span role="cell" className="c-ai">
          <AiCell
            review={review}
            canReview={
              file !== null &&
              file.fileExists !== false &&
              reviewable(file.fileName)
            }
            onClick={() => {
              onReview(slot.id);
            }}
          />
        </span>
        <span role="cell" className="c-ops">
          {file !== null && file.fileExists !== false ? (
            <>
              <button
                className="btn ghost"
                onClick={() => {
                  setEditing((v) => !v);
                }}
              >
                <Pencil size={12} /> 编辑
              </button>
              <button className="btn ghost" disabled={busy} onClick={remove}>
                <Trash2 size={12} /> 删除
              </button>
              <a
                className="btn ghost"
                href={fileUrl(file.id)}
                download={file.fileName ?? undefined}
              >
                <Download size={12} /> 下载
              </a>
            </>
          ) : (
            <>
              <button
                className="btn ghost"
                onClick={() => {
                  setEditing((v) => !v);
                }}
              >
                <Pencil size={12} /> 编辑
              </button>
              {file !== null && (
                <button className="btn ghost" disabled={busy} onClick={remove}>
                  <Trash2 size={12} /> 删除
                </button>
              )}
              {file === null && !pending && (
                <button
                  type="button"
                  className="btn ghost ai"
                  title="让右侧售前助手照模板起草一份草稿"
                  onClick={() => onDraft(slot.title)}
                >
                  <Wand2 size={12} /> 起草
                </button>
              )}
              <label className={`btn ghost${busy ? " disabled" : ""}`}>
                <Upload size={12} /> {busy ? "上传中…" : "上传"}
                <input
                  type="file"
                  hidden
                  disabled={busy}
                  onChange={(e) => {
                    const picked = e.target.files?.[0];
                    e.target.value = "";
                    if (picked !== undefined) upload(picked);
                  }}
                />
              </label>
            </>
          )}
        </span>
      </div>

      {showStd && (
        <div className="presales-list-detail presales-std-detail small">
          {slot.guide !== "" && <p>{slot.guide}</p>}
          {slot.checkpoints.length > 0 && (
            <ul>
              {slot.checkpoints.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          )}
          {slot.templateItem !== null && (
            <p className="muted">
              取自模板：{slot.templateItem.stageLabel} ·{" "}
              {slot.templateItem.name}
              。改模板即改标准，也是 AI 审阅的依据。
            </p>
          )}
        </div>
      )}

      {editing && (
        <div className="presales-list-detail">
          <EditSlotForm
            slot={slot}
            stages={stages}
            templateItems={templateItems}
            file={file}
            onError={onError}
            onDone={() => {
              setEditing(false);
              onChanged();
            }}
            onCancel={() => {
              setEditing(false);
            }}
          />
        </div>
      )}

      {/* 预览是全屏弹窗：挂到 body 上，不受列表布局影响。 */}
      {previewing?.fileName != null &&
        createPortal(
          <MaterialPreview
            versionId={previewing.id}
            fileName={previewing.fileName}
            fileSize={previewing.fileSize ?? 0}
            onClose={() => {
              setPreviewing(null);
            }}
          />,
          document.body,
        )}
    </>
  );
}

/**
 * 「AI 审阅」那一格：没审过给入口，在跑给进度，审完给待定条数。
 * 审完点开是修订清单（逐条采纳 → 生成修订稿）。
 */
function AiCell({
  review,
  canReview,
  onClick,
}: {
  review: ReviewBrief | undefined;
  canReview: boolean;
  onClick: () => void;
}): React.JSX.Element {
  if (review === undefined) {
    if (!canReview) return <span className="muted">—</span>;
    return (
      <button
        type="button"
        className="btn ghost"
        title="对照代码 > PRD > 路线图等资料与同库其他材料，出一份可逐条采纳的修订清单"
        onClick={onClick}
      >
        <Sparkles size={12} /> 审阅
      </button>
    );
  }
  if (review.status === "queued" || review.status === "running")
    return (
      <button type="button" className="btn ghost" onClick={onClick}>
        <Loader2 size={12} className="spin" />
        {review.status === "queued" ? "排队中" : "审阅中"}
      </button>
    );
  if (review.status !== "done")
    return (
      <button
        type="button"
        className="btn ghost presales-ai-fail"
        title={review.error ?? ""}
        onClick={onClick}
      >
        <TriangleAlert size={12} />{" "}
        {review.status === "cancelled" ? "已停止" : "失败"}
      </button>
    );
  const c = review.counts;
  return (
    <button
      type="button"
      className="btn ghost"
      title={`${review.verdict ?? ""}：共 ${String(c.total)} 条，待定 ${String(c.pending)}，已采纳 ${String(c.accepted)}，已写进修订稿 ${String(c.applied)}`}
      onClick={onClick}
    >
      {c.total === 0 ? (
        <span className="ok-text">无问题</span>
      ) : c.pending > 0 ? (
        <>
          {c.p0 > 0 && <b className="presales-sev sev-p0">P0×{c.p0}</b>}
          {c.pending} 条待定
        </>
      ) : (
        <span className="muted">已处理 {c.total} 条</span>
      )}
    </button>
  );
}

function EditSlotForm({
  slot,
  stages,
  templateItems,
  file,
  onError,
  onDone,
  onCancel,
}: {
  slot: Slot;
  /** 阶段清单来自模板，下拉用它。 */
  stages: { code: string; label: string }[];
  /** 库绑的模板条目；空 = 库没绑模板，不显示对号下拉。 */
  templateItems: TemplateItemOption[];
  /** 当前关联的文件；有它才能改名 / 替换。 */
  file: Version | null;
  onError: (message: string) => void;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [fileName, setFileName] = useState(file?.fileName ?? "");
  const [replacement, setReplacement] = useState<File | null>(null);
  const [title, setTitle] = useState(slot.title);
  const [stage, setStage] = useState<Stage>(slot.stage);
  const [priority, setPriority] = useState(slot.priority);
  const [audience, setAudience] = useState<"external" | "internal">(
    slot.audience,
  );
  /** 空串 = 自动（按名称对号）；"-" = 模板外；其余 = 模板条目 id。 */
  const initialLink =
    slot.link === "outside" ? "-" : (slot.templateItem?.id ?? "");
  const [link, setLink] = useState(initialLink);
  const [busy, setBusy] = useState(false);

  return (
    <div className="presales-form">
      <div className="field-row">
        <label className="field">
          材料名称
          <input
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
            }}
          />
        </label>
        <label className="field">
          阶段
          <Select
            value={stage}
            onChange={(v) => {
              setStage(v);
            }}
            options={stages.map((s) => ({ value: s.code, label: s.label }))}
          />
        </label>
        <label className="field">
          给谁看
          <Select
            value={audience}
            onChange={(v) => {
              setAudience(v === "internal" ? "internal" : "external");
            }}
            options={[
              { value: "external", label: "对外" },
              { value: "internal", label: "对内" },
            ]}
          />
        </label>
      </div>
      <label className="presales-check">
        <input
          type="checkbox"
          checked={priority}
          onChange={(e) => {
            setPriority(e.target.checked);
          }}
        />
        高优先级（缺口会算进「重点缺口」）
      </label>
      {templateItems.length > 0 && (
        <label className="field">
          对应模板里的哪一项（说明与检查要点取自它，也是 AI 审阅的标准）
          <Select
            value={link}
            onChange={(v) => {
              setLink(v);
            }}
            options={[
              { value: "", label: "自动（按名称 / 别名对号）" },
              { value: "-", label: "模板外（不对应模板里的任何一项）" },
              ...templateItems.map((i) => ({
                value: i.id,
                label: `${i.stageLabel} · ${i.name}`,
              })),
            ]}
          />
        </label>
      )}
      {file !== null && file.fileExists !== false && (
        <div className="field-row">
          <label className="field">
            文件名（文件库里同步改名）
            <input
              value={fileName}
              disabled={replacement !== null}
              onChange={(e) => {
                setFileName(e.target.value);
              }}
            />
          </label>
          <label className="field">
            替换文件（旧文件会从文件库删掉）
            <input
              type="file"
              onChange={(e) => {
                setReplacement(e.target.files?.[0] ?? null);
              }}
            />
          </label>
        </div>
      )}
      <div className="presales-actions">
        <button
          className="btn primary"
          disabled={busy || title.trim() === ""}
          onClick={() => {
            setBusy(true);
            const run = async (): Promise<void> => {
              await updateSlot(slot.id, {
                title: title.trim(),
                stage,
                priority,
                audience,
                ...(link === initialLink
                  ? {}
                  : { templateItemId: link === "" ? null : link }),
              });
              // 先替换再改名：替换会生成新文件，改名针对的应该是最终那一份。
              if (replacement !== null) {
                await uploadToSlot(slot.id, replacement);
              } else if (
                file !== null &&
                file.fileExists !== false &&
                fileName.trim() !== "" &&
                fileName.trim() !== file.fileName
              ) {
                await renameFile(file.id, fileName.trim());
              }
            };
            void run()
              .then(onDone)
              .catch((e: unknown) => {
                onError(errorText(e, "保存失败"));
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          保存
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
