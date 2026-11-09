import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import Fastify, { type FastifyInstance } from "fastify";
import { mkdirSync as mkdir, writeFileSync } from "node:fs";

import { createApp } from "./app.js";
import { IN_MEMORY, openDb, type Db } from "./db.js";
import { createFileStore, openFilesIndex } from "./files/store.js";
import { createKeyStore } from "./model-config.js";
import { piPaths } from "./pi/runtime.js";
import { createSkillStore } from "./skills.js";
import {
  checkGitUrl,
  registerCodeRepoRoutes,
  repoNameFrom,
  sshUrlOf,
  type CodeRepo,
  type GitDeps,
} from "./code-repos.js";

const HOST = "127.0.0.1:4400";
let dir: string;
let db: Db;
let index: Db;
let app: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-repos-")));
  const root = join(dir, "files");
  mkdirSync(join(root, "代码库"), { recursive: true });
  db = openDb(IN_MEMORY);
  index = openFilesIndex();
  ({ app } = createApp({
    auth: false,
    db,
    paths: piPaths(dir),
    keys: createKeyStore(dir, {}),
    skills: createSkillStore({
      dir: join(dir, "skills"),
      targetDirs: {
        pi: join(dir, "t", "pi"),
      },
    }),
    files: createFileStore(root, index),
    security: { port: 4400, webPort: 3200, extraOrigins: [] },
  }));
});
afterEach(async () => {
  await app.close();
  db.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

// 测试里按接口断言响应形状；T 只出现在返回值上是有意的。
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
async function call<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  url: string,
  payload?: object | Buffer,
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      host: HOST,
      ...(Buffer.isBuffer(payload)
        ? { "content-type": "application/octet-stream" }
        : {}),
    },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, body: res.json<T>() };
}
const repos = async () =>
  (await call<{ repos: CodeRepo[] }>("GET", "/api/code-repos")).body.repos;
const put = (path: string, text: string) =>
  call(
    "PUT",
    `/api/files/content?path=${encodeURIComponent(path)}&parents=1`,
    Buffer.from(text),
  );
async function productWithCode(codePath: string): Promise<string> {
  const line = await call<{ id: string }>("POST", "/api/product-lines", {
    name: "RouteHub",
  });
  const product = await call<{ id: string }>(
    "POST",
    `/api/product-lines/${line.body.id}/products`,
    { name: "ModelHub", codePath },
  );
  return product.body.id;
}
const codePathOf = (id: string) =>
  db
    .prepare<[string], { code_path: string | null }>(
      "SELECT code_path FROM products WHERE id = ?",
    )
    .get(id)?.code_path;

describe("代码库：按仓库管理", () => {
  it("清单列出每个仓库的文件数、字节、最近更新与绑定的产品", async () => {
    expect(await repos()).toEqual([]);
    expect(
      (await call("POST", "/api/code-repos", { name: "router" })).status,
    ).toBe(201);
    await put("/代码库/router/src/a.ts", "export const a = 1;");
    await put("/代码库/router/README.md", "# r");
    await productWithCode("/代码库/router/src");
    const [repo] = await repos();
    expect(repo).toMatchObject({
      name: "router",
      path: "/代码库/router",
      files: 2,
      products: [{ name: "ModelHub" }],
    });
    expect(repo?.bytes).toBeGreaterThan(0);
    expect(repo?.modifiedAt).not.toBeNull();
  });

  it("改名：绑定在仓库及其子目录上的产品跟着换路径", async () => {
    await call("POST", "/api/code-repos", { name: "router" });
    await put("/代码库/router/src/a.ts", "x");
    const id = await productWithCode("/代码库/router/src");
    const res = await call<CodeRepo>("PATCH", "/api/code-repos/router", {
      name: "model-router",
    });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe("/代码库/model-router");
    expect(codePathOf(id)).toBe("/代码库/model-router/src");
  });

  it("前缀相同的另一个仓库不受改名影响", async () => {
    await call("POST", "/api/code-repos", { name: "router" });
    await call("POST", "/api/code-repos", { name: "router2" });
    const id = await productWithCode("/代码库/router2");
    await call("PATCH", "/api/code-repos/router", { name: "r" });
    expect(codePathOf(id)).toBe("/代码库/router2");
  });

  it("重新上传前清空：内容没了、仓库与绑定还在", async () => {
    await call("POST", "/api/code-repos", { name: "router" });
    await put("/代码库/router/a.ts", "x");
    const id = await productWithCode("/代码库/router");
    const res = await call<CodeRepo>("POST", "/api/code-repos/router/reset");
    expect(res.body.files).toBe(0);
    expect(codePathOf(id)).toBe("/代码库/router");
  });

  it("删除：先解绑产品再删，返回被解绑的产品", async () => {
    await call("POST", "/api/code-repos", { name: "router" });
    await put("/代码库/router/a.ts", "x");
    const id = await productWithCode("/代码库/router");
    const res = await call<{ unbound: { name: string }[] }>(
      "DELETE",
      "/api/code-repos/router",
    );
    expect(res.body.unbound.map((p) => p.name)).toEqual(["ModelHub"]);
    expect(codePathOf(id)).toBeNull();
    expect(await repos()).toEqual([]);
  });

  it("没有 .git 的文件夹 git 信息为 null（界面据此不显示拉取）", async () => {
    await call("POST", "/api/code-repos", { name: "uploaded" });
    await put("/代码库/uploaded/a.ts", "x");
    const [repo] = await repos();
    expect(repo?.git).toBeNull();
  });

  it("不存在的仓库 404；非法名字 400；重名 409", async () => {
    expect((await call("DELETE", "/api/code-repos/nope")).status).toBe(404);
    expect(
      (await call("POST", "/api/code-repos", { name: "a/b" })).status,
    ).toBe(400);
    await call("POST", "/api/code-repos", { name: "router" });
    expect(
      (await call("POST", "/api/code-repos", { name: "router" })).status,
    ).toBe(409);
  });
});

describe("代码库：克隆与拉取", () => {
  /** 挂一个只有代码库路由的服务，git 换成假的。 */
  function gitApp(steps: {
    clone?: (dir: string) => void;
    pull?: (dir: string) => void;
    status?: string;
    /** 按地址决定克隆失败：返回 git 输出即失败。 */
    cloneFails?: (url: string) => string | undefined;
  }): {
    app: ReturnType<typeof createApp>["app"];
    calls: string[][];
    reindexed: string[];
  } {
    const files = createFileStore(join(dir, "files"), index);
    const calls: string[][] = [];
    const reindexed: string[] = [];
    const app: ReturnType<typeof createApp>["app"] = Fastify({
      logger: false,
    });
    const git: GitDeps = {
      reindex: (path) => {
        reindexed.push(path);
        return Promise.resolve(0);
      },
      run: (args, cwd, onLine) => {
        calls.push(args);
        onLine("Cloning into ...");
        if (args[0] === "status")
          return Promise.resolve({ code: 0, output: steps.status ?? "" });
        if (args[0] === "clone") {
          const failed = steps.cloneFails?.(args.at(-2) ?? "");
          if (failed !== undefined)
            return Promise.resolve({ code: 128, output: failed });
          const target = args.at(-1) ?? "";
          mkdir(target, { recursive: true });
          writeFileSync(join(target, "README.md"), "# cloned");
          mkdir(join(target, ".git"), { recursive: true });
          writeFileSync(join(target, ".git", "HEAD"), "ref: refs/heads/main");
          writeFileSync(
            join(target, ".git", "config"),
            '[remote "origin"]\n\turl = https://example.com/r.git\n',
          );
          steps.clone?.(cwd);
        }
        return Promise.resolve({ code: 0, output: "" });
      },
    };
    registerCodeRepoRoutes(app, db, files, Date.now, git);
    return { app, calls, reindexed };
  }

  interface GitEventSeen {
    type: string;
    ok?: boolean;
    repo?: CodeRepo;
    error?: string;
  }
  const sse = (text: string): GitEventSeen[] =>
    text
      .split("\n\n")
      .filter((chunk) => {
        return chunk.startsWith("data: ");
      })
      .map((chunk) => JSON.parse(chunk.slice(6)) as GitEventSeen);

  it("克隆：落到临时目录再改名，事件里有输出与结果", async () => {
    const { app: a, reindexed } = gitApp({});
    const res = await a.inject({
      method: "POST",
      url: "/api/code-repos/clone",
      headers: { host: HOST },
      payload: { url: "https://example.com/team/router.git" },
    });
    expect(res.statusCode).toBe(200);
    const events = sse(res.body);
    expect(events[0]).toMatchObject({ type: "phase", phase: "clone" });
    expect(events.some((e) => e.type === "line")).toBe(true);
    const done = events.at(-1);
    expect(done).toMatchObject({ type: "done", ok: true });
    expect(done?.repo).toMatchObject({
      name: "router",
      git: { branch: "main", remote: "https://example.com/r.git" },
    });
    expect(reindexed).toEqual(["/代码库/router"]);
    void a.close();
  });

  it("HTTPS 地址认证失败：自动改用 SSH 地址重试并成功", async () => {
    expect(sshUrlOf("https://github.com/acme/RouteHub")).toBe(
      "git@github.com:acme/RouteHub.git",
    );
    expect(sshUrlOf("https://gitlab.com/g/sub/app.git/")).toBe(
      "git@gitlab.com:g/sub/app.git",
    );
    expect(sshUrlOf("https://github.com/only-owner")).toBeNull();
    expect(sshUrlOf("git@github.com:a/b.git")).toBeNull();

    const { app: a, calls } = gitApp({
      cloneFails: (url) =>
        url.startsWith("https://")
          ? "remote: Repository not found.\nfatal: Authentication failed for 'https://github.com/acme/RouteHub/'"
          : undefined,
    });
    const events = sse(
      (
        await a.inject({
          method: "POST",
          url: "/api/code-repos/clone",
          headers: { host: HOST },
          payload: { url: "https://github.com/acme/RouteHub" },
        })
      ).body,
    );
    expect(calls.filter((c) => c[0] === "clone").map((c) => c.at(-2))).toEqual([
      "https://github.com/acme/RouteHub",
      "git@github.com:acme/RouteHub.git",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      ok: true,
      repo: { name: "RouteHub" },
    });
    await a.close();
  });

  it("HTTPS 与 SSH 都没权限：给出说人话的原因；非认证失败不重试", async () => {
    const { app: a, calls } = gitApp({
      cloneFails: (url) =>
        url.startsWith("https://")
          ? "fatal: Authentication failed"
          : "git@github.com: Permission denied (publickey).",
    });
    const done = sse(
      (
        await a.inject({
          method: "POST",
          url: "/api/code-repos/clone",
          headers: { host: HOST },
          payload: { url: "https://github.com/team/secret.git" },
        })
      ).body,
    ).at(-1);
    expect(done?.ok).toBe(false);
    expect(done?.error).toContain("SSH 公钥");
    expect(done?.error).toContain("Permission denied");
    expect(calls.filter((c) => c[0] === "clone")).toHaveLength(2);
    await a.close();

    const { app: b, calls: callsB } = gitApp({
      cloneFails: () => "fatal: unable to access: Could not resolve host",
    });
    await b.inject({
      method: "POST",
      url: "/api/code-repos/clone",
      headers: { host: HOST },
      payload: { url: "https://example.com/team/router.git" },
    });
    expect(callsB.filter((c) => c[0] === "clone")).toHaveLength(1);
    await b.close();
  });

  it("克隆名字支持覆盖；URL 传输协议被挡；重名 409", async () => {
    expect(() => {
      checkGitUrl("ext::sh -c touch /tmp/x");
    }).toThrow();
    expect(() => {
      checkGitUrl("--upload-pack=evil");
    }).toThrow();
    expect(repoNameFrom("https://x/y/router.git")).toBe("router");
    expect(repoNameFrom("git@github.com:team/app.git")).toBe("app");
    expect(repoNameFrom("https://x/y/z", "自定义名")).toBe("自定义名");

    const { app: a } = gitApp({});
    await call("POST", "/api/code-repos", { name: "router" });
    const res = await a.inject({
      method: "POST",
      url: "/api/code-repos/clone",
      headers: { host: HOST },
      payload: { url: "https://example.com/router.git" },
    });
    expect(res.statusCode).toBe(409);
    await a.close();
  });

  it("拉取：工作区有改动先拒绝，同意丢弃后才继续", async () => {
    await call("POST", "/api/code-repos", { name: "router" });
    mkdir(join(dir, "files", "代码库", "router", ".git"), { recursive: true });
    const { app: a, calls } = gitApp({
      status: " M src/a.ts\n?? b.ts\n",
    });
    const first = sse(
      (
        await a.inject({
          method: "POST",
          url: "/api/code-repos/router/pull",
          headers: { host: HOST },
          payload: {},
        })
      ).body,
    );
    expect(first.some((e) => e.type === "dirty")).toBe(true);
    expect(first.at(-1)).toMatchObject({ ok: false });
    expect(calls.some((c) => c[0] === "reset")).toBe(false);

    calls.length = 0;
    const second = sse(
      (
        await a.inject({
          method: "POST",
          url: "/api/code-repos/router/pull",
          headers: { host: HOST },
          payload: { discardsChanges: true },
        })
      ).body,
    );
    expect(second.at(-1)).toMatchObject({ type: "done", ok: true });
    expect(calls.map((c) => c[0])).toEqual([
      "status",
      "fetch",
      "reset",
      "clean",
      "merge",
    ]);
    await a.close();
  });

  it("拉取：不是 git 仓库 404 之前的普通错误", async () => {
    await call("POST", "/api/code-repos", { name: "plain" });
    const { app: a } = gitApp({});
    const res = await a.inject({
      method: "POST",
      url: "/api/code-repos/plain/pull",
      headers: { host: HOST },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
    await a.close();
  });
});

describe("代码库：自动同步", () => {
  /** 两个仓库：alpha 是 git 仓库（干净），dirty 是 git 仓库但有本地改动，plain 不是 git 仓库。 */
  async function syncApp() {
    for (const name of ["alpha", "dirty", "plain"])
      await call("POST", "/api/code-repos", { name });
    for (const name of ["alpha", "dirty"])
      mkdir(join(dir, "files", "代码库", name, ".git"), { recursive: true });
    const files = createFileStore(join(dir, "files"), index);
    const pulled: string[] = [];
    const a = Fastify({ logger: false });
    const git: GitDeps = {
      reindex: () => Promise.resolve(0),
      run: (args, cwd) => {
        if (args[0] === "status")
          return Promise.resolve({
            code: 0,
            output: cwd.endsWith("dirty") ? " M a.ts\n" : "",
          });
        if (args[0] === "merge") pulled.push(cwd.split("/").pop() ?? "");
        return Promise.resolve({ code: 0, output: "" });
      },
    };
    registerCodeRepoRoutes(a, db, files, Date.now, git);
    return { a, pulled };
  }
  const req = async (
    a: FastifyInstance,
    method: "GET" | "PUT" | "POST",
    url: string,
    payload?: object,
  ) => {
    const res = await a.inject({
      method,
      url,
      headers: { host: HOST },
      ...(payload ? { payload } : {}),
    });
    return {
      status: res.statusCode,
      body: res.json<Record<string, unknown>>(),
    };
  };

  it("默认关闭；开启后存下来并排好下一轮；非法间隔 400", async () => {
    const { a } = await syncApp();
    const first = await req(a, "GET", "/api/code-repos/auto-sync");
    expect(first.body).toMatchObject({
      enabled: false,
      intervalMinutes: 60,
      nextRunAt: null,
      lastRun: null,
    });
    const on = await req(a, "PUT", "/api/code-repos/auto-sync", {
      enabled: true,
      intervalMinutes: 30,
    });
    expect(on.body).toMatchObject({ enabled: true, intervalMinutes: 30 });
    expect(typeof on.body.nextRunAt).toBe("number");
    // 校验错误转 400 靠完整服务的错误处理，所以走 createApp 那一份。
    const bad = await call("PUT", "/api/code-repos/auto-sync", {
      enabled: true,
      intervalMinutes: 1,
    });
    expect(bad.status).toBe(400);
    await a.close();

    // 重启后配置还在。
    const b = Fastify({ logger: false });
    registerCodeRepoRoutes(b, db, createFileStore(join(dir, "files"), index));
    const again = await req(b, "GET", "/api/code-repos/auto-sync");
    expect(again.body).toMatchObject({ enabled: true, intervalMinutes: 30 });
    await b.close();
  });

  it("立即同步：只拉 git 仓库；有本地改动的不覆盖、记为失败", async () => {
    const { a, pulled } = await syncApp();
    const res = await req(a, "POST", "/api/code-repos/auto-sync/run");
    expect(res.status).toBe(200);
    const run = res.body.lastRun as {
      trigger: string;
      results: { name: string; ok: boolean; error: string | null }[];
    };
    expect(run.trigger).toBe("manual");
    expect(run.results.map((r) => r.name).sort()).toEqual(["alpha", "dirty"]);
    expect(run.results.find((r) => r.name === "alpha")?.ok).toBe(true);
    const dirty = run.results.find((r) => r.name === "dirty");
    expect(dirty?.ok).toBe(false);
    expect(dirty?.error).toContain("本地改动");
    expect(pulled).toEqual(["alpha"]);
    await a.close();
  });
});
