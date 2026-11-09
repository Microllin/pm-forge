import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  FileText,
  Loader2,
  Save,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import { ApiError, listSessions } from "../api";
import { ChatView } from "../chat/ChatView";
import { MarkdownText } from "../chat/markdown";
import { stripFrontmatter } from "../skills/skill-file";
import { diffLines, diffStat, foldUnchanged } from "./diff";
import {
  discardForge,
  forgeKey,
  getForgeDraft,
  KIND_LABEL,
  openForge,
  putForgeFile,
  saveForge,
  type ForgeDraft,
  type ForgeKind,
  type ForgeMode,
} from "./forge-api";
import "./forge.css";

/**
 * AI 工坊：左边和 AI 对话，右边看草稿（对比 / 预览 / 手改），人点保存才进库。
 *
 * 三个入口共用这一个界面（用户拍板的三种能力）：
 * - 新建：空草稿开场，AI 先问清再起草；
 * - 修改：载入现有定义，默认看「改动前后」——人审的是改了什么，不是全文；
 * - 沉淀：自动发出「扫描历史」，AI 列候选、人挑一个再起草。
 *
 * 工坊会话不进对话列表；没保存的草稿从页面上的「AI 草稿」找回。
 */

export type ForgeStart =
  | { mode: ForgeMode; name?: string }
  /** 接着上次没保存完的草稿。 */
  | { sessionId: string };

const STARTERS: Record<ForgeKind, Record<"create" | "edit", string[]>> = {
  skill: {
    create: [
      "我想要一个写竞品分析的技能：先问清对标对象和决策问题，再按固定框架输出。",
      "做一个评审 PRD 的技能，按完整性、可验收、风险三方面挑问题。",
    ],
    edit: [
      "description 写得更容易被选中：补上用户常说的触发词。",
      "按标准写法检查一遍，列出不合规的地方，先别改。",
    ],
  },
  agent: {
    create: [
      "我想要一个竞品定价侦察员：联网查定价，交回带来源的对比表。",
      "做一个需求评审员：读 PRD 和代码现状，挑出说不清、做不到的地方。",
    ],
    edit: [
      "工具权限按最小够用收紧一下，说明为什么。",
      "交回格式改成：结论 / 明细 / 风险 / 待确认。",
    ],
  },
};

export function ForgeStudio({
  kind,
  start,
  onClose,
  onSaved,
}: {
  kind: ForgeKind;
  start: ForgeStart;
  onClose: () => void;
  onSaved: (name: string) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<{
    id: string;
    kickoff: string | null;
    fresh: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = KIND_LABEL[kind];

  // 开工：新开或接上已有的草稿。start 只在挂载时读一次（换入口会整个重挂）。
  const startRef = useRef(start);
  useEffect(() => {
    let alive = true;
    const s = startRef.current;
    const opened =
      "sessionId" in s
        ? Promise.resolve({
            sessionId: s.sessionId,
            reused: true,
            kickoff: null,
          })
        : openForge({
            kind,
            mode: s.mode,
            ...(s.name === undefined ? {} : { name: s.name }),
          });
    opened
      .then((r) => {
        if (alive)
          setSession({ id: r.sessionId, kickoff: r.kickoff, fresh: !r.reused });
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : "打不开工坊");
      });
    return () => {
      alive = false;
    };
  }, [kind]);

  // AI 在改：草稿跟着刷；它停下时再刷一次收尾。
  const sessions = useQuery({
    queryKey: ["sessions"],
    queryFn: listSessions,
    refetchInterval: 2000,
    enabled: session !== null,
  });
  const streaming =
    session !== null &&
    (sessions.data ?? []).some((s) => s.id === session.id && s.streaming);
  const draft = useQuery({
    queryKey: forgeKey(session?.id ?? ""),
    queryFn: () => getForgeDraft(session?.id ?? ""),
    enabled: session !== null,
    refetchInterval: streaming ? 1500 : false,
  });
  const was = useRef(false);
  useEffect(() => {
    if (streaming) was.current = true;
    else if (was.current) {
      was.current = false;
      void draft.refetch();
    }
  }, [streaming, draft]);

  const mode: ForgeMode =
    draft.data?.mode ?? ("sessionId" in start ? "create" : start.mode);
  const title =
    draft.data?.target !== null && draft.data?.target !== undefined
      ? `AI 修改${label} · ${draft.data.name ?? draft.data.target}`
      : mode === "distill"
        ? `从历史沉淀${label}`
        : `AI 新建${label}${draft.data?.name ? ` · ${draft.data.name}` : ""}`;

  const [starter, setStarter] = useState<{ id: number; text: string }>();
  const [spoke, setSpoke] = useState(false);
  const starters =
    session?.fresh === true && !spoke && mode !== "distill"
      ? STARTERS[kind][mode === "edit" ? "edit" : "create"]
      : [];

  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const save = async (force = false): Promise<void> => {
    if (session === null) return;
    setSaving(true);
    setNotice(null);
    try {
      const r = await saveForge(session.id, force);
      queryClient.setQueryData(forgeKey(session.id), {
        ...r.draft,
        stale: false,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [`${kind}s`] }),
        queryClient.invalidateQueries({ queryKey: [kind, r.name] }),
      ]);
      onSaved(r.name);
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        window.confirm(e.message)
      ) {
        setSaving(false);
        await save(true);
        return;
      }
      setNotice({
        ok: false,
        text: e instanceof Error ? e.message : "保存失败",
      });
    } finally {
      setSaving(false);
    }
  };

  const discard = async (): Promise<void> => {
    if (session === null) return onClose();
    if (
      draft.data?.dirty === true &&
      !window.confirm(
        "放弃这份草稿？AI 的修改和这段对话都会删掉，库里的原件不受影响。",
      )
    )
      return;
    await discardForge(session.id).catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: ["forge-drafts", kind] });
    onClose();
  };

  const d = draft.data;
  const canSave =
    d !== undefined &&
    !streaming &&
    d.problems.errors.length === 0 &&
    (d.dirty || d.target === null);

  return (
    <div className="forge-overlay" role="dialog" aria-label={title}>
      <div className="forge">
        <header className="forge-head">
          <span className="forge-avatar" aria-hidden="true">
            <Sparkles size={15} />
          </span>
          <div className="forge-title">
            <strong>{title}</strong>
            <span className="muted small">
              {streaming
                ? "AI 正在改草稿…"
                : `草稿只存在工坊里，点「保存到${label}库」才生效`}
            </span>
          </div>
          <span className="row gap">
            <button
              type="button"
              className="btn primary"
              disabled={!canSave || saving}
              title={
                d?.problems.errors.length
                  ? "草稿还有问题，先修掉"
                  : d !== undefined && !d.dirty && d.target !== null
                    ? "没有改动"
                    : undefined
              }
              onClick={() => void save()}
            >
              {saving ? (
                <Loader2 size={13} className="spin" />
              ) : (
                <Save size={13} />
              )}{" "}
              保存到{label}库
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => void discard()}
              title="删掉草稿和这段工坊对话"
            >
              <Trash2 size={13} /> 放弃
            </button>
            <button
              type="button"
              className="btn ghost icon"
              aria-label="关闭工坊"
              title="关闭（草稿保留，可从「AI 草稿」找回）"
              onClick={() => {
                void queryClient.invalidateQueries({
                  queryKey: ["forge-drafts", kind],
                });
                onClose();
              }}
            >
              <X size={15} />
            </button>
          </span>
        </header>
        {notice !== null && (
          <p className={`forge-notice ${notice.ok ? "ok-text" : "err-text"}`}>
            {notice.text}
          </p>
        )}

        <div className="forge-body">
          <section className="forge-chat" aria-label="和 AI 对话">
            {starters.length > 0 && (
              <div className="forge-starters">
                <span className="muted small">
                  {mode === "edit"
                    ? "用大白话说要改什么，比如："
                    : `说说你想要什么样的${label}，比如：`}
                </span>
                {starters.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="presales-agent-chip"
                    onClick={() => {
                      setSpoke(true);
                      setStarter({ id: Date.now(), text: t });
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}
            {error !== null ? (
              <p className="err-text pad">{error}</p>
            ) : session === null ? (
              <p className="muted small pad">
                <Loader2 size={14} className="spin" /> 打开工坊…
              </p>
            ) : (
              <ChatView
                key={session.id}
                sessionId={session.id}
                autoSend={
                  session.fresh ? (session.kickoff ?? undefined) : undefined
                }
                onAutoSent={() =>
                  setSession((s) => (s === null ? s : { ...s, kickoff: null }))
                }
                outbox={starter}
                onOutboxSent={() => {
                  setSpoke(true);
                  setStarter(undefined);
                }}
              />
            )}
          </section>
          <section className="forge-draft" aria-label="草稿">
            {d === undefined ? (
              <p className="muted small pad">
                <Loader2 size={14} className="spin" /> 读取草稿…
              </p>
            ) : (
              <DraftPane
                draft={d}
                kind={kind}
                locked={streaming}
                onChanged={(next) =>
                  queryClient.setQueryData(forgeKey(d.sessionId), {
                    ...next,
                    stale: d.stale,
                  })
                }
              />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

type View = "diff" | "preview" | "source";

const MAIN: Record<ForgeKind, string> = {
  skill: "SKILL.md",
  agent: "AGENT.md",
};

function DraftPane({
  draft,
  kind,
  locked,
  onChanged,
}: {
  draft: ForgeDraft;
  kind: ForgeKind;
  /** AI 正在写：先别手改，免得两边互相覆盖。 */
  locked: boolean;
  onChanged: (next: ForgeDraft) => void;
}): React.JSX.Element {
  const main = MAIN[kind];
  /** 草稿里的文件 + 已删掉的（对比里要看得到「删了」）。主文件排第一。 */
  const paths = useMemo(() => {
    const all = new Set([
      ...Object.keys(draft.files),
      ...Object.keys(draft.base),
    ]);
    return [...all].sort((a, b) =>
      a === main ? -1 : b === main ? 1 : a.localeCompare(b),
    );
  }, [draft.files, draft.base, main]);
  const [picked, setPicked] = useState(main);
  const path = paths.includes(picked) ? picked : (paths[0] ?? main);
  const [view, setView] = useState<View>(
    draft.target === null ? "preview" : "diff",
  );

  const before = draft.base[path] ?? "";
  const after = draft.files[path];
  const empty = Object.keys(draft.files).length === 0;

  return (
    <div className="forge-draft-inner">
      <Problems draft={draft} />
      {empty ? (
        <div className="center">
          <div className="empty">
            <FileText size={22} className="faint-icon" />
            <h3>草稿还是空的</h3>
            <p className="muted small">
              在左边和 AI 说说你的想法，它起草后会出现在这里。
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="forge-tabs" role="tablist" aria-label="草稿文件">
            {paths.map((p) => (
              <FileTab
                key={p}
                path={p}
                active={p === path}
                before={draft.base[p]}
                after={draft.files[p]}
                onPick={() => setPicked(p)}
              />
            ))}
          </div>
          <div className="forge-views">
            {(["diff", "preview", "source"] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={`link-btn${view === v ? " on" : ""}`}
                aria-pressed={view === v}
                onClick={() => setView(v)}
              >
                {v === "diff" ? "改动前后" : v === "preview" ? "预览" : "手改"}
              </button>
            ))}
          </div>
          <div className="forge-view">
            {after === undefined ? (
              <p className="muted small pad">
                这个文件在草稿里已删除，保存后会从库里删掉。
              </p>
            ) : view === "diff" ? (
              <DiffView
                before={before}
                after={after}
                isNew={draft.base[path] === undefined}
              />
            ) : view === "preview" ? (
              <section className="skill-md">
                <MarkdownText
                  text={
                    path.endsWith(".md")
                      ? stripFrontmatter(after)
                      : `\`\`\`\n${after}\n\`\`\``
                  }
                  streaming={false}
                />
              </section>
            ) : (
              <SourceEditor
                key={`${draft.sessionId}:${path}`}
                sessionId={draft.sessionId}
                path={path}
                value={after}
                locked={locked}
                onChanged={onChanged}
              />
            )}
          </div>
        </>
      )}
      {draft.locked.length > 0 && (
        <p className="muted small">
          这些文件是二进制或过大，工坊不改、原样保留：{draft.locked.join("、")}
        </p>
      )}
    </div>
  );
}

function Problems({ draft }: { draft: ForgeDraft }): React.JSX.Element | null {
  const { errors, warnings } = draft.problems;
  const empty = Object.keys(draft.files).length === 0;
  if (!draft.stale && (empty || (errors.length === 0 && warnings.length === 0)))
    return null;
  return (
    <div className="forge-problems">
      {draft.stale && (
        <p className="warn-text small">
          <TriangleAlert size={12} />{" "}
          原件在你编辑期间被别处改过，保存会覆盖那次修改（保存时会再确认一次）。
        </p>
      )}
      {!empty &&
        errors.map((e) => (
          <p key={e} className="err-text small">
            <X size={12} /> {e}
          </p>
        ))}
      {!empty &&
        warnings.map((w) => (
          <p key={w} className="warn-text small">
            <TriangleAlert size={12} /> {w}
          </p>
        ))}
    </div>
  );
}

function FileTab({
  path,
  active,
  before,
  after,
  onPick,
}: {
  path: string;
  active: boolean;
  before: string | undefined;
  after: string | undefined;
  onPick: () => void;
}): React.JSX.Element {
  const stat = useMemo(
    () =>
      after === undefined || before === undefined || before === after
        ? null
        : diffStat(diffLines(before, after)),
    [before, after],
  );
  const state =
    after === undefined
      ? "已删"
      : before === undefined
        ? "新增"
        : stat === null
          ? ""
          : `+${String(stat.added)} −${String(stat.removed)}`;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={`forge-tab${active ? " active" : ""}${after === undefined ? " gone" : ""}`}
      onClick={onPick}
    >
      {path}
      {state !== "" && <span className="forge-tab-stat">{state}</span>}
    </button>
  );
}

function DiffView({
  before,
  after,
  isNew,
}: {
  before: string;
  after: string;
  isNew: boolean;
}): React.JSX.Element {
  const blocks = useMemo(
    () => foldUnchanged(diffLines(before, after)),
    [before, after],
  );
  const [open, setOpen] = useState<Set<number>>(new Set());
  if (before === after)
    return <p className="muted small pad">这个文件没有改动。</p>;
  return (
    <div className="forge-diff" aria-label="改动前后">
      {isNew && <p className="muted small">新文件，整份都是新增。</p>}
      {blocks.map((b, i) =>
        b.type === "fold" && !open.has(i) ? (
          <button
            key={i}
            type="button"
            className="forge-diff-fold"
            onClick={() => setOpen((s) => new Set(s).add(i))}
          >
            … {b.count} 行没改，点开看 …
          </button>
        ) : (
          b.lines.map((l, j) => (
            <div
              key={`${String(i)}-${String(j)}`}
              className={`forge-diff-line ${l.type}`}
            >
              <span className="forge-diff-mark" aria-hidden="true">
                {l.type === "add" ? "+" : l.type === "del" ? "−" : " "}
              </span>
              <span>{l.text === "" ? " " : l.text}</span>
            </div>
          ))
        ),
      )}
    </div>
  );
}

/** 手改：失焦即存进草稿（不进库）。AI 在写时只读。 */
function SourceEditor({
  sessionId,
  path,
  value,
  locked,
  onChanged,
}: {
  sessionId: string;
  path: string;
  value: string;
  locked: boolean;
  onChanged: (next: ForgeDraft) => void;
}): React.JSX.Element {
  const [text, setText] = useState(value);
  const [state, setState] = useState<"idle" | "saving" | "error">("idle");
  // AI 改了草稿、而人这边没有未存的改动时，跟上最新内容。
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setText(value);
  }, [value]);
  const flush = (): void => {
    if (!dirty.current) return;
    setState("saving");
    putForgeFile(sessionId, path, text)
      .then((next) => {
        dirty.current = false;
        setState("idle");
        onChanged(next);
      })
      .catch(() => setState("error"));
  };
  return (
    <div className="forge-source">
      <textarea
        className="skill-editor"
        aria-label={`手改 ${path}`}
        spellCheck={false}
        readOnly={locked}
        value={text}
        onChange={(e) => {
          dirty.current = true;
          setText(e.target.value);
        }}
        onBlur={flush}
      />
      <span className="muted small">
        {locked
          ? "AI 正在改，等它停下再手改。"
          : state === "saving"
            ? "存进草稿…"
            : state === "error"
              ? "没存上，再试一次（失焦即存）"
              : "改完点别处即存进草稿；AI 下一轮会看到你的修改。"}
      </span>
    </div>
  );
}
