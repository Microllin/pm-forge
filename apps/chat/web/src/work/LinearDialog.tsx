import { useState } from "react";
import { ExternalLink, Loader2, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  LINEAR_KEY,
  disconnectLinear,
  getLinear,
  saveLinear,
  type LinearState,
} from "./api";

/**
 * Linear 接入：填 API Key + 选拉哪些任务。
 *
 * Key 保存前服务端会先拿它去 Linear 验一次，填错当场就报，不留到同步时才发现。
 * 已经接上时 Key 框留空 = 不换 Key，只改过滤条件。
 */
export function LinearDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: (state: LinearState) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const state = useQuery({ queryKey: LINEAR_KEY, queryFn: getLinear });
  const data = state.data;

  const [key, setKey] = useState("");
  const [scope, setScope] = useState<"mine" | "all" | null>(null);
  const [teamKey, setTeamKey] = useState<string | null>(null);
  const [includeDone, setIncludeDone] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 没改过的字段跟着服务端的当前值走（数据异步到达，不能在 useState 初值里取）。
  const cur = {
    scope: scope ?? data?.scope ?? "mine",
    teamKey: teamKey ?? data?.teamKey ?? "",
    includeDone: includeDone ?? data?.includeDone ?? false,
  };

  const save = useMutation({
    mutationFn: () =>
      saveLinear({ ...cur, ...(key.trim() === "" ? {} : { key: key.trim() }) }),
    onSuccess: onSaved,
    onError: (e) => setError(e instanceof Error ? e.message : "保存失败"),
  });
  const disconnect = useMutation({
    mutationFn: disconnectLinear,
    onSuccess: (s) => {
      queryClient.setQueryData(LINEAR_KEY, s);
      setError(null);
    },
    onError: (e) => setError(e instanceof Error ? e.message : "操作失败"),
  });

  const connected = data?.connected === true;
  const canSave = connected || key.trim() !== "";

  return (
    <div
      className="overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label="接入 Linear"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        <div className="dialog-head">
          <h2>接入 Linear</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>

        {state.isLoading ? (
          <p className="muted small pad">
            <Loader2 size={14} className="spin" /> 读取中…
          </p>
        ) : (
          <>
            <label className="field">
              <span>
                API Key
                {connected && (
                  <span className="muted small">
                    {" "}
                    · 已接入（{data.keyHint}），留空则不更换
                  </span>
                )}
              </span>
              <input
                type="password"
                value={key}
                autoComplete="off"
                placeholder={connected ? "••••••••" : "lin_api_..."}
                onChange={(e) => setKey(e.target.value)}
              />
              <span className="field-hint">
                只存在本机，保存后只显示末四位。{" "}
                <a
                  href="https://linear.app/settings/account/security"
                  target="_blank"
                  rel="noreferrer"
                >
                  去创建 <ExternalLink size={11} />
                </a>
              </span>
            </label>

            <div className="field">
              <span>拉取范围</span>
              <span className="seg" role="group" aria-label="拉取范围">
                {(
                  [
                    ["mine", "只拉分给我的"],
                    ["all", "团队里所有的"],
                  ] as const
                ).map(([v, label]) => (
                  <button
                    key={v}
                    type="button"
                    className={cur.scope === v ? "on" : ""}
                    aria-pressed={cur.scope === v}
                    onClick={() => setScope(v)}
                  >
                    {label}
                  </button>
                ))}
              </span>
            </div>

            <label className="field">
              <span>团队标识（选填）</span>
              <input
                value={cur.teamKey}
                placeholder="如 ENG；不填则不限团队"
                maxLength={20}
                onChange={(e) => setTeamKey(e.target.value)}
              />
              <span className="field-hint">
                issue 编号前面的字母，如 ENG-123 的 ENG。一次最多拉 250 条。
              </span>
            </label>

            <label className="field check-field">
              <input
                type="checkbox"
                checked={cur.includeDone}
                onChange={(e) => setIncludeDone(e.target.checked)}
              />
              <span>连已完成、已取消的也拉下来</span>
            </label>

            {error !== null && (
              <p className="err-text" role="alert">
                {error}
              </p>
            )}

            <div className="dialog-foot">
              {connected && (
                <button
                  type="button"
                  className="btn ghost"
                  disabled={disconnect.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        "断开 Linear？已经拉下来的任务会保留，只是不能再同步。",
                      )
                    )
                      disconnect.mutate();
                  }}
                >
                  断开
                </button>
              )}
              <span style={{ flex: 1 }} />
              <button type="button" className="btn" onClick={onClose}>
                取消
              </button>
              <button
                type="submit"
                className="btn primary"
                disabled={!canSave || save.isPending}
              >
                {save.isPending && <Loader2 size={14} className="spin" />}
                {connected ? "保存并同步" : "验证并接入"}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
