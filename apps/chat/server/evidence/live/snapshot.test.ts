import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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

import { IN_MEMORY, openDb, type Db } from "../../db.js";
import {
  createFileStore,
  openFilesIndex,
  type FileStore,
} from "../../files/store.js";
import { createCatalog } from "../../products.js";
import type { UiIndex } from "../ui/index.js";
import { createEnvStore } from "./envs.js";
import { createSnapshotStore, type CaptureProgress } from "./snapshots.js";

/**
 * 页面快照库的**后台采集**（2026-10-28 用户指出「没有停止、也没有后台机制」后补的）。
 *
 * 守三件事：
 *   ① 采集在服务端跑：`start` 立即返回，不等采完；关掉页面照样继续；
 *   ② 能停：`cancel` 之后不再开新页面、也不会落成「半版快照」（半截的历史会误导人）；
 *   ③ 进度可续看：`status` 随时能问，界面靠它轮询，切走再回来能接上。
 *
 * 用真实浏览器 + 本地慢速假环境跑；本机没有 Chromium 时跳过浏览器用例。
 */

let server: Server;
let base = "";

const PAGE_COUNT = 10;
/** 每页等这么久才回，给「中途停止」留出窗口。 */
const SLOW_MS = 80;

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (req.method === "POST" && u.pathname === "/api/login") {
      res.writeHead(302, { "set-cookie": "sid=ok; Path=/", location: "/p/0" });
      res.end();
      return;
    }
    if (u.pathname === "/login") {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><form method=post action=/api/login><label>用户名<input name=username></label><label>密码<input type=password name=password></label><button type=submit>登录</button></form>`,
      );
      return;
    }
    if (!(req.headers.cookie ?? "").includes("sid=ok")) {
      res.writeHead(302, { location: "/login" });
      res.end();
      return;
    }
    setTimeout(() => {
      res.setHeader("content-type", "text/html; charset=utf-8");
      res.end(
        `<!doctype html><html><head><meta charset=utf-8><title>假页面 ${u.pathname}</title></head><body><h1>页面 ${u.pathname}</h1><p>这里是用于测试的正文内容，足够长。</p></body></html>`,
      );
    }, SLOW_MS);
  });
  await new Promise<void>((r) => {
    server.listen(0, "127.0.0.1", () => {
      r();
    });
  });
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

let dir: string;
let db: Db;
let index: Db;
let files: FileStore;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-snap-")));
  db = openDb(IN_MEMORY);
  index = openFilesIndex();
  // 文件库的根要自己建：生产环境由 main.ts 建，测试里不建就写不进第一份文件。
  mkdirSync(join(dir, "files"), { recursive: true });
  files = createFileStore(join(dir, "files"), index);
});
afterEach(() => {
  db.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 假页面清单：只喂 ui.frontends，避免为了测试造一整个前端项目。 */
const fakeUi = (count: number): UiIndex =>
  ({
    frontends: () =>
      Promise.resolve([
        {
          root: "/代码库/R/web",
          label: "web",
          pages: Array.from({ length: count }, (_, i) => ({
            path: `/p/${String(i)}`,
            title: `页 ${String(i)}`,
            redirect: null,
          })),
        },
      ]),
  }) as unknown as UiIndex;

async function setup(): Promise<{
  store: ReturnType<typeof createSnapshotStore>;
  productId: string;
  envId: string;
}> {
  const catalog = createCatalog(db);
  const line = catalog.createLine({ name: "线" });
  const product = catalog.createProduct(line.id, {
    name: "P",
    codePath: "/代码库/R",
  });
  const envs = createEnvStore(db, dir);
  const env = await envs.save(product.id, {
    baseUrl: base,
    username: "u",
    password: "p",
  });
  const store = createSnapshotStore({
    files,
    catalog,
    ui: fakeUi(PAGE_COUNT),
    envs,
  });
  return { store, productId: product.id, envId: env.id };
}

async function waitFor(
  store: ReturnType<typeof createSnapshotStore>,
  productId: string,
  ok: (p: CaptureProgress) => boolean,
  timeoutMs = 60_000,
): Promise<CaptureProgress> {
  const start = Date.now();
  for (;;) {
    const p = store.status(productId);
    if (p !== null && ok(p)) return p;
    if (Date.now() - start > timeoutMs) throw new Error("等超时");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("后台采集", () => {
  it("start 立即返回；采集在服务端继续跑，跑完落成一版快照", async () => {
    const { store, productId, envId } = await setup();
    const t = Date.now();
    const job = await store.start({ productId, frontendRoot: null, envId });
    // 立即返回：不等采完（每页要等页面稳定，10 页至少十几秒）。
    expect(Date.now() - t).toBeLessThan(1_000);
    expect(["queued", "login", "capture"]).toContain(job.stage);

    const done = await waitFor(store, productId, (p) => p.stage === "done");
    expect(done.done).toBe(PAGE_COUNT);
    expect(done.snapshotId).not.toBeNull();

    const list = await store.list(productId);
    expect(list).toHaveLength(1);
    expect(list[0]?.pages).toHaveLength(PAGE_COUNT);
    expect(list[0]?.pages.every((p) => p.image !== null)).toBe(true);
    // 版本：这个临时目录不是 git 仓库，如实说明，不编版本号。
    expect(list[0]?.version.commit).toBeNull();
    expect(list[0]?.version.unavailable).toContain("不是 git 仓库");
  }, 180_000);

  it("停止：不再开新页面，也不生成半版快照", async () => {
    const { store, productId, envId } = await setup();
    await store.start({ productId, frontendRoot: null, envId });
    // 等采到几页再停，确保确实在跑。
    await waitFor(store, productId, (p) => p.done >= 2);
    expect(await store.cancel(productId)).toBe(true);
    const after = await waitFor(store, productId, (p) => p.stage !== "capture");
    expect(after.stage).toBe("cancelled");
    expect(after.finishedAt).not.toBeNull();

    // 半版快照不进历史：列表为空。
    expect(await store.list(productId)).toHaveLength(0);
    // 已采的页留在进度里（人要能看见「采了 3 页被停了」）。
    expect(after.pages.length).toBeGreaterThan(0);
    expect(after.pages.length).toBeLessThan(PAGE_COUNT);
  }, 180_000);

  it("同一产品不允许并发采集；停完可以重开", async () => {
    const { store, productId, envId } = await setup();
    await store.start({ productId, frontendRoot: null, envId });
    await expect(
      store.start({ productId, frontendRoot: null, envId }),
    ).rejects.toThrow("正在采集");
    await store.cancel(productId);
    await waitFor(store, productId, (p) => p.stage === "cancelled");
    const again = await store.start({ productId, frontendRoot: null, envId });
    expect(["queued", "login", "capture"]).toContain(again.stage);
    await store.cancel(productId);
    await store.closeAll();
  }, 180_000);

  it("环境不属于这个产品 / 没存账号：启动时就报错，不留后台任务", async () => {
    const { store, productId } = await setup();
    await expect(
      store.start({ productId, frontendRoot: null, envId: "env_nope" }),
    ).rejects.toThrow("没有登记这个测试环境");
    expect(store.status(productId)).toBeNull();
  });
});
