import { useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ExternalLink,
  Loader2,
  MessageSquare,
  MessagesSquare,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SlidersHorizontal,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { listLines } from "../products/api";
import { Select } from "../ui/Select";
import {
  LINEAR_KEY,
  createRequestItem,
  deleteWorkItem,
  getLinear,
  listWorkItems,
  startWorkChat,
  syncLinear,
  updateWorkItem,
  workKey,
  type WorkFields,
  type WorkItem,
  type WorkKind,
  type WorkStatus,
} from "./api";
import { LinearDialog } from "./LinearDialog";
import { ART } from "../assets/art";
import "./work.css";

/**
 * 任务与需求：一张通栏表格，样子照 Orca 的议题列表——
 * 顶上一排快捷筛选，下面「筛选条件 + 搜索 + 操作」一条工具栏，再下面是表。
 *
 * - 用户需求：像备忘录一样直接在表里写。顶上常驻一条空行，敲标题回车就是一条；
 *   已有的行，标题、上下文、提出人、优先级、状态都在格子里直接改，离开即保存。
 * - 内部任务：只从 Linear 拉，只读。能做的只有关联产品和开对话。
 *
 * 每行最右边是「对话」：这一页的出口就是一次对话。
 */

const STATUS_LABEL: Record<WorkStatus, string> = {
  todo: "待处理",
  doing: "进行中",
  done: "已完成",
  canceled: "已取消",
};
const STATUSES: readonly WorkStatus[] = ["todo", "doing", "done", "canceled"];
/** 排序：正在干的最先看到，其次是待处理。 */
const SORT_ORDER: readonly WorkStatus[] = ["doing", "todo", "done", "canceled"];
const PRIORITY_LABEL = ["无", "紧急", "高", "中", "低"];

type Filter = "open" | "done" | "all";
const FILTER_LABEL: Record<Filter, string> = {
  open: "开放",
  done: "已完成",
  all: "全部",
};
const isOpen = (s: WorkStatus) => s === "todo" || s === "doing";

/**
 * 状态圈：圈填了多少就是走到了哪一步（待处理虚线圈 → 进行中半圈 → 审核中四分之三 → 完成打勾）。
 * 外部状态名里带 review 的单独算「审核中」——Linear 把它归在 started 里，但对人来说是两回事。
 */
function StatusIcon({
  status,
  external,
}: {
  status: WorkStatus;
  external?: string | null;
}): React.JSX.Element {
  const cls = `work-status s-${status}`;
  if (status === "done") return <CheckCircle2 size={14} className={cls} />;
  if (status === "canceled") return <XCircle size={14} className={cls} />;
  const review = status === "doing" && /review|审核|评审/i.test(external ?? "");
  const fill =
    status === "todo"
      ? null
      : review
        ? "M7 1.5A5.5 5.5 0 1 1 1.5 7H7Z"
        : "M7 1.5A5.5 5.5 0 0 1 7 12.5Z";
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 14 14"
      className={`${cls}${review ? " s-review" : ""}`}
      aria-hidden="true"
    >
      <circle
        cx={7}
        cy={7}
        r={5.5}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeDasharray={status === "todo" ? "2.2 1.6" : undefined}
      />
      {fill !== null && <path d={fill} fill="currentColor" />}
    </svg>
  );
}

/** 优先级信号格：三格，紧急是红色满格，无优先级是三条短横。 */
function PriorityBars({ p }: { p: number }): React.JSX.Element {
  const on = p === 1 || p === 2 ? 3 : p === 3 ? 2 : p === 4 ? 1 : 0;
  return (
    <span
      className={`work-bars p-${String(p)}`}
      title={`优先级：${PRIORITY_LABEL[p] ?? "无"}`}
      aria-label={`优先级：${PRIORITY_LABEL[p] ?? "无"}`}
      role="img"
    >
      {[0, 1, 2].map((i) => (
        <i key={i} className={i < on ? "on" : ""} />
      ))}
    </span>
  );
}

/** 负责人头像：取名字前两个字（邮箱取 @ 前面），完整名字放在悬停提示里。 */
function Avatar({ name }: { name: string }): React.JSX.Element {
  if (name.trim() === "") return <span className="muted">—</span>;
  const base = name.includes("@") ? (name.split("@")[0] ?? name) : name;
  const letters = /[\u4e00-\u9fa5]/.test(base)
    ? base.slice(-2)
    : base.slice(0, 2).toUpperCase();
  return (
    <span className="work-avatar" title={name} aria-label={name}>
      {letters}
    </span>
  );
}

/** 列表里的上下文只要一行纯文字：去掉 Markdown 的井号、星号、引用符、反引号。 */
const plainLine = (text: string): string =>
  text
    .split("\n")
    .map((l) =>
      l
        .replace(/^[#>\-*\s]+/, "")
        .replace(/[*`_]+/g, "")
        .trim(),
    )
    .find((l) => l !== "") ?? "";

const ago = (ms: number): string => {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${String(Math.floor(s / 60))} 分钟前`;
  if (s < 86400) return `${String(Math.floor(s / 3600))} 小时前`;
  if (s < 86400 * 30) return `${String(Math.floor(s / 86400))} 天前`;
  return new Date(ms).toLocaleDateString("zh-CN");
};

export function WorkPage({
  kind,
  onStartChat,
  onOpenSession,
}: {
  kind: WorkKind;
  /** 新开的对话与开场提示词：外壳把人带过去并发出去。 */
  onStartChat: (started: { sessionId: string; prompt: string }) => void;
  onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const key = workKey(kind);
  const isRequest = kind === "request";
  const items = useQuery({ queryKey: key, queryFn: () => listWorkItems(kind) });
  const linear = useQuery({
    queryKey: LINEAR_KEY,
    queryFn: getLinear,
    enabled: !isRequest,
  });
  const lines = useQuery({ queryKey: ["lines"], queryFn: listLines });

  const [filter, setFilter] = useState<Filter>("open");
  const [q, setQ] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [prio, setPrio] = useState("any");
  const [product, setProduct] = useState("any");
  const [linearOpen, setLinearOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const newRowRef = useRef<HTMLInputElement>(null);

  const onError = (e: unknown) =>
    setError(e instanceof Error ? e.message : "操作失败");
  const refresh = () => queryClient.invalidateQueries({ queryKey: key });

  const sync = useMutation({
    mutationFn: syncLinear,
    onSuccess: (state) => {
      setError(null);
      queryClient.setQueryData(LINEAR_KEY, state);
      void refresh();
    },
    onError: (e) => {
      onError(e);
      void queryClient.invalidateQueries({ queryKey: LINEAR_KEY });
    },
  });
  const chat = useMutation({
    mutationFn: startWorkChat,
    onSuccess: (r) => {
      void refresh();
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      onStartChat({ sessionId: r.sessionId, prompt: r.prompt });
    },
    onError,
  });

  const productOptions = useMemo(
    () =>
      (lines.data ?? []).flatMap((l) =>
        l.products.map((p) => ({ value: p.id, label: p.name })),
      ),
    [lines.data],
  );

  const all = useMemo(() => items.data ?? [], [items.data]);
  const counts = useMemo(
    () => ({
      open: all.filter((i) => isOpen(i.status)).length,
      done: all.filter((i) => !isOpen(i.status)).length,
      all: all.length,
    }),
    [all],
  );
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return all
      .filter((i) =>
        filter === "all"
          ? true
          : filter === "open"
            ? isOpen(i.status)
            : !isOpen(i.status),
      )
      .filter((i) => prio === "any" || String(i.priority) === prio)
      .filter(
        (i) =>
          product === "any" ||
          (product === "none" ? i.productId === null : i.productId === product),
      )
      .filter(
        (i) =>
          needle === "" ||
          i.title.toLowerCase().includes(needle) ||
          (i.externalKey ?? "").toLowerCase().includes(needle) ||
          i.description.toLowerCase().includes(needle) ||
          i.requester.toLowerCase().includes(needle) ||
          i.assignee.toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          SORT_ORDER.indexOf(a.status) - SORT_ORDER.indexOf(b.status) ||
          // 优先级 0 是「没设」，排在最后。
          (a.priority || 9) - (b.priority || 9) ||
          b.updatedAt - a.updatedAt,
      );
  }, [all, filter, q, prio, product]);

  const filtering = q.trim() !== "" || prio !== "any" || product !== "any";
  const clearAll = () => {
    setQ("");
    setPrio("any");
    setProduct("any");
  };
  const linearState = linear.data;
  const connected = linearState?.connected === true;

  return (
    <div className="work">
      <div className="work-pills" role="group" aria-label="快捷筛选">
        {(["open", "done", "all"] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={filter === f ? "on" : ""}
            aria-pressed={filter === f}
            onClick={() => setFilter(f)}
          >
            {FILTER_LABEL[f]}
            <em>{counts[f]}</em>
          </button>
        ))}
        {!isRequest && linearState?.lastSync && (
          <span
            className={`work-sync-note${linearState.lastSync.ok ? "" : " bad"}`}
            title={linearState.lastSync.error ?? undefined}
          >
            {linearState.lastSync.ok
              ? `Linear · ${ago(linearState.lastSync.at)}同步`
              : `Linear 同步失败：${linearState.lastSync.error ?? ""}`}
          </span>
        )}
      </div>

      <div className="work-toolbar">
        <button
          type="button"
          className={`btn${showFilters || prio !== "any" || product !== "any" ? " active-filter" : ""}`}
          aria-expanded={showFilters}
          onClick={() => setShowFilters((v) => !v)}
        >
          <SlidersHorizontal size={14} />
          筛选条件
        </button>
        <label className="work-search">
          <Search size={14} aria-hidden="true" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              isRequest ? "搜索标题、上下文、提出人" : "搜索编号、标题、负责人"
            }
            aria-label="搜索"
          />
          {q !== "" && (
            <button
              type="button"
              className="work-search-clear"
              aria-label="清除搜索"
              onClick={() => setQ("")}
            >
              <X size={14} />
            </button>
          )}
        </label>
        {isRequest ? (
          <button
            type="button"
            className="icon-btn bordered"
            aria-label="新建需求"
            title="新建需求"
            onClick={() => newRowRef.current?.focus()}
          >
            <Plus size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="icon-btn bordered"
            aria-label="Linear 接入设置"
            title="Linear 接入设置"
            onClick={() => setLinearOpen(true)}
          >
            <Settings2 size={16} />
          </button>
        )}
        <button
          type="button"
          className="icon-btn bordered"
          aria-label={isRequest ? "刷新" : "从 Linear 同步"}
          title={
            isRequest
              ? "刷新"
              : connected
                ? "从 Linear 同步"
                : "先接入 Linear 才能同步"
          }
          disabled={sync.isPending || (!isRequest && !connected)}
          onClick={() => {
            if (isRequest) void refresh();
            else sync.mutate();
          }}
        >
          <RefreshCw size={16} className={sync.isPending ? "spin" : ""} />
        </button>
      </div>

      {showFilters && (
        <div className="work-filterbar">
          <span className="muted small">优先级</span>
          <Select
            value={prio}
            aria-label="按优先级筛选"
            onChange={setPrio}
            options={[
              { value: "any", label: "不限" },
              ...[1, 2, 3, 4, 0].map((p) => ({
                value: String(p),
                label: PRIORITY_LABEL[p] ?? "",
              })),
            ]}
          />
          <span className="muted small">关联产品</span>
          <Select
            value={product}
            aria-label="按产品筛选"
            onChange={setProduct}
            options={[
              { value: "any", label: "不限" },
              { value: "none", label: "未关联" },
              ...productOptions,
            ]}
          />
          {filtering && (
            <button type="button" className="btn ghost" onClick={clearAll}>
              清除全部
            </button>
          )}
        </div>
      )}

      {error !== null && (
        <p className="work-error" role="alert">
          {error}
          <button
            type="button"
            className="work-search-clear"
            aria-label="关闭提示"
            onClick={() => setError(null)}
          >
            <X size={13} />
          </button>
        </p>
      )}

      <div className="work-table-wrap">
        <table className={`work-table ${isRequest ? "is-request" : "is-task"}`}>
          <thead>
            <tr>
              {isRequest ? (
                <th className="c-status" />
              ) : (
                <th className="c-id">ID</th>
              )}
              <th>标题 / 上下文</th>
              <th className="c-person">{isRequest ? "提出人" : "负责人"}</th>
              <th className="c-prio">优先级</th>
              <th className="c-product">关联产品</th>
              <th className="c-state">状态</th>
              <th className="c-time">已更新</th>
              <th className="c-actions" aria-label="操作" />
            </tr>
          </thead>
          <tbody>
            {isRequest && (
              <NewRequestRow
                inputRef={newRowRef}
                onCreated={() => void refresh()}
                onError={onError}
              />
            )}
            {shown.map((item) =>
              isRequest ? (
                <RequestRow
                  key={item.id}
                  item={item}
                  productOptions={productOptions}
                  starting={chat.isPending && chat.variables === item.id}
                  onStart={() => chat.mutate(item.id)}
                  onOpenSession={onOpenSession}
                  onChanged={() => void refresh()}
                  onError={onError}
                />
              ) : (
                <TaskRow
                  key={item.id}
                  item={item}
                  productOptions={productOptions}
                  starting={chat.isPending && chat.variables === item.id}
                  onStart={() => chat.mutate(item.id)}
                  onOpenSession={onOpenSession}
                  onChanged={() => void refresh()}
                  onError={onError}
                />
              ),
            )}
          </tbody>
        </table>

        {items.isLoading && (
          <p className="work-empty muted small">
            <Loader2 size={14} className="spin" /> 加载中…
          </p>
        )}
        {items.isError && (
          <p className="err-text small pad" role="alert">
            读不到任务：{items.error.message}
            <button
              type="button"
              className="link-btn"
              onClick={() => void items.refetch()}
            >
              重试
            </button>
          </p>
        )}
        {!items.isLoading && !items.isError && shown.length === 0 && (
          <div className="work-empty">
            <img
              className="work-empty-art"
              src={ART.tasks.src}
              srcSet={ART.tasks.srcSet}
              alt=""
              aria-hidden="true"
              width={160}
              height={160}
            />
            {!isRequest && !connected ? (
              <>
                <strong>还没有接入 Linear</strong>
                <span>填一把 API Key，就能把 Linear 里的 issue 拉进来。</span>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => setLinearOpen(true)}
                >
                  接入 Linear
                </button>
              </>
            ) : all.length === 0 ? (
              <>
                <strong>
                  {isRequest ? "还没有记录用户需求" : "没有拉到任务"}
                </strong>
                <span>
                  {isRequest
                    ? "在上面那一行直接输入，回车就记下一条。"
                    : "检查一下接入设置里的拉取范围，或点右上角同步。"}
                </span>
              </>
            ) : (
              <>
                <strong>没有匹配的{isRequest ? "需求" : "任务"}</strong>
                <span>更改查询或清除它。</span>
              </>
            )}
          </div>
        )}
      </div>

      {linearOpen && (
        <LinearDialog
          onClose={() => setLinearOpen(false)}
          onSaved={(state) => {
            queryClient.setQueryData(LINEAR_KEY, state);
            setLinearOpen(false);
            // 刚连上就拉一次：人点保存的下一步一定是想看到任务。
            if (state.connected) sync.mutate();
          }}
        />
      )}
    </div>
  );
}

/* ── 行 ─────────────────────────────────────────────────────────────── */

interface RowProps {
  item: WorkItem;
  productOptions: { value: string; label: string }[];
  starting: boolean;
  onStart: () => void;
  onOpenSession: (id: string) => void;
  onChanged: () => void;
  onError: (e: unknown) => void;
}

/** 顶上常驻的空行：敲标题回车就建一条，焦点留在原地，可以连着记。 */
function NewRequestRow({
  inputRef,
  onCreated,
  onError,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  onCreated: () => void;
  onError: (e: unknown) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState("");
  const create = useMutation({
    mutationFn: () => createRequestItem({ title: title.trim() }),
    onSuccess: () => {
      setTitle("");
      onCreated();
    },
    onError,
  });
  return (
    <tr className="work-new-row">
      <td className="c-status">
        {create.isPending ? (
          <Loader2 size={14} className="spin" />
        ) : (
          <Plus size={14} />
        )}
      </td>
      <td colSpan={7}>
        <input
          ref={inputRef}
          className="work-cell-input"
          value={title}
          maxLength={200}
          placeholder="新需求：直接输入，回车保存"
          aria-label="新需求"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (title.trim() !== "" && !create.isPending) create.mutate();
            }
            if (e.key === "Escape") setTitle("");
          }}
        />
      </td>
    </tr>
  );
}

function useSave(
  item: WorkItem,
  onChanged: () => void,
  onError: RowProps["onError"],
) {
  return useMutation({
    mutationFn: (fields: Partial<WorkFields>) =>
      updateWorkItem(item.id, fields),
    onSuccess: onChanged,
    onError,
  });
}

/** 文字格子：离开或回车即保存；Esc 撤回。 */
function CellInput({
  value,
  onCommit,
  placeholder,
  label,
  className = "",
  maxLength,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  label: string;
  className?: string;
  maxLength: number;
}): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  const [prev, setPrev] = useState(value);
  // 服务端值变了（比如别处改过）：跟上。
  if (value !== prev) {
    setPrev(value);
    setDraft(value);
  }
  return (
    <input
      className={`work-cell-input ${className}`}
      value={draft}
      maxLength={maxLength}
      placeholder={placeholder}
      aria-label={label}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing)
          e.currentTarget.blur();
        if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function ProductCell({
  item,
  options,
  onSave,
}: {
  item: WorkItem;
  options: RowProps["productOptions"];
  onSave: (productId: string | null) => void;
}): React.JSX.Element {
  return (
    <Select
      className="work-cell-select"
      value={item.productId ?? ""}
      aria-label={`关联产品：${item.title}`}
      placeholder="—"
      onChange={(v) => onSave(v === "" ? null : v)}
      options={[{ value: "", label: "不关联" }, ...options]}
    />
  );
}

function Actions({
  item,
  starting,
  onStart,
  onOpenSession,
  extra,
}: Pick<RowProps, "item" | "starting" | "onStart" | "onOpenSession"> & {
  extra?: React.ReactNode;
}): React.JSX.Element {
  // 每行只有一个对话按钮：开过对话就回到那条对话，没开过才新建。
  // 两个长得差不多的图标并排，人分不清哪个是继续、哪个是新开。
  const resume = item.sessionId;
  return (
    <div className="work-actions">
      <button
        type="button"
        className={`work-chat-btn${resume ? " resume" : ""}`}
        title={resume ? "回到上次为这条开的对话" : "开一个新对话处理这条"}
        aria-label={`${resume ? "继续对话" : "开始对话"}：${item.title}`}
        disabled={starting}
        onClick={() => {
          if (resume) onOpenSession(resume);
          else onStart();
        }}
      >
        {starting ? (
          <Loader2 size={13} className="spin" />
        ) : resume ? (
          <MessagesSquare size={13} />
        ) : (
          <MessageSquare size={13} />
        )}
        {resume ? "继续对话" : "对话"}
      </button>
      {/* 没有附加按钮也占住这一格，否则「对话」会左右错位。 */}
      {extra ?? <span className="work-slot" aria-hidden="true" />}
    </div>
  );
}

function RequestRow(props: RowProps): React.JSX.Element {
  const { item, onChanged, onError } = props;
  const save = useSave(item, onChanged, onError);
  const remove = useMutation({
    mutationFn: () => deleteWorkItem(item.id),
    onSuccess: onChanged,
    onError,
  });
  return (
    <tr className={isOpen(item.status) ? "" : "is-closed"}>
      <td className="c-status">
        <StatusIcon status={item.status} />
      </td>
      <td className="c-title">
        <CellInput
          className="title"
          value={item.title}
          label="标题"
          maxLength={200}
          onCommit={(v) => {
            if (v.trim() !== "") save.mutate({ title: v.trim() });
          }}
        />
        <CellInput
          className="context"
          value={item.description}
          label="上下文"
          placeholder="补充上下文：原话、场景、截图说明…"
          maxLength={20_000}
          onCommit={(v) => save.mutate({ description: v })}
        />
      </td>
      <td className="c-person">
        <CellInput
          value={item.requester}
          label="提出人"
          placeholder="—"
          maxLength={80}
          onCommit={(v) => save.mutate({ requester: v.trim() })}
        />
      </td>
      <td className="c-prio">
        <Select
          className={`work-cell-select prio p-${String(item.priority)}`}
          value={String(item.priority)}
          aria-label={`优先级：${item.title}`}
          onChange={(v) => save.mutate({ priority: Number(v) })}
          options={[1, 2, 3, 4, 0].map((p) => ({
            value: String(p),
            label: PRIORITY_LABEL[p] ?? "",
          }))}
        />
      </td>
      <td className="c-product">
        <ProductCell
          item={item}
          options={props.productOptions}
          onSave={(productId) => save.mutate({ productId })}
        />
      </td>
      <td className="c-state">
        <Select
          className="work-cell-select"
          value={item.status}
          aria-label={`状态：${item.title}`}
          onChange={(v) => save.mutate({ status: v })}
          options={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))}
        />
      </td>
      <td className="c-time">{ago(item.updatedAt)}</td>
      <td className="c-actions">
        <Actions
          {...props}
          extra={
            <button
              type="button"
              className="icon-btn work-del"
              title="删除"
              aria-label={`删除：${item.title}`}
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`删除「${item.title}」？`)) remove.mutate();
              }}
            >
              <Trash2 size={14} />
            </button>
          }
        />
      </td>
    </tr>
  );
}

function TaskRow(props: RowProps): React.JSX.Element {
  const { item, onChanged, onError } = props;
  const save = useSave(item, onChanged, onError);
  const context = [item.labels.join(" · "), plainLine(item.description)]
    .filter((x) => x.trim() !== "")
    .join("  ｜  ");
  return (
    <tr className={isOpen(item.status) ? "" : "is-closed"}>
      <td className="c-id">
        <span className="work-key">{item.externalKey}</span>
      </td>
      <td className="c-title">
        <div className="work-title-text" title={item.title}>
          {item.title}
        </div>
        {context !== "" && (
          <div className="work-context-text" title={item.description}>
            {context}
          </div>
        )}
      </td>
      <td className="c-person">
        <Avatar name={item.assignee} />
      </td>
      <td className="c-prio">
        <PriorityBars p={item.priority} />
      </td>
      <td className="c-product">
        <ProductCell
          item={item}
          options={props.productOptions}
          onSave={(productId) => save.mutate({ productId })}
        />
      </td>
      <td className="c-state">
        <span className="work-state">
          <StatusIcon status={item.status} external={item.externalStatus} />
          {item.externalStatus ?? STATUS_LABEL[item.status]}
        </span>
      </td>
      <td className="c-time">
        {ago(item.externalUpdatedAt ?? item.updatedAt)}
      </td>
      <td className="c-actions">
        <Actions
          {...props}
          extra={
            item.url ? (
              <a
                className="icon-btn"
                href={item.url}
                target="_blank"
                rel="noreferrer"
                title="在 Linear 打开"
                aria-label={`在 Linear 打开：${item.title}`}
              >
                <ExternalLink size={14} />
              </a>
            ) : undefined
          }
        />
      </td>
    </tr>
  );
}
