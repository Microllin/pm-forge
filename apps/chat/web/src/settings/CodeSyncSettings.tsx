import { useState } from "react";
import { CheckCircle2, Loader2, RefreshCw, XCircle } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  SYNC_INTERVALS,
  getAutoSync,
  runAutoSync,
  saveAutoSync,
  type AutoSyncStatus,
} from "../code/api";
import { Select } from "../ui/Select";

/**
 * 代码库自动同步：按间隔把「事实底座 → 代码库」里所有 git 仓库各拉一次更新。
 * 点一下即保存（和「界面」卡片一样没有保存按钮）。服务端只做快进、从不丢弃本地改动，
 * 有本地改动或分叉的仓库会在「上次同步」里标红，交给人去代码库页处理。
 */

const intervalLabel = (m: number): string =>
  m === 1440
    ? "每天"
    : m >= 60
      ? `每 ${String(m / 60)} 小时`
      : `每 ${String(m)} 分钟`;

const timeText = (ms: number): string =>
  new Date(ms).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

export function CodeSyncSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const key = ["code-repos", "auto-sync"];
  const status = useQuery({
    queryKey: key,
    queryFn: getAutoSync,
    // 同步在后台跑，开着设置页时隔一会儿刷新一下「上次同步」。
    refetchInterval: 30_000,
  });
  const [error, setError] = useState<string | null>(null);

  const onDone = (data: AutoSyncStatus): void => {
    setError(null);
    queryClient.setQueryData(key, data);
    // 拉到新代码后代码库页的提交号、文件数会变。
    void queryClient.invalidateQueries({ queryKey: ["code-repos"] });
  };
  const onError = (cause: unknown): void => {
    setError(cause instanceof Error ? cause.message : "操作失败");
  };
  const save = useMutation({
    mutationFn: saveAutoSync,
    onSuccess: onDone,
    onError,
  });
  const run = useMutation({
    mutationFn: runAutoSync,
    onSuccess: onDone,
    onError,
  });

  const data = status.data;
  const busy = save.isPending || run.isPending || data?.running === true;
  const results = data?.lastRun?.results ?? [];
  const failed = results.filter((r) => !r.ok);
  const changed = results.filter((r) => r.ok && r.changed);

  return (
    <section className="card">
      <header className="card-head">
        <h3>代码库自动同步</h3>
      </header>

      {data ? (
        <>
          <div className="grid">
            <div className="field">
              <span>自动同步</span>
              <span className="seg" role="group" aria-label="自动同步开关">
                {[false, true].map((on) => (
                  <button
                    key={String(on)}
                    type="button"
                    className={data.enabled === on ? "on" : ""}
                    aria-pressed={data.enabled === on}
                    disabled={save.isPending}
                    onClick={() =>
                      save.mutate({
                        enabled: on,
                        intervalMinutes: data.intervalMinutes,
                      })
                    }
                  >
                    {on ? "开启" : "关闭"}
                  </button>
                ))}
              </span>
            </div>
            <label>
              同步间隔
              <Select
                value={String(data.intervalMinutes)}
                disabled={save.isPending}
                aria-label="同步间隔"
                onChange={(v) =>
                  save.mutate({
                    enabled: data.enabled,
                    intervalMinutes: Number(v),
                  })
                }
                options={SYNC_INTERVALS.map((m) => ({
                  value: String(m),
                  label: intervalLabel(m),
                }))}
              />
            </label>
          </div>

          <dl className="kv">
            <dt>下次同步</dt>
            <dd>
              {data.running ? (
                <span className="muted">
                  <Loader2 size={13} className="spin" /> 正在同步…
                </span>
              ) : data.nextRunAt !== null ? (
                timeText(data.nextRunAt)
              ) : (
                <span className="muted">未开启</span>
              )}
            </dd>
            <dt>上次同步</dt>
            <dd>
              {data.lastRun === null ? (
                <span className="muted">还没同步过</span>
              ) : (
                <>
                  {timeText(data.lastRun.startedAt)}
                  <span className="muted small">
                    {" "}
                    · {data.lastRun.trigger === "manual"
                      ? "手动"
                      : "定时"} ·{" "}
                    {results.length === 0
                      ? "代码库里没有 git 仓库"
                      : `${String(results.length)} 个仓库，${String(changed.length)} 个有更新，${String(failed.length)} 个失败`}
                  </span>
                </>
              )}
            </dd>
          </dl>

          {failed.length > 0 && (
            <ul className="small" aria-label="同步失败的仓库">
              {failed.map((r) => (
                <li key={r.name} className="err-text">
                  <XCircle size={13} /> {r.name}：{r.error}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="muted small">
          <Loader2 size={13} className="spin" /> 查询中…
        </p>
      )}

      <p className="muted small">
        只同步从 git
        克隆来的仓库，上传的文件夹不受影响。只做快进更新、不会覆盖本地改动；
        有本地改动或与远端分叉的仓库会标在上面，请到「代码库」页手动处理。
      </p>

      <footer className="card-foot">
        {error !== null && (
          <span className="err-text">
            <XCircle size={13} /> {error}
          </span>
        )}
        {error === null && run.isSuccess && failed.length === 0 && (
          <span className="ok-text small">
            <CheckCircle2 size={13} /> 同步完成
          </span>
        )}
        <button
          type="button"
          className="btn"
          disabled={busy || data === undefined}
          onClick={() => run.mutate()}
        >
          {run.isPending ? (
            <Loader2 size={13} className="spin" />
          ) : (
            <RefreshCw size={13} />
          )}{" "}
          立即同步
        </button>
      </footer>
    </section>
  );
}
