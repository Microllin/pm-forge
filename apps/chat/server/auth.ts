import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { Db } from "./db.js";
import { HttpError } from "./errors.js";

/**
 * 登录模块。
 *
 * ## 为什么要有
 *
 * 部署到开发机给局域网用时（PMFORGE_CHAT_WEB_HOST=0.0.0.0），页面服务把 /api 原样代理到
 * 对话服务。没有登录的话，同一局域网里谁打开地址都能看全部产品、文件、对话，还能花你的
 * 模型 key。Host / Origin 闸（security.ts）挡的是「恶意网页借你的浏览器」，挡不住「别人
 * 直接打开页面」。
 *
 * ## 现在是单账户，表结构按多账户搭
 *
 * 第一次打开页面时设置唯一的账户（setup），之后只能登录，不能再注册。`users` 是真的一张
 * 用户表、会话挂 `user_id`，以后做多账户 / 数据隔离时往上加，不用推倒。
 *
 * ## 取舍
 *
 * - 密码用 scrypt 加盐存，不存明文；登录凭证是随机串，库里只存它的 sha256——库文件泄了
 *   也拿不到能用的凭证。
 * - 凭证放 HttpOnly Cookie：页面脚本读不到，图片 / PDF / 流式对话这些浏览器直连的请求
 *   也会自动带上，不用每处改。
 * - 首次设置有「抢先」风险（设好之前局域网里谁先打开谁设）。这是使用者明确接受的取舍；
 *   一旦有了账户，setup 接口永久关闭。
 * - 进程内部调用（售前助手的工具走 app.inject）带一个每次启动随机生成的内部凭证放行，
 *   外部请求伪造不了。
 */

export const SESSION_COOKIE = "pmforge_session";
/** 登录保持多久。局域网自用，30 天免得天天输。 */
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
/** 进程内部调用的凭证头。 */
export const INTERNAL_HEADER = "x-pmforge-internal";

/**
 * 登录失败的处理：按**用户名**与**来源 IP** 两个维度分别计数，锁定时长按次数指数增长。
 *
 * 原来是「同一个用户名错 5 次锁 60 秒」：折算每天约 7200 次尝试，慢速爆破完全可行；
 * 而反向也成立——故意连错 5 次就能把别人锁一分钟，循环打等于持续锁死。
 * 现在：
 * - 锁定时长随失败轮次翻倍（1 → 5 → 15 → 60 分钟封顶），爆破成本随次数增长；
 * - 同一 IP 跨用户名的失败也计入，拦住「换着用户名试」；
 * - 用户不存在时照样跑一次 scrypt（见 `verifyPassword` 的 dummy），抹平响应时间差。
 */
const MAX_FAILURES = 5;
/** 第 n 轮锁定的时长（分钟）。封顶 60 分钟。 */
const LOCK_STEPS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
/** 同一 IP 上限更宽：局域网里可能有人在共用一个出口。 */
const MAX_FAILURES_PER_IP = 20;
/** 用户不存在时用来抹平时间的假哈希：固定盐，只为消耗同样多的 CPU。 */
const DUMMY_HASH = `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`;

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/*
 * 哈希串里带上参数：`scrypt$N=16384,r=8,p=1$<salt>$<key>`。
 *
 * 原来只存 `scrypt$<salt>$<key>`，参数用的是 Node 默认值（N=16384, r=8, p=1）。
 * 将来想提高成本参数时，老哈希无法区分是哪一档算出来的——要么所有老密码都验不过，
 * 要么只能永远停留在当前强度。写进去之后可以逐条按自己的参数验、登录时顺手升级。
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_PARAMS = `N=${String(SCRYPT_N)},r=${String(SCRYPT_R)},p=${String(SCRYPT_P)}`;

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${SCRYPT_PARAMS}$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** 从哈希串里取参数；老格式（没有参数段）按当时的默认值处理。 */
function parseHash(stored: string): {
  params: string;
  saltHex: string;
  keyHex: string;
} | null {
  const parts = stored.split("$");
  if (parts[0] !== "scrypt") return null;
  if (parts.length === 3) {
    // 老格式：scrypt$salt$key，参数是 Node 当时的默认值。
    const [, saltHex, keyHex] = parts;
    return saltHex === undefined || keyHex === undefined
      ? null
      : { params: SCRYPT_PARAMS, saltHex, keyHex };
  }
  if (parts.length === 4) {
    const [, params, saltHex, keyHex] = parts;
    return params === undefined || saltHex === undefined || keyHex === undefined
      ? null
      : { params, saltHex, keyHex };
  }
  return null;
}

async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parsed = parseHash(stored);
  if (parsed === null) return false;
  const expected = Buffer.from(parsed.keyHex, "hex");
  if (expected.length === 0) return false;
  const actual = await scryptAsync(
    password,
    Buffer.from(parsed.saltHex, "hex"),
    expected.length,
  );
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string): string =>
  createHash("sha256").update(s).digest("hex");

const username = z
  .string({ error: "用户名必填" })
  .trim()
  .min(2, "用户名至少 2 个字")
  .max(40, "用户名最多 40 个字")
  .regex(/^[\w.@-]+$/u, "用户名只能用字母、数字和 _ . @ -");
const password = z
  .string({ error: "密码必填" })
  .min(8, "密码至少 8 位")
  .max(128, "密码最多 128 位");

const credentialsBody = z.object({ username, password });
const loginBody = z.object({
  username: z.string().trim().min(1, "请输入用户名"),
  password: z.string().min(1, "请输入密码"),
});
const changePasswordBody = z.object({
  current: z.string().min(1, "请输入当前密码"),
  next: password,
});

export interface AuthUser {
  id: string;
  username: string;
}

/**
 * 不需要登录就能访问的接口：查状态、首次设置、登录。
 *
 * 这里写的是**路由模板**（`request.routeOptions.url` 的值），不是请求里的原始路径。
 * 两者在带参数的路由上也一致（如 `/api/sessions/:id`），比对时按模板前缀判断。
 */
const PUBLIC_API = new Set([
  // 健康检查只回「服务活着」，不含数据；登录页也要靠它判断连没连上。
  "/api/health",
  "/api/auth/status",
  "/api/auth/setup",
  "/api/auth/login",
]);

/** 这个路由模板是不是接口。非接口（静态页之类）不归登录闸管。 */
function isApiRoute(template: string | undefined): boolean {
  return template?.startsWith("/api/") === true;
}

declare module "fastify" {
  interface FastifyRequest {
    /** 当前登录的用户。内部调用为 null。 */
    authUser?: AuthUser | null;
  }
}

/**
 * 读一个 Cookie。
 *
 * 值用 decodeURIComponent 解码，但它遇到畸形的百分号编码（`%`、`%E0%A4%A`）会抛
 * URIError。以前这里没兜住：任何人只要在浏览器里写一个坏 Cookie，之后每个接口都
 * 500——不是安全问题，是任何人都能一键把服务打瘫。解析不了就当没这个 Cookie。
 */
function readCookie(request: FastifyRequest, name: string): string | null {
  const raw = request.headers.cookie;
  if (raw === undefined) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function setSessionCookie(reply: FastifyReply, token: string): void {
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(Math.floor(SESSION_TTL_MS / 1000))}`,
  );
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

/**
 * 进程内部凭证的比较：先比**字节长度**，再定时安全比较，并兜住异常。
 *
 * 原来用 `internal.length === internalToken.length`：这是 UTF-16 码元数，而
 * `timingSafeEqual` 比的是字节数。6 个多字节字符（如 "é".repeat(64)，128 字节）
 * 就能过长度检查，再让 timingSafeEqual 抛 RangeError —— 未登录也能稳定打出 500。
 */
function internalTokenMatches(given: string, expected: string): boolean {
  try {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export interface Auth {
  /** 进程内部调用要带的凭证（放在 INTERNAL_HEADER 头里）。 */
  internalToken: string;
}

export function registerAuth(
  app: FastifyInstance,
  db: Db,
  now: () => number = Date.now,
): Auth {
  const internalToken = randomBytes(32).toString("hex");
  /*
   * 登录失败计数落库（`login_failures` 表，本模块自建）。
   *
   * 原来只在内存 Map 里：重启清零。对局域网常驻服务来说，「重启一下就重新拥有完整
   * 尝试额度」意味着限速等于没有——攻击者只要等到一次升级/重启。落库之后重启不清零，
   * 过期的记录在每次查询时顺手清掉，表不会长。
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS login_failures (
      bucket     TEXT PRIMARY KEY,
      count      INTEGER NOT NULL,
      until      INTEGER NOT NULL,
      rounds     INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const readFailure = (
    bucket: string,
  ): { count: number; until: number; rounds: number } | undefined =>
    db
      .prepare<[string], { count: number; until: number; rounds: number }>(
        "SELECT count, until, rounds FROM login_failures WHERE bucket = ?",
      )
      .get(bucket);
  const writeFailure = (
    bucket: string,
    f: { count: number; until: number; rounds: number },
  ): void => {
    db.prepare(
      `INSERT INTO login_failures (bucket, count, until, rounds, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(bucket) DO UPDATE SET count = excluded.count,
         until = excluded.until, rounds = excluded.rounds,
         updated_at = excluded.updated_at`,
    ).run(bucket, f.count, f.until, f.rounds, now());
  };

  /** 记一次失败并返回要锁到什么时候（0 = 还没到锁的程度）。 */
  const recordFailure = (bucket: string, limit: number): void => {
    const prev = readFailure(bucket);
    // 上一轮锁已到期（或从没锁过）的，从 1 数起；还在同一轮里的接着累加。
    const count = prev?.until === 0 ? prev.count + 1 : 1;
    const rounds = prev?.rounds ?? 0;
    if (count < limit) {
      writeFailure(bucket, { count, until: 0, rounds });
      return;
    }
    const step =
      LOCK_STEPS_MS[Math.min(rounds, LOCK_STEPS_MS.length - 1)] ?? 60_000;
    writeFailure(bucket, { count: 0, until: now() + step, rounds: rounds + 1 });
  };

  /** 当前是否被锁着；锁着就抛 429。 */
  const throwIfLocked = (bucket: string): void => {
    const lock = readFailure(bucket);
    if (lock === undefined || lock.until === 0 || lock.until <= now()) return;
    throw new HttpError(
      429,
      "TOO_MANY_ATTEMPTS",
      `输错次数太多，请 ${String(Math.ceil((lock.until - now()) / 1000))} 秒后再试`,
    );
  };

  const userCount = (): number =>
    db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM users").get()?.n ??
    0;

  const startSession = (reply: FastifyReply, userId: string): void => {
    const token = randomBytes(32).toString("base64url");
    const t = now();
    db.prepare(
      "INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
    ).run(sha256(token), userId, t, t + SESSION_TTL_MS);
    // 顺手清掉过期的，表不会无限长。
    db.prepare("DELETE FROM auth_sessions WHERE expires_at < ?").run(t);
    setSessionCookie(reply, token);
  };

  const userOf = (request: FastifyRequest): AuthUser | null => {
    const token = readCookie(request, SESSION_COOKIE);
    if (token === null || token === "") return null;
    const row = db
      .prepare<[string, number], { id: string; username: string }>(
        "SELECT u.id, u.username FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
      )
      .get(sha256(token), now());
    return row ?? null;
  };

  /*
   * 登录闸挂在 preHandler 而不是 onRequest。
   *
   * onRequest 阶段拿到的 `request.url` 是**未经解码、未归一化**的原始串，而路由匹配用的是
   * 解码后的值。于是 `/%61pi/sessions`（%61 = a）这样一条请求：onRequest 看到的是
   * `/%61pi/sessions`，不以 `/api/` 开头，放行；Fastify 却把它匹配到 `/api/sessions`
   * 并执行了。实测确认：不带任何凭证即可读写全部接口（2026-10-31，安全审计）。
   *
   * preHandler 在路由匹配之后执行，能拿到 `request.routeOptions.url` —— 它是路由表里的
   * **模板**（`/api/sessions`、`/api/sessions/:id`），由我们自己注册时写定，请求方无法伪造。
   * 用它判断「这是不是一个接口」，路径变形就绕不过去了。
   *
   * 代价：未匹配到任何路由的请求不会进 preHandler（Fastify 直接回 404），
   * 这正好是我们想要的——404 本来就不含任何数据。
   */
  app.addHook("preHandler", (request, _reply, done) => {
    const template = request.routeOptions.url;
    // 只管接口。页面本身（打包产物）由页面服务托管，不含数据。
    if (!isApiRoute(template) || PUBLIC_API.has(template ?? "")) {
      done();
      return;
    }
    /*
     * 进程内部调用（售前助手的工具走 app.inject）。
     *
     * 长度比较原来用 `internal.length`（UTF-16 码元）对 `timingSafeEqual`（比字节），
     * 6 个多字节字符就能通过长度检查再让它抛错——未登录也能稳定打出 500。
     * 改成比字节长度，并且比较本身也兜住异常。
     */
    const internal = request.headers[INTERNAL_HEADER];
    if (
      typeof internal === "string" &&
      internalTokenMatches(internal, internalToken)
    ) {
      request.authUser = null;
      done();
      return;
    }
    const user = userOf(request);
    if (user === null) {
      done(new HttpError(401, "UNAUTHORIZED", "请先登录"));
      return;
    }
    request.authUser = user;
    done();
  });

  app.get("/api/auth/status", (request) => ({
    setupRequired: userCount() === 0,
    user: userOf(request),
  }));

  app.post("/api/auth/setup", async (request, reply) => {
    const v = credentialsBody.parse(request.body);
    if (userCount() > 0)
      throw new HttpError(409, "ALREADY_SETUP", "账户已经设置过了，请直接登录");
    const id = randomUUID();
    const t = now();
    const hash = await hashPassword(v.password);
    // 再查一次再写：两个人几乎同时提交时，只让第一个成功。
    const created = db.transaction(() => {
      if (userCount() > 0) return false;
      db.prepare(
        "INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run(id, v.username, hash, t, t);
      return true;
    })();
    if (!created)
      throw new HttpError(409, "ALREADY_SETUP", "账户已经设置过了，请直接登录");
    startSession(reply, id);
    return { user: { id, username: v.username } };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const v = loginBody.parse(request.body);
    const userKey = `u:${v.username.toLowerCase()}`;
    const ipKey = `ip:${request.ip}`;
    throwIfLocked(userKey);
    throwIfLocked(ipKey);

    const row = db
      .prepare<
        [string],
        { id: string; username: string; password_hash: string }
      >(
        "SELECT id, username, password_hash FROM users WHERE username = ? COLLATE NOCASE",
      )
      .get(v.username);
    /*
     * 用户不存在时也跑一次 scrypt。
     *
     * 原来直接短路返回，而存在的用户要先算几十毫秒——响应时间就能区分出哪些用户名是真的，
     * 再对这些真用户名慢速爆破。用固定盐的假哈希把两条路径的时间抹平。
     */
    const ok = await verifyPassword(
      v.password,
      row?.password_hash ?? DUMMY_HASH,
    );
    if (row === undefined || !ok) {
      recordFailure(userKey, MAX_FAILURES);
      recordFailure(ipKey, MAX_FAILURES_PER_IP);
      // 不区分「没这个用户」和「密码错」，免得被拿来试探用户名。
      throw new HttpError(401, "BAD_CREDENTIALS", "用户名或密码不对");
    }
    db.prepare("DELETE FROM login_failures WHERE bucket = ?").run(userKey);
    startSession(reply, row.id);
    return { user: { id: row.id, username: row.username } };
  });

  app.post("/api/auth/logout", (request, reply) => {
    const token = readCookie(request, SESSION_COOKIE);
    if (token !== null)
      db.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").run(
        sha256(token),
      );
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post("/api/auth/password", async (request, reply) => {
    const v = changePasswordBody.parse(request.body);
    const user = request.authUser;
    if (user === undefined || user === null)
      throw new HttpError(401, "UNAUTHORIZED", "请先登录");
    const row = db
      .prepare<[string], { password_hash: string }>(
        "SELECT password_hash FROM users WHERE id = ?",
      )
      .get(user.id);
    if (
      row === undefined ||
      !(await verifyPassword(v.current, row.password_hash))
    )
      throw new HttpError(400, "BAD_CREDENTIALS", "当前密码不对");
    const hash = await hashPassword(v.next);
    db.prepare(
      "UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?",
    ).run(hash, now(), user.id);
    // 改了密码，其他地方登着的一律下线；当前这台换一张新凭证继续用。
    db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);
    startSession(reply, user.id);
    return { ok: true };
  });

  return { internalToken };
}
