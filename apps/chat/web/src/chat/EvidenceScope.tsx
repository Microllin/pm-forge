import { useEffect, useRef, useState } from "react";
import { FileSearch } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { loadSessionEvidence, setSessionEvidenceScope } from "../api";

/**
 * 「依据范围」：输入框上方的一行小字。
 *
 * AI 每轮取依据默认在**整个依据库**里定位；这里让使用者勾几个目录把范围缩小，
 * 从下一条消息起生效。不勾 = 整个依据库——这是默认，也是绝大多数场景该用的，
 * 所以平时只是一行小字，不改对话页的布局（输入框位置、对话列宽度都不动）。
 *
 * 不属于任何产品的对话不显示：那里没有依据库可选。
 */

const KIND_CN = { doc: "文档", code: "代码" } as const;

export function EvidenceScope({
  sessionId,
}: {
  sessionId: string;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const key = ["session-evidence", sessionId];
  const evidence = useQuery({
    queryKey: key,
    queryFn: () => loadSessionEvidence(sessionId),
  });
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const data = evidence.data;
  if (data?.productName == null) return null;

  const total = data.sources.length;
  const base =
    total === 0
      ? `依据：「${data.productName}」还没绑定事实依据`
      : data.scope.length === 0
        ? `依据：${data.productName} · 整个依据库（${String(total)} 处）`
        : `依据：${data.productName} · 已限定 ${String(data.scope.length)} 处`;
  // 找不到的要一眼看见：否则人会以为 AI 读过它。
  const summary =
    data.missing.length > 0
      ? `${base} · ${String(data.missing.length)} 处找不到`
      : base;

  const save = (next: string[]): void => {
    setSaving(true);
    setError(null);
    void setSessionEvidenceScope(sessionId, next)
      .then(() => queryClient.invalidateQueries({ queryKey: key }))
      .then(() => {
        setOpen(false);
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "保存失败");
      })
      .finally(() => {
        setSaving(false);
      });
  };

  return (
    <div className="evidence-scope" ref={wrapRef}>
      <button
        type="button"
        className="evidence-chip"
        disabled={total === 0}
        title={
          total === 0
            ? "去产品里绑定文档目录 / 代码目录 / 参考资料，AI 才有依据可读"
            : "每条消息发出前，平台会从这里挑出相关文件连正文一起交给 AI；可以手动缩小范围"
        }
        onClick={() => {
          setPicked(new Set(data.scope));
          setOpen((v) => !v);
        }}
      >
        <FileSearch size={12} /> {summary}
      </button>
      {open && (
        <div className="evidence-pop" role="dialog" aria-label="依据范围">
          <p className="evidence-hint">
            不勾 =
            在整个依据库里找。勾选后只在选中的地方找，从下一条消息起生效。
          </p>
          <ul>
            {data.sources.map((s) => (
              <li key={s.path}>
                <label>
                  <input
                    type="checkbox"
                    checked={picked.has(s.path)}
                    onChange={(event) => {
                      const next = new Set(picked);
                      if (event.target.checked) next.add(s.path);
                      else next.delete(s.path);
                      setPicked(next);
                    }}
                  />
                  <span className="evidence-kind">{KIND_CN[s.kind]}</span>
                  <span className="evidence-label">{s.label}</span>
                  <span className="evidence-path">{s.path}</span>
                </label>
              </li>
            ))}
            {data.missing.map((p) => (
              <li key={p} className="is-missing">
                <label title="绑定了但文件库里找不到，AI 读不到它。去产品里修正绑定。">
                  <input type="checkbox" disabled />
                  <span className="evidence-kind">缺失</span>
                  <span className="evidence-label">找不到</span>
                  <span className="evidence-path">{p}</span>
                </label>
              </li>
            ))}
          </ul>
          {error !== null && <p className="evidence-error">{error}</p>}
          <div className="evidence-actions">
            <button
              type="button"
              className="btn"
              disabled={saving}
              onClick={() => {
                save([]);
              }}
            >
              用整个依据库
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={saving || picked.size === 0}
              onClick={() => {
                save([...picked]);
              }}
            >
              只用勾选的
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
