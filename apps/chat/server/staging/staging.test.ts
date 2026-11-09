import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { IN_MEMORY, openDb, type Db } from "../db.js";
import { inNoiseDir } from "../evidence/atlas.js";
import {
  createFileStore,
  openFilesIndex,
  type FileStore,
} from "../files/store.js";
import { createKeyStore } from "../model-config.js";
import { piPaths } from "../pi/runtime.js";
import { createSkillStore } from "../skills.js";
import { createToolRegistry } from "../agent-team/tools.js";
import { createDraftStore } from "./drafts.js";
import { moveTo } from "./move.js";
import { targetProblem } from "./paths.js";
import {
  draftTitle,
  type StagingApplyReport,
  type StagingItem,
} from "./routes.js";

/**
 * 临时区端到端：真 app、真文件库（临时目录）。
 * 断言的是临时区那几条规则，而不是实现细节。
 */

const HOST = "127.0.0.1:4400";
let dir: string;
let root: string;
let db: Db;
let index: Db;
let files: FileStore;
let app: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-staging-")));
  root = join(dir, "files");
  mkdirSync(join(root, "产品", "Alpha"), { recursive: true });
  db = openDb(IN_MEMORY);
  index = openFilesIndex();
  files = createFileStore(root, index);
  ({ app } = createApp({
    auth: false,
    db,
    paths: piPaths(dir),
    keys: createKeyStore(dir, {}),
    skills: createSkillStore({
      dir: join(dir, "skills"),
      targetDirs: { pi: join(dir, "t", "pi") },
    }),
    files,
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
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: object,
): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method,
    url,
    headers: { host: HOST },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    status: res.statusCode,
    body: (res.body === "" ? undefined : res.json()) as T,
  };
}

const disk = (path: string): string => join(root, path.slice(1));

async function seedProduct(folderPath?: string): Promise<string> {
  const line = await call<{ id: string }>("POST", "/api/product-lines", {
    name: "云路由",
  });
  const product = await call<{ id: string }>(
    "POST",
    `/api/product-lines/${line.body.id}/products`,
    { name: "Alpha", ...(folderPath === undefined ? {} : { folderPath }) },
  );
  return product.body.id;
}

async function newSession(productId?: string): Promise<string> {
  const res = await call<{ id: string }>(
    "POST",
    "/api/sessions",
    productId === undefined ? {} : { productId },
  );
  return res.body.id;
}

const listStaging = async () =>
  (
    await call<{
      root: string;
      items: StagingItem[];
      counts: Record<string, number>;
    }>("GET", "/api/staging")
  ).body;

describe("对话存到临时区", () => {
  it("落在 /临时区/对话；默认去处是产品文档目录；确认后搬走、临时区清空", async () => {
    const productId = await seedProduct("/产品/Alpha");
    const sessionId = await newSession(productId);

    const saved = await call<StagingItem>("POST", "/api/staging/drafts", {
      sessionId,
      markdown: "# 订阅席位分配 PRD\n\n正文",
    });
    expect(saved.status).toBe(201);
    expect(saved.body.source).toBe("chat");
    expect(saved.body.title).toBe("订阅席位分配 PRD");
    expect(saved.body.draftPath).toMatch(
      /^\/临时区\/对话\/\d{4}-\d{2}-\d{2}\/订阅席位分配 PRD\.md$/,
    );
    expect(saved.body.target).toBe("/产品/Alpha/订阅席位分配 PRD.md");
    expect(saved.body.productName).toBe("Alpha");
    expect(saved.body.sessionId).toBe(sessionId);
    // 正式位置没被碰。
    expect(existsSync(disk("/产品/Alpha/订阅席位分配 PRD.md"))).toBe(false);

    const list = await listStaging();
    expect(list.counts.chat).toBe(1);
    const content = await call<{ content: string }>(
      "GET",
      `/api/staging/content?key=${encodeURIComponent(saved.body.key)}`,
    );
    expect(content.body.content).toContain("正文");

    // 人在临时区里改过草稿：确认的是改过的版本。
    writeFileSync(
      disk(saved.body.draftPath),
      "# 订阅席位分配 PRD\n\n改过的正文\n",
    );
    const applied = await call<StagingApplyReport>(
      "POST",
      "/api/staging/apply",
      {
        items: [{ key: saved.body.key, target: "/产品/Alpha/prd/席位.md" }],
      },
    );
    expect(applied.body.failed).toEqual([]);
    expect(applied.body.applied.map((a) => a.path)).toEqual([
      "/产品/Alpha/prd/席位.md",
    ]);
    expect(readFileSync(disk("/产品/Alpha/prd/席位.md"), "utf8")).toContain(
      "改过的正文",
    );
    expect(existsSync(disk(saved.body.draftPath))).toBe(false);
    expect((await listStaging()).items).toEqual([]);
    // 当天的文件夹空了就收掉，但来源子目录本身留着。
    const day = saved.body.draftPath.slice(
      0,
      saved.body.draftPath.lastIndexOf("/"),
    );
    expect(existsSync(disk(day))).toBe(false);
  });

  it("没有产品时没有默认去处：不填就报原因，填了才写", async () => {
    const sessionId = await newSession();
    const saved = await call<StagingItem>("POST", "/api/staging/drafts", {
      sessionId,
      title: "随手记",
      markdown: "随便写写",
    });
    expect(saved.body.target).toBeNull();

    const first = await call<StagingApplyReport>("POST", "/api/staging/apply", {
      items: [{ key: saved.body.key }],
    });
    expect(first.body.applied).toEqual([]);
    expect(first.body.failed[0]?.why).toContain("还没选去处");

    const second = await call<StagingApplyReport>(
      "POST",
      "/api/staging/apply",
      {
        items: [{ key: saved.body.key, target: "/产品/Alpha/随手记.md" }],
      },
    );
    expect(second.body.failed).toEqual([]);
    expect(existsSync(disk("/产品/Alpha/随手记.md"))).toBe(true);
  });

  it("去处不能是临时区、代码库，也不能把文件夹当文件替换；已有同名文件时替换并报出来", async () => {
    const sessionId = await newSession();
    const saved = await call<StagingItem>("POST", "/api/staging/drafts", {
      sessionId,
      title: "x",
      markdown: "新内容",
    });

    for (const [target, why] of [
      ["/临时区/别处.md", "不能写回临时区"],
      ["/代码库/repo/x.md", "不能写进代码库"],
      ["/产品/Alpha", "是一个文件夹"],
    ] as const) {
      const r = await call<StagingApplyReport>("POST", "/api/staging/apply", {
        items: [{ key: saved.body.key, target }],
      });
      expect(r.body.failed[0]?.why).toContain(why);
    }
    // 被拒之后草稿还在、文件夹没被删。
    expect(existsSync(disk(saved.body.draftPath))).toBe(true);
    expect(existsSync(disk("/产品/Alpha"))).toBe(true);

    const check = await call<{ problem: string | null; exists: boolean }>(
      "GET",
      `/api/staging/target?path=${encodeURIComponent("/产品/Alpha/旧.md")}`,
    );
    expect(check.body).toMatchObject({ problem: null, exists: false });

    writeFileSync(disk("/产品/Alpha/旧.md"), "旧内容");
    const r = await call<StagingApplyReport>("POST", "/api/staging/apply", {
      items: [{ key: saved.body.key, target: "/产品/Alpha/旧.md" }],
    });
    expect(r.body.replaced).toEqual(["x"]);
    expect(readFileSync(disk("/产品/Alpha/旧.md"), "utf8")).toContain("新内容");
  });

  it("丢弃：删草稿文件，正式位置不受影响", async () => {
    const productId = await seedProduct("/产品/Alpha");
    const saved = await call<StagingItem>("POST", "/api/staging/drafts", {
      sessionId: await newSession(productId),
      markdown: "# 要丢的\n",
    });
    const r = await call<{ discarded: number }>(
      "POST",
      "/api/staging/discard",
      {
        keys: [saved.body.key],
      },
    );
    expect(r.body.discarded).toBe(1);
    expect(existsSync(disk(saved.body.draftPath))).toBe(false);
    expect(existsSync(disk("/产品/Alpha/要丢的.md"))).toBe(false);
    expect((await listStaging()).items).toEqual([]);
  });

  it("对话不存在、内容为空：直接拒", async () => {
    expect(
      (
        await call("POST", "/api/staging/drafts", {
          sessionId: "nope",
          markdown: "x",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await call("POST", "/api/staging/drafts", {
          sessionId: await newSession(),
          markdown: "  \n",
        })
      ).status,
    ).toBe(400);
  });
});

describe("临时区不是事实依据", () => {
  it("依据链路把临时区当噪声目录跳过", () => {
    expect(inNoiseDir("/临时区/对话/2026-10-31/x.md")).toBe(true);
    expect(inNoiseDir("/临时区")).toBe(true);
    expect(inNoiseDir("/产品/Alpha/x.md")).toBe(false);
    // 名字像但不是临时区的不误伤。
    expect(inNoiseDir("/临时区之外/x.md")).toBe(false);
  });

  it("产品的文档目录与参考资料不许绑到临时区", async () => {
    const line = await call<{ id: string }>("POST", "/api/product-lines", {
      name: "线",
    });
    const bad = await call<{ error: { message: string } }>(
      "POST",
      `/api/product-lines/${line.body.id}/products`,
      { name: "B", folderPath: "/临时区/对话" },
    );
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body)).toContain("不能绑定临时区");
  });

  it("targetProblem：根、临时区、代码库", () => {
    expect(targetProblem("/")).not.toBeNull();
    expect(targetProblem("/临时区/a.md")).toContain("临时区");
    expect(targetProblem("/代码库/a.md")).toContain("代码库");
    expect(targetProblem("/产品/a.md")).toBeNull();
  });
});

describe("确认搬运的原子性", () => {
  it("覆盖已有文件时，搬到一半失败不会把原文件弄丢", async () => {
    // 旧文件在正式位置，新文件在临时区。
    await files.write("/产品/Alpha/PRD.md", Buffer.from("旧版"), {
      mode: "overwrite",
      parents: true,
    });
    await files.write("/临时区/对话/x/PRD.md", Buffer.from("新版"), {
      mode: "overwrite",
      parents: true,
    });
    // 让搬移失败：目标名改成一段不可能写成功的路径段。
    const broken = files;
    const realMove = broken.move.bind(files);
    let calls = 0;
    broken.move = async (from: string, to: string) => {
      calls += 1;
      // 第一次是「旧文件挪到旁边」，放行；第二次是「新文件搬到正式位置」，失败。
      if (calls === 2) throw new Error("磁盘满了");
      return realMove(from, to);
    };

    await expect(
      moveTo(files, "/临时区/对话/x/PRD.md", "/产品/Alpha/PRD.md"),
    ).rejects.toThrow("磁盘满了");
    broken.move = realMove;

    // 正式位置那份还在，而且还是旧内容；临时区的草稿也没被吃掉。
    const kept = await files.item("/产品/Alpha/PRD.md", { content: true });
    expect(kept.content).toBe("旧版");
    const draft = await files.item("/临时区/对话/x/PRD.md", { content: true });
    expect(draft.content).toBe("新版");
  });

  it("正常覆盖：新内容就位，旧的备份不残留", async () => {
    await files.write("/产品/Alpha/PRD.md", Buffer.from("旧版"), {
      mode: "overwrite",
      parents: true,
    });
    await files.write("/临时区/对话/y/PRD.md", Buffer.from("新版"), {
      mode: "overwrite",
      parents: true,
    });
    const out = await moveTo(
      files,
      "/临时区/对话/y/PRD.md",
      "/产品/Alpha/PRD.md",
    );
    expect(out.replaced).toBe(true);
    expect(
      (await files.item("/产品/Alpha/PRD.md", { content: true })).content,
    ).toBe("新版");
    const folder = await files.list("/产品/Alpha");
    expect(folder.entries.map((e) => e.name)).toEqual(["PRD.md"]);
  });
});

describe("智能体 draft_write", () => {
  it("写进 /临时区/智能体 并登记，临时区里看得到、默认去处是产品文档目录", async () => {
    const productId = await seedProduct("/产品/Alpha");
    const drafts = createDraftStore(db, files);
    const reg = createToolRegistry({ db, files, drafts });
    const tool = reg.get("draft_write")?.build({
      productId,
      agentName: "prd-writer",
      runId: "abcdef123456",
      webTarget: () => Promise.resolve(null),
    });
    if (tool === undefined) throw new Error("没有 draft_write");
    const out = await (
      tool.execute as unknown as (
        id: string,
        p: unknown,
      ) => Promise<{ content: { text: string }[] }>
    )("t1", { title: "席位 PRD", markdown: "# 席位\n" });
    expect(out.content[0]?.text).toMatch(
      /已写入临时区：\/临时区\/智能体\/\d{8}-\d{4}-prd-writer-abcdef\/席位 PRD\.md/,
    );

    const item = (await listStaging()).items.find((i) => i.source === "agent");
    expect(item).toMatchObject({
      origin: "智能体 prd-writer",
      target: "/产品/Alpha/席位 PRD.md",
      productName: "Alpha",
    });
  });
});

describe("售前草稿", () => {
  interface Version {
    id: string;
    status: string;
    filePath: string | null;
  }
  interface Slot {
    id: string;
    title: string;
    versions: Version[];
  }

  async function seedLib(): Promise<{ libId: string; slot: Slot }> {
    const lib = await call<{ lib: { id: string }; slots: Slot[] }>(
      "POST",
      "/api/presales",
      {},
    );
    const slot = lib.body.slots[0];
    if (slot === undefined) throw new Error("模板没铺出条目");
    return { libId: lib.body.lib.id, slot };
  }
  const draft = async (slotId: string, name: string): Promise<Version> =>
    (
      await call<Version>("POST", `/api/presales/slots/${slotId}/draft`, {
        name,
        text: `# ${name}\n`,
      })
    ).body;
  const versions = async (libId: string, slotId: string): Promise<Version[]> =>
    (
      await call<{ slots: Slot[] }>("GET", `/api/presales/${libId}`)
    ).body.slots.find((s) => s.id === slotId)?.versions ?? [];

  it("起草落临时区；售前页「设为现行版」把文件搬进 /售前/<库>/", async () => {
    const { libId, slot } = await seedLib();
    const v = await draft(slot.id, "白皮书");
    expect(v.filePath).toMatch(/^\/临时区\/售前\/.+\/AI草稿\/白皮书\.md$/);

    const r = await call("POST", `/api/presales/versions/${v.id}/status`, {
      status: "current",
    });
    expect(r.status).toBe(204);
    const [now] = await versions(libId, slot.id);
    expect(now?.status).toBe("current");
    expect(now?.filePath).toMatch(/^\/售前\/[^/]+\/白皮书\.md$/);
    expect(existsSync(disk(now?.filePath ?? "/x"))).toBe(true);
    expect(existsSync(disk(v.filePath ?? "/x"))).toBe(false);
  });

  it("临时区里确认 = 设为现行版，旧现行版归档不删；同名不覆盖", async () => {
    const { libId, slot } = await seedLib();
    const first = await draft(slot.id, "白皮书");
    await call("POST", `/api/presales/versions/${first.id}/status`, {
      status: "current",
    });
    const second = await draft(slot.id, "白皮书");

    const list = await listStaging();
    const item = list.items.find((i) => i.key === `presales:${second.id}`);
    expect(item?.source).toBe("presales");
    expect(item?.note).toContain("会转为归档");
    expect(list.counts.presales).toBe(1); // 现行版不算待确认

    const applied = await call<StagingApplyReport>(
      "POST",
      "/api/staging/apply",
      {
        items: [{ key: `presales:${second.id}` }],
      },
    );
    expect(applied.body.failed).toEqual([]);
    const all = await versions(libId, slot.id);
    const byId = new Map(all.map((x) => [x.id, x]));
    expect(byId.get(second.id)?.status).toBe("current");
    expect(byId.get(first.id)?.status).toBe("archived");
    // 两份都叫「白皮书.md」：第二份自动改名，第一份的文件还在。
    expect(byId.get(second.id)?.filePath).toMatch(/白皮书 \(1\)\.md$/);
    expect(existsSync(disk(byId.get(first.id)?.filePath ?? "/x"))).toBe(true);
    expect((await listStaging()).items).toEqual([]);
  });

  it("临时区里丢弃：删草稿版本与文件；现行版碰不到", async () => {
    const { libId, slot } = await seedLib();
    const keep = await draft(slot.id, "保留");
    await call("POST", `/api/presales/versions/${keep.id}/status`, {
      status: "current",
    });
    const drop = await draft(slot.id, "丢掉");

    const r = await call<{ discarded: number }>(
      "POST",
      "/api/staging/discard",
      {
        keys: [`presales:${drop.id}`, `presales:${keep.id}`],
      },
    );
    expect(r.body.discarded).toBe(1);
    const all = await versions(libId, slot.id);
    expect(all.map((x) => x.id)).toEqual([keep.id]);
    expect(existsSync(disk(drop.filePath ?? "/x"))).toBe(false);
  });
});

describe("draftTitle", () => {
  it("取第一个标题，其次会话标题，都没有用「对话草稿」", () => {
    expect(draftTitle("前言\n## 第二节 ##\n", "会话")).toBe("第二节");
    expect(draftTitle("没有标题", "会话")).toBe("会话");
    expect(draftTitle("没有标题", null)).toBe("对话草稿");
  });
});
