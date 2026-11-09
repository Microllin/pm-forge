import { randomUUID } from "node:crypto";

import type { Db } from "./db.js";

export interface SessionRow {
  id: string;
  title: string;
  /** 这段对话属于哪个产品；null = 普通对话，不注入事实依据。 */
  productId: string | null;
  /** 手选的依据范围（文件库路径）；空 = 整个依据库。 */
  evidenceScope: string[];
  createdAt: number;
  updatedAt: number;
  /**
   * 这条会话是不是一次 AI 分析，null = 普通对话。
   * 分析就跑在真对话里（用户要看得见过程、还能追问），所以不另建一张表。
   */
  task: AnalysisTask | null;
}

/** AI 分析任务的入参。存在 sessions.task（JSON）。 */
export type AnalysisTask =
  | {
      kind: "discover";
      /** 第一处选中的路径（旧会话只有这一项）。 */
      folderPath: string;
      /** 本次勾选的全部路径：文档文件夹、单个文件、代码仓库。 */
      paths?: string[];
    }
  | {
      kind: "compare";
      productId: string;
      templateId: string;
      folderPath: string;
    }
  | {
      kind: "architecture";
      productId: string;
      /** 展开哪个节点；null = 分析一级功能。 */
      nodeId: string | null;
      /** append = 向下拆一层（只补不覆盖）；replace = 这一支整个重来。 */
      mode: "append" | "replace";
      codePath: string;
    }
  | {
      kind: "wiki-outline";
      productId: string;
      /** append = 补章节；replace = 重新规划（只清没写正文的页）。 */
      mode: "append" | "replace";
    }
  | {
      kind: "wiki-page";
      productId: string;
      pageId: string;
    }
  | {
      /**
       * 售前材料的 AI 识别：从一个文件夹范围里挑出每类材料该用哪一份。
       * 结果**不进库**，先落成候选等人逐条确认（见 presales-import.ts）。
       */
      kind: "presales-recognize";
      libId: string;
      folderPath: string;
    }
  | {
      /**
       * 售前材料的 AI 审阅 / 体系复盘里的一步（见 presales-review.ts）。
       * 结果由服务端取回存进 presales_ai_jobs，不在对话里应用；用户在对话里追问后
       * 可以在售前页点「重新取结果」。
       */
      kind: "presales-ai";
      libId: string;
      jobId: string;
      job: "ledger" | "cross" | "review";
    }
  | {
      /**
       * 售前库的专属助手（见 presales-agent.ts）：常驻在售前页右侧，带专属工具
       * （读清单与标准、读材料、发起审阅、取结果、起草缺口）。一库一条。
       */
      kind: "presales-agent";
      libId: string;
    }
  | {
      /**
       * AI 工坊（见 forge.ts）：AI 新建 / 修改 / 从历史沉淀技能或智能体。
       * 草稿在 forge_drafts，人点保存才进库。不进对话列表。
       */
      kind: "forge";
      of: "skill" | "agent";
      mode: "create" | "edit" | "distill";
    }
  | {
      /**
       * 市场情报的「AI 调研」（见 intel/routes.ts）：带情报工具与联网搜索，
       * 发现逐条提交进情报库（待确认）。
       */
      kind: "intel-research";
      productId: string | null;
    }
  | {
      /** 全局 AI 补齐里「写一份缺失的产出物」。结果自动进补齐草稿区，不在对话里应用。 */
      kind: "fill-artifact";
      productId: string;
      runId: string;
      stageCode: string;
      artifact: string;
    };

interface RawSessionRow {
  id: string;
  title: string;
  header: string;
  task: string | null;
  product_id: string | null;
  evidence_scope: string | null;
  created_at: number;
  updated_at: number;
}

/** 坏掉的 task 当成普通对话，不让一个字段把会话列表打崩。 */
function parseTask(raw: string | null): AnalysisTask | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as AnalysisTask;
  } catch {
    return null;
  }
}

/** 宽容解析：一列脏 JSON 不该让整段对话打不开，解析失败当「不限定」。 */
function parseScope(raw: string | null): string[] {
  if (raw === null || raw === "") return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value)
      ? value.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

const toRow = (r: RawSessionRow): SessionRow => ({
  id: r.id,
  title: r.title,
  productId: r.product_id,
  evidenceScope: parseScope(r.evidence_scope),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  task: parseTask(r.task),
});

/** 条目只需要一个 id 就能去重；其余字段原样存，不解析。 */
function entryIdOf(entry: unknown): string | undefined {
  if (entry === null || typeof entry !== "object") return undefined;
  const id = (entry as { id?: unknown }).id;
  return typeof id === "string" && id !== "" ? id : undefined;
}

export interface SessionStore {
  /** header 是 pi 会话头原文；id 必须与 header.id 一致（pi 以它为会话 id）。 */
  create(input: {
    id?: string;
    title: string;
    header: unknown;
    task?: AnalysisTask;
    /** 这段对话属于哪个产品（决定事实依据库）。 */
    productId?: string | null;
    /** 手选的依据范围（文件库路径）。 */
    evidenceScope?: string[];
  }): SessionRow;
  list(): SessionRow[];
  get(id: string): SessionRow | undefined;
  rename(id: string, title: string): SessionRow | undefined;
  /** 改依据范围；从下一条消息起生效。 */
  setEvidenceScope(id: string, scope: string[]): SessionRow | undefined;
  remove(id: string): boolean;
  header(id: string): unknown;
  /** 条目原文，按到达序。 */
  entries(id: string): unknown[];
  /**
   * 追加条目。按 entry id 去重——同步时整段 getEntries() 喂进来是安全的，
   * 只有新的会落库。返回新增条数。
   */
  append(id: string, entries: readonly unknown[]): number;
}

export function createSessionStore(db: Db): SessionStore {
  const insertEntry = db.prepare<[string, string, string, string]>(
    `INSERT OR IGNORE INTO entries (session_id, seq, entry_id, payload)
     VALUES (?, COALESCE((SELECT MAX(seq) FROM entries WHERE session_id = ?), 0) + 1, ?, ?)`,
  );
  const touch = db.prepare<[number, string]>(
    "UPDATE sessions SET updated_at = ? WHERE id = ?",
  );

  return {
    create({ id, title, header, task, productId, evidenceScope }) {
      const now = Date.now();
      const sessionId = id ?? randomUUID();
      const scope =
        evidenceScope === undefined || evidenceScope.length === 0
          ? null
          : JSON.stringify(evidenceScope);
      db.prepare(
        "INSERT INTO sessions (id, title, header, task, product_id, evidence_scope, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        sessionId,
        title,
        JSON.stringify(header),
        task === undefined ? null : JSON.stringify(task),
        productId ?? null,
        scope,
        now,
        now,
      );
      return {
        id: sessionId,
        title,
        productId: productId ?? null,
        evidenceScope: evidenceScope ?? [],
        createdAt: now,
        updatedAt: now,
        task: task ?? null,
      };
    },

    list() {
      return db
        .prepare<[], RawSessionRow>(
          "SELECT * FROM sessions ORDER BY updated_at DESC",
        )
        .all()
        .map(toRow);
    },

    get(id) {
      const r = db
        .prepare<[string], RawSessionRow>("SELECT * FROM sessions WHERE id = ?")
        .get(id);
      return r ? toRow(r) : undefined;
    },

    setEvidenceScope(id, scope) {
      db.prepare(
        "UPDATE sessions SET evidence_scope = ?, updated_at = ? WHERE id = ?",
      ).run(scope.length === 0 ? null : JSON.stringify(scope), Date.now(), id);
      return this.get(id);
    },

    rename(id, title) {
      db.prepare(
        "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
      ).run(title, Date.now(), id);
      return this.get(id);
    },

    remove(id) {
      return (
        db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes > 0
      );
    },

    header(id) {
      const r = db
        .prepare<[string], { header: string }>(
          "SELECT header FROM sessions WHERE id = ?",
        )
        .get(id);
      return r ? (JSON.parse(r.header) as unknown) : undefined;
    },

    entries(id) {
      return db
        .prepare<[string], { payload: string }>(
          "SELECT payload FROM entries WHERE session_id = ? ORDER BY seq",
        )
        .all(id)
        .map((r) => JSON.parse(r.payload) as unknown);
    },

    append(id, entries) {
      let added = 0;
      db.transaction(() => {
        for (const entry of entries) {
          const entryId = entryIdOf(entry);
          // 没有 id 的条目 pi 不会产出；真遇到就跳过，而不是编一个——
          // 编出来的 id 会让 parentId 链断掉，恢复时整段分支错位。
          if (entryId === undefined) continue;
          added += insertEntry.run(
            id,
            id,
            entryId,
            JSON.stringify(entry),
          ).changes;
        }
        if (added > 0) touch.run(Date.now(), id);
      })();
      return added;
    },
  };
}
