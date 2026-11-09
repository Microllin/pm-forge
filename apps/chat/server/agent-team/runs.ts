import type { Db } from "../db.js";

/**
 * 运行记录：一次派活一行。
 *
 * **不进 db.ts 的序号迁移表**，由 createRunStore 自己 IF NOT EXISTS 建表。
 * 原因是实测撞过：并行分支（feat/ui-snapshot-env）在同一个序号追加了 ENV_MIGRATION，
 * 线上库已按那个序号跑过，于是本分支的同序号迁移被当成「已执行」，表根本没建
 * （2026-10-28，隔离副本启动报 no such table: agent_runs）。只追加的序号表在两条
 * 并行分支各加一条时天然冲突；这张表是自给自足的新表，自己建最稳。
 * 以后要改结构：同样在这里用 ALTER 前先查 pragma table_info，别回到序号表。
 */
export const AGENT_RUNS_MIGRATION = `
  CREATE TABLE IF NOT EXISTS agent_runs (
    id            TEXT PRIMARY KEY,
    session_id    TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    parent_run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
    depth         INTEGER NOT NULL,
    agent         TEXT NOT NULL,
    task          TEXT NOT NULL,
    reason        TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL,
    result        TEXT NOT NULL DEFAULT '',
    error         TEXT,
    model         TEXT,
    turns         INTEGER NOT NULL DEFAULT 0,
    tool_calls    INTEGER NOT NULL DEFAULT 0,
    tokens_in     INTEGER NOT NULL DEFAULT 0,
    tokens_out    INTEGER NOT NULL DEFAULT 0,
    transcript    TEXT NOT NULL DEFAULT '[]',
    started_at    INTEGER NOT NULL,
    ended_at      INTEGER
  );
  CREATE INDEX IF NOT EXISTS agent_runs_session_idx ON agent_runs(session_id, started_at);
  CREATE INDEX IF NOT EXISTS agent_runs_parent_idx  ON agent_runs(parent_run_id);
`;

export type RunStatus = "running" | "done" | "failed" | "stopped";

export interface AgentRunRow {
  id: string;
  sessionId: string | null;
  parentRunId: string | null;
  depth: number;
  agent: string;
  task: string;
  reason: string;
  status: RunStatus;
  result: string;
  error: string | null;
  model: string | null;
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  startedAt: number;
  endedAt: number | null;
}

interface Raw {
  id: string;
  session_id: string | null;
  parent_run_id: string | null;
  depth: number;
  agent: string;
  task: string;
  reason: string;
  status: RunStatus;
  result: string;
  error: string | null;
  model: string | null;
  turns: number;
  tool_calls: number;
  tokens_in: number;
  tokens_out: number;
  started_at: number;
  ended_at: number | null;
}

const toRow = (r: Raw): AgentRunRow => ({
  id: r.id,
  sessionId: r.session_id,
  parentRunId: r.parent_run_id,
  depth: r.depth,
  agent: r.agent,
  task: r.task,
  reason: r.reason,
  status: r.status,
  result: r.result,
  error: r.error,
  model: r.model,
  turns: r.turns,
  toolCalls: r.tool_calls,
  tokensIn: r.tokens_in,
  tokensOut: r.tokens_out,
  startedAt: r.started_at,
  endedAt: r.ended_at,
});

const COLS =
  "id, session_id, parent_run_id, depth, agent, task, reason, status, result, error, model, turns, tool_calls, tokens_in, tokens_out, started_at, ended_at";

export interface RunFinish {
  status: Exclude<RunStatus, "running">;
  result: string;
  error: string | null;
  turns: number;
  toolCalls: number;
  tokensIn: number;
  tokensOut: number;
  transcript: readonly unknown[];
}

export interface RunStore {
  start(row: {
    id: string;
    sessionId: string | null;
    parentRunId: string | null;
    depth: number;
    agent: string;
    task: string;
    reason: string;
    model: string | null;
  }): void;
  finish(id: string, f: RunFinish): void;
  get(id: string): AgentRunRow | undefined;
  transcript(id: string): unknown[];
  bySession(sessionId: string): AgentRunRow[];
  children(id: string): AgentRunRow[];
  recent(limit: number): AgentRunRow[];
  /** 服务重启时还标着 running 的，进程已经没了：如实改成 stopped。 */
  sweepOrphans(): number;
}

export function createRunStore(db: Db, now: () => number = Date.now): RunStore {
  db.exec(AGENT_RUNS_MIGRATION);
  return {
    start(r) {
      db.prepare(
        `INSERT INTO agent_runs (id, session_id, parent_run_id, depth, agent, task, reason, status, model, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      ).run(
        r.id,
        r.sessionId,
        r.parentRunId,
        r.depth,
        r.agent,
        r.task,
        r.reason,
        r.model,
        now(),
      );
    },
    finish(id, f) {
      db.prepare(
        `UPDATE agent_runs SET status = ?, result = ?, error = ?, turns = ?, tool_calls = ?, tokens_in = ?, tokens_out = ?,
           transcript = ?, ended_at = ? WHERE id = ?`,
      ).run(
        f.status,
        f.result,
        f.error,
        f.turns,
        f.toolCalls,
        f.tokensIn,
        f.tokensOut,
        JSON.stringify(f.transcript),
        now(),
        id,
      );
    },
    get(id) {
      const r = db
        .prepare<[string], Raw>(`SELECT ${COLS} FROM agent_runs WHERE id = ?`)
        .get(id);
      return r && toRow(r);
    },
    transcript(id) {
      const r = db
        .prepare<[string], { transcript: string }>(
          "SELECT transcript FROM agent_runs WHERE id = ?",
        )
        .get(id);
      return r ? (JSON.parse(r.transcript) as unknown[]) : [];
    },
    bySession(sessionId) {
      return db
        .prepare<[string], Raw>(
          `SELECT ${COLS} FROM agent_runs WHERE session_id = ? ORDER BY started_at`,
        )
        .all(sessionId)
        .map(toRow);
    },
    children(id) {
      return db
        .prepare<[string], Raw>(
          `SELECT ${COLS} FROM agent_runs WHERE parent_run_id = ? ORDER BY started_at`,
        )
        .all(id)
        .map(toRow);
    },
    recent(limit) {
      return db
        .prepare<[number], Raw>(
          `SELECT ${COLS} FROM agent_runs ORDER BY started_at DESC LIMIT ?`,
        )
        .all(limit)
        .map(toRow);
    },
    sweepOrphans() {
      return db
        .prepare(
          "UPDATE agent_runs SET status = 'stopped', error = '服务重启，运行中断', ended_at = ? WHERE status = 'running'",
        )
        .run(now()).changes;
    },
  };
}
