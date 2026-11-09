import { readSse } from "../api";
import { createRequest, json } from "../http";

/** 代码库的仓库接口。形状与 server/code-repos.ts 一一对应。 */
const request = createRequest("/api");

export interface CodeRepo {
  name: string;
  path: string;
  files: number;
  bytes: number;
  modifiedAt: number | null;
  createdAt: number;
  products: { id: string; name: string }[];
  /** git 读到的信息；上传的文件夹没有 git，为 null。 */
  git: {
    remote: string | null;
    branch: string | null;
    commit: string | null;
  } | null;
}

const enc = encodeURIComponent;

export const listRepos = () =>
  request<{ repos: CodeRepo[] }>("/code-repos").then((r) => r.repos);
export const createRepo = (name: string) =>
  request<CodeRepo>("/code-repos", { method: "POST", ...json({ name }) });
export const renameRepo = (name: string, next: string) =>
  request<CodeRepo>(`/code-repos/${enc(name)}`, {
    method: "PATCH",
    ...json({ name: next }),
  });
export const resetRepo = (name: string) =>
  request<CodeRepo>(`/code-repos/${enc(name)}/reset`, {
    method: "POST",
    ...json({}),
  });
export const deleteRepo = (name: string) =>
  request<{ unbound: { id: string; name: string }[] }>(
    `/code-repos/${enc(name)}`,
    { method: "DELETE" },
  );

/** 克隆 / 拉取的流式事件。 */
export type GitEvent =
  | { type: "phase"; phase: "clone" | "pull"; name: string }
  | { type: "line"; line: string }
  | { type: "dirty"; files: number }
  | { type: "done"; ok: boolean; repo?: CodeRepo; error?: string };

export const cloneRepo = (
  input: { url: string; name?: string; branch?: string },
  onEvent: (e: GitEvent) => void,
): Promise<void> =>
  readSse("/api/code-repos/clone", input, (e) => onEvent(e as GitEvent));

export const pullRepo = (
  name: string,
  input: { discardsChanges?: boolean },
  onEvent: (e: GitEvent) => void,
): Promise<void> =>
  readSse(`/api/code-repos/${enc(name)}/pull`, input, (e) =>
    onEvent(e as GitEvent),
  );

/** 自动同步。形状与 server/code-repos-sync.ts 对应。 */
export const SYNC_INTERVALS = [15, 30, 60, 180, 360, 720, 1440] as const;

export interface AutoSyncStatus {
  enabled: boolean;
  intervalMinutes: number;
  running: boolean;
  nextRunAt: number | null;
  lastRun: {
    startedAt: number;
    finishedAt: number;
    trigger: "manual" | "schedule";
    results: {
      name: string;
      ok: boolean;
      changed: boolean;
      error: string | null;
    }[];
  } | null;
}

export const getAutoSync = () =>
  request<AutoSyncStatus>("/code-repos/auto-sync");
export const saveAutoSync = (input: {
  enabled: boolean;
  intervalMinutes: number;
}) =>
  request<AutoSyncStatus>("/code-repos/auto-sync", {
    method: "PUT",
    ...json(input),
  });
export const runAutoSync = () =>
  request<AutoSyncStatus>("/code-repos/auto-sync/run", {
    method: "POST",
    ...json({}),
  });
