import { useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  FileCheck2,
  Loader2,
  MessageSquareText,
  Play,
  Square,
  TriangleAlert,
  Wand2,
  X,
} from "lucide-react";

import {
  ISSUE_TYPE_LABEL,
  aiKey,
  applyRun,
  asCross,
  cancelRun,
  getPlan,
  resumeRun,
  startRun,
  type Run,
} from "./ai-api";

/**
 * 体系复盘：整套售前材料一起过一遍。
 *
 * 发起前先预览（几份材料、几条对话、大概多少 token、哪些读不了），确认后才开跑——
 * 它一次要开 2N+1 条对话，是售前页最贵的一个按钮。
 *
 * 跑的过程：① 每份抽口径台账 → ② 所有台账放一起比对（腐烂文字 / 上下文不一致 /
 * 与代码 / PRD 不符）→ ③ 每份出修订清单。③ 的结果直接落到材料清单的「AI 审阅」列，
 * 这里只放体系层面的报告与进度。
 */

const errorText = (e: unknown, fallback: string): string =>
  e instanceof Error && e.message !== "" ? e.message : fallback;

const fmtTime = (t: number): string =>
  new Date(t).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const PHASE_LABEL = {
  ledger: "抽口径台账",
  cross: "跨材料比对",
  review: "逐份出修订清单",
} as const;

export function RunSection({
  libId,
  run,
  onOpenSession,
  onChanged,
}: {
  libId: string;
  run: Run;
  onOpenSession?: ((sessionId: string) => void) | undefined;
  onChanged: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(run.status !== "done");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const cross = asCross(run.cross);

  const act = (fn: () => Promise<unknown>): void => {
    setBusy(true);
    setError(null);
    setNote(null);
    fn()
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: aiKey(libId) });
      })
      .catch((e: unknown) => {
        setError(errorText(e, "操作失败"));
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const p = run.progress;
  const live = run.status === "running";
  const accepted = run.reviews.reduce(
    (n, r) => n + r.counts.accepted - r.counts.applied,
    0,
  );

  return (
    <section className="presales-run">
      <header className="presales-run-head">
        <button
          type="button"
          className="btn ghost"
          aria-expanded={open}
          onClick={() => {
            setOpen((v) => !v);
          }}
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          体系复盘
        </button>
        <span className="muted small">{fmtTime(run.createdAt)}</span>
        <span
          className={`pill ${run.status === "done" ? "ok" : run.status === "running" ? "" : "warn"}`}
        >
          {run.status === "running" ? (
            <>
              <Loader2 size={12} className="spin" /> {PHASE_LABEL[run.phase]}
            </>
          ) : run.status === "done" ? (
            "已完成"
          ) : run.status === "cancelled" ? (
            "已停止"
          ) : (
            "中断待继续"
          )}
        </span>
        <span className="muted small">
          台账 {p.ledger.done}/{p.ledger.total} · 比对{" "}
          {p.cross.done > 0 ? "完成" : p.cross.total > 0 ? "进行中" : "未开始"}{" "}
          · 修订 {p.review.done}/{run.materials}
          {run.failures.length > 0 && (
            <b className="presales-gap"> · {run.failures.length} 步失败</b>
          )}
        </span>
        <span className="presales-preview-spacer" />
        {live ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => {
              act(() => cancelRun(run.id));
            }}
          >
            <Square size={12} /> 停止
          </button>
        ) : (
          (run.status === "interrupted" ||
            run.status === "cancelled" ||
            run.failures.length > 0) && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              title="接着跑：中断的继续，失败 / 停掉的那几步重跑"
              onClick={() => {
                act(() => resumeRun(run.id));
              }}
            >
              <Play size={12} /> 继续
            </button>
          )
        )}
        <button
          type="button"
          className="btn primary"
          disabled={busy || accepted === 0}
          title={
            accepted === 0
              ? "先在下表「AI 审阅」列逐份采纳条目"
              : "每份材料按各自已采纳的条目，在原文件里替换、另存为草稿版本"
          }
          onClick={() => {
            setBusy(true);
            setError(null);
            applyRun(run.id)
              .then((out) => {
                const ok = out.results.filter((r) => r.ok).length;
                setNote(
                  ok === 0
                    ? "没有生成任何修订稿：采纳的条目都找不到原文，或已经写过了。"
                    : `已为 ${String(ok)} 份材料生成修订稿（草稿），在各自的审阅面板里预览、设为可对外。`,
                );
                onChanged();
                void queryClient.invalidateQueries({ queryKey: aiKey(libId) });
              })
              .catch((e: unknown) => {
                setError(errorText(e, "生成失败"));
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          <FileCheck2 size={13} /> 生成全部修订稿（{accepted} 条）
        </button>
      </header>

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

      {open && (
        <div className="presales-run-body">
          {cross === null ? (
            <p className="muted small">
              {live
                ? "跨材料比对在台账抽完之后跑；结果出来后体系层面的问题列在这里，每份材料的修订清单在下表「AI 审阅」列。"
                : "这次复盘没有比对结果。"}
            </p>
          ) : (
            <>
              <p className="presales-run-summary">{cross.summary}</p>
              {cross.issues.length === 0 ? (
                <p className="muted small">比对没有发现体系层面的问题。</p>
              ) : (
                <ol className="presales-issues">
                  {cross.issues.map((i, n) => (
                    <li
                      key={`${i.title}-${String(n)}`}
                      className="presales-issue"
                    >
                      <div className="presales-issue-head">
                        <span
                          className={`presales-sev sev-${i.severity.toLowerCase()}`}
                        >
                          {i.severity}
                        </span>
                        <span className="tag">
                          {ISSUE_TYPE_LABEL[i.type] ?? i.type}
                        </span>
                        <b>{i.title}</b>
                      </div>
                      <p className="presales-issue-reason">{i.detail}</p>
                      {i.suggestion !== "" && (
                        <p className="presales-issue-reason">
                          建议：{i.suggestion}
                        </p>
                      )}
                      <p className="presales-issue-evidence">
                        {i.materials.length > 0 && (
                          <>涉及：{i.materials.join("、")} </>
                        )}
                        {i.evidence.map((e) => (
                          <code key={e}>{e}</code>
                        ))}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
              {run.cross?.sessionId != null && onOpenSession !== undefined && (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => {
                    onOpenSession(run.cross?.sessionId ?? "");
                  }}
                >
                  <MessageSquareText size={13} /> 在对话里看比对过程
                </button>
              )}
            </>
          )}
          {run.failures.length > 0 && (
            <div className="presales-run-failures">
              <p className="muted small">没成功的几步（点「继续」会重跑）：</p>
              <ul>
                {run.failures.map((f) => (
                  <li key={f.id} className="small">
                    {f.kind === "ledger"
                      ? "台账"
                      : f.kind === "cross"
                        ? "比对"
                        : "修订"}
                    ：{f.error ?? "失败"}
                    {f.sessionId !== null && onOpenSession !== undefined && (
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() => {
                          onOpenSession(f.sessionId ?? "");
                        }}
                      >
                        看对话
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function RunDialog({
  libId,
  onClose,
  onStarted,
}: {
  libId: string;
  onClose: () => void;
  onStarted: () => void;
}): React.JSX.Element {
  const plan = useQuery({
    queryKey: ["presales", libId, "ai-plan"],
    queryFn: () => getPlan(libId),
    staleTime: 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = plan.data;

  return createPortal(
    <div className="presales-scrim" role="dialog" aria-modal="true">
      <div className="presales-dialog presales-run-dialog">
        <h3>
          <Wand2 size={16} /> 体系复盘：整套材料过一遍
        </h3>
        {plan.isPending ? (
          <p className="muted small">
            <Loader2 size={13} className="spin" /> 正在读材料、估算用量…
          </p>
        ) : data === undefined ? (
          <p className="presales-error">
            <TriangleAlert size={13} /> {errorText(plan.error, "预览失败")}
          </p>
        ) : (
          <>
            <p className="small">
              三步：① 每份材料抽口径台账 → ②
              所有台账放一起比对，找腐烂文字、上下文不一致、与代码 / PRD 不符 →
              ③ 每份材料出修订清单。依据取信顺序：代码 &gt; PRD &gt;
              路线图等其他资料。
            </p>
            {!data.hasProduct && (
              <p className="presales-error small">
                <TriangleAlert size={12} /> 这本库没绑产品：没有代码 / PRD
                可依，只能做材料之间的一致性与口径检查。
              </p>
            )}
            <div className="presales-run-plan">
              <div>
                <b>{data.materials.length}</b> 份材料参与
                <ul className="small">
                  {data.materials.map((m) => (
                    <li key={m.slotId}>
                      {m.title}{" "}
                      <span className="muted">
                        · {m.fileName} · {Math.round(m.chars / 1000)} 千字
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {data.skipped.length > 0 && (
                <div>
                  <b>{data.skipped.length}</b> 份不参与
                  <ul className="small muted">
                    {data.skipped.map((s) => (
                      <li key={s.slotId}>
                        {s.title}：{s.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
            <p className="small">
              将开 <b>{data.sessions}</b> 条对话（同时跑 2 条），约{" "}
              <b>
                {Math.round(data.tokens.min / 10000)}–
                {Math.round(data.tokens.max / 10000)} 万
              </b>{" "}
              token。每一步都能在对话列表里看过程，随时可以停。修改只会生成草稿版本，不会动现行版。
            </p>
          </>
        )}
        {error !== null && (
          <p className="presales-error" role="alert">
            <TriangleAlert size={13} /> {error}
          </p>
        )}
        <div className="presales-actions">
          <button
            type="button"
            className="btn primary"
            disabled={busy || data === undefined || data.materials.length === 0}
            title={
              data?.materials.length === 0 ? "没有能读出文字的现行材料" : ""
            }
            onClick={() => {
              if (data === undefined) return;
              setBusy(true);
              setError(null);
              startRun(libId, data.planId)
                .then(() => {
                  onStarted();
                  onClose();
                })
                .catch((e: unknown) => {
                  setError(errorText(e, "发起失败"));
                  void plan.refetch();
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            <Play size={13} /> 开始复盘
          </button>
          <button type="button" className="btn" onClick={onClose}>
            <X size={13} /> 取消
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
