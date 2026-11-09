import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RESTART_EXIT_CODE } from "./config.js";

/**
 * 进程看护：跑 server/main.ts，并在它请求时重启它。
 *
 * 为什么不用 `tsx watch`：pi 升级完成后服务要以退出码 75 请求重启，而 tsx watch
 * 在子进程退出后只会**等文件变化**，不会重新拉起——升级后服务就停在那里了。
 *
 * 行为：
 * - 子进程以 75 退出 → 立即重启（这是预期内的重启）。
 * - `--watch`（开发）：server/ 下文件变化 → 重启；子进程崩溃 → 等下一次文件变化
 *   再起（立即重启只会把同一个错误刷屏）。
 * - 非 watch：崩溃后退避重启，1 分钟内崩 5 次就放弃，免得空转。
 */

const serverDir = dirname(fileURLToPath(import.meta.url));
// 可覆盖仅为测试：用一个最小脚本验证「退出码 75 → 重启」这条约定。
const entry = process.env.PMFORGE_CHAT_ENTRY ?? join(serverDir, "main.ts");
const watchMode = process.argv.includes("--watch");

let child: ChildProcess | undefined;
let restarting = false;
let shuttingDown = false;
const crashes: number[] = [];

function log(message: string): void {
  process.stdout.write(`[supervisor] ${message}\n`);
}

function start(): void {
  restarting = false;
  // --import tsx：直接跑 TS，不经构建。tsx 从仓库根的 node_modules 解析。
  child = spawn(process.execPath, ["--import", "tsx", entry], {
    stdio: "inherit",
    // 告诉服务「有人接手重启」：升级 pi 后它才敢以 75 退出。
    env: { ...process.env, PMFORGE_CHAT_SUPERVISED: "1" },
  });
  child.on("exit", (code, signal) => {
    child = undefined;
    if (shuttingDown) return;
    if (restarting || code === RESTART_EXIT_CODE) {
      log(code === RESTART_EXIT_CODE ? "服务请求重启" : "文件变化，重启");
      start();
      return;
    }
    log(`服务退出（code=${String(code)} signal=${String(signal)}）`);
    if (watchMode) {
      log("等待文件变化后重启…");
      return;
    }
    const now = Date.now();
    crashes.push(now);
    while (crashes.length > 0 && now - (crashes[0] ?? 0) > 60_000)
      crashes.shift();
    if (crashes.length >= 5) {
      log("1 分钟内崩溃 5 次，放弃重启");
      process.exit(1);
    }
    setTimeout(start, 1000);
  });
}

function restart(): void {
  if (!child) {
    start();
    return;
  }
  restarting = true;
  child.kill("SIGTERM");
}

if (watchMode) {
  let timer: NodeJS.Timeout | undefined;
  watch(serverDir, { recursive: true }, (_event, file) => {
    // 测试文件变化不影响运行中的服务。
    if (file === null || file.endsWith(".test.ts")) return;
    clearTimeout(timer);
    timer = setTimeout(restart, 150);
  });
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    shuttingDown = true;
    child?.kill(sig);
    process.exit(0);
  });
}

start();
