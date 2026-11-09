import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Circle,
  CircleSlash,
  Eye,
  Loader2,
  MessageSquare,
  Play,
  Sparkles,
  Square,
  Trash2,
  XCircle,
  ArrowRightLeft,
  TriangleAlert,
  X,
} from "lucide-react";

import {
  applyDrafts,
  cancelRun,
  discardDrafts,
  getCurrentRun,
  readDraft,
  resumeRun,
  type FillDraft,
  type FillJob,
  type FillRun,
} from "./api";
import "./fill.css";

/**
 * 产品 → AI 补齐：最近一次全局补齐的进度，以及它产出的草稿。
 *
 * 草稿的去处只有两个：**挪入**（写进产品目录 / wiki 章节，同名替换）或**丢弃**。
 * 挪入前会把「哪几份会替换已有内容」单独点名，再确认一次——替换是这个页面唯一会覆盖东西的动作。
 */
export function FillPage({
  onLaunch,
  onOpenSession,
}: {
  onLaunch: () => void;
  onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const run = useQuery({
    queryKey: ["global-fill-run"],
    queryFn: getCurrentRun,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 2000 : false),
  });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<FillDraft[] | null>(null);
  const [preview, setPreview] = useState<{
    draft: FillDraft;
    content: string | null;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const refresh = (data?: FillRun): void => {
    if (data !== undefined) queryClient.setQueryData(["global-fill-run"], data);
    void queryClient.invalidateQueries({ queryKey: ["global-fill-run"] });
  };

  if (run.isLoading)
    return (
      <p className="muted small pad">
        <Loader2 size={14} className="spin" /> 加载…
      </p>
    );
  /*
   * 读失败要单独说，不能让下面的 `data ?? null` 把它显示成「还没有跑过全局补齐」——
   * 那会引导人去点「发起补齐」，而这是全平台最贵的一个按钮（一次可能开上百条对话、
   * 烧几百万 token）。服务刚起或库被锁时最容易撞上。
   */
  if (run.isError)
    return (
      <div className="fill-page">
        <div className="fill-empty">
          <TriangleAlert size={28} aria-hidden="true" />
          <h2>读不到补齐记录</h2>
          <p className="err-text" role="alert">
            {run.error.message}
          </p>
          <p className="muted small">
            这不代表还没跑过——先重试，别直接点「发起补齐」。
          </p>
          <button
            type="button"
            className="btn"
            onClick={() => void run.refetch()}
          >
            重试
          </button>
        </div>
      </div>
    );
  const current = run.data ?? null;

  if (current === null)
    return (
      <div className="fill-page">
        <div className="fill-empty">
          <Sparkles size={28} aria-hidden="true" />
          <h2>还没有跑过全局补齐</h2>
          <p className="muted">
            全局 AI 补齐会挨个产品看生命周期里缺哪些产出物、Wiki
            哪些章节没写，让 AI 起草出来放进草稿区；你看过之后一键挪入。
            花费很高，发起前会让你预览并二次确认。
          </p>
          <button type="button" className="btn fill-go" onClick={onLaunch}>
            <Sparkles size={14} /> 发起全局补齐
          </button>
        </div>
      </div>
    );

  const jobs = current.jobs;
  const finished = jobs.filter(
    (j) => j.status !== "queued" && j.status !== "running",
  ).length;
  const pending = current.drafts.filter((d) => d.status === "pending");
  const handled = current.drafts.length - pending.length;
  const selected = pending.filter((d) => picked.has(d.id));
  const allPicked = pending.length > 0 && selected.length === pending.length;
  const failed = jobs.filter((j) => j.status === "failed");

  const togglePick = (id: string): void => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const apply = (drafts: FillDraft[]): void => {
    setBusy(true);
    setNotice(null);
    void applyDrafts(drafts.map((d) => d.id))
      .then((report) => {
        setConfirming(null);
        setPicked(new Set());
        void queryClient.invalidateQueries({ queryKey: ["wiki"] });
        void queryClient.invalidateQueries({ queryKey: ["files"] });
        setNotice({
          ok: report.failed.length === 0,
          text: [
            `已挪入 ${String(report.applied.length)} 份`,
            report.replaced.length > 0
              ? `其中替换了 ${String(report.replaced.length)} 份已有内容`
              : null,
            report.failed.length > 0
              ? `${String(report.failed.length)} 份没挪成：${report.failed
                  .map((f) => `${f.title}（${f.why}）`)
                  .join("；")}`
              : null,
          ]
            .filter((x) => x !== null)
            .join("，"),
        });
        refresh();
      })
      .catch((cause: unknown) =>
        setNotice({
          ok: false,
          text: cause instanceof Error ? cause.message : "挪入失败",
        }),
      )
      .finally(() => setBusy(false));
  };

  const discard = (drafts: FillDraft[]): void => {
    if (
      !window.confirm(
        `丢弃 ${String(drafts.length)} 份草稿？草稿文件会被删除，正式位置不受影响。`,
      )
    )
      return;
    setBusy(true);
    void discardDrafts(drafts.map((d) => d.id))
      .then((r) => {
        setPicked(new Set());
        setNotice({ ok: true, text: `已丢弃 ${String(r.discarded)} 份草稿` });
        refresh();
      })
      .catch((cause: unknown) =>
        setNotice({
          ok: false,
          text: cause instanceof Error ? cause.message : "丢弃失败",
        }),
      )
      .finally(() => setBusy(false));
  };

  const openPreview = (draft: FillDraft): void => {
    setPreview({ draft, content: null });
    void readDraft(draft.id)
      .then((content) => setPreview({ draft, content }))
      .catch((cause: unknown) =>
        setPreview({
          draft,
          content: `读不到草稿：${cause instanceof Error ? cause.message : "未知错误"}`,
        }),
      );
  };

  return (
    <div className="fill-page">
      <header className="fill-page-head">
        <div>
          <h2>
            最近一次全局补齐 <StatusChip status={current.status} />
          </h2>
          <p className="muted small">
            {new Date(current.createdAt).toLocaleString()} 发起 · {current.note}
            {" · "}草稿位置 <code>{current.folder}</code>
          </p>
        </div>
        <div className="fill-page-actions">
          {current.status === "running" && (
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                if (
                  window.confirm(
                    "停止这次补齐？正在跑的对话会被中断，排队的不再开始；已经生成的草稿保留。",
                  )
                )
                  void cancelRun(current.id).then(refresh);
              }}
            >
              <Square size={13} /> 停止
            </button>
          )}
          {current.status === "interrupted" && (
            <button
              type="button"
              className="btn"
              onClick={() => void resumeRun(current.id).then(refresh)}
            >
              <Play size={13} /> 继续跑完
            </button>
          )}
          {current.status !== "running" && (
            <button type="button" className="btn fill-go" onClick={onLaunch}>
              <Sparkles size={14} /> 发起新的补齐
            </button>
          )}
        </div>
      </header>

      {current.status === "interrupted" && (
        <div className="fill-banner">
          服务重启打断了这次补齐。点「继续跑完」会把没完成的任务重新跑一遍（会再开对话）。
        </div>
      )}

      <div className="fill-progress" aria-label="进度">
        <div className="fill-bar">
          <span
            style={{
              width: `${String(jobs.length === 0 ? 0 : (finished / jobs.length) * 100)}%`,
            }}
          />
        </div>
        <span className="small">
          任务 {finished}/{jobs.length}
          {failed.length > 0 && (
            <span className="err-text"> · {failed.length} 个失败</span>
          )}
          {current.status === "running" && (
            <span className="muted">
              {" "}
              · 跑的过程中还会追加任务（比对完才知道缺什么）
            </span>
          )}
        </span>
      </div>

      {notice !== null && (
        <p
          className={notice.ok ? "ok-text" : "err-text"}
          role={notice.ok ? "status" : "alert"}
        >
          {notice.text}
        </p>
      )}

      <section className="fill-section">
        <div className="fill-section-head">
          <h3>
            草稿 <span className="muted">{pending.length} 份待处理</span>
            {handled > 0 && (
              <span className="muted small"> · 已处理 {handled} 份</span>
            )}
          </h3>
          {pending.length > 0 && (
            <div className="fill-toolbar">
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={() =>
                  setConfirming(selected.length > 0 ? selected : pending)
                }
              >
                <ArrowRightLeft size={14} />
                {selected.length > 0
                  ? `挪入所选（${String(selected.length)}）`
                  : `一键全部挪入（${String(pending.length)}）`}
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={busy || selected.length === 0}
                onClick={() => discard(selected)}
              >
                <Trash2 size={14} /> 丢弃所选
              </button>
            </div>
          )}
        </div>
        {pending.length === 0 ? (
          <p className="muted small">
            {current.status === "running"
              ? "草稿会随任务完成陆续出现在这里。"
              : "没有待处理的草稿。"}
          </p>
        ) : (
          <table className="fill-table">
            <thead>
              <tr>
                <th className="fill-check">
                  <input
                    type="checkbox"
                    aria-label="全选草稿"
                    checked={allPicked}
                    onChange={() =>
                      setPicked(
                        allPicked
                          ? new Set()
                          : new Set(pending.map((d) => d.id)),
                      )
                    }
                  />
                </th>
                <th>产品</th>
                <th>草稿</th>
                <th>挪入到</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {pending.map((d) => (
                <tr
                  key={d.id}
                  className={picked.has(d.id) ? "picked" : undefined}
                >
                  <td className="fill-check">
                    <input
                      type="checkbox"
                      aria-label={`选中 ${d.title}`}
                      checked={picked.has(d.id)}
                      onChange={() => togglePick(d.id)}
                    />
                  </td>
                  <td>{d.productName}</td>
                  <td>
                    <span className="fill-kind">
                      {d.kind === "wiki" ? "Wiki" : "产出物"}
                    </span>{" "}
                    {d.title}
                    {!d.exists && (
                      <span className="fill-flag danger">草稿已不在</span>
                    )}
                  </td>
                  <td>
                    <code className="fill-target">{d.target}</code>
                    {d.willReplace && (
                      <span className="fill-flag warn">会替换已有内容</span>
                    )}
                  </td>
                  <td className="fill-row-actions">
                    <button
                      type="button"
                      className="btn small ghost"
                      aria-label={`预览 ${d.title}`}
                      onClick={() => openPreview(d)}
                    >
                      <Eye size={13} /> 预览
                    </button>
                    {d.sessionId !== null && (
                      <button
                        type="button"
                        className="btn small ghost"
                        aria-label={`看 ${d.title} 的对话`}
                        onClick={() => onOpenSession(d.sessionId ?? "")}
                      >
                        <MessageSquare size={13} /> 对话
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted small">
          草稿也是普通文件：可以先去「事实底座 → 文件库」打开{" "}
          <code>{current.folder}</code> 改一改，挪入的就是改过的版本。
        </p>
      </section>

      <section className="fill-section">
        <div className="fill-section-head">
          <h3>
            任务 <span className="muted">{jobs.length} 个</span>
          </h3>
        </div>
        <ul className="fill-jobs">
          {jobs.map((j) => (
            <JobItem key={j.id} job={j} onOpenSession={onOpenSession} />
          ))}
        </ul>
      </section>

      {confirming !== null && (
        <ApplyConfirm
          drafts={confirming}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={() => apply(confirming)}
        />
      )}

      {preview !== null && (
        <div
          className="fill-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setPreview(null);
          }}
        >
          <div className="fill-dialog wide" role="dialog" aria-label="预览草稿">
            <header className="fill-head">
              <div>
                <h2>{preview.draft.title}</h2>
                <p className="muted small">
                  {preview.draft.productName} · 挪入到{" "}
                  <code>{preview.draft.target}</code>
                </p>
              </div>
              <button
                type="button"
                className="icon-btn"
                aria-label="关闭"
                onClick={() => setPreview(null)}
              >
                <X size={16} />
              </button>
            </header>
            <div className="fill-body">
              {preview.content === null ? (
                <p className="muted">
                  <Loader2 size={14} className="spin" /> 读取…
                </p>
              ) : (
                <pre className="fill-preview">{preview.content}</pre>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** 挪入前的确认：会替换已有内容的那几份单独点名。 */
function ApplyConfirm({
  drafts,
  busy,
  onCancel,
  onConfirm,
}: {
  drafts: FillDraft[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const replacing = drafts.filter((d) => d.willReplace);
  const gone = drafts.filter((d) => !d.exists);
  return (
    <div className="fill-overlay">
      <div className="fill-dialog" role="dialog" aria-label="确认挪入">
        <header className="fill-head">
          <h2>挪入 {drafts.length} 份草稿？</h2>
        </header>
        <div className="fill-body">
          <p>
            产出物写进产品的文档目录，Wiki
            草稿写进对应章节；挪入后草稿文件删除。
          </p>
          {replacing.length > 0 ? (
            <div className="fill-cost">
              <div>
                <strong>
                  其中 {replacing.length} 份会替换已有内容（无法撤销）：
                </strong>
                <ul>
                  {replacing.map((d) => (
                    <li key={d.id}>
                      {d.productName} · <code>{d.target}</code>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <p className="muted small">
              这些位置现在都是空的，不会覆盖任何内容。
            </p>
          )}
          {gone.length > 0 && (
            <p className="err-text small">
              {gone.length} 份草稿文件已经不在了，会挪入失败并在结果里列出。
            </p>
          )}
        </div>
        <footer className="fill-foot">
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className={`btn ${replacing.length > 0 ? "danger" : "primary"}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy && <Loader2 size={14} className="spin" />}
            {replacing.length > 0 ? "挪入并替换" : "挪入"}
          </button>
        </footer>
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<FillRun["status"], string> = {
  running: "进行中",
  done: "已完成",
  cancelled: "已停止",
  interrupted: "被中断",
};

function StatusChip({
  status,
}: {
  status: FillRun["status"];
}): React.JSX.Element {
  return <span className={`fill-chip ${status}`}>{STATUS_TEXT[status]}</span>;
}

const JOB_ICON: Record<FillJob["status"], React.JSX.Element> = {
  queued: <Circle size={14} />,
  running: <Loader2 size={14} className="spin" />,
  done: <CheckCircle2 size={14} />,
  failed: <XCircle size={14} />,
  cancelled: <CircleSlash size={14} />,
  skipped: <CircleSlash size={14} />,
};
const JOB_TEXT: Record<FillJob["status"], string> = {
  queued: "排队",
  running: "进行中",
  done: "完成",
  failed: "失败",
  cancelled: "已停止",
  skipped: "未跑",
};

function JobItem({
  job,
  onOpenSession,
}: {
  job: FillJob;
  onOpenSession: (id: string) => void;
}): React.JSX.Element {
  return (
    <li className={`fill-job ${job.status}`}>
      <span className="fill-job-icon" aria-label={JOB_TEXT[job.status]}>
        {JOB_ICON[job.status]}
      </span>
      <span className="fill-job-product">{job.productName}</span>
      <span className="fill-job-label">
        {job.label}
        {job.error !== null && job.status !== "done" && (
          <span className="fill-job-error">{job.error}</span>
        )}
      </span>
      {job.sessionId !== null && (
        <button
          type="button"
          className="btn small ghost"
          onClick={() => onOpenSession(job.sessionId ?? "")}
        >
          <MessageSquare size={13} /> 看对话
        </button>
      )}
    </li>
  );
}
