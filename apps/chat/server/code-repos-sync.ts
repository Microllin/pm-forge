import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "./db.js";
import { conflict } from "./errors.js";

/**
 * 代码库自动同步（设置 → 代码库自动同步）：按设定的间隔，把 /代码库 下所有 git 仓库
 * 各拉一次更新。拉取本身复用手动「拉取」那一段（只快进、按仓库加锁），这里只管三件事：
 *   1. 开关与间隔存在 settings 表（key 见 CONFIG_KEY），改了立即按新间隔重排下一轮；
 *   2. 定时器：上一轮跑完才排下一轮，不会叠着跑；服务重启后按「上次开始 + 间隔」接着排；
 *   3. 每轮的结果（每个仓库成功 / 失败原因 / 有没有拉到新提交）存下来给设置页看。
 * 安全边界：自动同步**从不丢弃本地改动**，工作区脏就记一条失败，留给人到代码库页处理。
 */

export const CONFIG_KEY = "code_repos.auto_sync";
const LAST_RUN_KEY = "code_repos.auto_sync.last_run";

/** 可选间隔（分钟）。界面给下拉，后端也只认这几档，免得有人填 1 分钟把远端刷爆。 */
export const SYNC_INTERVALS = [15, 30, 60, 180, 360, 720, 1440] as const;

export interface AutoSyncConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export interface AutoSyncRepoResult {
  name: string;
  ok: boolean;
  /** 拉到了新提交。 */
  changed: boolean;
  error: string | null;
}

export interface AutoSyncRun {
  startedAt: number;
  finishedAt: number;
  /** manual：设置页点「立即同步」；schedule：定时触发。 */
  trigger: "manual" | "schedule";
  results: AutoSyncRepoResult[];
}

export interface AutoSyncStatus extends AutoSyncConfig {
  running: boolean;
  /** 下一轮预计开始时间；没开启为 null。 */
  nextRunAt: number | null;
  lastRun: AutoSyncRun | null;
}

export interface AutoSyncDeps {
  /** 当前所有 git 仓库的名字。 */
  repos: () => Promise<string[]>;
  pull: (
    name: string,
  ) => Promise<{ ok: boolean; error?: string; changed?: boolean }>;
}

const DEFAULT_CONFIG: AutoSyncConfig = { enabled: false, intervalMinutes: 60 };
/** 服务刚启动时别立刻开跑，给启动留点余量。 */
const STARTUP_GRACE_MS = 30_000;

const configBody = z.object({
  enabled: z.boolean(),
  intervalMinutes: z
    .number()
    .int()
    .refine((n) => (SYNC_INTERVALS as readonly number[]).includes(n), {
      message: `同步间隔只能是 ${SYNC_INTERVALS.join(" / ")} 分钟之一`,
    }),
});

export function registerAutoSync(
  app: FastifyInstance,
  db: Db,
  now: () => number,
  deps: AutoSyncDeps,
): void {
  const read = (key: string): unknown => {
    const row = db
      .prepare<[string], { value: string }>(
        "SELECT value FROM settings WHERE key = ?",
      )
      .get(key);
    if (row === undefined) return null;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: unknown): void => {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, JSON.stringify(value));
  };

  const loadConfig = (): AutoSyncConfig => {
    const parsed = configBody.safeParse(read(CONFIG_KEY));
    return parsed.success ? parsed.data : { ...DEFAULT_CONFIG };
  };

  let config = loadConfig();
  let lastRun = read(LAST_RUN_KEY) as AutoSyncRun | null;
  let running: Promise<AutoSyncRun> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let nextRunAt: number | null = null;
  let closed = false;
  /** 下一轮从哪个时间点起算：上一轮开始时间；刚打开开关时是打开那一刻。 */
  let anchor = lastRun?.startedAt ?? now();

  const runOnce = (trigger: AutoSyncRun["trigger"]): Promise<AutoSyncRun> => {
    if (running !== null) return running;
    running = (async () => {
      const startedAt = now();
      anchor = startedAt;
      const results: AutoSyncRepoResult[] = [];
      const names = await deps.repos().catch((): string[] => []);
      // 一个一个拉：并发拉十几个仓库既占带宽，也容易被远端限流。
      for (const name of names) {
        if (closed) break;
        try {
          const r = await deps.pull(name);
          results.push({
            name,
            ok: r.ok,
            changed: r.changed === true,
            error: r.ok ? null : (r.error ?? "拉取失败"),
          });
        } catch (cause) {
          results.push({
            name,
            ok: false,
            changed: false,
            error: cause instanceof Error ? cause.message : "拉取失败",
          });
        }
      }
      const run: AutoSyncRun = {
        startedAt,
        finishedAt: now(),
        trigger,
        results,
      };
      lastRun = run;
      write(LAST_RUN_KEY, run);
      return run;
    })().finally(() => {
      running = null;
      schedule();
    });
    return running;
  };

  /** 按当前配置排下一轮；已排的先撤掉。 */
  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    nextRunAt = null;
    if (closed || !config.enabled || running !== null) return;
    const interval = config.intervalMinutes * 60_000;
    nextRunAt = Math.max(anchor + interval, now() + STARTUP_GRACE_MS);
    timer = setTimeout(
      () => {
        timer = null;
        void runOnce("schedule");
      },
      Math.max(0, nextRunAt - now()),
    );
    // 别因为这个定时器让进程退不掉。
    timer.unref();
  }

  const status = (): AutoSyncStatus => ({
    ...config,
    running: running !== null,
    nextRunAt,
    lastRun,
  });

  app.get("/api/code-repos/auto-sync", () => status());

  app.put("/api/code-repos/auto-sync", (request) => {
    const wasEnabled = config.enabled;
    config = configBody.parse(request.body);
    write(CONFIG_KEY, config);
    // 刚打开时从「现在」起算，而不是从很久以前的上一轮起算后立刻开跑。
    if (config.enabled && !wasEnabled) anchor = now();
    schedule();
    return status();
  });

  /** 立即同步一轮，等跑完再返回结果（仓库多时可能要几十秒）。 */
  app.post("/api/code-repos/auto-sync/run", async () => {
    if (running !== null) throw conflict("正在同步中，请稍候");
    await runOnce("manual");
    return status();
  });

  schedule();
  app.addHook("onClose", async () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    await running?.catch(() => undefined);
  });
}
