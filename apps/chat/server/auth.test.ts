import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { INTERNAL_HEADER, registerAuth, SESSION_COOKIE } from "./auth.js";
import { IN_MEMORY, openDb, type Db } from "./db.js";
import { HttpError } from "./errors.js";
import { createKeyStore } from "./model-config.js";
import { piPaths } from "./pi/runtime.js";
import { createSkillStore } from "./skills.js";

/**
 * 登录模块。两层测：
 * - 直接挂到一个最小的 fastify 上，测登录闸本身（设置、登录、锁定、改密、内部凭证）；
 * - 挂进真实的 createApp，确认默认就开着、业务接口真的被挡住。
 */

let db: Db;
let app: FastifyInstance;
let internalToken: string;
let clock: number;

beforeEach(async () => {
  db = openDb(IN_MEMORY);
  clock = 1_000_000;
  app = Fastify();
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError)
      return reply
        .code(error.status)
        .send({ error: { code: error.code, message: error.message } });
    return reply.code(400).send({ error: { code: "BAD_REQUEST" } });
  });
  ({ internalToken } = registerAuth(app, db, () => clock));
  app.get("/api/secret", () => ({ secret: 42 }));
  app.get("/index.html", () => "page");
  await app.ready();
});
afterEach(async () => {
  await app.close();
  db.close();
});

/** 从 set-cookie 里取出登录凭证，拼成下一次请求要带的 cookie 头。 */
const cookieOf = (res: { headers: Record<string, unknown> }): string => {
  const header = res.headers["set-cookie"];
  const raw = Array.isArray(header)
    ? String(header[0] ?? "")
    : typeof header === "string"
      ? header
      : "";
  return raw.split(";")[0] ?? "";
};

const post = (url: string, payload: object, cookie?: string) =>
  app.inject({
    method: "POST",
    url,
    payload,
    headers: cookie === undefined ? {} : { cookie },
  });
const get = (url: string, cookie?: string) =>
  app.inject({
    method: "GET",
    url,
    headers: cookie === undefined ? {} : { cookie },
  });

const setup = () =>
  post("/api/auth/setup", { username: "pm", password: "correct-horse" });

describe("登录闸", () => {
  it("没登录：业务接口 401，页面与状态接口照常", async () => {
    expect((await get("/api/secret")).statusCode).toBe(401);
    expect((await get("/index.html")).statusCode).toBe(200);
    const status = await get("/api/auth/status");
    expect(status.json()).toEqual({ setupRequired: true, user: null });
  });

  it("路径经 URL 编码变形也绕不过登录闸（不能读别人的数据）", async () => {
    /*
     * 这是实测过的真实漏洞（2026-10-31 安全审计）：原来按 `request.url` 前缀判断，
     * 而 onRequest 拿到的 url 是未解码的原始串，`/%61pi/sessions`（%61 = a）看着不是
     * /api/ 开头就放行了，Fastify 却把它匹配到 /api/sessions。不登录即可读全部数据。
     * 现在按路由模板判断，下面这些变形都必须挡住。
     */
    for (const path of [
      "/%61pi/secret",
      "/api/%2e%2e/%61pi/secret",
      "/api/%2E%2E/secret",
      "/API/secret",
      "/api//secret",
    ]) {
      const res = await app.inject({ method: "GET", url: path });
      expect(
        [401, 404].includes(res.statusCode),
        `${path} 应当被拒，实际 ${String(res.statusCode)}`,
      ).toBe(true);
      expect(res.body).not.toContain("42");
    }
    // 正常路径仍然按未登录拒绝，但登录后放行。
    expect((await get("/api/secret")).statusCode).toBe(401);
    expect((await get("/api/secret", cookieOf(await setup()))).statusCode).toBe(
      200,
    );
  });

  it("内部凭证：多字节字符不会再打出 500", async () => {
    // 原来用 UTF-16 码元长度对字节长度比较，6 个多字节字符就能让 timingSafeEqual 抛错。
    const res = await app.inject({
      method: "GET",
      url: "/api/secret",
      headers: { [INTERNAL_HEADER]: "é".repeat(64) },
    });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain("INTERNAL");
  });

  it("首次设置：建账户并直接登录；之后不能再设置", async () => {
    const res = await setup();
    expect(res.statusCode).toBe(200);
    const cookie = cookieOf(res);
    expect(cookie.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
    expect(String(res.headers["set-cookie"])).toContain("HttpOnly");
    expect((await get("/api/secret", cookie)).json()).toEqual({ secret: 42 });
    expect((await get("/api/auth/status", cookie)).json()).toMatchObject({
      setupRequired: false,
      user: { username: "pm" },
    });
    const again = await post("/api/auth/setup", {
      username: "intruder",
      password: "whatever123",
    });
    expect(again.statusCode).toBe(409);
  });

  it("Cookie 里有畸形百分号编码时按未登录处理，不 500", async () => {
    await setup();
    // 任何人写一个坏 Cookie 就能让每个接口 500 —— 这不是安全问题，是一键打瘫。
    for (const bad of ["%", "%E0%A4%A", "%zz"]) {
      const res = await get("/api/secret", `${SESSION_COOKIE}=${bad}`);
      expect(res.statusCode, bad).toBe(401);
    }
  });

  it("密码不存明文，凭证只存摘要", async () => {
    const cookie = cookieOf(await setup());
    const user = db
      .prepare<[], { password_hash: string }>("SELECT password_hash FROM users")
      .get();
    expect(user?.password_hash).not.toContain("correct-horse");
    const token = decodeURIComponent(cookie.split("=")[1] ?? "");
    const row = db
      .prepare<[string], { n: number }>(
        "SELECT COUNT(*) AS n FROM auth_sessions WHERE token_hash = ?",
      )
      .get(token);
    expect(row?.n).toBe(0);
  });

  it("设置时校验密码长度", async () => {
    const res = await post("/api/auth/setup", {
      username: "pm",
      password: "short",
    });
    expect(res.statusCode).toBe(400);
  });

  it("哈希串里带 scrypt 参数，且能读懂老格式", async () => {
    await setup();
    const row = db
      .prepare<[], { password_hash: string }>("SELECT password_hash FROM users")
      .get();
    // 带参数才可能将来提高强度：不然老哈希分不清是哪一档算出来的。
    expect(row?.password_hash).toMatch(/^scrypt\$N=\d+,r=\d+,p=\d+\$/);
    // 老格式（三段）仍然能登录：已经部署的环境里全是这种。
    const legacy = row?.password_hash.replace(/^scrypt\$N=[^$]+\$/, "scrypt$");
    db.prepare("UPDATE users SET password_hash = ?").run(legacy);
    const ok = await post("/api/auth/login", {
      username: "pm",
      password: "correct-horse",
    });
    expect(ok.statusCode).toBe(200);
  });

  it("失败计数落库：重启后锁定仍然有效", async () => {
    await setup();
    for (let i = 0; i < 5; i++)
      await post("/api/auth/login", { username: "pm", password: "nope-nope" });
    // 模拟重启：同一个库，新起一套登录闸。
    const reborn = Fastify();
    reborn.setErrorHandler((error, _req, reply) =>
      error instanceof HttpError
        ? reply
            .code(error.status)
            .send({ error: { code: error.code, message: error.message } })
        : reply.code(400).send({}),
    );
    registerAuth(reborn, db, () => clock);
    const res = await reborn.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { host: "127.0.0.1:4400" },
      payload: { username: "pm", password: "correct-horse" },
    });
    expect(res.statusCode).toBe(429);
    await reborn.close();
  });

  it("登录：对的放行（用户名不分大小写），错的 401 且不说是哪个错", async () => {
    await setup();
    const bad = await post("/api/auth/login", {
      username: "pm",
      password: "wrong-password",
    });
    expect(bad.statusCode).toBe(401);
    const noUser = await post("/api/auth/login", {
      username: "nobody",
      password: "wrong-password",
    });
    expect(noUser.json()).toEqual(bad.json());
    const ok = await post("/api/auth/login", {
      username: "PM",
      password: "correct-horse",
    });
    expect(ok.statusCode).toBe(200);
    expect((await get("/api/secret", cookieOf(ok))).statusCode).toBe(200);
  });

  it("连续输错 5 次锁 1 分钟，过后恢复", async () => {
    await setup();
    for (let i = 0; i < 5; i++)
      await post("/api/auth/login", { username: "pm", password: "nope-nope" });
    const locked = await post("/api/auth/login", {
      username: "pm",
      password: "correct-horse",
    });
    expect(locked.statusCode).toBe(429);
    clock += 61_000;
    const ok = await post("/api/auth/login", {
      username: "pm",
      password: "correct-horse",
    });
    expect(ok.statusCode).toBe(200);
  });

  it("锁定逐轮加长：第一轮 1 分钟，第二轮更长，不让慢速爆破", async () => {
    await setup();
    const wrong = () =>
      post("/api/auth/login", { username: "pm", password: "nope-nope" });
    const right = () =>
      post("/api/auth/login", { username: "pm", password: "correct-horse" });
    for (let i = 0; i < 5; i++) await wrong();
    expect((await right()).statusCode).toBe(429);
    clock += 61_000; // 第一轮锁到期
    for (let i = 0; i < 5; i++) await wrong(); // 再错 5 次：第二轮
    // 这一轮锁 5 分钟：过 1 分钟仍然锁着。
    clock += 61_000;
    expect((await right()).statusCode).toBe(429);
    clock += 5 * 60_000;
    expect((await right()).statusCode).toBe(200);
  });

  it("同一 IP 换着用户名试也会被锁", async () => {
    await setup();
    // 每次换一个不存在的用户名：单看用户名各自只错一次，但同一来源累计到上限。
    for (let i = 0; i < 20; i++)
      await post("/api/auth/login", {
        username: `nobody${String(i)}`,
        password: "nope-nope",
      });
    const res = await post("/api/auth/login", {
      username: "pm",
      password: "correct-horse",
    });
    expect(res.statusCode).toBe(429);
  });

  it("登录 30 天后过期", async () => {
    const cookie = cookieOf(await setup());
    clock += 31 * 24 * 3600 * 1000;
    expect((await get("/api/secret", cookie)).statusCode).toBe(401);
  });

  it("退出登录：凭证作废", async () => {
    const cookie = cookieOf(await setup());
    await post("/api/auth/logout", {}, cookie);
    expect((await get("/api/secret", cookie)).statusCode).toBe(401);
  });

  it("改密码：当前密码要对；改完其他地方下线，当前这台继续可用", async () => {
    const first = cookieOf(await setup());
    const other = cookieOf(
      await post("/api/auth/login", {
        username: "pm",
        password: "correct-horse",
      }),
    );
    const wrong = await post(
      "/api/auth/password",
      { current: "nope", next: "brand-new-pass" },
      first,
    );
    expect(wrong.statusCode).toBe(400);
    const changed = await post(
      "/api/auth/password",
      { current: "correct-horse", next: "brand-new-pass" },
      first,
    );
    expect(changed.statusCode).toBe(200);
    expect((await get("/api/secret", other)).statusCode).toBe(401);
    expect((await get("/api/secret", cookieOf(changed))).statusCode).toBe(200);
    const relogin = await post("/api/auth/login", {
      username: "pm",
      password: "brand-new-pass",
    });
    expect(relogin.statusCode).toBe(200);
  });

  it("进程内部调用：带对的内部凭证放行，假的不放", async () => {
    const ok = await app.inject({
      method: "GET",
      url: "/api/secret",
      headers: { [INTERNAL_HEADER]: internalToken },
    });
    expect(ok.statusCode).toBe(200);
    const fake = await app.inject({
      method: "GET",
      url: "/api/secret",
      headers: { [INTERNAL_HEADER]: "0".repeat(internalToken.length) },
    });
    expect(fake.statusCode).toBe(401);
  });
});

describe("真实服务默认开着登录闸", () => {
  let dir: string;
  let real: FastifyInstance;
  let realDb: Db;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pmforge-auth-"));
    realDb = openDb(IN_MEMORY);
    ({ app: real } = createApp({
      db: realDb,
      paths: piPaths(dir),
      keys: createKeyStore(dir, {}),
      skills: createSkillStore({
        dir: join(dir, "skills"),
        targetDirs: {
          pi: join(dir, "targets", "pi"),
        },
      }),
      security: false,
    }));
  });
  afterEach(async () => {
    await real.close();
    realDb.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("不传 auth 时，对话、产品接口都要登录", async () => {
    for (const url of ["/api/sessions", "/api/product-lines"]) {
      const res = await real.inject({ method: "GET", url });
      expect(res.statusCode).toBe(401);
    }
  });
});
