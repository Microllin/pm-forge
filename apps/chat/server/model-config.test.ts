import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createKeyStore, envKeyName } from "./model-config.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chat-keys-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("KeyStore", () => {
  it("按 provider 的环境变量优先，不落盘；列表里也算接入", async () => {
    expect(envKeyName("cloud-router")).toBe("PMFORGE_CHAT_KEY_CLOUD_ROUTER");
    const keys = createKeyStore(dir, {
      PMFORGE_CHAT_KEY_CLOUD_ROUTER: "sk-env",
    });
    expect(await keys.get("cloud-router")).toEqual({
      value: "sk-env",
      source: "env",
    });
    expect(await keys.list()).toEqual(["cloud-router"]);
  });

  it("文件存储 0600；清除后回到 none", async () => {
    const keys = createKeyStore(dir, {});
    await keys.set("relay", "  sk-file  ");
    expect(await keys.get("relay")).toEqual({
      value: "sk-file",
      source: "file",
    });
    expect((await stat(join(dir, "keys", "relay"))).mode & 0o777).toBe(0o600);
    await keys.clear("relay");
    expect(await keys.get("relay")).toEqual({ value: null, source: "none" });
  });

  it("非法 provider id 不会被拼进文件路径", async () => {
    const keys = createKeyStore(dir, {});
    await expect(keys.set("../evil", "x")).rejects.toThrow();
  });
});
