import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { IN_MEMORY, openDb, type Db } from "./db.js";
import { createKeyStore } from "./model-config.js";
import { piPaths } from "./pi/runtime.js";
import type { Product, ProductLine } from "./products.js";
import { createSkillStore } from "./skills.js";

/**
 * 产品模块（一级菜单「产品」）的接口。走对话服务的 createApp：路由确实挂在 3200
 * 背后的同一个服务上，安全闸与错误处理也是同一套。
 */
const PORT = 4400;
const HOST = `127.0.0.1:${String(PORT)}`;

let db: Db;
let dir: string;
let app: ReturnType<typeof createApp>["app"];
let clock = 1000;

beforeEach(() => {
  db = openDb(IN_MEMORY);
  dir = mkdtempSync(join(tmpdir(), "pmforge-products-"));
  clock = 1000;
  ({ app } = createApp({
    auth: false,
    db,
    paths: piPaths(dir),
    keys: createKeyStore(dir, {}),
    // 技能目录与分发目标都在临时目录里，绝不碰真实的 ~/.pi。
    skills: createSkillStore({
      dir: join(dir, "skills"),
      targetDirs: {
        pi: join(dir, "targets", "pi"),
      },
    }),
    security: { port: PORT, webPort: 3200, extraOrigins: [] },
    now: () => (clock += 1),
  }));
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  headers = {},
) {
  const res = await app.inject({
    method,
    url,
    headers: { host: HOST, ...headers },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    body:
      res.body === ""
        ? undefined
        : (JSON.parse(res.body) as Record<string, unknown>),
  };
}

const errorOf = (r: { body?: Record<string, unknown> | undefined }) =>
  (r.body?.error as { code: string; message: string }).message;
const lines = async () =>
  ((await call("GET", "/api/product-lines")).body?.lines ??
    []) as ProductLine[];
const newLine = async (name: string, description?: string) =>
  (
    await call("POST", "/api/product-lines", {
      name,
      ...(description === undefined ? {} : { description }),
    })
  ).body as unknown as ProductLine;
const newProduct = async (lineId: string, name: string) =>
  (await call("POST", `/api/product-lines/${lineId}/products`, { name }))
    .body as unknown as Product;

describe("产品线", () => {
  it("新建 → 列表里按创建顺序出现，名称与描述去掉首尾空白", async () => {
    const created = await call("POST", "/api/product-lines", {
      name: "  RouteHub ",
      description: " 大模型路由 ",
    });
    expect(created.status).toBe(201);
    await newLine("DevSuite");
    const list = await lines();
    expect(list.map((l) => l.name)).toEqual(["RouteHub", "DevSuite"]);
    expect(list[0]).toMatchObject({ description: "大模型路由", products: [] });
  });

  it("名称校验：空、只有空格、超过 80 字、缺字段，均 400 并给中文原因", async () => {
    expect(
      errorOf(await call("POST", "/api/product-lines", { name: "" })),
    ).toBe("产品线名称不能为空");
    expect(
      errorOf(await call("POST", "/api/product-lines", { name: "   " })),
    ).toBe("产品线名称不能为空");
    expect(
      errorOf(
        await call("POST", "/api/product-lines", { name: "长".repeat(81) }),
      ),
    ).toBe("产品线名称最多 80 个字");
    const missing = await call("POST", "/api/product-lines", {});
    expect(missing.status).toBe(400);
    expect(errorOf(missing)).toBe("产品线名称必填");
    expect(await lines()).toEqual([]);
  });

  it("重名（不区分大小写）409；改名撞名 409；只改自己的大小写可以", async () => {
    const line = await newLine("RouteHub");
    await newLine("DevSuite");
    const dup = await call("POST", "/api/product-lines", {
      name: "routehub",
    });
    expect(dup.status).toBe(409);
    expect(errorOf(dup)).toBe("已有同名产品线「routehub」");

    expect(
      (
        await call("PATCH", `/api/product-lines/${line.id}`, {
          name: "devsuite",
        })
      ).status,
    ).toBe(409);
    const recased = await call("PATCH", `/api/product-lines/${line.id}`, {
      name: "Routehub",
    });
    expect(recased.status).toBe(200);
    expect(recased.body).toMatchObject({ name: "Routehub" });
  });

  it("修改：只改描述时名称不变，updatedAt 前进；空请求体 400", async () => {
    const line = await newLine("RouteHub", "旧描述");
    const updated = await call("PATCH", `/api/product-lines/${line.id}`, {
      description: "新描述",
    });
    expect(updated.body).toMatchObject({
      name: "RouteHub",
      description: "新描述",
    });
    expect(updated.body?.updatedAt as number).toBeGreaterThan(line.updatedAt);
    expect(
      errorOf(await call("PATCH", `/api/product-lines/${line.id}`, {})),
    ).toBe("没有要修改的字段");
  });

  it("删除：下面还有产品时 409 且什么都不删；清空后可删，再删 404", async () => {
    const line = await newLine("RouteHub");
    const product = await newProduct(line.id, "ModelHub");
    const blocked = await call("DELETE", `/api/product-lines/${line.id}`);
    expect(blocked.status).toBe(409);
    expect(errorOf(blocked)).toBe(
      "这条产品线下还有 1 个产品，先移走或删除它们",
    );
    expect((await lines())[0]?.products).toHaveLength(1);

    expect((await call("DELETE", `/api/products/${product.id}`)).status).toBe(
      204,
    );
    expect((await call("DELETE", `/api/product-lines/${line.id}`)).status).toBe(
      204,
    );
    expect(await lines()).toEqual([]);
    expect((await call("DELETE", `/api/product-lines/${line.id}`)).status).toBe(
      404,
    );
  });

  it("数据库本身也拒绝删除非空产品线（应用层漏判也删不掉）", async () => {
    const line = await newLine("RouteHub");
    await newProduct(line.id, "ModelHub");
    expect(() =>
      db.prepare("DELETE FROM product_lines WHERE id = ?").run(line.id),
    ).toThrow(/FOREIGN KEY/);
  });

  it("不存在的产品线：改、删、在下面建产品都是 404", async () => {
    expect(
      (await call("PATCH", "/api/product-lines/nope", { name: "x" })).status,
    ).toBe(404);
    expect((await call("DELETE", "/api/product-lines/nope")).status).toBe(404);
    const create = await call("POST", "/api/product-lines/nope/products", {
      name: "x",
    });
    expect(create.status).toBe(404);
    expect(errorOf(create)).toBe("产品线不存在");
  });
});

describe("产品", () => {
  it("建在产品线下，列表里嵌在所属产品线内、按创建顺序", async () => {
    const line = await newLine("RouteHub");
    const created = await call(
      "POST",
      `/api/product-lines/${line.id}/products`,
      {
        name: "ModelHub",
        description: "模型路由",
      },
    );
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      lineId: line.id,
      name: "ModelHub",
      description: "模型路由",
    });
    await newProduct(line.id, "SecHub");
    await newProduct(line.id, "OpsHub");
    expect((await lines())[0]?.products.map((p) => p.name)).toEqual([
      "ModelHub",
      "SecHub",
      "OpsHub",
    ]);
  });

  it("同一产品线内重名 409（不区分大小写）；不同产品线下可以同名", async () => {
    const a = await newLine("A");
    const b = await newLine("B");
    await newProduct(a.id, "Console");
    const dup = await call("POST", `/api/product-lines/${a.id}/products`, {
      name: "console",
    });
    expect(dup.status).toBe(409);
    expect(errorOf(dup)).toBe("这条产品线下已有同名产品「console」");
    expect(
      (
        await call("POST", `/api/product-lines/${b.id}/products`, {
          name: "Console",
        })
      ).status,
    ).toBe(201);
  });

  it("换产品线：移到目标末尾，原产品线里消失", async () => {
    const a = await newLine("A");
    const b = await newLine("B");
    const moving = await newProduct(a.id, "X");
    await newProduct(a.id, "Y");
    await newProduct(b.id, "Z");
    const moved = await call("PATCH", `/api/products/${moving.id}`, {
      lineId: b.id,
    });
    expect(moved.body).toMatchObject({ lineId: b.id, name: "X" });
    const [la, lb] = await lines();
    expect(la?.products.map((p) => p.name)).toEqual(["Y"]);
    expect(lb?.products.map((p) => p.name)).toEqual(["Z", "X"]);
  });

  it("换产品线撞名 409 且不移动；目标产品线不存在 404", async () => {
    const a = await newLine("A");
    const b = await newLine("B");
    const p = await newProduct(a.id, "Same");
    await newProduct(b.id, "same");
    expect(
      (await call("PATCH", `/api/products/${p.id}`, { lineId: b.id })).status,
    ).toBe(409);
    expect(
      (await call("PATCH", `/api/products/${p.id}`, { lineId: "nope" })).status,
    ).toBe(404);
    expect((await lines())[0]?.products.map((x) => x.id)).toEqual([p.id]);
  });

  it("删产品时清掉情报库里指向它的编号（不留孤儿）", async () => {
    const line = await newLine("A");
    const p = await newProduct(line.id, "Gone");
    const other = await newProduct(line.id, "Keep");
    const created = async (title: string, productIds: string[]) =>
      (
        await call("POST", "/api/intel", {
          kind: "competitor",
          title,
          productIds,
        })
      ).body?.id as string;
    const intelId = await created("一条挂在它上面的情报", [p.id, other.id]);
    const orphanId = await created("只挂着它的一条", [p.id]);
    expect((await call("DELETE", `/api/products/${p.id}`)).status).toBe(204);
    const list = await call("GET", "/api/intel");
    const items = (list.body?.items ?? []) as {
      id: string;
      productIds: string[];
    }[];
    expect(items.find((i) => i.id === intelId)?.productIds).toEqual([other.id]);
    // 清空后回到「全局」：不该留下一个不存在的产品 id。
    expect(items.find((i) => i.id === orphanId)?.productIds).toEqual([]);
  });

  it("改名改描述；不在产品线间移动时位置不变", async () => {
    const line = await newLine("A");
    const first = await newProduct(line.id, "One");
    await newProduct(line.id, "Two");
    const renamed = await call("PATCH", `/api/products/${first.id}`, {
      name: "First",
      description: "第一个",
    });
    expect(renamed.body).toMatchObject({
      name: "First",
      description: "第一个",
    });
    expect((await lines())[0]?.products.map((p) => p.name)).toEqual([
      "First",
      "Two",
    ]);
    expect(
      errorOf(await call("PATCH", `/api/products/${first.id}`, { name: " " })),
    ).toBe("产品名称不能为空");
  });

  it("删除；不存在的产品 404", async () => {
    const line = await newLine("A");
    const p = await newProduct(line.id, "X");
    expect((await call("DELETE", `/api/products/${p.id}`)).status).toBe(204);
    expect((await call("DELETE", `/api/products/${p.id}`)).status).toBe(404);
    expect(
      (await call("PATCH", `/api/products/${p.id}`, { name: "y" })).status,
    ).toBe(404);
  });
});

describe("安全与持久化", () => {
  it("非回环 Host 一律 403；外站 Origin 的写请求 403，前端端口放行", async () => {
    const rebinding = await app.inject({
      method: "GET",
      url: "/api/product-lines",
      headers: { host: "evil.example:4400" },
    });
    expect(rebinding.statusCode).toBe(403);
    expect(
      (
        await call(
          "POST",
          "/api/product-lines",
          { name: "X" },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call(
          "POST",
          "/api/product-lines",
          { name: "X" },
          { origin: "http://127.0.0.1:3200" },
        )
      ).status,
    ).toBe(201);
  });

  it("格式错误的 JSON 体：400，不是 500", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/product-lines",
      headers: { host: HOST, "content-type": "application/json" },
      payload: "{not json",
    });
    expect(res.statusCode).toBe(400);
  });

  it("落盘后重开：数据还在，迁移不重复执行", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "pmforge-product-"));
    try {
      const path = join(dataDir, "chat.db");
      const first = openDb(path);
      first
        .prepare(
          "INSERT INTO product_lines (id, name, description, sort_order, created_at, updated_at) VALUES ('l1', 'A', '', 1, 1, 1)",
        )
        .run();
      first.close();
      const second = openDb(path);
      expect(second.prepare("SELECT name FROM product_lines").all()).toEqual([
        { name: "A" },
      ]);
      // 迁移只增不改：加一条迁移就把这个数字加一。写死而不是读 MIGRATIONS.length，
      // 为的是「漏登记一条迁移」时测试会红，而不是跟着一起错。
      // 13 条之后又加了：14 = 会话绑定产品与依据范围；15 = 售前条目对上模板条目；
      // 16 = 售前 AI 审阅 / 体系复盘的任务表；17 = 售前助手会话与「上传后自动审阅」开关。
      // 18 = 登录：用户表与登录凭证表；19 = 测试环境登记（AI 只读看页面）。
      const applied = second
        .prepare("SELECT COUNT(*) AS n FROM _migrations")
        .get() as { n: number };
      expect(applied).toEqual({ n: 20 });
      second.close();
      // 重开不会再跑一遍：条数不变，才说明迁移是幂等的。
      const third = openDb(path);
      expect(
        (
          third.prepare("SELECT COUNT(*) AS n FROM _migrations").get() as {
            n: number;
          }
        ).n,
      ).toBe(20);
      third.close();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
