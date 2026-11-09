import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CheckCheck,
  Eye,
  FolderOpen,
  Loader2,
  MessageSquare,
  Trash2,
  X,
} from "lucide-react";

import { ART } from "../assets/art";
import { MarkdownText } from "../chat/markdown";
import { Select } from "../ui/Select";
import {
  STAGING_QUERY_KEY,
  applyStaging,
  checkTarget,
  discardStaging,
  getStaging,
  readStagingContent,
  type StagingItem,
  type StagingSource,
} from "./api";
import "./staging.css";

/**
 * 临时区：所有待确认的 AI 产出，一处看、一套动作。
 *
 * 去处只有两个：**确认**（搬到正式位置）或**丢弃**。确认前把「会替换已有内容」的
 * 那几份单独点名，对话 / 智能体草稿的去处可以当场改。
 * 临时区里的东西不是事实依据——AI 下一轮读不到，确认后才算数。
 */

const SOURCE_LABEL: Record<StagingSource, string> = {
  chat: "对话",
  agent: "智能体",
  fill: "AI 补齐",
  presales: "售前",
};
const SOURCES: readonly StagingSource[] = ["chat", "agent", "fill", "presales"];
const ALL = "__all__";

export function StagingPage({
  onOpenSession,
  onOpenFolder,
}: {
  onOpenSession: (sessionId: string) => void;
  /** 去「事实底座 → 文件库」打开草稿所在文件夹（草稿是普通文件，可以先改再确认）。 */
  onOpenFolder: (folder: string, file: string) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const staging = useQuery({
    queryKey: STAGING_QUERY_KEY,
    queryFn: getStaging,
    refetchInterval: 15_000,
  });
  const [source, setSource] = useState<StagingSource | typeof ALL>(ALL);
  const [product, setProduct] = useState<string>(ALL);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState<StagingItem[] | null>(null);
  const [preview, setPreview] = useState<StagingItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const items = useMemo(() => staging.data?.items ?? [], [staging.data]);
  const products = useMemo(() => {
    const seen = new Map<string, string>();
    for (const i of items)
      seen.set(i.productId ?? "", i.productName ?? "未归属产品");
    return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [items]);
  const shown = items.filter(
    (i) =>
      (source === ALL || i.source === source) &&
      (product === ALL || (i.productId ?? "") === product),
  );
  const selected = shown.filter((i) => picked.has(i.key));
  const allPicked = shown.length > 0 && selected.length === shown.length;

  // 已经不在清单里的勾选（处理掉了、或在补齐页 / 售前页被处理了）不算数：
  // selected 只从当前显示的条目里取，失效的键自然不会被提交。

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: STAGING_QUERY_KEY });
    void queryClient.invalidateQueries({ queryKey: ["files"] });
    void queryClient.invalidateQueries({ queryKey: ["wiki"] });
    void queryClient.invalidateQueries({ queryKey: ["global-fill-run"] });
    void queryClient.invalidateQueries({ queryKey: ["presales"] });
  };

  const togglePick = (key: string): void => {
    const next = new Set(picked);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setPicked(next);
  };

  const apply = (
    list: StagingItem[],
    targets: ReadonlyMap<string, string>,
  ): void => {
    setBusy(true);
    setNotice(null);
    void applyStaging(
      list.map((i) => {
        const t = targets.get(i.key);
        return t === undefined ? { key: i.key } : { key: i.key, target: t };
      }),
    )
      .then((report) => {
        setConfirming(null);
        setNotice({
          ok: report.failed.length === 0,
          text: [
            `已确认 ${String(report.applied.length)} 份`,
            report.replaced.length > 0
              ? `其中替换了 ${String(report.replaced.length)} 份已有内容`
              : null,
            report.failed.length > 0
              ? `${String(report.failed.length)} 份没成功：${report.failed
                  .map((f) => `${f.title}（${f.why}）`)
                  .join("；")}`
              : null,
          ]
            .filter((x) => x !== null)
            .join("，"),
        });
        refresh();
      })
      .catch((cause: unknown) =>
        setNotice({
          ok: false,
          text: cause instanceof Error ? cause.message : "确认失败",
        }),
      )
      .finally(() => setBusy(false));
  };

  const discard = (list: StagingItem[]): void => {
    const what =
      list.length === 1
        ? `「${list[0]?.title ?? ""}」`
        : `${String(list.length)} 份`;
    if (
      !window.confirm(`丢弃${what}？临时区里的文件会被删除，正式位置不受影响。`)
    )
      return;
    setBusy(true);
    setNotice(null);
    void discardStaging(list.map((i) => i.key))
      .then((r) => {
        setNotice({ ok: true, text: `已丢弃 ${String(r.discarded)} 份` });
        refresh();
      })
      .catch((cause: unknown) =>
        setNotice({
          ok: false,
          text: cause instanceof Error ? cause.message : "丢弃失败",
        }),
      )
      .finally(() => setBusy(false));
  };

  if (staging.isLoading)
    return (
      <p className="muted small pad">
        <Loader2 size={14} className="spin" /> 加载…
      </p>
    );
  if (staging.isError)
    return (
      <p className="err-text small pad" role="alert">
        读不到临时区：{staging.error.message}
      </p>
    );

  const root = staging.data?.root ?? "/临时区";

  return (
    <div className="staging-page">
      <header className="staging-head">
        <p className="muted small">
          AI 的产出先放这里，你确认后才进正式位置；在这之前它们
          <strong>不算事实依据</strong>，AI 下一轮读不到。 文件都在{" "}
          <code>{root}</code>，可以先去文件库改，确认的就是改过的版本。
        </p>
      </header>

      {items.length === 0 ? (
        <div className="staging-empty">
          <img
            className="staging-empty-art"
            src={ART.staging.src}
            srcSet={ART.staging.srcSet}
            alt=""
            aria-hidden="true"
            width={180}
            height={180}
          />
          <h2>没有待确认的产出</h2>
          <p className="muted">
            对话里每条回答下方点「存到临时区」，或者让智能体写草稿、跑全局 AI
            补齐、让售前助手起草，产出都会出现在这里。
          </p>
        </div>
      ) : (
        <>
          <div className="staging-bar">
            <div className="seg" role="group" aria-label="按来源筛选">
              <button
                type="button"
                className={source === ALL ? "on" : undefined}
                aria-pressed={source === ALL}
                onClick={() => setSource(ALL)}
              >
                全部 {items.length}
              </button>
              {SOURCES.filter((s) => (staging.data?.counts[s] ?? 0) > 0).map(
                (s) => (
                  <button
                    key={s}
                    type="button"
                    className={source === s ? "on" : undefined}
                    aria-pressed={source === s}
                    onClick={() => setSource(s)}
                  >
                    {SOURCE_LABEL[s]} {staging.data?.counts[s] ?? 0}
                  </button>
                ),
              )}
            </div>
            {products.length > 1 && (
              <Select
                className="input sm"
                aria-label="按产品筛选"
                value={product}
                onChange={setProduct}
                options={[
                  { value: ALL, label: "全部产品" },
                  ...products.map(([id, name]) => ({ value: id, label: name })),
                ]}
              />
            )}
            <div className="staging-actions">
              <button
                type="button"
                className="btn primary"
                disabled={busy || selected.length === 0}
                onClick={() => setConfirming(selected)}
              >
                <CheckCheck size={14} />
                确认所选
                {selected.length > 0 ? `（${String(selected.length)}）` : ""}
              </button>
              <button
                type="button"
                className="btn ghost"
                disabled={busy || selected.length === 0}
                onClick={() => discard(selected)}
              >
                <Trash2 size={14} /> 丢弃所选
              </button>
            </div>
          </div>

          {notice !== null && (
            <p
              className={`small ${notice.ok ? "ok-text" : "err-text"}`}
              role={notice.ok ? "status" : "alert"}
            >
              {notice.text}
            </p>
          )}

          {shown.length === 0 ? (
            <p className="muted small">这个筛选下没有待确认的产出。</p>
          ) : (
            <table className="staging-table">
              <thead>
                <tr>
                  <th className="staging-check">
                    <input
                      type="checkbox"
                      aria-label="全选"
                      checked={allPicked}
                      onChange={() =>
                        setPicked(
                          allPicked
                            ? new Set()
                            : new Set(shown.map((i) => i.key)),
                        )
                      }
                    />
                  </th>
                  <th>产出</th>
                  <th>确认后去到</th>
                  <th className="staging-time">时间</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr
                    key={i.key}
                    className={picked.has(i.key) ? "picked" : undefined}
                  >
                    <td className="staging-check">
                      <input
                        type="checkbox"
                        aria-label={`选中 ${i.title}`}
                        checked={picked.has(i.key)}
                        onChange={() => togglePick(i.key)}
                      />
                    </td>
                    <td>
                      <div className="staging-title">
                        <span className={`staging-src ${i.source}`}>
                          {SOURCE_LABEL[i.source]}
                        </span>
                        <span className="staging-name">{i.title}</span>
                        {!i.exists && (
                          <span className="pill warn">文件已不在</span>
                        )}
                      </div>
                      <div className="muted small staging-meta">
                        {i.productName ?? "未归属产品"} · {i.origin}
                      </div>
                    </td>
                    <td>
                      {i.target === null ? (
                        <span className="muted small">确认时选择</span>
                      ) : (
                        <code className="staging-target">{i.target}</code>
                      )}
                      {i.willReplace && (
                        <span className="pill warn">会替换已有内容</span>
                      )}
                      {i.note !== null && (
                        <div className="muted small">{i.note}</div>
                      )}
                    </td>
                    <td className="staging-time muted small">
                      {new Date(i.createdAt).toLocaleString()}
                    </td>
                    <td className="staging-row-actions">
                      <button
                        type="button"
                        className="btn small primary"
                        aria-label={`确认 ${i.title}`}
                        title="确认：搬到正式位置，之后才算事实依据"
                        disabled={busy}
                        onClick={() => setConfirming([i])}
                      >
                        <Check size={13} /> 确认
                      </button>
                      <button
                        type="button"
                        className="btn small ghost staging-discard"
                        aria-label={`丢弃 ${i.title}`}
                        title="丢弃：删掉临时区里的这份，正式位置不受影响"
                        disabled={busy}
                        onClick={() => discard([i])}
                      >
                        <Trash2 size={13} /> 丢弃
                      </button>
                      <span className="staging-row-sep" aria-hidden="true" />
                      <button
                        type="button"
                        className="btn small ghost"
                        aria-label={`预览 ${i.title}`}
                        onClick={() => setPreview(i)}
                      >
                        <Eye size={13} /> 预览
                      </button>
                      <button
                        type="button"
                        className="btn small ghost"
                        aria-label={`在文件库打开 ${i.title}`}
                        title="去文件库打开（可以先改再确认）"
                        onClick={() =>
                          onOpenFolder(
                            i.draftPath.slice(
                              0,
                              i.draftPath.lastIndexOf("/"),
                            ) || "/",
                            i.draftPath,
                          )
                        }
                      >
                        <FolderOpen size={13} />
                      </button>
                      {i.sessionId !== null && (
                        <button
                          type="button"
                          className="btn small ghost"
                          aria-label={`看 ${i.title} 的对话`}
                          title="回到产出它的对话"
                          onClick={() => onOpenSession(i.sessionId ?? "")}
                        >
                          <MessageSquare size={13} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {confirming !== null && (
        <ConfirmDialog
          items={confirming}
          busy={busy}
          onCancel={() => setConfirming(null)}
          onConfirm={(targets) => apply(confirming, targets)}
        />
      )}
      {preview !== null && (
        <PreviewDialog
          item={preview}
          onClose={() => setPreview(null)}
          onDiscard={() => {
            setPreview(null);
            discard([preview]);
          }}
          onConfirm={() => {
            setPreview(null);
            setConfirming([preview]);
          }}
        />
      )}
    </div>
  );
}

/* ── 确认 ── */

type TargetCheck = { problem: string | null; exists: boolean } | "checking";

/**
 * 确认框：可改去处的逐条给输入框（现场校验能不能写、会不会替换），
 * 定死去处的列出来；会替换已有内容的单独点名。
 */
function ConfirmDialog({
  items,
  busy,
  onCancel,
  onConfirm,
}: {
  items: StagingItem[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: (targets: ReadonlyMap<string, string>) => void;
}): React.JSX.Element {
  const [targets, setTargets] = useState<ReadonlyMap<string, string>>(
    () =>
      new Map(
        items
          .filter((i) => i.targetEditable)
          .map((i) => [i.key, i.target ?? ""]),
      ),
  );
  const [checks, setChecks] = useState<ReadonlyMap<string, TargetCheck>>(
    new Map(),
  );

  // 去处一改就去服务端校验（防抖 300ms）：能不能写、会不会替换以服务端为准。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      for (const [key, path] of targets) {
        if (path.trim() === "") continue;
        setChecks((prev) => new Map(prev).set(key, "checking"));
        void checkTarget(path.trim())
          .then((r) => setChecks((prev) => new Map(prev).set(key, r)))
          .catch(() =>
            setChecks((prev) =>
              new Map(prev).set(key, { problem: "校验失败", exists: false }),
            ),
          );
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [targets]);

  const editable = items.filter((i) => i.targetEditable);
  const fixed = items.filter((i) => !i.targetEditable);
  const blocked = editable.some((i) => {
    const path = targets.get(i.key)?.trim() ?? "";
    const c = checks.get(i.key);
    return (
      path === "" || c === undefined || c === "checking" || c.problem !== null
    );
  });
  const replacing = [
    ...fixed.filter((i) => i.willReplace).map((i) => i.target ?? i.title),
    ...editable
      .filter((i) => {
        const c = checks.get(i.key);
        return c !== undefined && c !== "checking" && c.exists;
      })
      .map((i) => targets.get(i.key) ?? i.title),
  ];

  return (
    <div className="staging-overlay">
      <div className="staging-dialog" role="dialog" aria-label="确认入库">
        <header className="staging-dialog-head">
          <h2>确认 {items.length} 份产出？</h2>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            onClick={onCancel}
          >
            <X size={16} />
          </button>
        </header>
        <div className="staging-dialog-body">
          <p className="small">
            确认后从临时区搬到正式位置，之后才算事实依据。
          </p>
          {editable.length > 0 && (
            <div className="staging-targets">
              {editable.map((i) => {
                const c = checks.get(i.key);
                return (
                  <label key={i.key} className="field">
                    <span>
                      {i.title} <span className="muted small">→ 写到</span>
                    </span>
                    <input
                      className="input"
                      value={targets.get(i.key) ?? ""}
                      placeholder="如 /product-docs/products/xxx/prd/功能名.md"
                      onChange={(e) =>
                        setTargets((prev) =>
                          new Map(prev).set(i.key, e.target.value),
                        )
                      }
                    />
                    <span className="small staging-check-line">
                      {(targets.get(i.key)?.trim() ?? "") === "" ? (
                        <span className="err-text">
                          还没选去处：填一个文件路径
                        </span>
                      ) : c === undefined || c === "checking" ? (
                        <span className="muted">校验中…</span>
                      ) : c.problem !== null ? (
                        <span className="err-text">{c.problem}</span>
                      ) : c.exists ? (
                        <span className="staging-warn-text">
                          这里已有文件，会被替换
                        </span>
                      ) : (
                        <span className="ok-text">
                          新文件，不会覆盖任何内容
                        </span>
                      )}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          {fixed.length > 0 && (
            <ul className="staging-fixed small">
              {fixed.map((i) => (
                <li key={i.key}>
                  {i.title} → <code>{i.target ?? "（未知）"}</code>
                  {i.note !== null && (
                    <span className="muted"> · {i.note}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {replacing.length > 0 && (
            <div className="staging-warn">
              <strong>
                其中 {replacing.length} 份会替换已有内容（无法撤销）：
              </strong>
              <ul className="small">
                {replacing.map((t) => (
                  <li key={t}>
                    <code>{t}</code>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <footer className="staging-dialog-foot">
          <button
            type="button"
            className="btn ghost"
            disabled={busy}
            onClick={onCancel}
          >
            取消
          </button>
          <button
            type="button"
            className={`btn ${replacing.length > 0 ? "danger" : "primary"}`}
            disabled={busy || blocked}
            onClick={() =>
              onConfirm(
                new Map([...targets].map(([k, v]) => [k, v.trim()] as const)),
              )
            }
          >
            {busy && <Loader2 size={14} className="spin" />}
            {replacing.length > 0 ? "确认并替换" : "确认"}
          </button>
        </footer>
      </div>
    </div>
  );
}

/* ── 预览 ── */

function PreviewDialog({
  item,
  onClose,
  onDiscard,
  onConfirm,
}: {
  item: StagingItem;
  onClose: () => void;
  onDiscard: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  const content = useQuery({
    queryKey: ["staging-content", item.key],
    queryFn: () => readStagingContent(item.key),
    gcTime: 0,
  });
  return (
    <div
      className="staging-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="staging-dialog wide" role="dialog" aria-label="预览">
        <header className="staging-dialog-head">
          <div>
            <h2>{item.title}</h2>
            <p className="muted small">
              {item.origin} · <code>{item.draftPath}</code>
            </p>
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="staging-dialog-body">
          {content.isLoading ? (
            <p className="muted small">
              <Loader2 size={14} className="spin" /> 读取…
            </p>
          ) : content.isError ? (
            <p className="err-text small">读不到：{content.error.message}</p>
          ) : content.data?.content == null ? (
            <p className="muted small">
              这份文件不是文本（如 PPT /
              Word）或太大，没法在这里预览。去文件库或售前页打开它。
            </p>
          ) : (
            <div className="staging-preview md">
              <MarkdownText text={content.data.content} streaming={false} />
            </div>
          )}
        </div>
        <footer className="staging-dialog-foot">
          <button type="button" className="btn ghost" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="btn ghost staging-discard"
            onClick={onDiscard}
          >
            <Trash2 size={14} /> 丢弃
          </button>
          <button type="button" className="btn primary" onClick={onConfirm}>
            <CheckCheck size={14} /> 确认这份
          </button>
        </footer>
      </div>
    </div>
  );
}
