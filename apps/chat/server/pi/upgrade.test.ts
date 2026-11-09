import { describe, expect, it, vi } from "vitest";

import { runSelfcheck } from "./selfcheck.js";
import {
  PI_AI_PACKAGE,
  PI_PACKAGE,
  UpgradeRejected,
  createUpgrader,
  installedVersion,
  type UpgradeDeps,
  type UpgradeEvent,
} from "./upgrade.js";

/** 编排逻辑：所有外部动作都是假的，断言「什么情况下做了什么」。 */
function fakeDeps(overrides: Partial<UpgradeDeps> = {}) {
  const installs: string[] = [];
  const deps: UpgradeDeps = {
    installed: (pkg) => Promise.resolve(pkg === PI_PACKAGE ? "1.2.0" : "1.2.1"),
    registry: () =>
      Promise.resolve({
        latest: "1.3.0",
        time: { "1.2.0": "t", "1.3.0": "t" },
        repository: null,
      }),
    piAiFor: () => Promise.resolve("1.3.0"),
    install: (pi, piAi) => {
      installs.push(`${pi}/${piAi}`);
      return Promise.resolve({ code: 0, output: "" });
    },
    selfcheck: () => Promise.resolve({ code: 0, output: "" }),
    busy: () => false,
    restart: () => true,
    ...overrides,
  };
  return { deps, installs };
}

async function run(deps: UpgradeDeps, target = "1.3.0") {
  const events: UpgradeEvent[] = [];
  await createUpgrader(deps).upgrade(target, (e) => events.push(e));
  return { events, done: events.at(-1) };
}

describe("升级编排", () => {
  it("成功：两个包一起装 → 自检 → 请求重启", async () => {
    const { deps, installs } = fakeDeps();
    const { done } = await run(deps);
    expect(installs).toEqual(["1.3.0/1.3.0"]);
    expect(done).toEqual({
      type: "done",
      ok: true,
      version: "1.3.0",
      restarting: true,
    });
  });

  it("自检不过：装回原版本，不重启", async () => {
    const restart = vi.fn(() => true);
    const { deps, installs } = fakeDeps({
      selfcheck: () => Promise.resolve({ code: 1, output: "x" }),
      restart,
    });
    const { done } = await run(deps);
    expect(installs).toEqual(["1.3.0/1.3.0", "1.2.0/1.2.1"]);
    expect(done).toMatchObject({ ok: false, rolledBack: true });
    expect(restart).not.toHaveBeenCalled();
  });

  it("安装失败：不跑自检、不回滚（没改动）", async () => {
    const selfcheck = vi.fn(() => Promise.resolve({ code: 0, output: "" }));
    const { deps, installs } = fakeDeps({
      install: (pi, piAi) => {
        installs.push(`${pi}/${piAi}`);
        return Promise.resolve({ code: 1, output: "ERR" });
      },
      selfcheck,
    });
    const { done } = await run(deps);
    expect(done).toMatchObject({ ok: false });
    expect(selfcheck).not.toHaveBeenCalled();
    expect(installs).toHaveLength(1);
  });

  it("有对话在跑：开始前就拒（409）", async () => {
    const { deps } = fakeDeps({ busy: () => true });
    await expect(run(deps)).rejects.toBeInstanceOf(UpgradeRejected);
  });

  it("非法版本号：拒（防命令注入）", async () => {
    const { deps } = fakeDeps();
    await expect(run(deps, "1.3.0 && rm -rf /")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("npm 上不存在的版本：失败且不安装", async () => {
    const { deps, installs } = fakeDeps();
    const { done } = await run(deps, "9.9.9");
    expect(done).toMatchObject({ ok: false });
    expect(installs).toHaveLength(0);
  });

  it("不在 supervisor 下：成功但提示手动重启", async () => {
    const { deps } = fakeDeps({ restart: () => false });
    expect((await run(deps)).done).toMatchObject({
      ok: true,
      restarting: false,
    });
  });
});

describe("真实环境", () => {
  it("读得到磁盘上装的 pi 版本", async () => {
    expect(await installedVersion(PI_PACKAGE)).toMatch(/^\d+\.\d+\.\d+/);
    expect(await installedVersion(PI_AI_PACKAGE)).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("自检对当前装的 pi 全部通过", async () => {
    const result = await runSelfcheck();
    expect(result.checks.filter((c) => !c.ok)).toEqual([]);
    expect(result.ok).toBe(true);
  });
});
