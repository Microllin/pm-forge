import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, Loader2, Sparkles, X } from "lucide-react";

import { getPlan, startFill, type FillRun, type PlanRow } from "./api";
import "./fill.css";

/**
 * 全局 AI 补齐的发起框：两步，第二步是**严格确认**。
 *
 * 1. 预览：每个产品会做什么、为什么跳过、要开几条对话；可以去掉不想跑的产品。
 * 2. 确认：把代价摆在眼前（对话数、token 粗估、耗时），勾选「我了解」才能开始（2026-10-22 起不再手打确认语）。
 *
 * 手打而不是再点一次按钮：连点两下「确定」是肌肉记忆，打字能逼人读一眼数字。
 * 这只是体验层；服务端还会核预览编号（见 server/global-fill.ts）。
 */
export function GlobalFillDialog({
  onClose,
  onStarted,
  onOpenProgress,
}: {
  onClose: () => void;
  onStarted: (run: FillRun) => void;
  onOpenProgress: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const plan = useQuery({
    queryKey: ["global-fill-plan"],
    queryFn: getPlan,
    // 预览要反映此刻的情况：每次打开都重算，不吃缓存。
    staleTime: 0,
    gcTime: 0,
  });
  const [step, setStep] = useState<"preview" | "confirm">("preview");
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);
  const [aware, setAware] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; stale: boolean } | null>(
    null,
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const rows = useMemo(() => plan.data?.rows ?? [], [plan.data]);
  // 没动过勾选时默认选中所有「有事可做」的产品。
  const selected = useMemo(
    () =>
      picked ?? new Set(rows.filter((r) => !r.idle).map((r) => r.productId)),
    [picked, rows],
  );
  const chosen = rows.filter((r) => selected.has(r.productId) && !r.idle);
  const limits = plan.data?.limits;
  const sessions = chosen.reduce(
    (acc, r) => ({
      min: acc.min + r.sessions.min,
      max: acc.max + r.sessions.max,
    }),
    { min: 0, max: 0 },
  );
  const capped = limits !== undefined && sessions.max > limits.maxSessions;
  const maxRun =
    limits === undefined
      ? sessions.max
      : Math.min(sessions.max, limits.maxSessions);
  const tokens = limits
    ? {
        min: sessions.min * limits.tokensPerSession.min,
        max: maxRun * limits.tokensPerSession.max,
      }
    : { min: 0, max: 0 };
  /** 每条对话粗估 1–3 分钟，按并发数摊。 */
  const minutes = limits
    ? {
        min: Math.max(1, Math.ceil((sessions.min * 1) / limits.concurrency)),
        max: Math.max(1, Math.ceil((maxRun * 3) / limits.concurrency)),
      }
    : { min: 0, max: 0 };
  const outlineCount = chosen.filter((r) => r.wiki.state === "outline").length;

  const toggle = (id: string): void => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const start = (): void => {
    if (!plan.data) return;
    setBusy(true);
    setError(null);
    void startFill({
      productIds: chosen.map((r) => r.productId),
      planId: plan.data.planId,
    })
      .then((run) => {
        void queryClient.invalidateQueries({ queryKey: ["global-fill-run"] });
        onStarted(run);
      })
      .catch((cause: unknown) => {
        const text = cause instanceof Error ? cause.message : "发起失败";
        setError({ text, stale: text.includes("重新预览") });
      })
      .finally(() => setBusy(false));
  };

  const repreview = (): void => {
    setError(null);
    setAware(false);
    setPicked(null);
    setStep("preview");
    void plan.refetch();
  };

  return (
    <div
      className="fill-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        className="fill-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="全局 AI 补齐"
      >
        <header className="fill-head">
          <div>
            <h2>
              <Sparkles size={16} /> 全局 AI 补齐
            </h2>
            <p className="muted small">
              借助事实底座，给所有产品起草生命周期里缺的产出物、Wiki
              里没写的章节。
            </p>
          </div>
          <ol className="fill-steps" aria-label="步骤">
            <li aria-current={step === "preview" ? "step" : undefined}>
              1 预览
            </li>
            <li aria-current={step === "confirm" ? "step" : undefined}>
              2 确认
            </li>
          </ol>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        {plan.isLoading && (
          <p className="muted small pad">
            <Loader2 size={14} className="spin" /> 正在盘点每个产品缺什么…
          </p>
        )}
        {plan.error && (
          <p className="err-text pad" role="alert">
            {plan.error.message}
          </p>
        )}

        {plan.data?.running === true && (
          <div className="fill-banner">
            已经有一次全局补齐在跑，一次只能跑一批。
            <button
              type="button"
              className="btn small"
              onClick={onOpenProgress}
            >
              查看进度
            </button>
          </div>
        )}

        {plan.data && step === "preview" && (
          <>
            <div className="fill-body">
              {rows.length === 0 ? (
                <p className="muted small">
                  还没有产品。先在产品页建产品、绑目录。
                </p>
              ) : (
                <table className="fill-table">
                  <thead>
                    <tr>
                      <th className="fill-check" />
                      <th>产品</th>
                      <th>生命周期产出物</th>
                      <th>Wiki</th>
                      <th className="num">新开对话</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr
                        key={r.productId}
                        className={r.idle ? "idle" : undefined}
                      >
                        <td className="fill-check">
                          <input
                            type="checkbox"
                            aria-label={`补齐 ${r.productName}`}
                            disabled={r.idle}
                            checked={!r.idle && selected.has(r.productId)}
                            onChange={() => toggle(r.productId)}
                          />
                        </td>
                        <td>
                          <strong>{r.productName}</strong>
                          <span className="muted small">{r.lineName}</span>
                        </td>
                        <td>{lifecycleText(r)}</td>
                        <td>{wikiText(r)}</td>
                        <td className="num">
                          {r.idle ? "—" : range(r.sessions.min, r.sessions.max)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="muted small">
                生成的文件全部先放在 <code>{plan.data.draftRoot}/</code> 下，
                <strong>不碰产品现有目录、不改 Wiki 正文</strong>
                。你看过之后，在「产品 → AI 补齐」里一键挪入正式位置。
              </p>
            </div>
            <footer className="fill-foot">
              <span className="fill-sum">
                选了 <strong>{chosen.length}</strong> 个产品 · 预计新开{" "}
                <strong>{range(sessions.min, maxRun)}</strong> 个对话
              </span>
              <button type="button" className="btn ghost" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={chosen.length === 0 || plan.data.running}
                onClick={() => setStep("confirm")}
              >
                下一步：确认代价
              </button>
            </footer>
          </>
        )}

        {plan.data && limits && step === "confirm" && (
          <>
            <div className="fill-body">
              <div className="fill-cost" role="note">
                <AlertTriangle size={18} aria-hidden="true" />
                <div>
                  <strong>这一步改动大、花费高，请确认后再开始</strong>
                  <ul>
                    <li>
                      会新开 <b>{range(sessions.min, maxRun)}</b>{" "}
                      个对话，对话列表里会多出这么多条
                      {capped && (
                        <>
                          （超过单次上限 {limits.maxSessions}
                          ，多出的部分这次不跑）
                        </>
                      )}
                    </li>
                    <li>
                      预计消耗约{" "}
                      <b>
                        {wan(tokens.min)}–{wan(tokens.max)}
                      </b>{" "}
                      token（粗估，按每个对话 {wan(limits.tokensPerSession.min)}
                      –{wan(limits.tokensPerSession.max)} 算）
                    </li>
                    <li>
                      同时跑 {limits.concurrency} 个，预计{" "}
                      <b>
                        {minutes.min}–{minutes.max}
                      </b>{" "}
                      分钟；中途可以随时停止，已经生成的草稿会保留
                    </li>
                    <li>
                      产出只进 <code>{plan.data.draftRoot}/</code>
                      ，看过再挪入；挪入时同名文件、已写的章节会被替换
                    </li>
                    {outlineCount > 0 && (
                      <li>
                        {outlineCount} 个产品还没有
                        Wiki，会直接建好空的章节目录（不会覆盖任何已有内容）
                      </li>
                    )}
                  </ul>
                </div>
              </div>
              <p className="muted small">
                涉及：{chosen.map((r) => r.productName).join("、")}
              </p>
              <label className="fill-aware">
                <input
                  type="checkbox"
                  checked={aware}
                  onChange={(e) => setAware(e.target.checked)}
                />
                我了解这会新开大量对话、消耗大量 token
              </label>
              {error !== null && (
                <p className="err-text" role="alert">
                  {error.text}
                  {error.stale && (
                    <button
                      type="button"
                      className="btn small"
                      onClick={repreview}
                    >
                      重新预览
                    </button>
                  )}
                </p>
              )}
            </div>
            <footer className="fill-foot">
              <button
                type="button"
                className="btn ghost"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setStep("preview");
                }}
              >
                <ArrowLeft size={14} /> 返回修改
              </button>
              <button
                type="button"
                className="btn fill-go"
                disabled={!aware || busy}
                onClick={start}
              >
                {busy ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Sparkles size={14} />
                )}
                开始全局补齐
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

const range = (min: number, max: number): string =>
  min === max ? String(min) : `${String(min)}–${String(max)}`;

/** token 数写成「万」：数字太长没人读。 */
const wan = (n: number): string =>
  n >= 10_000 ? `${String(Math.round(n / 10_000))} 万` : String(n);

function lifecycleText(r: PlanRow): React.ReactNode {
  switch (r.lifecycle.state) {
    case "known":
      return `缺 ${String(r.lifecycle.missing.length)} 份，逐份起草`;
    case "compare":
      return `先比对一次，再起草缺的（最多 ${String(r.lifecycle.max)} 份）`;
    case "none":
    case "skip":
      return <span className="muted">{r.lifecycle.reason}</span>;
  }
}

function wikiText(r: PlanRow): React.ReactNode {
  switch (r.wiki.state) {
    case "pages":
      return `${String(r.wiki.pages.length)} 章待写`;
    case "outline":
      return `先规划目录，再写约 ${String(r.wiki.estimate)} 章`;
    case "none":
    case "skip":
      return <span className="muted">{r.wiki.reason}</span>;
  }
}
