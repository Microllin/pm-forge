import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, History, Sparkles } from "lucide-react";

import { KIND_LABEL, listForgeDrafts, type ForgeKind } from "./forge-api";

/**
 * 页面头上的三个工坊入口：AI 新建、从历史沉淀、没保存的 AI 草稿。
 *
 * 「AI 草稿」只列有改动没保存的：工坊会话不进对话列表，关掉工坊后这里是唯一的回头路。
 */
export function ForgeEntry({
  kind,
  onStart,
  onResume,
}: {
  kind: ForgeKind;
  onStart: (mode: "create" | "distill") => void;
  onResume: (sessionId: string) => void;
}): React.JSX.Element {
  const label = KIND_LABEL[kind];
  const drafts = useQuery({
    queryKey: ["forge-drafts", kind],
    queryFn: () => listForgeDrafts(kind),
  });
  const pending = (drafts.data ?? []).filter((d) => d.dirty);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent): void => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <>
      <button
        type="button"
        className="btn"
        title={`说一句想法，AI 问清后起草一个${label}`}
        onClick={() => onStart("create")}
      >
        <Sparkles size={13} /> AI 新建
      </button>
      <button
        type="button"
        className="btn"
        title={`AI 扫描历史对话，列出值得沉淀成${label}的做法，你挑一个它来起草`}
        onClick={() => onStart("distill")}
      >
        <History size={13} /> 从历史沉淀
      </button>
      {pending.length > 0 && (
        <span className="forge-drafts" ref={box}>
          <button
            type="button"
            className="btn"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            AI 草稿 {pending.length} <ChevronDown size={12} />
          </button>
          {open && (
            <div className="forge-drafts-menu" role="menu">
              {pending.map((d) => (
                <button
                  key={d.sessionId}
                  type="button"
                  role="menuitem"
                  className="forge-drafts-item"
                  onClick={() => {
                    setOpen(false);
                    onResume(d.sessionId);
                  }}
                >
                  <span>
                    {d.target !== null
                      ? `修改 · ${d.target}`
                      : `${d.mode === "distill" ? "沉淀" : "新建"} · ${d.name ?? "未命名"}`}
                  </span>
                  <span className="muted small">
                    {new Date(d.updatedAt).toLocaleString("zh-CN")}{" "}
                    改过，还没保存
                  </span>
                </button>
              ))}
            </div>
          )}
        </span>
      )}
    </>
  );
}
