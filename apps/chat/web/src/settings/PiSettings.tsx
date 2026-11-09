import { useState } from "react";
import {
  ArrowUpCircle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { getPi, upgradePi, waitForServer, type UpgradeEvent } from "../api";

/**
 * pi 版本：显示已装与 npm 最新，一键升级。
 *
 * 升级由服务端完成：安装 → 子进程自检 → 通过则重启（失败自动装回原版本）。
 * 这里只负责展示进度日志，并在服务重启后自动重连、刷新版本号。
 */
export function PiSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const pi = useQuery({ queryKey: ["pi"], queryFn: getPi });
  const [log, setLog] = useState<string[]>([]);
  const [phase, setPhase] = useState<
    "idle" | "running" | "restarting" | "ok" | "failed"
  >("idle");
  const [result, setResult] = useState<string | null>(null);

  const upgrade = async (): Promise<void> => {
    setLog([]);
    setResult(null);
    setPhase("running");
    let final: UpgradeEvent | undefined;
    try {
      await upgradePi(undefined, (event) => {
        if (event.type === "log") setLog((l) => [...l, event.line]);
        else if (event.type === "step")
          setLog((l) => [...l, `▸ ${event.name}`]);
        else final = event;
      });
    } catch (cause) {
      setPhase("failed");
      setResult(cause instanceof Error ? cause.message : "升级失败");
      return;
    }
    if (final?.type !== "done") {
      setPhase("failed");
      setResult("升级过程中连接中断，刷新页面查看当前版本");
      return;
    }
    if (!final.ok) {
      setPhase("failed");
      setResult(
        final.error + (final.rolledBack ? "" : "（回滚未完成，请检查）"),
      );
      return;
    }
    if (!final.restarting) {
      setPhase("ok");
      setResult(
        `已装好 ${final.version}，但服务不在看护进程下，请手动重启后生效`,
      );
      return;
    }
    setPhase("restarting");
    const back = await waitForServer();
    setPhase(back ? "ok" : "failed");
    setResult(
      back
        ? `已升级到 ${final.version}`
        : "服务重启后没有恢复，请查看服务端日志",
    );
    await queryClient.invalidateQueries();
  };

  const data = pi.data;
  const running = phase === "running" || phase === "restarting";

  return (
    <section className="card">
      <header className="card-head">
        <h3>pi 版本</h3>
        <button
          type="button"
          className="icon-btn ghost"
          aria-label="刷新"
          disabled={running}
          onClick={() => void pi.refetch()}
        >
          <RefreshCw size={13} className={pi.isFetching ? "spin" : ""} />
        </button>
      </header>

      {data ? (
        <dl className="kv">
          <dt>已安装</dt>
          <dd>
            <code>{data.installed}</code>
            {data.installedAt && (
              <span className="muted small">
                {" "}
                · {data.installedAt.slice(0, 10)}
              </span>
            )}
          </dd>
          <dt>npm 最新</dt>
          <dd>
            {data.latest ? (
              <>
                <code>{data.latest}</code>
                {data.latestAt && (
                  <span className="muted small">
                    {" "}
                    · {data.latestAt.slice(0, 10)}
                  </span>
                )}
              </>
            ) : (
              <span className="err-text small">
                {data.registryError ?? "查询失败"}
              </span>
            )}
          </dd>
        </dl>
      ) : (
        <p className="muted small">
          <Loader2 size={13} className="spin" /> 查询中…
        </p>
      )}

      {data?.repository && (
        <p className="small">
          <a href={data.repository} target="_blank" rel="noreferrer noopener">
            更新日志 ↗
          </a>
        </p>
      )}

      {log.length > 0 && <pre className="log">{log.join("\n")}</pre>}

      <footer className="card-foot">
        {result && (
          <span className={phase === "ok" ? "ok-text" : "err-text"}>
            {phase === "ok" ? (
              <CheckCircle2 size={13} />
            ) : (
              <XCircle size={13} />
            )}{" "}
            {result}
          </span>
        )}
        {phase === "restarting" && (
          <span className="muted">
            <Loader2 size={13} className="spin" /> 服务重启中…
          </span>
        )}
        {data?.updateAvailable === true && (
          <button
            type="button"
            className="btn primary"
            disabled={running}
            onClick={() => void upgrade()}
          >
            {phase === "running" ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <ArrowUpCircle size={13} />
            )}{" "}
            升级到 {data.latest}
          </button>
        )}
        {data && !data.updateAvailable && data.latest && phase === "idle" && (
          <span className="ok-text small">
            <CheckCircle2 size={13} /> 已是最新
          </span>
        )}
      </footer>
    </section>
  );
}
