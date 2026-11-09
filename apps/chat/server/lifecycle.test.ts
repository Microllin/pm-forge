import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { IN_MEMORY, openDb, type Db } from "./db.js";
import { BUILTIN_TEMPLATE } from "./lifecycle-builtin.js";
import type { Template } from "./lifecycle.js";
import { createKeyStore } from "./model-config.js";
import { piPaths } from "./pi/runtime.js";
import type { Product, ProductLine } from "./products.js";
import { createSkillStore } from "./skills.js";

/**
 * 生命周期规范（产品菜单下的二级页）的接口。与产品模块同一个服务、同一套安全闸。
 *
 * 重点覆盖三件老版本做不到的事：模板能新建、层与产出物能改、出厂模板改坏能恢复。
 */
const PORT = 4400;
const HOST = `127.0.0.1:${String(PORT)}`;

let db: Db;
let dir: string;
let app: ReturnType<typeof createApp>["app"];
let clock = 1000;

beforeEach(() => {
  db = openDb(IN_MEMORY);
  dir = mkdtempSync(join(tmpdir(), "pmforge-lifecycle-"));
  clock = 1000;
  ({ app } = createApp({
    auth: false,
    db,
    paths: piPaths(dir),
    keys: createKeyStore(dir, {}),
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
) {
  const res = await app.inject({
    method,
    url,
    headers: { host: HOST },
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
const templates = async () =>
  ((await call("GET", "/api/lifecycle-templates")).body?.templates ??
    []) as Template[];
/** 取出厂模板。找不到就抛——测试里它必须在，静默返回 undefined 只会让断言错位。 */
const builtin = async (): Promise<Template> => {
  const hit = (await templates()).find((t) => t.builtin);
  if (!hit) throw new Error("库里没有出厂模板");
  return hit;
};
const byId = async (id: string): Promise<Template> => {
  const hit = (await templates()).find((t) => t.id === id);
  if (!hit) throw new Error(`找不到模板 ${id}`);
  return hit;
};
const newTemplate = async (name: string) =>
  (await call("POST", "/api/lifecycle-templates", { name }))
    .body as unknown as Template;

describe("出厂模板", () => {
  it("首次打开就有一条「标准 SaaS Web 产品」，层与产出物按方法论齐备", async () => {
    const list = await templates();
    expect(list).toHaveLength(1);
    const t = list[0];
    expect(t).toMatchObject({ name: BUILTIN_TEMPLATE.name, builtin: true });
    // 层：L0.1 → L5.2，顺序与方法论第 1 节全链总览一致
    expect(t?.stages.map((s) => s.code)).toEqual([
      "L0.1",
      "L0.2",
      "L0.3",
      "L0.4",
      "L0.5",
      "L1",
      "L2",
      "L3",
      "L4",
      "L5.1",
      "L5.2",
    ]);
    // 想法卡、产品一页纸、Roadmap 这几件用户点名的产出物都在
    const names = t?.stages.flatMap((s) => s.artifacts.map((a) => a.name));
    expect(names).toContain("想法卡");
    expect(names).toContain("立项 PR-FAQ");
    expect(names).toContain("产品定位与范围（产品一页纸）");
    expect(names).toContain("阶段规划（Roadmap）");
  });

  it("产出物带判定要点与文件线索——这是后续让 AI 比对的依据", async () => {
    const idea = (await builtin()).stages[0]?.artifacts[0];
    expect(idea?.required).toBe(true);
    expect(idea?.checkpoints.length).toBeGreaterThanOrEqual(3);
    expect(idea?.checkpoints[0]).toContain("痛点");
    expect(idea?.fileHints).toContain("想法卡");
  });

  it("出厂模板照样能改（这是老版本做不到的），改坏了能恢复出厂", async () => {
    const t = await builtin();
    const stage = t.stages[0];
    expect(stage).toBeDefined();
    // 改名、删层
    await call("PATCH", `/api/lifecycle-templates/${t.id}`, {
      name: "被我改了",
    });
    await call("DELETE", `/api/lifecycle-stages/${stage?.id ?? ""}`);
    const hacked = await builtin();
    expect(hacked.name).toBe("被我改了");
    expect(hacked.stages).toHaveLength(10);

    const reset = await call("POST", `/api/lifecycle-templates/${t.id}/reset`);
    expect(reset.status).toBe(200);
    const back = await builtin();
    expect(back.name).toBe(BUILTIN_TEMPLATE.name);
    expect(back.stages).toHaveLength(11);
    expect(back.stages[0]?.code).toBe("L0.1");
  });

  it("自建模板没有「出厂」这个状态，恢复出厂被拒", async () => {
    const mine = await newTemplate("内部工具精简档");
    const r = await call("POST", `/api/lifecycle-templates/${mine.id}/reset`);
    expect(r.status).toBe(409);
    expect(errorOf(r)).toContain("只有出厂模板");
  });

  it("删光了不会自己长回来（只认「整库为空」才播种）", async () => {
    const t = await builtin();
    expect(
      (await call("DELETE", `/api/lifecycle-templates/${t.id}`)).status,
    ).toBe(204);
    expect(await templates()).toHaveLength(0);
  });
});

describe("模板", () => {
  it("新建是空模板；同名 409", async () => {
    const created = await call("POST", "/api/lifecycle-templates", {
      name: "  内部工具 ",
      description: " 没有市场可算 ",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: "内部工具",
      description: "没有市场可算",
      builtin: false,
      stages: [],
    });
    const again = await call("POST", "/api/lifecycle-templates", {
      name: "内部工具",
    });
    expect(again.status).toBe(409);
    expect(errorOf(again)).toBe("已有同名模板「内部工具」");
  });

  it("名称校验给中文原因", async () => {
    expect(
      errorOf(await call("POST", "/api/lifecycle-templates", { name: " " })),
    ).toBe("模板名称不能为空");
    expect(
      errorOf(
        await call("POST", "/api/lifecycle-templates", {
          name: "x".repeat(81),
        }),
      ),
    ).toBe("模板名称最多 80 个字");
  });

  it("复制：层与产出物整棵带过来，名字加「副本」且撞名递增", async () => {
    const src = await builtin();
    const first = await call(
      "POST",
      `/api/lifecycle-templates/${src.id}/duplicate`,
    );
    expect(first.status).toBe(201);
    const copy = first.body as unknown as Template;
    expect(copy.name).toBe(`${BUILTIN_TEMPLATE.name} 副本`);
    expect(copy.builtin).toBe(false);
    expect(copy.stages).toHaveLength(11);
    expect(copy.stages[0]?.artifacts[0]?.checkpoints).toEqual(
      src.stages[0]?.artifacts[0]?.checkpoints,
    );

    const second = (
      await call("POST", `/api/lifecycle-templates/${src.id}/duplicate`)
    ).body as unknown as Template;
    expect(second.name).toBe(`${BUILTIN_TEMPLATE.name} 副本 2`);
  });
});

describe("阶段与产出物", () => {
  it("加阶段 / 改阶段 / 上下移 / 删阶段连带产出物", async () => {
    const t = await newTemplate("自定义档");
    const added = await call(
      "POST",
      `/api/lifecycle-templates/${t.id}/stages`,
      {
        code: "P1",
        label: "立项",
        question: "值不值得做",
      },
    );
    expect(added.status).toBe(201);
    await call("POST", `/api/lifecycle-templates/${t.id}/stages`, {
      code: "P2",
      label: "规划",
    });
    let tree = await byId(t.id);
    expect(tree.stages.map((s) => s.code)).toEqual(["P1", "P2"]);

    // 同一个模板里代号唯一
    const clash = await call(
      "POST",
      `/api/lifecycle-templates/${t.id}/stages`,
      { code: "p1", label: "重复" },
    );
    expect(clash.status).toBe(409);
    expect(errorOf(clash)).toBe("这个模板里已有阶段「p1」");

    // 下移 P1
    const moved = (
      await call(
        "POST",
        `/api/lifecycle-stages/${tree.stages[0]?.id ?? ""}/move`,
        {
          delta: 1,
        },
      )
    ).body as unknown as Template;
    expect(moved.stages.map((s) => s.code)).toEqual(["P2", "P1"]);
    // 已经在最前面还往上移：原地不动，不报错
    const top = (
      await call(
        "POST",
        `/api/lifecycle-stages/${moved.stages[0]?.id ?? ""}/move`,
        {
          delta: -1,
        },
      )
    ).body as unknown as Template;
    expect(top.stages.map((s) => s.code)).toEqual(["P2", "P1"]);

    // 产出物挂上去，删层时连带删掉
    const stageId = top.stages[0]?.id ?? "";
    await call("POST", `/api/lifecycle-stages/${stageId}/artifacts`, {
      name: "立项报告",
      checkpoints: " 为什么现在 \n\n 谁的痛点 \n ",
      fileHints: "立项\n报告",
    });
    tree = await byId(t.id);
    const artifact = tree.stages[0]?.artifacts[0];
    // 多行文本去空行、去行尾空白后一行一条
    expect(artifact?.checkpoints).toEqual(["为什么现在", "谁的痛点"]);
    expect(artifact?.fileHints).toEqual(["立项", "报告"]);
    expect(artifact?.required).toBe(true);

    await call("DELETE", `/api/lifecycle-stages/${stageId}`);
    tree = await byId(t.id);
    expect(tree.stages.map((s) => s.code)).toEqual(["P1"]);
    expect(
      db
        .prepare<[], { n: number }>(
          "SELECT COUNT(*) AS n FROM lifecycle_artifacts",
        )
        .get()?.n,
    ).toBe(
      // 出厂模板自己的产出物还在，被删的只有刚挂的那一个
      BUILTIN_TEMPLATE.stages.reduce((n, s) => n + s.artifacts.length, 0),
    );
  });

  it("改产出物：没给的字段不动，required 可降为选填", async () => {
    const t = await builtin();
    const target = t.stages[0]?.artifacts[0];
    const after = (
      await call("PATCH", `/api/lifecycle-artifacts/${target?.id ?? ""}`, {
        required: false,
      })
    ).body as unknown as Template;
    const updated = after.stages[0]?.artifacts[0];
    expect(updated?.required).toBe(false);
    expect(updated?.name).toBe(target?.name);
    expect(updated?.checkpoints).toEqual(target?.checkpoints);
  });

  it("同一阶段下产出物不重名", async () => {
    const t = await builtin();
    const stage = t.stages[0];
    const r = await call(
      "POST",
      `/api/lifecycle-stages/${stage?.id ?? ""}/artifacts`,
      { name: "想法卡" },
    );
    expect(r.status).toBe(409);
    expect(errorOf(r)).toBe("这个阶段下已有产出物「想法卡」");
  });
});

describe("产品绑定模板", () => {
  const newLine = async (name: string) =>
    (await call("POST", "/api/product-lines", { name }))
      .body as unknown as ProductLine;

  it("新建与编辑都能绑；空串解绑；不存在的模板 404", async () => {
    const t = await builtin();
    const line = await newLine("RouteHub");
    const created = (
      await call("POST", `/api/product-lines/${line.id}/products`, {
        name: "ModelHub",
        templateId: t.id,
      })
    ).body as unknown as Product;
    expect(created.templateId).toBe(t.id);

    const unbound = (
      await call("PATCH", `/api/products/${created.id}`, { templateId: "" })
    ).body as unknown as Product;
    expect(unbound.templateId).toBe(null);

    const bad = await call("PATCH", `/api/products/${created.id}`, {
      templateId: "不存在",
    });
    expect(bad.status).toBe(404);
    expect(errorOf(bad)).toBe("绑定的生命周期规范模板不存在");
  });

  it("模板被产品绑着就不让删，且列表里能看到绑定数", async () => {
    const t = await builtin();
    const line = await newLine("RouteHub");
    await call("POST", `/api/product-lines/${line.id}/products`, {
      name: "ModelHub",
      templateId: t.id,
    });
    expect((await builtin()).productCount).toBe(1);

    const r = await call("DELETE", `/api/lifecycle-templates/${t.id}`);
    expect(r.status).toBe(409);
    expect(errorOf(r)).toContain("还有 1 个产品绑着");
  });
});
