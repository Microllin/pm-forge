import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { HttpError } from "../errors.js";
import type { Runner } from "./runner.js";
import {
  APP_ROOT,
  PI_AI_PACKAGE,
  PI_PACKAGE,
  UpgradeRejected,
  createUpgrader,
  fetchRegistry,
  installedVersion,
  piAiVersionFor,
  pnpmCommand,
  runCommand,
  type UpgradeDeps,
  type UpgradeEvent,
} from "./upgrade.js";

const upgradeBody = z.object({ version: z.string().trim().optional() });

export interface PiRoutesOptions {
  /** 请求重启。不在 supervisor 下时返回 false（界面提示手动重启）。 */
  requestRestart: () => boolean;
  /** 测试注入：替换真实的安装 / 自检 / registry。 */
  deps?: Partial<UpgradeDeps>;
}

/** 真实环境下的升级动作。 */
function realDeps(runner: Runner, requestRestart: () => boolean): UpgradeDeps {
  const pnpm = pnpmCommand();
  return {
    installed: installedVersion,
    registry: () => fetchRegistry(),
    piAiFor: (version) => piAiVersionFor(version),
    install: (pi, piAi, onLine) =>
      runCommand(
        pnpm.command,
        [
          ...pnpm.prefix,
          "add",
          "-E",
          `${PI_PACKAGE}@${pi}`,
          `${PI_AI_PACKAGE}@${piAi}`,
        ],
        APP_ROOT,
        onLine,
      ),
    // 子进程：加载的是刚装上的新版 pi，而不是本进程已缓存的旧模块。
    selfcheck: (onLine) =>
      runCommand(
        process.execPath,
        ["--import", "tsx", join(APP_ROOT, "server", "pi", "selfcheck.ts")],
        APP_ROOT,
        onLine,
      ),
    busy: () => runner.busy(),
    restart: requestRestart,
  };
}

export function piRoutes(options: PiRoutesOptions) {
  return (app: FastifyInstance, ctx: { runner: Runner }): void => {
    const deps = {
      ...realDeps(ctx.runner, options.requestRestart),
      ...options.deps,
    };
    const upgrader = createUpgrader(deps);

    app.get("/api/pi", async () => {
      const installed = await deps.installed(PI_PACKAGE);
      try {
        const registry = await deps.registry();
        return {
          installed,
          installedAt: registry.time[installed] ?? null,
          latest: registry.latest,
          latestAt: registry.time[registry.latest] ?? null,
          updateAvailable: registry.latest !== installed,
          repository: registry.repository,
          upgrading: upgrader.running,
          registryError: null,
        };
      } catch (cause) {
        // 查不到 npm（断网）不该让设置页整块挂掉：已装版本照样显示。
        return {
          installed,
          installedAt: null,
          latest: null,
          latestAt: null,
          updateAvailable: false,
          repository: null,
          upgrading: upgrader.running,
          registryError:
            cause instanceof Error ? cause.message : "查询 npm 失败",
        };
      }
    });

    /** 升级。进度以 SSE 推送（每帧一个 UpgradeEvent JSON）。 */
    app.post("/api/pi/upgrade", async (request, reply) => {
      const body = upgradeBody.parse(request.body ?? {});
      const target = body.version ?? (await deps.registry()).latest;
      // 并发 / 有对话在跑 / 版本号非法：开流之前就拒，回正常的 HTTP 错误。
      if (upgrader.running)
        throw new HttpError(409, "CONFLICT", "已经有一次升级在进行");
      if (deps.busy()) {
        throw new HttpError(
          409,
          "CONFLICT",
          "有对话正在进行，等它结束（或停止）再升级",
        );
      }

      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      // 断开后别再写（`writableEnded` 在客户端断开时为 false）。升级本身继续跑完：
      // 中途掐断会停在「装了一半」的状态，比跑完更危险。
      // 放对象里：闭包里改的值，TS 的流分析看不见，会把它当成恒 false 报错。
      const state = { gone: false };
      raw.on("close", () => {
        state.gone = true;
      });
      const emit = (event: UpgradeEvent): void => {
        if (state.gone) return;
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      };
      try {
        await upgrader.upgrade(target, emit);
      } catch (cause) {
        if (!(cause instanceof UpgradeRejected)) throw cause;
        emit({
          type: "done",
          ok: false,
          error: cause.message,
          rolledBack: false,
        });
      } finally {
        if (!state.gone) raw.end();
      }
    });
  };
}
