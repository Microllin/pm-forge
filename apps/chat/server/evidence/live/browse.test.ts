import { createServer, type Server } from "node:http";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { createApp } from "../../app.js";
import { IN_MEMORY, openDb, type Db } from "../../db.js";
import {
  createFileStore,
  openFilesIndex,
  type FileStore,
} from "../../files/store.js";
import { createKeyStore } from "../../model-config.js";
import { piPaths } from "../../pi/runtime.js";
import { createCatalog } from "../../products.js";
import { createSkillStore } from "../../skills.js";
import { maskSecrets, openReadOnly, WRITE_WORDS } from "./browser.js";
import { createEnvStore } from "./envs.js";

/**
 * 只读浏览。这是「对话没有工具」那条边界的唯一放开处，
 * 所以这里守的全是「只读」本身——用一个本地假测试环境 + 真浏览器跑：
 *   ① 页面脚本自己发的写请求被网络层拦下，服务端一次都没收到；
 *   ② 像写操作的按钮、表单里的按钮不给点；
 *   ③ 跳出测试环境的导航被拦；
 *   ④ 账号密码不进任何接口响应，落盘文件权限 600。
 *
 * 本机没有 Chromium 时浏览器相关用例跳过（只读口径的纯函数部分照测）。
 */

let server: Server;
let base = "";
const hits = { writes: 0, logins: 0 };

const page = (body: string) =>
  `<!doctype html><html><head><meta charset=utf-8><title>假环境</title></head><body><nav><a href="/orders">订单管理</a> <a href="/users">用户管理</a></nav><main>${body}</main></body></html>`;

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const authed = (req.headers.cookie ?? "").includes("sid=ok");
    if (req.method === "POST" && u.pathname === "/api/login") {
      hits.logins += 1;
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        // 只认 u / p：其余凭据回到登录页（测「登录失败」要真失败）。
        const ok = /username=u(&|$)/.test(body) && /password=p(&|$)/.test(body);
        res.writeHead(
          302,
          ok
            ? { "set-cookie": "sid=ok; Path=/", location: "/orders" }
            : { location: "/login?error=1" },
        );
        res.end();
      });
      return;
    }
    if (req.method !== "GET") {
      hits.writes += 1;
      res.end("{}");
      return;
    }
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (u.pathname === "/login") {
      res.end(
        `<!doctype html><form method=post action=/api/login><label>用户名<input name=username></label><label>密码<input type=password name=password></label><button type=submit>登录</button></form>`,
      );
      return;
    }
    if (!authed) {
      res.writeHead(302, { location: "/login" });
      res.end();
      return;
    }
    if (u.pathname === "/orders") {
      res.end(
        page(
          `<h1>订单管理</h1><button onclick="fetch('/api/orders/1',{method:'DELETE'})">删除</button><table><thead><tr><th>订单号</th><th>金额</th></tr></thead><tbody><tr><td>A001</td><td>99.00</td></tr></tbody></table><a href="/orders/A001">查看</a><p>密钥 sk-abcdefghijklmnopqrstuvwx</p>`,
        ),
      );
      return;
    }
    if (u.pathname === "/orders/A001") {
      res.end(
        page(
          `<h1>订单详情</h1><form><label>备注<input></label><button type=button>查看</button></form><a href="https://example.com/out">外链</a>`,
        ),
      );
      return;
    }
    if (u.pathname === "/sneaky") {
      res.end(
        page(
          `<h1>偷偷写</h1><script>fetch('/api/x',{method:'POST',body:'1'});fetch('/api/y',{method:'DELETE'})</script>`,
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${String(typeof addr === "object" && addr !== null ? addr.port : 0)}`;
});

afterAll(async () => {
  await new Promise<void>((r) => {
    server.close(() => {
      r();
    });
  });
});

const hasChromium = await (async () => {
  try {
    const b = await openReadOnly(
      { baseUrl: "http://127.0.0.1:9", username: "x", password: "x" },
      { settleMs: 0 },
    ).catch((e: unknown) => e);
    // 起得来浏览器、只是连不上地址：说明本机有 Chromium。
    return !(
      b instanceof Error &&
      /Executable|browserType\.launch|没找到可用的浏览器内核/.test(b.message)
    );
  } catch {
    return false;
  }
})();

describe("只读口径（纯函数）", () => {
  it("像写操作的按钮文字一律认出来", () => {
    for (const w of [
      "删除",
      "新建订单",
      "保存",
      "提交",
      "确认",
      "退出登录",
      "Delete",
      "Submit",
    ])
      expect(WRITE_WORDS.test(w)).toBe(true);
    for (const w of ["订单管理", "查看", "详情", "下一页", "用户管理"])
      expect(WRITE_WORDS.test(w)).toBe(false);
  });

  it("页面里像密钥的文字打码", () => {
    expect(maskSecrets("key sk-abcdefghijklmnopqrstuvwx end")).toBe(
      "key sk-abc…（已打码） end",
    );
  });
});

describe.skipIf(!hasChromium)("只读浏览器（真浏览器 + 本地假环境）", () => {
  it("登录后读到文字结构：标题、菜单、表格、按钮；密钥打码", async () => {
    const b = await openReadOnly(
      { baseUrl: base, username: "u", password: "p" },
      { settleMs: 50 },
    );
    try {
      const s = await b.open("/orders");
      expect(s.text).toContain("标题：订单管理");
      expect(s.text).toContain("菜单：订单管理、用户管理");
      expect(s.text).toContain("列 = 订单号 | 金额");
      expect(s.text).toContain("A001 | 99.00");
      expect(s.text).not.toContain("sk-abcdefghijklmnop");
      expect(s.screenshot.length).toBeGreaterThan(1000);
    } finally {
      await b.close();
    }
  });

  it("页面脚本自己发的写请求被拦下，服务端一次都没收到", async () => {
    const before = hits.writes;
    const b = await openReadOnly(
      { baseUrl: base, username: "u", password: "p" },
      { settleMs: 200 },
    );
    try {
      const s = await b.open("/sneaky");
      expect(s.blocked).toEqual(
        expect.arrayContaining(["POST /api/x", "DELETE /api/y"]),
      );
    } finally {
      await b.close();
    }
    expect(hits.writes).toBe(before);
  });

  it("写操作按钮、表单里的按钮不给点；导航可以点", async () => {
    const before = hits.writes;
    const b = await openReadOnly(
      { baseUrl: base, username: "u", password: "p" },
      { settleMs: 50 },
    );
    try {
      await b.open("/orders");
      await expect(b.click("删除")).rejects.toThrow("只读模式下不点");
      const detail = await b.click("查看");
      expect(detail.path).toBe("/orders/A001");
      await expect(b.click("查看")).rejects.toThrow("在表单里");
    } finally {
      await b.close();
    }
    expect(hits.writes).toBe(before);
  });

  it("不能打开、也不能跳到测试环境以外的地方", async () => {
    const b = await openReadOnly(
      { baseUrl: base, username: "u", password: "p" },
      { settleMs: 50 },
    );
    try {
      await expect(b.open("https://example.com/")).rejects.toThrow(
        "只能打开登记的测试环境",
      );
      await b.open("/orders/A001");
      const out = await b.click("外链");
      expect(out.blocked.join()).toContain("跳出测试环境");
    } finally {
      await b.close();
    }
  });

  it(
    "账号密码错了：如实报还停在登录页，不带出账号密码",
    { timeout: 20_000 },
    async () => {
      const err = await openReadOnly(
        {
          baseUrl: base,
          username: "secret-user",
          password: "secret-pw",
        },
        { settleMs: 50 },
      ).catch((e: unknown) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain("secret-pw");
    },
  );
});

/* ── 登记与接口：账号密码只写不读 ─────────────────────────────── */

let dir: string;
let db: Db;
let index: Db;
let files: FileStore;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-browse-")));
  db = openDb(IN_MEMORY);
  index = openFilesIndex();
  files = createFileStore(join(dir, "files"), index);
});
afterEach(() => {
  db.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("测试环境登记", () => {
  it("账号密码存独立文件（600），数据库里没有；编辑时不填 = 沿用", async () => {
    const catalog = createCatalog(db);
    const p = catalog.createProduct(catalog.createLine({ name: "L" }).id, {
      name: "P",
    });
    const envs = createEnvStore(db, dir);
    const e = await envs.save(p.id, {
      baseUrl: "https://test.example.com/some/path",
      username: "u1",
      password: "pw-1",
      role: "普通租户",
    });
    expect(e.baseUrl).toBe("https://test.example.com");
    expect(e.hasCredential).toBe(true);
    expect(
      JSON.stringify(db.prepare("SELECT * FROM test_envs").all()),
    ).not.toContain("pw-1");
    expect(statSync(join(dir, "envs", `${e.id}.json`)).mode & 0o777).toBe(
      0o600,
    );

    await envs.save(
      p.id,
      { baseUrl: "https://test.example.com", role: "管理员" },
      e.id,
    );
    expect(await envs.credential(e.id)).toEqual({
      username: "u1",
      password: "pw-1",
    });
    expect(envs.get(e.id)?.role).toBe("管理员");

    await envs.remove(e.id);
    expect(await envs.credential(e.id)).toBeNull();
  });

  it("接口响应里永远没有账号密码；只认本产品的环境", async () => {
    const { app } = createApp({
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
      files,
      security: false,
      browse: { dataDir: dir },
    });
    try {
      const catalog = createCatalog(db);
      const line = catalog.createLine({ name: "L" });
      const p = catalog.createProduct(line.id, { name: "P" });
      const other = catalog.createProduct(line.id, { name: "Q" });
      const created = await app.inject({
        method: "POST",
        url: `/api/products/${p.id}/envs`,
        payload: {
          baseUrl: "https://t.example.com",
          username: "alice",
          password: "s3cret!",
        },
      });
      expect(created.statusCode).toBe(201);
      expect(created.body).not.toContain("s3cret!");
      expect(created.body).not.toContain("alice");
      const id = created.json<{ id: string }>().id;

      const list = await app.inject({
        method: "GET",
        url: `/api/products/${p.id}/envs`,
      });
      expect(list.body).not.toContain("s3cret!");
      expect(
        list.json<{ envs: { hasCredential: boolean }[] }>().envs[0]
          ?.hasCredential,
      ).toBe(true);

      const cross = await app.inject({
        method: "DELETE",
        url: `/api/products/${other.id}/envs/${id}`,
      });
      expect(cross.statusCode).toBe(404);

      const bad = await app.inject({
        method: "POST",
        url: `/api/products/${p.id}/envs`,
        payload: { baseUrl: "file:///etc/passwd" },
      });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
