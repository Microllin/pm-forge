import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * supervisor 的核心约定：服务以退出码 75 退出 → 被重新拉起（pi 升级后靠它生效）。
 * 用一个最小入口脚本代替真实服务：第一次启动就以 75 退出，第二次常驻。
 */
describe("supervisor", () => {
  it("子进程以 75 退出时重新拉起，并带上 SUPERVISED 标记", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-supervisor-"));
    const log = join(dir, "starts.log");
    const entry = join(dir, "entry.mjs");
    await writeFile(
      entry,
      `import { appendFileSync, readFileSync } from "node:fs";
       appendFileSync(${JSON.stringify(log)}, (process.env.PMFORGE_CHAT_SUPERVISED ?? "-") + "\\n");
       const n = readFileSync(${JSON.stringify(log)}, "utf8").trim().split("\\n").length;
       if (n === 1) process.exit(75);
       setInterval(() => {}, 1000);`,
    );
    const supervisor = spawn(
      process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "supervisor.ts")],
      { env: { ...process.env, PMFORGE_CHAT_ENTRY: entry }, stdio: "ignore" },
    );
    try {
      let lines: string[] = [];
      for (let i = 0; i < 200 && lines.length < 2; i += 1) {
        await new Promise((r) => setTimeout(r, 50));
        lines = (await readFile(log, "utf8").catch(() => ""))
          .trim()
          .split("\n")
          .filter(Boolean);
      }
      expect(lines).toEqual(["1", "1"]);
    } finally {
      supervisor.kill("SIGTERM");
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
