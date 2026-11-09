import { existsSync } from "node:fs";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import {
  parseAgentDefinition,
  requireAgentMeta,
  type AgentStore,
} from "./agents.js";
import type { Db } from "./db.js";
import { HttpError, badRequest, conflict, notFound } from "./errors.js";
import {
  KIND_LABEL,
  distillKickoff,
  forgeSystemPrompt,
  type ForgeKind,
  type ForgeMode,
} from "./forge-prompts.js";
import { historyToUiMessages } from "./pi/history.js";
import type { SessionProfile } from "./pi/runner.js";
import type { SessionRow, SessionStore } from "./sessions.js";
import { parseFrontmatter, requireMeta, type SkillStore } from "./skills.js";

export type { ForgeKind, ForgeMode };

/**
 * AI 工坊：让 AI 新建 / 修改技能与智能体，或从历史对话里沉淀出来。
 *
 * 设计取舍：
 * - **工坊是一条真会话**（task.kind = "forge"），和售前助手同一套：换掉身份说明、
 *   开一组只对它开放的工具。三种入口（新建 / 修改 / 沉淀）只是开场不同。
 * - **草稿与正式库分开**：AI 只能写 forge_drafts 里的草稿，人点「保存」才写进库。
 *   这是 agent-team.md 里「AI 不直接改正式内容」的同一条线。
 * - **草稿存全文、不存补丁**：人在右侧也能直接手改，AI 下一轮 draft_view 就能看到；
 *   对比视图拿 base（开工时的快照）与当前草稿现算，不依赖 AI 自述改了什么。
 * - **保存前查「原件有没有被别人改过」**：开工后有人在技能页手改过，直接覆盖会悄悄丢掉
 *   那次修改，所以先拒、给人看清再决定覆盖。
 * - **工坊会话不进对话列表、也不被翻历史扫到**（前端过滤 + 这里的 SQL 排除）：
 *   否则「沉淀」会把自己的工坊过程当成素材，越沉淀越乱。
 *
 * 表由本模块自建（IF NOT EXISTS），不进 db.ts 的序号迁移——原因见 agent-team/runs.ts 顶注。
 */

export const FORGE_MIGRATION = `
  CREATE TABLE IF NOT EXISTS forge_drafts (
    session_id  TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    mode        TEXT NOT NULL,
    target      TEXT,
    base        TEXT NOT NULL DEFAULT '{}',
    files       TEXT NOT NULL DEFAULT '{}',
    locked      TEXT NOT NULL DEFAULT '[]',
    saved_name  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS forge_drafts_target_idx ON forge_drafts(kind, target, updated_at);
`;

/** 智能体草稿里那份定义的固定文件名（保存时按 frontmatter 的 name 存成 <name>.md）。 */
export const AGENT_FILE = "AGENT.md";
export const SKILL_FILE = "SKILL.md";
const MAX_FILES = 50;
const MAX_FILE_BYTES = 512 * 1024;
/** history_read 一次交回的上限；更长的分页读。 */
const READ_PAGE = 30_000;
/** promptExtra 里直接附上全文的阈值；更大的只列清单，让 AI 自己 draft_view。 */
const INLINE_DRAFT = 8_000;

type Files = Record<string, string>;

export interface DraftProblems {
  /** 保存会失败的问题。 */
  errors: string[];
  /** 能保存，但多半不是人想要的（工具名不认识、技能不存在等）。 */
  warnings: string[];
}

export interface ForgeDraft {
  sessionId: string;
  kind: ForgeKind;
  mode: ForgeMode;
  /** 改的是哪个现有定义；null = 新建（还没保存过）。 */
  target: string | null;
  /** 开工（或上次保存）时的快照：对比视图的左边。 */
  base: Files;
  files: Files;
  /** 二进制或超大的附属文件：工坊不碰，原样保留。 */
  locked: string[];
  savedName: string | null;
  /** 草稿与 base 有没有差别。 */
  dirty: boolean;
  problems: DraftProblems;
  /** 草稿里的 name（从 frontmatter 读），界面标题用。 */
  name: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RawDraft {
  session_id: string;
  kind: ForgeKind;
  mode: ForgeMode;
  target: string | null;
  base: string;
  files: string;
  locked: string;
  saved_name: string | null;
  created_at: number;
  updated_at: number;
}

export interface ToolCatalogEntry {
  name: string;
  label: string;
  level: string;
  summary: string;
}

export interface ForgeDeps {
  db: Db;
  store: SessionStore;
  skills: SkillStore;
  agents?: AgentStore | undefined;
  newHeader: () => unknown;
  /** 平台工具注册表（给智能体选 tools 用）。 */
  toolCatalog: () => ToolCatalogEntry[];
  cwd: string;
  now?: () => number;
}

export interface Forge {
  profile(session: SessionRow): SessionProfile | undefined;
}

const parseJson = <T>(raw: string, fallback: T): T => {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

const without = (files: Files, path: string): Files =>
  Object.fromEntries(Object.entries(files).filter(([p]) => p !== path));

const sameFiles = (a: Files, b: Files): boolean => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

const text = (
  t: string,
): { content: { type: "text"; text: string }[]; details: undefined } => ({
  content: [{ type: "text", text: t }],
  details: undefined,
});
const done = (t: string): Promise<ReturnType<typeof text>> =>
  Promise.resolve(text(t));
const asTool = (t: unknown): ToolDefinition => t as ToolDefinition;

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** 草稿内的路径：相对、无 ..、不以点开头的段（.DS_Store、.git 不该出现在技能里）。 */
export function checkDraftPath(kind: ForgeKind, path: string): string {
  const p = path.trim().replace(/^\.\//, "");
  if (kind === "agent") {
    if (p !== AGENT_FILE)
      throw new Error(`智能体草稿只有一份文件：${AGENT_FILE}`);
    return p;
  }
  const parts = p.split(/[\\/]/);
  if (
    p === "" ||
    p.startsWith("/") ||
    /^[a-zA-Z]:/.test(p) ||
    parts.some((s) => s === "" || s === ".." || s.startsWith("."))
  )
    throw new Error(`路径不合法：${path}（只能是技能目录内的相对路径）`);
  return parts.join("/");
}

export function registerForge(app: FastifyInstance, deps: ForgeDeps): Forge {
  const { db, store, skills, agents } = deps;
  const now = deps.now ?? Date.now;
  db.exec(FORGE_MIGRATION);

  const skillExists = (name: string): boolean =>
    existsSync(join(skills.dir, name, SKILL_FILE));
  const agentExists = (name: string): boolean =>
    agents !== undefined && existsSync(join(agents.dir, `${name}.md`));

  const problemsOf = (
    kind: ForgeKind,
    target: string | null,
    files: Files,
  ): DraftProblems => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const mainPath = kind === "skill" ? SKILL_FILE : AGENT_FILE;
    const main = files[mainPath];
    if (main === undefined || main.trim() === "") {
      errors.push(`还没有 ${mainPath}`);
      return { errors, warnings };
    }
    let name: string | undefined;
    try {
      name = kind === "skill" ? requireMeta(main).name : requireAgentMeta(main);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
    if (name !== undefined && name !== target) {
      const taken = kind === "skill" ? skillExists(name) : agentExists(name);
      if (taken)
        errors.push(
          `${KIND_LABEL[kind]}库里已经有「${name}」。换个名字，或改成在它上面修改。`,
        );
    }
    if (kind === "agent") {
      const def = parseAgentDefinition(main);
      const known = new Set(deps.toolCatalog().map((t) => t.name));
      const unknown = def.tools.filter((t) => !known.has(t));
      if (def.tools.length === 0)
        warnings.push(
          "没写 tools：平台内不会进团队花名册；终端里则是继承全部工具（含写与执行命令）。",
        );
      if (unknown.length > 0)
        warnings.push(`这些工具平台里没有，会被忽略：${unknown.join("、")}`);
      const missing = def.skills.filter((s) => !skillExists(s));
      if (missing.length > 0)
        warnings.push(`点名的技能库里没有：${missing.join("、")}`);
    }
    const total = Object.keys(files).length;
    if (total > MAX_FILES)
      errors.push(`文件太多（${String(total)} 个，上限 ${String(MAX_FILES)}）`);
    return { errors, warnings };
  };

  const toDraft = (r: RawDraft): ForgeDraft => {
    const base = parseJson<Files>(r.base, {});
    const files = parseJson<Files>(r.files, {});
    const main = files[r.kind === "skill" ? SKILL_FILE : AGENT_FILE];
    return {
      sessionId: r.session_id,
      kind: r.kind,
      mode: r.mode,
      target: r.target,
      base,
      files,
      locked: parseJson<string[]>(r.locked, []),
      savedName: r.saved_name,
      dirty: !sameFiles(base, files),
      problems: problemsOf(r.kind, r.target, files),
      name: main === undefined ? null : (parseFrontmatter(main).name ?? null),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  };

  const rawOf = (sessionId: string): RawDraft | undefined =>
    db
      .prepare<[string], RawDraft>(
        "SELECT * FROM forge_drafts WHERE session_id = ?",
      )
      .get(sessionId);

  const draftOf = (sessionId: string): ForgeDraft => {
    const r = rawOf(sessionId);
    if (r === undefined) throw notFound("工坊草稿不存在");
    return toDraft(r);
  };

  const writeFiles = (sessionId: string, files: Files): void => {
    for (const [p, t] of Object.entries(files))
      if (Buffer.byteLength(t, "utf8") > MAX_FILE_BYTES)
        throw badRequest(`${p} 超过 512 KiB`);
    db.prepare(
      "UPDATE forge_drafts SET files = ?, updated_at = ? WHERE session_id = ?",
    ).run(JSON.stringify(files), now(), sessionId);
  };

  /** 读现有定义成「文本文件表 + 不能碰的文件」。 */
  const loadLive = async (
    kind: ForgeKind,
    name: string,
  ): Promise<{ files: Files; locked: string[] }> => {
    if (kind === "agent") {
      if (agents === undefined) throw notFound("智能体库未启用");
      const a = await agents.get(name);
      return { files: { [AGENT_FILE]: a.content }, locked: [] };
    }
    const s = await skills.get(name);
    const files: Files = { [SKILL_FILE]: s.content };
    const locked: string[] = [];
    for (const f of s.files) {
      if (f === SKILL_FILE) continue;
      const c = await skills.readFile(name, f);
      if (c.text === null) locked.push(f);
      else files[f] = c.text;
    }
    return { files, locked };
  };

  /* ── 工具 ── */

  const fileTable = (d: ForgeDraft): string => {
    const rows = Object.entries(d.files).map(
      ([p, t]) =>
        `- ${p}（${String(t.length)} 字${d.base[p] === undefined ? "，新增" : d.base[p] === t ? "" : "，已改"}）`,
    );
    const removed = Object.keys(d.base).filter((p) => !(p in d.files));
    if (removed.length > 0) rows.push(`- 已删除：${removed.join("、")}`);
    if (d.locked.length > 0)
      rows.push(`- 不可编辑（二进制或过大，原样保留）：${d.locked.join("、")}`);
    return rows.length === 0 ? "（草稿是空的）" : rows.join("\n");
  };

  const problemText = (p: DraftProblems): string => {
    if (p.errors.length === 0 && p.warnings.length === 0) return "校验通过。";
    return [
      ...p.errors.map((e) => `❌ ${e}`),
      ...p.warnings.map((w) => `⚠️ ${w}`),
    ].join("\n");
  };

  const toolsFor = (sessionId: string, kind: ForgeKind): ToolDefinition[] => {
    const label = KIND_LABEL[kind];
    const mainPath = kind === "skill" ? SKILL_FILE : AGENT_FILE;

    const draftView = defineTool({
      name: "draft_view",
      label: "看草稿",
      description: `Show the current ${kind} draft: file list, validation result, and file contents. Pass path to read one file. The human may edit the draft by hand between turns — call this before changing anything.`,
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      execute(_id, params) {
        const d = draftOf(sessionId);
        if (params.path !== undefined) {
          const p = checkDraftPath(kind, params.path);
          const t = d.files[p];
          if (t === undefined) throw new Error(`草稿里没有 ${p}`);
          return done(t);
        }
        const out = [
          d.target === null
            ? `新建的${label}草稿（还没保存过）。`
            : `在「${d.target}」上修改的草稿。`,
          "",
          "## 文件",
          fileTable(d),
          "",
          "## 校验",
          problemText(d.problems),
        ];
        for (const [p, t] of Object.entries(d.files))
          out.push(
            "",
            `## ${p}`,
            t.length > READ_PAGE
              ? `${t.slice(0, READ_PAGE)}\n…（已截断，用 path 单独读）`
              : t,
          );
        return done(out.join("\n"));
      },
    });

    const afterWrite = (what: string): Promise<ReturnType<typeof text>> => {
      const d = draftOf(sessionId);
      return done(`${what}\n\n校验：\n${problemText(d.problems)}`);
    };

    const draftWrite = defineTool({
      name: "draft_write",
      label: "写草稿",
      description: `Write a whole file into the ${kind} draft (creates or replaces). ${kind === "skill" ? `Main file is ${SKILL_FILE}; bundled files go under references/ etc.` : `The only file is ${AGENT_FILE}.`} Returns the validation result.`,
      parameters: Type.Object({
        path: Type.String({ description: `e.g. ${mainPath}` }),
        content: Type.String(),
      }),
      execute(_id, params) {
        const p = checkDraftPath(kind, params.path);
        const d = draftOf(sessionId);
        writeFiles(sessionId, { ...d.files, [p]: params.content });
        return afterWrite(
          `已写入 ${p}（${String(params.content.length)} 字）。`,
        );
      },
    });

    const draftEdit = defineTool({
      name: "draft_edit",
      label: "改草稿",
      description:
        "Replace one exact, unique snippet in a draft file. Use for small edits so the human's diff stays focused. old_text must match exactly once.",
      parameters: Type.Object({
        path: Type.String(),
        old_text: Type.String(),
        new_text: Type.String(),
      }),
      execute(_id, params) {
        const p = checkDraftPath(kind, params.path);
        const d = draftOf(sessionId);
        const cur = d.files[p];
        if (cur === undefined) throw new Error(`草稿里没有 ${p}`);
        const at = cur.indexOf(params.old_text);
        if (params.old_text === "" || at < 0)
          throw new Error(
            "old_text 在文件里找不到。先 draft_view 看当前内容。",
          );
        if (cur.includes(params.old_text, at + 1))
          throw new Error("old_text 出现了不止一次，多带几行上下文让它唯一。");
        const next =
          cur.slice(0, at) +
          params.new_text +
          cur.slice(at + params.old_text.length);
        writeFiles(sessionId, { ...d.files, [p]: next });
        return afterWrite(`已修改 ${p}。`);
      },
    });

    const draftDelete = defineTool({
      name: "draft_delete",
      label: "删草稿文件",
      description: `Delete a bundled file from the skill draft (not ${SKILL_FILE}).`,
      parameters: Type.Object({ path: Type.String() }),
      execute(_id, params) {
        const p = checkDraftPath(kind, params.path);
        if (p === SKILL_FILE) throw new Error(`${SKILL_FILE} 不能删`);
        const d = draftOf(sessionId);
        if (!(p in d.files)) throw new Error(`草稿里没有 ${p}`);
        writeFiles(sessionId, without(d.files, p));
        return afterWrite(`已删除 ${p}。`);
      },
    });

    const baseOn = defineTool({
      name: "draft_base_on",
      label: "载入现有定义",
      description: `Load an existing ${kind} from the library into the draft, so that saving updates it instead of creating a duplicate. Only allowed while the draft is not yet tied to an existing ${kind}. Replaces the current draft content.`,
      parameters: Type.Object({ name: Type.String() }),
      async execute(_id, params) {
        const d = draftOf(sessionId);
        if (d.target !== null)
          throw new Error(`这份草稿已经在改「${d.target}」，不能换。`);
        const live = await loadLive(kind, params.name);
        db.prepare(
          "UPDATE forge_drafts SET target = ?, base = ?, files = ?, locked = ?, updated_at = ? WHERE session_id = ?",
        ).run(
          params.name,
          JSON.stringify(live.files),
          JSON.stringify(live.files),
          JSON.stringify(live.locked),
          now(),
          sessionId,
        );
        return done(
          `已载入「${params.name}」。之后的修改保存时会更新它。\n\n${fileTable(draftOf(sessionId))}`,
        );
      },
    });

    const libraryList = defineTool({
      name: "library_list",
      label: "看技能与智能体库",
      description:
        "List existing skills and agents (name + description). Use it to avoid duplicates and to pick skills an agent should load.",
      parameters: Type.Object({}),
      async execute() {
        const ss = await skills.list();
        const as = agents === undefined ? [] : await agents.list();
        return text(
          [
            `## 技能（${String(ss.length)}）`,
            ...ss.map((s) => `- ${s.name}：${s.description}`),
            "",
            `## 智能体（${String(as.length)}）`,
            ...as.map(
              (a) =>
                `- ${a.name}：${a.description}${a.tools.length > 0 ? `（工具：${a.tools.join(", ")}）` : ""}`,
            ),
          ].join("\n"),
        );
      },
    });

    const libraryRead = defineTool({
      name: "library_read",
      label: "读现有定义",
      description:
        "Read an existing skill (optionally one bundled file) or agent definition, as a reference.",
      parameters: Type.Object({
        kind: Type.Union([Type.Literal("skill"), Type.Literal("agent")]),
        name: Type.String(),
        file: Type.Optional(Type.String()),
      }),
      async execute(_id, params) {
        if (params.kind === "agent") {
          if (agents === undefined) throw new Error("智能体库未启用");
          return text((await agents.get(params.name)).content);
        }
        if (params.file !== undefined && params.file !== SKILL_FILE) {
          const f = await skills.readFile(params.name, params.file);
          return text(f.text ?? `（二进制或过大，${String(f.bytes)} 字节）`);
        }
        const s = await skills.get(params.name);
        return text(
          `${s.content}\n\n---\n附属文件：${s.files.filter((f) => f !== SKILL_FILE).join("、") || "无"}`,
        );
      },
    });

    const toolCatalog = defineTool({
      name: "tool_catalog",
      label: "看平台工具",
      description:
        "List platform tools an agent may be given in its `tools:` field (name, level, what it does). Pick the minimum set.",
      parameters: Type.Object({}),
      execute() {
        return done(
          deps
            .toolCatalog()
            .map(
              (t) =>
                `- ${t.name}（${t.label}，${t.level === "observe" ? "只读" : "会产生草稿"}）：${t.summary}`,
            )
            .join("\n"),
        );
      },
    });

    const historyList = defineTool({
      name: "history_list",
      label: "列历史对话",
      description:
        "List past normal conversations (newest first) with date, number of user turns and the opening message. Optionally filter by keyword (literal match on title and content).",
      parameters: Type.Object({
        keyword: Type.Optional(Type.String()),
        days: Type.Optional(
          Type.Number({ description: "look back N days, default 60" }),
        ),
        limit: Type.Optional(
          Type.Number({ description: "default 40, max 100" }),
        ),
      }),
      execute(_id, params) {
        const since = now() - (params.days ?? 60) * 24 * 3600 * 1000;
        const limit = Math.min(Math.max(params.limit ?? 40, 1), 100);
        const kw = params.keyword?.trim() ?? "";
        const rows = db
          .prepare<
            [number, string, string, string, number],
            {
              id: string;
              title: string;
              updated_at: number;
              turns: number;
              first: string | null;
            }
          >(
            `SELECT s.id, s.title, s.updated_at,
               (SELECT COUNT(*) FROM entries e WHERE e.session_id = s.id
                  AND json_extract(e.payload, '$.type') = 'message'
                  AND json_extract(e.payload, '$.message.role') = 'user') AS turns,
               (SELECT e.payload FROM entries e WHERE e.session_id = s.id
                  AND json_extract(e.payload, '$.type') = 'message'
                  AND json_extract(e.payload, '$.message.role') = 'user'
                  ORDER BY e.seq LIMIT 1) AS first
             FROM sessions s
             WHERE s.task IS NULL AND s.updated_at >= ?
               AND (? = '' OR s.title LIKE ? OR EXISTS (
                 SELECT 1 FROM entries e WHERE e.session_id = s.id AND e.payload LIKE ?))
             ORDER BY s.updated_at DESC LIMIT ?`,
          )
          .all(since, kw, `%${kw}%`, `%${kw}%`, limit)
          .filter((r) => r.turns > 0);
        if (rows.length === 0)
          return done(
            kw === "" ? "这段时间没有对话。" : `没有包含「${kw}」的对话。`,
          );
        return done(
          rows
            .map((r) => {
              const first = r.first === null ? "" : messageText(r.first);
              return `- [${r.id}] ${day(r.updated_at)}「${r.title}」${String(r.turns)} 轮：${first.replace(/\s+/g, " ").slice(0, 120)}`;
            })
            .join("\n"),
        );
      },
    });

    const historyRead = defineTool({
      name: "history_read",
      label: "读历史对话",
      description:
        "Read one past conversation as plain text (user / AI turns; tool calls shown by name). Long conversations are paged: pass offset from the previous call.",
      parameters: Type.Object({
        sessionId: Type.String(),
        offset: Type.Optional(Type.Number()),
      }),
      execute(_id, params) {
        const row = store.get(params.sessionId);
        if (row === undefined) throw new Error("没有这段对话");
        if (row.task?.kind === "forge") throw new Error("工坊对话不作为素材");
        const full = transcriptText(
          deps.cwd,
          store.header(row.id),
          store.entries(row.id),
        );
        const offset = Math.max(0, params.offset ?? 0);
        const page = full.slice(offset, offset + READ_PAGE);
        const next = offset + READ_PAGE;
        return done(
          `# ${row.title}（${day(row.createdAt)}）\n\n${page}${next < full.length ? `\n\n…（还有 ${String(full.length - next)} 字，用 offset=${String(next)} 继续读）` : ""}`,
        );
      },
    });

    const list = [
      draftView,
      draftWrite,
      draftEdit,
      ...(kind === "skill" ? [draftDelete] : []),
      baseOn,
      libraryList,
      libraryRead,
      ...(kind === "agent" ? [toolCatalog] : []),
      historyList,
      historyRead,
    ];
    return list.map(asTool);
  };

  /* ── 接口 ── */

  const createBody = z.object({
    kind: z.enum(["skill", "agent"]),
    mode: z.enum(["create", "edit", "distill"]),
    name: z.string().min(1).optional(),
  });
  const idParams = z.object({ id: z.string().min(1) });

  const titleOf = (kind: ForgeKind, mode: ForgeMode, name?: string): string =>
    mode === "edit"
      ? `AI 修改${KIND_LABEL[kind]} · ${name ?? ""}`
      : mode === "distill"
        ? `从历史沉淀${KIND_LABEL[kind]}`
        : `AI 新建${KIND_LABEL[kind]}`;

  /** 最近的工坊草稿（工坊会话不进对话列表，没保存的活要有地方找回来）。 */
  app.get("/api/forge", (request) => {
    const q = z
      .object({ kind: z.enum(["skill", "agent"]).optional() })
      .parse(request.query);
    const rows = db
      .prepare<[string, string], RawDraft>(
        `SELECT * FROM forge_drafts WHERE (? = '' OR kind = ?)
           ORDER BY updated_at DESC LIMIT 30`,
      )
      .all(q.kind ?? "", q.kind ?? "")
      .map(toDraft);
    return {
      drafts: rows.map((d) => ({
        sessionId: d.sessionId,
        kind: d.kind,
        mode: d.mode,
        target: d.target,
        name: d.name,
        dirty: d.dirty,
        savedName: d.savedName,
        updatedAt: d.updatedAt,
      })),
    };
  });

  /**
   * 开一个工坊。修改模式下，同一个定义已有没保存的草稿就接着用——
   * 否则人关掉再点一次「AI 修改」，上次改了一半的东西就找不到了。
   */
  app.post("/api/forge", async (request, reply) => {
    const body = createBody.parse(request.body);
    if (body.kind === "agent" && agents === undefined)
      throw notFound("智能体库未启用");
    if (body.mode === "edit") {
      if (body.name === undefined) throw badRequest("要修改哪个？");
      const open = db
        .prepare<[string, string], RawDraft>(
          "SELECT * FROM forge_drafts WHERE kind = ? AND target = ? ORDER BY updated_at DESC",
        )
        .all(body.kind, body.name)
        .map(toDraft)
        .find((d) => d.dirty && store.get(d.sessionId) !== undefined);
      if (open !== undefined)
        return reply.send({
          sessionId: open.sessionId,
          reused: true,
          kickoff: null,
        });
    }
    const live =
      body.mode === "edit" && body.name !== undefined
        ? await loadLive(body.kind, body.name)
        : { files: {}, locked: [] };
    const header = deps.newHeader() as { id: string };
    const target = body.mode === "edit" ? (body.name ?? null) : null;
    const row = store.create({
      id: header.id,
      title: titleOf(body.kind, body.mode, body.name),
      header,
      task: { kind: "forge", of: body.kind, mode: body.mode },
    });
    const t = now();
    db.prepare(
      `INSERT INTO forge_drafts (session_id, kind, mode, target, base, files, locked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.id,
      body.kind,
      body.mode,
      target,
      JSON.stringify(live.files),
      JSON.stringify(live.files),
      JSON.stringify(live.locked),
      t,
      t,
    );
    return reply.code(201).send({
      sessionId: row.id,
      reused: false,
      kickoff: body.mode === "distill" ? distillKickoff(body.kind) : null,
    });
  });

  app.get("/api/forge/:id", async (request) => {
    const { id } = idParams.parse(request.params);
    const d = draftOf(id);
    return { ...d, stale: await isStale(d) };
  });

  /** 人在右侧手改草稿。content = null 表示删掉这个文件。 */
  app.put("/api/forge/:id/file", (request) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({ path: z.string().min(1), content: z.string().nullable() })
      .parse(request.body);
    const d = draftOf(id);
    let p: string;
    try {
      p = checkDraftPath(d.kind, body.path);
    } catch (e) {
      throw badRequest(e instanceof Error ? e.message : "路径不合法");
    }
    if (body.content === null && (p === SKILL_FILE || p === AGENT_FILE))
      throw badRequest(`${p} 不能删`);
    writeFiles(
      id,
      body.content === null
        ? without(d.files, p)
        : { ...d.files, [p]: body.content },
    );
    return draftOf(id);
  });

  /** 原件在开工后被别处改过没有（手改、另一个工坊保存）。新建的没有原件。 */
  const isStale = async (d: ForgeDraft): Promise<boolean> => {
    if (d.target === null) return false;
    const exists =
      d.kind === "skill" ? skillExists(d.target) : agentExists(d.target);
    if (!exists) return true;
    const live = await loadLive(d.kind, d.target);
    return !sameFiles(live.files, d.base);
  };

  app.post("/api/forge/:id/save", async (request) => {
    const { id } = idParams.parse(request.params);
    const { force } = z
      .object({ force: z.boolean().optional() })
      .parse(request.body ?? {});
    const d = draftOf(id);
    if (d.problems.errors.length > 0)
      throw badRequest(`草稿还有问题：${d.problems.errors.join("；")}`);
    if (d.target !== null && (await isStale(d)) && force !== true) {
      const gone =
        d.kind === "skill" ? !skillExists(d.target) : !agentExists(d.target);
      throw conflict(
        gone
          ? `「${d.target}」已经被删除或改名了。确认要按草稿重新建一份吗？`
          : `「${d.target}」在你编辑期间被别处改过，保存会覆盖那次修改。确认覆盖吗？`,
      );
    }
    let saved: string;
    try {
      saved = await apply(d);
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw badRequest(e instanceof Error ? e.message : "保存失败");
    }
    // 保存后草稿 = 新的基准：接着改就是在刚保存的版本上改。
    const live = await loadLive(d.kind, saved);
    db.prepare(
      "UPDATE forge_drafts SET target = ?, base = ?, files = ?, locked = ?, saved_name = ?, updated_at = ? WHERE session_id = ?",
    ).run(
      saved,
      JSON.stringify(live.files),
      JSON.stringify(live.files),
      JSON.stringify(live.locked),
      saved,
      now(),
      id,
    );
    store.rename(id, titleOf(d.kind, "edit", saved));
    return { name: saved, draft: draftOf(id) };
  });

  /** 写进正式库，返回保存后的名字（frontmatter 改了 name 会跟着改名）。 */
  const apply = async (d: ForgeDraft): Promise<string> => {
    const main = d.files[d.kind === "skill" ? SKILL_FILE : AGENT_FILE] ?? "";
    if (d.kind === "agent") {
      if (agents === undefined) throw notFound("智能体库未启用");
      const target =
        d.target !== null && agentExists(d.target) ? d.target : null;
      const a =
        target === null
          ? await agents.create(main)
          : await agents.update(target, main);
      return a.name;
    }
    const target = d.target !== null && skillExists(d.target) ? d.target : null;
    if (target === null) {
      const s = await skills.importTree(
        Object.entries(d.files).map(([path, t]) => ({
          path,
          base64: Buffer.from(t, "utf8").toString("base64"),
        })),
      );
      return s.name;
    }
    const s = await skills.update(target, main);
    const others = Object.entries(d.files)
      .filter(([p, t]) => p !== SKILL_FILE && d.base[p] !== t)
      .map(([path, t]) => ({ path, text: t }));
    const removed = Object.keys(d.base).filter(
      (p) => p !== SKILL_FILE && !(p in d.files),
    );
    if (others.length > 0 || removed.length > 0)
      await skills.putFiles(s.name, others, removed);
    return s.name;
  };

  /** 放弃：连会话一起删（草稿行随外键级联）。 */
  app.delete("/api/forge/:id", (request, reply) => {
    const { id } = idParams.parse(request.params);
    draftOf(id);
    store.remove(id);
    return reply.code(204).send();
  });

  return {
    profile(session) {
      if (session.task?.kind !== "forge") return undefined;
      const r = rawOf(session.id);
      if (r === undefined) return undefined;
      const kind = r.kind;
      return {
        systemPrompt: forgeSystemPrompt(kind, r.mode, r.target),
        tools: toolsFor(session.id, kind),
        // 每轮现场附上草稿现状：人可能在两轮之间手改过，也可能刚 draft_base_on 换了目标。
        promptExtra: () => {
          const raw = rawOf(session.id);
          if (raw === undefined) return "";
          const d = toDraft(raw);
          const size = Object.values(d.files).reduce((n, t) => n + t.length, 0);
          return [
            "",
            "## 草稿现状（每轮自动附上）",
            d.target === null
              ? `新建中，还没保存过。`
              : `在改「${d.target}」${d.savedName !== null ? "（已保存过，之后的修改要再点保存）" : ""}。`,
            fileTable(d),
            `校验：${problemText(d.problems)}`,
            ...(size > 0 && size <= INLINE_DRAFT
              ? Object.entries(d.files).flatMap(([p, t]) => ["", `### ${p}`, t])
              : size > 0
                ? ["（草稿较长，需要时用 draft_view 读）"]
                : []),
          ].join("\n");
        },
      };
    },
  };
}

/** 一条 pi 消息条目的纯文本（只取 text 块）。 */
function messageText(payload: string): string {
  const content = parseJson<{ message?: { content?: unknown } }>(payload, {})
    .message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c: { type?: string; text?: string }) =>
      c.type === "text" ? (c.text ?? "") : "",
    )
    .join("");
}

/**
 * 把一段对话压成给模型读的纯文本：用户与 AI 的文字原样，工具调用只留名字。
 * 走 historyToUiMessages：分支、压缩、被撤回的条目都按界面看到的来，不自己解释。
 */
export function transcriptText(
  cwd: string,
  header: unknown,
  entries: readonly unknown[],
): string {
  const out: string[] = [];
  for (const m of historyToUiMessages(cwd, header, entries)) {
    const lines: string[] = [];
    for (const part of m.parts) {
      if (part.type === "text") lines.push(part.text);
      else if (part.type === "dynamic-tool")
        lines.push(`[调用工具 ${part.toolName}]`);
    }
    const body = lines.join("\n").trim();
    if (body !== "")
      out.push(`### ${m.role === "user" ? "用户" : "AI"}\n${body}`);
  }
  return out.join("\n\n");
}
