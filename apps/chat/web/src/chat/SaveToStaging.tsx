import { useEffect, useState } from "react";
import { useAui } from "@assistant-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Inbox, Loader2 } from "lucide-react";

import { STAGING_QUERY_KEY, saveToStaging } from "../staging/api";

/**
 * 回答下方的「存到临时区」。
 *
 * 对话会话没有文件工具（安全边界），AI 写的 PRD 原来只能留在聊天记录里、人自己复制粘贴。
 * 这个按钮把这条回答的正文原样存进 `/临时区/对话/<日期>/`，去「临时区」确认后才进正式位置。
 * 取正文与「复制」按钮同一个来源（getCopyText），所以存下的就是复制得到的那份。
 */
export function SaveToStaging({
  sessionId,
}: {
  sessionId: string;
}): React.JSX.Element {
  const aui = useAui();
  const queryClient = useQueryClient();
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "saving" }
    | { kind: "saved"; path: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // 「已存」的勾显示一会儿再退回图标；提示留在 title 里，悬停还能看到存到了哪。
  useEffect(() => {
    if (state.kind !== "saved" && state.kind !== "error") return;
    const timer = window.setTimeout(() => setState({ kind: "idle" }), 4000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const save = (): void => {
    const markdown = aui.message.getCopyText();
    if (markdown.trim() === "") {
      setState({ kind: "error", message: "这条回答没有文字可存" });
      return;
    }
    setState({ kind: "saving" });
    void saveToStaging({ sessionId, markdown })
      .then((item) => {
        setState({ kind: "saved", path: item.draftPath });
        void queryClient.invalidateQueries({ queryKey: STAGING_QUERY_KEY });
      })
      .catch((cause: unknown) =>
        setState({
          kind: "error",
          message: cause instanceof Error ? cause.message : "存失败了",
        }),
      );
  };

  const label =
    state.kind === "saved"
      ? `已存到临时区：${state.path}（去左侧「临时区」确认）`
      : state.kind === "error"
        ? `没存成：${state.message}`
        : "存到临时区（确认后才进正式位置）";

  return (
    <>
      <button
        type="button"
        className="icon-btn ghost"
        aria-label={label}
        title={label}
        disabled={state.kind === "saving"}
        onClick={save}
      >
        {state.kind === "saving" ? (
          <Loader2 size={13} className="spin" />
        ) : state.kind === "saved" ? (
          <Check size={13} />
        ) : (
          <Inbox size={13} />
        )}
      </button>
      {(state.kind === "saved" || state.kind === "error") && (
        <span
          className={`small ${state.kind === "saved" ? "muted" : "err-text"}`}
          role="status"
        >
          {state.kind === "saved" ? "已存到临时区" : state.message}
        </span>
      )}
    </>
  );
}
