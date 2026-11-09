import { memo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Download,
  Eye,
  FileCheck2,
  Loader2,
  MessageSquareText,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  X,
} from "lucide-react";

import {
  ISSUE_TYPE_LABEL,
  aiKey,
  applyJob,
  asReview,
  collectJob,
  decide,
  getJob,
  jobKey,
  setVersionStatus,
  startReview,
  type Decision,
  type Issue,
  type Job,
} from "./ai-api";
import { MaterialPreview } from "./MaterialPreview";

/**
 * 一份材料的 AI 修订清单。
 *
 * 一条 = 「原文 → 改为」+ 为什么 + 依据。人逐条采纳 / 驳回，然后「生成修订稿」：
 * 在原文件里替换文字（保留样式），另存成草稿版本，现行版不动。
 *
 * 每条右上角写明它能不能自动替换——「原文命中 N 处」才能；找不到原文的（跨段落、
 * 数字单元格、模型没逐字摘）和只提醒的条目，采纳了也只能手改，界面上要说清楚。
 */

const SEVERITY_CLASS: Record<string, string> = {
  P0: "sev-p0",
  P1: "sev-p1",
  P2: "sev-p2",
};

const fileUrl = (id: string) => `/api/presales/versions/${id}/file`;

const errorText = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message !== "" ? e.message : fallback;

export function ReviewPanel({
  jobId,
  libId,
  slotId,
  slotTitle,
  onClose,
  onOpenSession,
  onChanged,
}: {
  jobId: string;
  libId: string;
  slotId: string;
  slotTitle: string;
  onClose: () => void;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  /** 生成修订稿 / 改了版本状态：材料清单要刷新。 */
  onChanged: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [currentJob, setCurrentJob] = useState(jobId);
  const job = useQuery({
    queryKey: jobKey(currentJob),
    queryFn: () => getJob(currentJob),
    refetchInterval: (q) =>
      q.state.data?.status === "queued" || q.state.data?.status === "running"
        ? 2000
        : false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState<{
    id: string;
    name: string;
    size: number;
  } | null>(null);
  const [filter, setFilter] = useState<"all" | "auto" | "manual">("all");

  const data = job.data;
  const review = asReview(data);
  const running = data?.status === "queued" || data?.status === "running";

  const put = (next: Job): void => {
    queryClient.setQueryData(jobKey(next.id), next);
    void queryClient.invalidateQueries({ queryKey: aiKey(libId) });
  };

  const act = (fn: () => Promise<unknown>, done?: string): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    fn()
      .then(() => {
        if (done !== undefined) setNote(done);
      })
      .catch((e: unknown) => {
        setError(errorText(e, "操作失败"));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const setDecision = (ids: string[], d: Decision): void => {
    if (data === undefined || ids.length === 0) return;
    act(async () => {
      put(await decide(data.id, Object.fromEntries(ids.map((id) => [id, d]))));
    });
  };

  const autoable = (i: Issue): boolean =>
    i.replacement !== null && i.original !== "" && i.matches > 0;

  const issues = review?.issues ?? [];
  const shown = issues.filter((i) =>
    filter === "all" ? true : filter === "auto" ? autoable(i) : !autoable(i),
  );
  const ready = issues.filter(
    (i) => i.decision === "accepted" && !i.applied && autoable(i),
  );
  const acceptedManual = issues.filter(
    (i) => i.decision === "accepted" && !autoable(i),
  );

  const applied = data?.appliedVersion ?? null;

  return createPortal(
    <div className="presales-scrim" role="dialog" aria-modal="true">
      <div className="presales-review">
        <header className="presales-preview-head">
          <Sparkles size={15} aria-hidden="true" />
          <h3>
            AI 审阅 · {slotTitle}
            {data?.baseVersion != null && (
              <span className="muted">
                {" "}
                （{data.baseVersion.fileName ?? ""} · {data.baseVersion.version}
                ）
              </span>
            )}
          </h3>
          <span className="presales-preview-spacer" />
          {data?.sessionId != null && onOpenSession !== undefined && (
            <button
              type="button"
              className="btn ghost"
              title="每次审阅都是一条真对话：可以看它读了哪些依据、怎么判的，也能追问"
              onClick={() => {
                onOpenSession(data.sessionId ?? "");
              }}
            >
              <MessageSquareText size={13} /> 在对话里看过程
            </button>
          )}
          <button
            type="button"
            className="btn ghost"
            disabled={busy || running}
            title={running ? "这一轮还在跑" : "按现行版重新审一遍"}
            onClick={() => {
              act(async () => {
                const next = await startReview(slotId);
                setCurrentJob(next.id);
                put(next);
              });
            }}
          >
            <RefreshCw size={13} /> 重新审阅
          </button>
          <button type="button" className="btn ghost" onClick={onClose}>
            <X size={14} /> 关闭
          </button>
        </header>

        <div className="presales-review-body">
          {job.isPending ? (
            <p className="muted">加载中…</p>
          ) : data === undefined ? (
            <p className="presales-error">
              <TriangleAlert size={13} /> 读不到这次审阅，关掉重开试试。
            </p>
          ) : running ? (
            <p className="presales-review-wait">
              <Loader2 size={14} className="spin" />
              {data.status === "queued"
                ? "排队中：同时最多跑两份，前面的跑完就轮到它。"
                : "正在审阅：按「代码 → PRD → 其他资料」取依据，对照同库其他材料逐段核对。一份通常要一两分钟。"}
            </p>
          ) : data.status === "failed" || data.status === "cancelled" ? (
            <div className="presales-review-fail">
              <p className="presales-error">
                <TriangleAlert size={13} />{" "}
                {data.status === "cancelled"
                  ? "这次审阅被停掉了。"
                  : "这次审阅没成功。"}
              </p>
              {data.error !== null && (
                <p className="muted small">{data.error}</p>
              )}
              {data.sessionId !== null && (
                <p className="muted small">
                  如果是「没有找到 json
                  结果块」，可以在对话里追一句「请按要求在末尾补一个 json
                  块」，再回来点
                  <button
                    type="button"
                    className="btn ghost"
                    disabled={busy}
                    onClick={() => {
                      act(async () => {
                        put(await collectJob(data.id));
                      });
                    }}
                  >
                    重新取结果
                  </button>
                </p>
              )}
            </div>
          ) : review === null ? (
            <p className="muted">这次审阅没有结果。</p>
          ) : (
            <>
              <section className="presales-review-summary">
                <span
                  className={`pill ${review.verdict === "可直接用" ? "ok" : "warn"}`}
                >
                  {review.verdict}
                </span>
                <p>{review.summary}</p>
                {review.truncated && (
                  <p className="muted small">
                    <TriangleAlert size={12} />{" "}
                    材料太长，这次只审了前一部分，后面的内容没覆盖到。
                  </p>
                )}
                {review.gaps.length > 0 && (
                  <ul className="presales-review-gaps">
                    {review.gaps.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                )}
              </section>

              {applied !== null && (
                <AppliedVersion
                  version={applied}
                  busy={busy}
                  onPreview={() => {
                    setPreviewing({
                      id: applied.id,
                      name: applied.fileName ?? "",
                      size: applied.fileSize ?? 0,
                    });
                  }}
                  onPromote={() => {
                    if (
                      !window.confirm(
                        `把修订稿 ${applied.version} 设为「可对外」？当前现行版会自动转为已归档。`,
                      )
                    )
                      return;
                    act(async () => {
                      await setVersionStatus(applied.id, "current");
                      onChanged();
                      await job.refetch();
                    }, `${applied.version} 已设为可对外`);
                  }}
                />
              )}

              <div className="presales-review-toolbar">
                <div className="seg" role="tablist" aria-label="筛选">
                  {(
                    [
                      ["all", `全部 ${String(issues.length)}`],
                      [
                        "auto",
                        `可自动替换 ${String(issues.filter(autoable).length)}`,
                      ],
                      [
                        "manual",
                        `需手改 ${String(issues.filter((i) => !autoable(i)).length)}`,
                      ],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      type="button"
                      role="tab"
                      aria-selected={filter === k}
                      className={filter === k ? "on" : ""}
                      onClick={() => {
                        setFilter(k);
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <span className="presales-preview-spacer" />
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  title="把能自动替换、还没定的 P0 / P1 条目一次全部采纳"
                  onClick={() => {
                    setDecision(
                      issues
                        .filter(
                          (i) =>
                            autoable(i) &&
                            !i.applied &&
                            i.decision === "pending" &&
                            (i.severity === "P0" || i.severity === "P1"),
                        )
                        .map((i) => i.id),
                      "accepted",
                    );
                  }}
                >
                  <Check size={13} /> 采纳全部可替换的 P0/P1
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || ready.length === 0}
                  title={
                    ready.length === 0
                      ? "先采纳能自动替换的条目（右上角写着「原文命中」的）"
                      : "在原文件里替换文字（保留样式），另存为草稿版本；现行版不动"
                  }
                  onClick={() => {
                    act(async () => {
                      const out = await applyJob(data.id);
                      put(out.job);
                      onChanged();
                    }, "修订稿已生成（草稿），预览确认后再设为可对外。");
                  }}
                >
                  <FileCheck2 size={13} /> 生成修订稿（{ready.length} 条）
                </button>
              </div>
              {acceptedManual.length > 0 && (
                <p className="muted small">
                  已采纳但需手改的 {acceptedManual.length}{" "}
                  条不会写进修订稿：原文在文件里找不到（跨段落、数字单元格或摘得不准），或只给了提醒没给改法。请下载后在
                  Office 里改。
                </p>
              )}

              {shown.length === 0 ? (
                <p className="muted presales-list-empty">
                  {issues.length === 0
                    ? "没有发现需要修改的地方。"
                    : "这一类下没有条目。"}
                </p>
              ) : (
                <ol className="presales-issues">
                  {shown.map((i) => (
                    <IssueRow
                      key={i.id}
                      issue={i}
                      autoable={autoable(i)}
                      busy={busy}
                      onDecide={(d) => {
                        setDecision([i.id], d);
                      }}
                    />
                  ))}
                </ol>
              )}
            </>
          )}
          {error !== null && (
            <p className="presales-error" role="alert">
              <TriangleAlert size={13} /> {error}
            </p>
          )}
          {note !== null && (
            <p className="ok-text small" role="status">
              {note}
            </p>
          )}
        </div>
      </div>
      {previewing !== null && (
        <MaterialPreview
          versionId={previewing.id}
          fileName={previewing.name}
          fileSize={previewing.size}
          onClose={() => {
            setPreviewing(null);
          }}
        />
      )}
    </div>,
    document.body,
  );
}

function AppliedVersion({
  version,
  busy,
  onPreview,
  onPromote,
}: {
  version: NonNullable<Job["appliedVersion"]>;
  busy: boolean;
  onPreview: () => void;
  onPromote: () => void;
}): React.JSX.Element {
  return (
    <section className="presales-review-applied">
      <FileCheck2 size={14} aria-hidden="true" />
      <span>
        修订稿 <b>{version.version}</b>
        <span className="muted">（{version.fileName ?? ""}）</span>
      </span>
      <span className={`pill ${version.status === "current" ? "ok" : "warn"}`}>
        {version.status === "current"
          ? "已设为可对外"
          : version.status === "archived"
            ? "已归档"
            : "草稿"}
      </span>
      <span className="presales-preview-spacer" />
      <button type="button" className="btn ghost" onClick={onPreview}>
        <Eye size={13} /> 预览
      </button>
      <a
        className="btn ghost"
        href={fileUrl(version.id)}
        download={version.fileName ?? undefined}
      >
        <Download size={13} /> 下载
      </a>
      {version.status !== "current" && (
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={onPromote}
        >
          设为可对外
        </button>
      )}
    </section>
  );
}

const IssueRow = memo(function IssueRow({
  issue: i,
  autoable,
  busy,
  onDecide,
}: {
  issue: Issue;
  autoable: boolean;
  busy: boolean;
  onDecide: (d: Decision) => void;
}): React.JSX.Element {
  return (
    <li
      className={`presales-issue is-${i.decision}${i.applied ? " is-applied" : ""}`}
    >
      <div className="presales-issue-head">
        <span className={`presales-sev ${SEVERITY_CLASS[i.severity] ?? ""}`}>
          {i.severity}
        </span>
        <span className="tag">{ISSUE_TYPE_LABEL[i.type] ?? i.type}</span>
        {i.related.length > 0 && (
          <span className="muted small">涉及：{i.related.join("、")}</span>
        )}
        <span className="presales-preview-spacer" />
        <span
          className={`small ${autoable ? "ok-text" : "muted"}`}
          title={
            autoable
              ? "采纳后会在原文件里自动替换"
              : i.original === ""
                ? "没有可替换的原文，只能手改"
                : i.replacement === null
                  ? "只提醒、没给改法"
                  : "原文在文件里找不到（跨段落 / 数字单元格 / 摘得不准），只能手改"
          }
        >
          {autoable
            ? `原文命中 ${String(i.matches)} 处`
            : i.original === "" || i.replacement === null
              ? "只提醒"
              : "需手改"}
        </span>
      </div>
      {i.original !== "" && (
        <div className="presales-issue-diff">
          <del>{i.original}</del>
          {i.replacement !== null && <ins>{i.replacement}</ins>}
        </div>
      )}
      {i.original === "" && i.replacement !== null && (
        <div className="presales-issue-diff">
          <ins>{i.replacement}</ins>
        </div>
      )}
      <p className="presales-issue-reason">{i.reason}</p>
      {i.evidence.length > 0 && (
        <p className="presales-issue-evidence">
          依据：
          {i.evidence.map((p) => (
            <code key={p}>{p}</code>
          ))}
        </p>
      )}
      <div className="presales-issue-ops">
        {i.applied ? (
          <span className="pill ok">已写进修订稿</span>
        ) : (
          <>
            <button
              type="button"
              className={`btn ghost${i.decision === "accepted" ? " on" : ""}`}
              aria-pressed={i.decision === "accepted"}
              disabled={busy}
              onClick={() => {
                onDecide(i.decision === "accepted" ? "pending" : "accepted");
              }}
            >
              <Check size={12} />{" "}
              {i.decision === "accepted" ? "已采纳" : "采纳"}
            </button>
            <button
              type="button"
              className={`btn ghost${i.decision === "rejected" ? " on" : ""}`}
              aria-pressed={i.decision === "rejected"}
              disabled={busy}
              onClick={() => {
                onDecide(i.decision === "rejected" ? "pending" : "rejected");
              }}
            >
              <X size={12} /> {i.decision === "rejected" ? "已驳回" : "驳回"}
            </button>
          </>
        )}
      </div>
    </li>
  );
});
