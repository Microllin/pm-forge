import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, ScanSearch, TriangleAlert, X } from "lucide-react";

import { createRequest, json } from "../http";
import { FolderPicker } from "../analysis/FolderPicker";

/**
 * 「AI 识别导入」对话框。
 *
 * ## 为什么不做目录映射
 *
 * 真实的售前材料堆是：一个大文件夹里散着几百个文件，命名不统一、旧版本和新版本
 * 混在一起、有的还埋在子目录里。按「哪个目录对应哪类材料」去猜，在这种堆里必然
 * 出错。所以交给模型看**文件清单**（路径 + 修改时间 + 大小），让它判每类材料该用
 * 哪一份、哪一版最新。
 *
 * ## 两段式：识别 → 确认
 *
 * 识别结果只落成**候选**，人逐条看过、改过才入库。AI 把「报价单-对内」认成
 * 「对外版」发出去的代价，远高于多点几下确认。
 */
const api = createRequest("/api");

export interface Candidate {
  id: string;
  slotId: string;
  slotTitle: string;
  filePath: string;
  fileName: string;
  fileSize: number;
  fileModifiedAt: number;
  confidence: "high" | "medium" | "low";
  reason: string;
  alternates: { filePath: string; reason: string }[];
  status: "pending" | "accepted" | "rejected";
  versionId: string | null;
}

const CONFIDENCE: Record<Candidate["confidence"], string> = {
  high: "高",
  medium: "中",
  low: "低",
};

const fmtSize = (bytes: number): string => {
  if (bytes < 1024 * 1024)
    return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export function ImportDialog({
  libId,
  onClose,
  onDone,
}: {
  libId: string;
  onClose: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [picking, setPicking] = useState(true);
  const [folder, setFolder] = useState<string | null>(null);
  const [phase, setPhase] = useState<"idle" | "asking" | "loading" | "review">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [unknown, setUnknown] = useState<string[]>([]);

  const run = async (path: string): Promise<void> => {
    setFolder(path);
    setPicking(false);
    setPhase("asking");
    setError(null);
    try {
      // 第一步：建会话 + 拿提示词。
      const started = await api<{
        sessionId: string;
        prompt: string;
        stats: { files: number; total: number; truncated: boolean };
      }>(`/presales/${libId}/recognize`, {
        method: "POST",
        ...json({ folderPath: path }),
      });
      setPhase("loading");
      // 第二步：把提示词真的发给模型（走对话那条现成的流式通道，答完才 resolve）。
      const res = await fetch(`/api/sessions/${started.sessionId}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: started.prompt }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(
          text === "" ? `模型请求失败（${String(res.status)}）` : text,
        );
      }
      // 流式响应要读完，否则会话那一轮还挂在那儿。
      await res.text();
      // 第三步：取结果、落成候选。
      const result = await api<{ candidates: Candidate[]; unknown: string[] }>(
        `/presales/recognize/${started.sessionId}`,
        { method: "POST", ...json({}) },
      );
      setCandidates(result.candidates);
      setUnknown(result.unknown);
      setPhase("review");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "识别失败");
      setPhase("idle");
    }
  };

  const decide = (id: string, accept: boolean): void => {
    setError(null);
    void api<unknown>(
      `/presales/candidates/${id}/${accept ? "accept" : "skip"}`,
      { method: "POST", ...json(accept ? {} : {}) },
    )
      .then(async () => {
        const next = await api<{ candidates: Candidate[] }>(
          `/presales/${libId}/candidates`,
        );
        setCandidates(next.candidates);
        if (accept) onDone();
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "操作失败");
      });
  };

  const pending = candidates.filter((c) => c.status === "pending");
  const accepted = candidates.filter((c) => c.status === "accepted");

  return (
    <div className="presales-scrim" role="dialog" aria-modal="true">
      <div className="presales-import">
        <header className="presales-import-head">
          <h3>AI 识别导入</h3>
          <button
            className="presales-icon-btn"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={15} />
          </button>
        </header>

        {picking ? (
          <FolderPicker
            title="选择要识别的文件夹"
            hint="选个大文件夹就行，里面零散文件和子目录都可以。AI 会从清单里挑出每类材料最合适、最新的一版。"
            submitLabel="从这个范围识别"
            onPick={run}
            onClose={onClose}
          />
        ) : (
          <div className="presales-import-body">
            <p className="muted small">
              范围 <code>{folder ?? ""}</code>
              {phase === "asking" && " · 正在准备提示词…"}
              {phase === "loading" && " · AI 正在挑文件，可能要一会儿…"}
              {phase === "review" &&
                ` · 识别出 ${String(pending.length)} 条待确认` +
                  (accepted.length > 0
                    ? `，已入库 ${String(accepted.length)} 条`
                    : "")}
            </p>

            {(phase === "asking" || phase === "loading") && (
              <p className="presales-import-wait">
                <Loader2 size={15} className="spin" />
                {phase === "asking" ? "准备中…" : "AI 正在读文件清单并挑选…"}
              </p>
            )}

            {error !== null && (
              <p className="presales-error">
                <TriangleAlert size={13} /> {error}
              </p>
            )}

            {unknown.length > 0 && (
              <p className="presales-import-warn">
                有 {unknown.length} 项 AI
                提到、但库里对不上（可能是缺了某类材料的条目）：
                <code>{unknown.slice(0, 5).join("、")}</code>
                {unknown.length > 5 ? "…" : ""}
              </p>
            )}

            {phase === "review" && candidates.length === 0 && (
              <p className="muted small pad">
                这次没挑出任何材料。换个范围再试，或者在这个范围里确实还没有可用文件。
              </p>
            )}

            {candidates.length > 0 && (
              <ul className="presales-candidates">
                {candidates.map((c) => (
                  <li key={c.id} className={`presales-candidate ${c.status}`}>
                    <div className="presales-candidate-main">
                      <b>{c.slotTitle}</b>
                      <span
                        className={`pill ${c.confidence === "high" ? "ok" : "warn"}`}
                      >
                        把握 {CONFIDENCE[c.confidence]}
                      </span>
                      {c.status === "accepted" && (
                        <span className="pill ok">已入库</span>
                      )}
                      {c.status === "rejected" && (
                        <span className="pill">已忽略</span>
                      )}
                    </div>
                    <code
                      className="presales-candidate-file"
                      title={c.filePath}
                    >
                      {c.fileName}
                    </code>
                    <span className="muted small">
                      {fmtSize(c.fileSize)} ·{" "}
                      {new Date(c.fileModifiedAt).toLocaleDateString("zh-CN")}
                    </span>
                    {c.reason !== "" && (
                      <p className="muted small presales-candidate-why">
                        {c.reason}
                      </p>
                    )}
                    {c.alternates.length > 0 && (
                      <details className="presales-candidate-alts">
                        <summary>另有 {c.alternates.length} 个备选</summary>
                        <ul>
                          {c.alternates.map((a) => (
                            <li key={a.filePath}>
                              <code>{a.filePath}</code>
                              {a.reason !== "" && (
                                <span className="muted small">
                                  {" "}
                                  · {a.reason}
                                </span>
                              )}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                    {c.status === "pending" && (
                      <div className="presales-actions">
                        <button
                          className="btn primary"
                          onClick={() => {
                            decide(c.id, true);
                          }}
                        >
                          确认入库
                        </button>
                        <button
                          className="btn ghost"
                          onClick={() => {
                            decide(c.id, false);
                          }}
                        >
                          忽略
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="presales-import-foot">
              <button
                className="btn"
                onClick={() => {
                  setPicking(true);
                  setPhase("idle");
                  setCandidates([]);
                  setUnknown([]);
                  setError(null);
                }}
              >
                <ScanSearch size={13} /> 换个范围重新识别
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  void queryClient.invalidateQueries({
                    queryKey: ["presales"],
                  });
                  onClose();
                }}
              >
                完成
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
