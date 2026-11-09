import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { IN_MEMORY, openDb, type Db } from "../db.js";
import { createKeyStore } from "../model-config.js";
import { piPaths } from "../pi/runtime.js";
import { createSessionStore } from "../sessions.js";
import { createSkillStore } from "../skills.js";
import { mergeBriefs, renderIntelBrief } from "./brief.js";
import { registerIntel } from "./routes.js";
import { createIntelStore, type IntelItem, type IntelStore } from "./store.js";

/**
 * 市场情报：
 * - 条目的增删改与校验；AI 提交的一律「待确认」，确认后才会被附给对话；
 * - 检索按 对象 / 标题 / 标签 / 正文 加权，产品对话只看全局 + 本产品；
 * - 下发段写明「参考，不是准则」，并进依据段的同一个包裹里（界面才会折叠）；
 * - 过了复核日期标「可能过时」。
 */

let dir: string;
let db: Db;
let store: IntelStore;
let clock = 1_800_000_000_000;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-intel-")));
  db = openDb(IN_MEMORY);
  store = createIntelStore(db, () => clock);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const seed = (over: Partial<Parameters<IntelStore["create"]>[0]> = {}) =>
  store.create({
    kind: "competitor",
    subject: "Notion",
    title: "Notion AI 定价调整",
    summary: "Notion AI 并入 Business 套餐，不再单独收费。",
    content: "2026 年起 Business 套餐每席位 20 美元，含 AI。",
    sources: [{ url: "https://notion.so/pricing", title: "定价页" }],
    tags: ["定价", "AI"],
    observedAt: "2026-05",
    confidence: "official",
    ...over,
  });

describe("情报库", () => {
  it("增改与校验", () => {
    const a = seed();
    expect(a.status).toBe("active");
    expect(a.sources).toEqual([
      { url: "https://notion.so/pricing", title: "定价页" },
    ]);
    expect(() => seed({ title: "  " })).toThrow("标题不能为空");
    expect(() => seed({ observedAt: "五月" })).toThrow("观察日期");
    const b = store.update(a.id, { kind: "market", title: "改了" });
    expect(b).toMatchObject({ kind: "market", title: "改了", subject: "" });
  });

  it("检索按字段加权，正文碰一个词不算", () => {
    seed();
    store.create({
      kind: "compliance",
      subject: "个人信息保护法",
      title: "跨境传输需要安全评估",
      content: "顺带提到定价两个字。",
    });
    const hits = store.search("我们要给 Notion 那样的 AI 套餐定价");
    expect(hits.map((h) => h.item.title)).toEqual(["Notion AI 定价调整"]);
  });

  it("产品对话只看全局与本产品的条目；待确认的不下发", () => {
    seed({ title: "全局的 Notion 定价" });
    seed({ title: "别的产品的 Notion 定价", productIds: ["p2"] });
    seed({ title: "本产品的 Notion 定价", productIds: ["p1"] });
    store.create(
      { kind: "competitor", subject: "Notion", title: "待确认的 Notion 定价" },
      { status: "pending", origin: "ai" },
    );
    const titles = store
      .search("Notion 定价", { productId: "p1" })
      .map((h) => h.item.title);
    expect(titles[0]).toBe("本产品的 Notion 定价");
    expect(titles).toContain("全局的 Notion 定价");
    expect(titles).not.toContain("别的产品的 Notion 定价");
    expect(titles).not.toContain("待确认的 Notion 定价");
  });

  it("过了复核日期标可能过时", () => {
    const a = seed({ reviewAfter: clock + 1000 });
    expect(a.stale).toBe(false);
    clock += 2000;
    expect(store.get(a.id).stale).toBe(true);
    expect(
      renderIntelBrief([{ item: store.get(a.id), score: 1, matched: [] }]),
    ).toContain("可能过时");
  });
});

describe("下发给 AI", () => {
  it("写明是参考而不是准则，并带上出处与时效", () => {
    const item: IntelItem = seed();
    const text = renderIntelBrief([{ item, score: 9, matched: [] }]) ?? "";
    expect(text).toContain("不是要照做的准则");
    expect(text).toContain("描述我们自己的产品只用事实依据");
    expect(text).toContain("观察于 2026-05");
    expect(text).toContain("https://notion.so/pricing");
  });

  it("并进依据段的同一个包裹；没有依据段时自己包一层", () => {
    expect(mergeBriefs(null, null)).toBeNull();
    expect(
      mergeBriefs(
        "<pmforge-evidence>\n依据\n</pmforge-evidence>",
        "<参考情报>x</参考情报>",
      ),
    ).toBe(
      "<pmforge-evidence>\n依据\n\n<参考情报>x</参考情报>\n</pmforge-evidence>",
    );
    expect(mergeBriefs(null, "情报")).toBe(
      "<pmforge-evidence>\n情报\n</pmforge-evidence>",
    );
  });

  it("续聊不重复给；核对类任务不附；条目改过算新的", async () => {
    const app = (await import("fastify")).default();
    const sessions = createSessionStore(db);
    const intel = registerIntel(app, {
      store,
      sessions,
      newHeader: () => ({ id: "h" }),
      productName: () => null,
    });
    const a = seed();
    const state = { first: true, given: new Set<string>() };
    const s = { productId: null, task: null };
    expect(intel.brief(s, "Notion 的定价怎么样", state)).toContain(a.title);
    state.first = false;
    expect(intel.brief(s, "再说说 Notion 定价的影响", state)).toBeNull();
    clock += 1;
    store.update(a.id, {
      kind: "competitor",
      subject: "Notion",
      title: a.title,
      content: "新",
    });
    expect(intel.brief(s, "再说说 Notion 定价的影响", state)).toContain(
      a.title,
    );
    expect(
      intel.brief(
        {
          productId: null,
          task: { kind: "presales-ai", libId: "l", jobId: "j", job: "review" },
        },
        "Notion 定价",
        { first: true, given: new Set() },
      ),
    ).toBeNull();
    await app.close();
  });
});

describe("接口与 AI 调研", () => {
  it("开调研会话、条目增删与归档", async () => {
    const { app, runner } = createApp({
      auth: false,
      db,
      paths: piPaths(dir),
      keys: createKeyStore(dir, {}),
      skills: createSkillStore({
        dir: join(dir, "skills"),
        targetDirs: { pi: join(dir, "t") },
      }),
      security: { port: 4400, webPort: 3200, extraOrigins: [] },
    });
    const H = { host: "127.0.0.1:4400" };
    const res = await app.inject({
      method: "POST",
      url: "/api/intel/research",
      headers: H,
      payload: { topic: "飞书文档的 AI 功能", kind: "competitor" },
    });
    expect(res.statusCode).toBe(201);
    const { sessionId, kickoff } = res.json<{
      sessionId: string;
      kickoff: string;
    }>();
    expect(kickoff).toContain("飞书文档的 AI 功能");
    expect(kickoff).toContain("侧重：竞品");

    const sessions = createSessionStore(db);
    const row = sessions.get(sessionId);
    expect(row?.task).toEqual({ kind: "intel-research", productId: null });

    const list = await app.inject({
      method: "GET",
      url: "/api/intel",
      headers: H,
    });
    expect(list.json<{ items: unknown[] }>().items).toEqual([]);

    const created = await app.inject({
      method: "POST",
      url: "/api/intel",
      headers: H,
      payload: { kind: "industry", title: "大模型降价潮", subject: "LLM API" },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ id: string }>().id;
    const archived = await app.inject({
      method: "POST",
      url: `/api/intel/${id}/status`,
      headers: H,
      payload: { status: "archived" },
    });
    expect(archived.json<{ status: string }>().status).toBe("archived");
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/intel/${id}`,
          headers: H,
        })
      ).statusCode,
    ).toBe(204);
    runner.disposeAll();
    await app.close();
  });

  it("执行体工具：提交的条目是待确认", async () => {
    const { intelProposeTool } = await import("./tools.js");
    const tool = intelProposeTool(store, { productId: "p1", sessionId: "s1" });
    const out = await (
      tool.execute as unknown as (
        id: string,
        p: unknown,
      ) => Promise<{ content: { text: string }[] }>
    )("t", {
      kind: "compliance",
      subject: "生成式 AI 服务管理办法",
      title: "上线前需算法备案",
      summary: "面向公众的生成式 AI 服务需备案。",
      content: "第十七条……",
      observed_at: "2023-08",
      confidence: "official",
      review_months: 12,
    });
    expect(out.content[0]?.text).toContain("待人在市场情报页确认");
    const [item] = store.list({ status: "pending" });
    expect(item).toMatchObject({
      origin: "ai",
      sessionId: "s1",
      productIds: ["p1"],
      confidence: "official",
    });
    expect(item?.reviewAfter).toBeGreaterThan(Date.now());
  });
});
