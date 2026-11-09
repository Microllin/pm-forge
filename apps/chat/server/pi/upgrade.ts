import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * pi 版本检查与一键升级。
 *
 * 流程：拒绝并发 → 校验版本 → `pnpm add -E` → **子进程**自检 → 通过则请求重启，
 * 失败则装回原版本。所有外部动作（跑命令、查 registry、退出进程）都经 deps 注入，
 * 编排逻辑本身可以离线单测。
 */

export const PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const PI_AI_PACKAGE = "@earendil-works/pi-ai";
const REGISTRY = "https://registry.npmjs.org";

/** apps/chat 根目录（本文件在 server/pi/ 下）。 */
export const APP_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * 读**磁盘上**当前装的版本，而不是 import 进来的模块版本：升级完、重启前，
 * 两者不一样，界面要显示的是磁盘上的。
 */
export async function installedVersion(
  pkg: string = PI_PACKAGE,
): Promise<string> {
  // pi 是纯 ESM 包（exports 只有 import 条件），require.resolve 找不到它；
  // 直接读 node_modules 里的清单（pnpm 的软链会被跟随到实际版本目录）。
  const manifest = JSON.parse(
    await readFile(join(APP_ROOT, "node_modules", pkg, "package.json"), "utf8"),
  ) as { version?: string };
  if (!manifest.version) throw new Error(`读不到 ${pkg} 的版本`);
  return manifest.version;
}

export interface RegistryInfo {
  latest: string;
  /** 已发布版本 → 发布时间（ISO）。 */
  time: Record<string, string>;
  repository: string | null;
}

export async function fetchRegistry(
  pkg: string = PI_PACKAGE,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistryInfo> {
  const res = await fetchImpl(`${REGISTRY}/${pkg.replace("/", "%2f")}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`npm registry 返回 ${String(res.status)}`);
  const body = (await res.json()) as {
    "dist-tags"?: { latest?: string };
    time?: Record<string, string>;
    repository?: { url?: string } | string;
  };
  const latest = body["dist-tags"]?.latest;
  if (!latest) throw new Error("npm registry 没有 latest 版本");
  const repo =
    typeof body.repository === "string"
      ? body.repository
      : body.repository?.url;
  return {
    latest,
    time: body.time ?? {},
    repository: repo ? repo.replace(/^git\+/, "").replace(/\.git$/, "") : null,
  };
}

/** 某个版本的 pi-coding-agent 依赖哪个 pi-ai（我们直接依赖 pi-ai，必须同步升）。 */
export async function piAiVersionFor(
  version: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(
    `${REGISTRY}/${PI_PACKAGE.replace("/", "%2f")}/${version}`,
    {
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) throw new Error(`查不到 ${PI_PACKAGE}@${version}`);
  const body = (await res.json()) as { dependencies?: Record<string, string> };
  const range = body.dependencies?.[PI_AI_PACKAGE];
  const exact = range?.replace(/^[\^~=]/, "");
  if (!exact || !SEMVER.test(exact)) {
    throw new Error(
      `${PI_PACKAGE}@${version} 的 ${PI_AI_PACKAGE} 依赖无法解析：${String(range)}`,
    );
  }
  return exact;
}

export interface CommandResult {
  code: number;
  output: string;
}

/** 跑一个命令，逐行回调输出。参数数组，不经 shell——版本号进命令行前也已校验过。 */
export function runCommand(
  command: string,
  args: string[],
  cwd: string,
  onLine: (line: string) => void,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env: process.env });
    let output = "";
    let buffer = "";
    const onData = (data: Buffer): void => {
      const text = data.toString("utf8");
      output += text;
      buffer += text;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") onLine(line);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (error) => {
      output += String(error);
      resolve({ code: 1, output });
    });
    child.on("close", (code) => {
      if (buffer.trim() !== "") onLine(buffer);
      resolve({ code: code ?? 1, output });
    });
  });
}

/** 用当前这个 pnpm（npm_execpath）而不是 PATH 里随便哪个。 */
export function pnpmCommand(): { command: string; prefix: string[] } {
  const execPath = process.env.npm_execpath;
  if (execPath?.includes("pnpm")) {
    return { command: process.execPath, prefix: [execPath] };
  }
  return { command: "pnpm", prefix: [] };
}

export type UpgradeEvent =
  | { type: "log"; line: string }
  | { type: "step"; name: string }
  | { type: "done"; ok: true; version: string; restarting: boolean }
  | { type: "done"; ok: false; error: string; rolledBack: boolean };

export interface UpgradeDeps {
  installed: (pkg: string) => Promise<string>;
  registry: () => Promise<RegistryInfo>;
  piAiFor: (version: string) => Promise<string>;
  /** 安装指定版本（两个包一起）。 */
  install: (
    piVersion: string,
    piAiVersion: string,
    onLine: (l: string) => void,
  ) => Promise<CommandResult>;
  /** 子进程自检。 */
  selfcheck: (onLine: (l: string) => void) => Promise<CommandResult>;
  /** 是否有对话在跑。 */
  busy: () => boolean;
  /** 请求重启；返回 false 表示不在 supervisor 下，需要手动重启。 */
  restart: () => boolean;
}

export class UpgradeRejected extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createUpgrader(deps: UpgradeDeps) {
  let running = false;

  return {
    get running() {
      return running;
    },

    /**
     * 开始升级。同步校验（并发、在跑的对话）在开始前抛 UpgradeRejected；
     * 之后的进度与结果都经 emit 推送。
     */
    async upgrade(
      target: string,
      emit: (e: UpgradeEvent) => void,
    ): Promise<void> {
      if (running) throw new UpgradeRejected(409, "已经有一次升级在进行");
      if (deps.busy())
        throw new UpgradeRejected(
          409,
          "有对话正在进行，等它结束（或停止）再升级",
        );
      if (!SEMVER.test(target))
        throw new UpgradeRejected(400, `版本号不合法：${target}`);
      running = true;
      const log = (line: string): void => {
        emit({ type: "log", line });
      };
      try {
        emit({ type: "step", name: "校验版本" });
        const registry = await deps.registry();
        if (!(target in registry.time))
          throw new Error(`npm 上没有 ${PI_PACKAGE}@${target}`);
        const previous = {
          pi: await deps.installed(PI_PACKAGE),
          piAi: await deps.installed(PI_AI_PACKAGE),
        };
        if (previous.pi === target) throw new Error(`已经是 ${target}`);
        const piAi = await deps.piAiFor(target);
        log(
          `${PI_PACKAGE} ${previous.pi} → ${target}，${PI_AI_PACKAGE} ${previous.piAi} → ${piAi}`,
        );

        emit({ type: "step", name: "安装" });
        const installed = await deps.install(target, piAi, log);
        if (installed.code !== 0) throw new Error("安装失败（未改动现有版本）");

        emit({ type: "step", name: "自检" });
        const checked = await deps.selfcheck(log);
        if (checked.code !== 0) {
          emit({ type: "step", name: "回滚" });
          const rolled = await deps.install(previous.pi, previous.piAi, log);
          emit({
            type: "done",
            ok: false,
            error: "新版本自检未通过，已装回原版本",
            rolledBack: rolled.code === 0,
          });
          return;
        }

        const restarting = deps.restart();
        emit({ type: "done", ok: true, version: target, restarting });
      } catch (cause) {
        emit({
          type: "done",
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
          rolledBack: false,
        });
      } finally {
        running = false;
      }
    },
  };
}

export type Upgrader = ReturnType<typeof createUpgrader>;
