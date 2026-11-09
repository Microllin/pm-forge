import { randomUUID } from "node:crypto";

import type { Db } from "../db.js";
import type { FileStore } from "../files/store.js";
import { childOf } from "../files/paths.js";
import { safeSegment } from "../global-fill-prompts.js";

/**
 * 对话与智能体的草稿登记。
 *
 * 补齐草稿有自己的 fill_drafts、售前草稿是 presales_versions 里的草稿版本——
 * 那两份状态原样保留，不并进来。这张表只装**原来没有任何登记**的两类：
 * 对话里存下的、智能体 draft_write 写的。
 *
 * **不进 db.ts 的序号迁移表**，与 agent-team/runs.ts 同一个理由：并行分支各在
 * 同一序号追加一条会互相吞掉。这是自给自足的新表，自己 IF NOT EXISTS 建。
 */
export const STAGING_DRAFTS_MIGRATION = `
  CREATE TABLE IF NOT EXISTS staging_drafts (
    id           TEXT PRIMARY KEY,
    source       TEXT NOT NULL,
    product_id   TEXT,
    title        TEXT NOT NULL,
    origin       TEXT NOT NULL DEFAULT '',
    draft_path   TEXT NOT NULL,
    target_path  TEXT,
    session_id   TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    applied_path TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS staging_drafts_status_idx
    ON staging_drafts(status, created_at);
`;

export type DraftSource = "chat" | "agent";
export type DraftStatus = "pending" | "applied" | "discarded";

export interface StagingDraft {
  id: string;
  source: DraftSource;
  productId: string | null;
  title: string;
  /** 给人看的出处：「对话：xxx」「智能体 prd-writer」。 */
  origin: string;
  draftPath: string;
  /** 建议的去处（默认产品文档目录/标题.md）；确认时可改。null = 没有建议，确认时必须填。 */
  targetPath: string | null;
  sessionId: string | null;
  status: DraftStatus;
  /** 确认后实际写到了哪。 */
  appliedPath: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  source: DraftSource;
  product_id: string | null;
  title: string;
  origin: string;
  draft_path: string;
  target_path: string | null;
  session_id: string | null;
  status: DraftStatus;
  applied_path: string | null;
  created_at: number;
  updated_at: number;
}

const toDraft = (r: Row): StagingDraft => ({
  id: r.id,
  source: r.source,
  productId: r.product_id,
  title: r.title,
  origin: r.origin,
  draftPath: r.draft_path,
  targetPath: r.target_path,
  sessionId: r.session_id,
  status: r.status,
  appliedPath: r.applied_path,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export interface SaveDraftInput {
  source: DraftSource;
  productId: string | null;
  title: string;
  markdown: string;
  origin: string;
  /** 临时区里的哪个文件夹（调用方按来源拼好）。 */
  folder: string;
  targetPath: string | null;
  sessionId: string | null;
}

export interface DraftStore {
  /** 写文件 + 登记。同名自动改名，不覆盖临时区里已有的草稿。 */
  save(input: SaveDraftInput): Promise<StagingDraft>;
  pending(): StagingDraft[];
  get(id: string): StagingDraft | undefined;
  mark(id: string, status: DraftStatus, appliedPath?: string): void;
}

export function createDraftStore(
  db: Db,
  files: FileStore,
  now: () => number = Date.now,
): DraftStore {
  db.exec(STAGING_DRAFTS_MIGRATION);

  const get = (id: string): StagingDraft | undefined => {
    const row = db
      .prepare<[string], Row>("SELECT * FROM staging_drafts WHERE id = ?")
      .get(id);
    return row === undefined ? undefined : toDraft(row);
  };

  return {
    async save(input) {
      const title = input.title.trim() === "" ? "未命名" : input.title.trim();
      const { entry } = await files.write(
        childOf(input.folder, `${safeSegment(title)}.md`),
        Buffer.from(
          input.markdown.endsWith("\n")
            ? input.markdown
            : `${input.markdown}\n`,
          "utf8",
        ),
        { mode: "autorename", parents: true },
      );
      const id = randomUUID();
      const stamp = now();
      db.prepare(
        `INSERT INTO staging_drafts
           (id, source, product_id, title, origin, draft_path, target_path, session_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        id,
        input.source,
        input.productId,
        title,
        input.origin,
        entry.path,
        input.targetPath,
        input.sessionId,
        stamp,
        stamp,
      );
      const saved = get(id);
      if (saved === undefined) throw new Error("草稿登记后读取失败");
      return saved;
    },

    pending() {
      return db
        .prepare<[], Row>(
          "SELECT * FROM staging_drafts WHERE status = 'pending' ORDER BY created_at DESC",
        )
        .all()
        .map(toDraft);
    },

    get,

    mark(id, status, appliedPath) {
      db.prepare(
        "UPDATE staging_drafts SET status = ?, applied_path = ?, updated_at = ? WHERE id = ?",
      ).run(status, appliedPath ?? null, now(), id);
    },
  };
}
