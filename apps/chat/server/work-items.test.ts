import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { IN_MEMORY, openDb, type Db } from "./db.js";
import { createKeyStore } from "./model-config.js";
import { piPaths } from "./pi/runtime.js";
import { createSkillStore } from "./skills.js";
import { linearStatus, type WorkItem } from "./work-items.js";

const HOST = "127.0.0.1:4400";
let dir: string;
let db: Db;
let app: ReturnType<typeof createApp>["app"];
let linearCalls: { auth: string; body: { variables?: unknown } }[];
let linearReply: () => Response;

const issue = (n: number, type = "unstarted") => ({
  id: `uuid-${String(n)}`,
  identifier: `ENG-${String(n)}`,
  title: `任务 ${String(n)}`,
  description: "做点事",
  url: `https://linear.app/x/issue/ENG-${String(n)}`,
  priority: 2,
  updatedAt: "2026-10-01T00:00:00.000Z",
  state: { name: type === "started" ? "In Progress" : "Todo", type },
  assignee: { name: "小王" },
  team: { key: "ENG" },
  labels: { nodes: [{ name: "Bug" }] },
});

const fakeFetch: typeof fetch = (_url, init) => {
  linearCalls.push({
    auth: new Headers(init?.headers).get("authorization") ?? "",
    body: JSON.parse(init?.body as string) as { variables?: unknown },
  });
  return Promise.resolve(linearReply());
};
const ok = (data: unknown) =>
  new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-work-")));
  db = openDb(IN_MEMORY);
  linearCalls = [];
  linearReply = () =>
    ok({
      viewer: { name: "我", email: "me@x.com" },
      teams: { nodes: [{ key: "ENG", name: "Engineering" }] },
    });
  ({ app } = createApp({
    auth: false,
    db,
    paths: piPaths(dir),
    keys: createKeyStore(dir, {}),
    integrationKeys: createKeyStore(join(dir, "integrations"), {}),
    linearFetch: fakeFetch,
    skills: createSkillStore({
      dir: join(dir, "skills"),
      targetDirs: { pi: join(dir, "t", "pi") },
    }),
    security: { port: 4400, webPort: 3200, extraOrigins: [] },
  }));
});
afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 各接口回包字段的并集：测试只按需取用，省得每处都写一遍类型。 */
interface Body extends WorkItem {
  items: WorkItem[];
  prompt: string;
  item: WorkItem;
  sessionId: string;
  sessions: { id: string; title: string }[];
  connected: boolean;
  lastSync: unknown;
}

const call = async (method: string, url: string, payload?: unknown) => {
  const res = await app.inject({
    method: method as "GET",
    url,
    headers: { host: HOST },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
  if (res.body === "") return { status: res.statusCode, body: {} as Body };
  // 204 没有回包，上面已经单独处理。
  return { status: res.statusCode, body: res.json<Body>() };
};

describe("任务与需求：手记", () => {
  it("增删改查，按类别分开列", async () => {
    const created = await call("POST", "/api/work-items", {
      kind: "request",
      title: "导出 Excel",
      requester: "客户 A",
      priority: 2,
    });
    expect(created.status).toBe(201);
    const item = created.body as WorkItem;
    expect(item).toMatchObject({
      kind: "request",
      source: "manual",
      status: "todo",
      requester: "客户 A",
    });

    expect(
      (await call("GET", "/api/work-items?kind=request")).body.items,
    ).toHaveLength(1);
    expect(
      (await call("GET", "/api/work-items?kind=task")).body.items,
    ).toHaveLength(0);

    const patched = await call("PATCH", `/api/work-items/${item.id}`, {
      status: "done",
      title: "导出 Excel 报表",
    });
    expect(patched.body).toMatchObject({
      status: "done",
      title: "导出 Excel 报表",
    });

    expect((await call("DELETE", `/api/work-items/${item.id}`)).status).toBe(
      204,
    );
    expect(
      (await call("GET", `/api/work-items?kind=request`)).body.items,
    ).toEqual([]);
  });

  it("内部任务不能手建", async () => {
    const res = await call("POST", "/api/work-items", {
      kind: "task",
      title: "手建任务",
    });
    expect(res.status).toBe(400);
  });

  it("标题必填", async () => {
    const res = await call("POST", "/api/work-items", {
      kind: "request",
      title: "  ",
    });
    expect(res.status).toBe(400);
  });

  it("开对话：建会话、回提示词、待办挪到进行中", async () => {
    const item = (
      await call("POST", "/api/work-items", {
        kind: "request",
        title: "梳理权限模型",
        description: "现在角色太多",
      })
    ).body as WorkItem;
    const res = await call("POST", `/api/work-items/${item.id}/chat`);
    expect(res.status).toBe(201);
    expect(res.body.prompt).toContain("梳理权限模型");
    expect(res.body.prompt).toContain("现在角色太多");
    expect(res.body.item).toMatchObject({
      status: "doing",
      sessionId: res.body.sessionId,
    });
    const sessions = (await call("GET", "/api/sessions")).body.sessions;
    expect(sessions.find((s) => s.id === res.body.sessionId)?.title).toBe(
      "需求：梳理权限模型",
    );

    // 会话删了，条目上的对话链接跟着失效。
    await call("DELETE", `/api/sessions/${res.body.sessionId}`);
    const again = (await call("GET", "/api/work-items?kind=request")).body
      .items;
    expect(again[0]?.sessionId).toBeNull();
  });
});

describe("任务与需求：Linear", () => {
  it("没配 Key 不能同步", async () => {
    const res = await call("POST", "/api/integrations/linear/sync");
    expect(res.status).toBe(400);
  });

  it("保存 Key 先验证，状态只回末四位", async () => {
    const res = await call("PUT", "/api/integrations/linear", {
      key: "lin_api_secret1234",
      scope: "all",
      teamKey: "eng",
      includeDone: false,
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      connected: true,
      keyHint: "…1234",
      scope: "all",
      teamKey: "eng",
    });
    expect(JSON.stringify(res.body)).not.toContain("secret");
    expect(linearCalls[0]?.auth).toBe("lin_api_secret1234");
  });

  it("Key 被拒就不存", async () => {
    linearReply = () => new Response("{}", { status: 401 });
    const res = await call("PUT", "/api/integrations/linear", {
      key: "bad",
    });
    expect(res.status).toBe(400);
    expect((await call("GET", "/api/integrations/linear")).body.connected).toBe(
      false,
    );
  });

  it("同步：按过滤条件拉、重复同步只更新、本地关联的产品保留", async () => {
    await call("PUT", "/api/integrations/linear", {
      key: "lin_api_x",
      teamKey: "eng",
    });
    linearReply = () =>
      ok({
        issues: {
          nodes: [issue(1), issue(2, "started")],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    const first = await call("POST", "/api/integrations/linear/sync");
    expect(first.body.lastSync).toMatchObject({ ok: true, added: 2 });
    const vars = linearCalls.at(-1)?.body.variables as {
      filter: Record<string, unknown>;
    };
    expect(vars.filter).toMatchObject({
      assignee: { isMe: { eq: true } },
      team: { key: { eq: "ENG" } },
      state: { type: { nin: ["completed", "canceled"] } },
    });

    const tasks = (await call("GET", "/api/work-items?kind=task")).body.items;
    expect(tasks.map((t) => t.externalKey).sort()).toEqual(["ENG-1", "ENG-2"]);
    const two = tasks.find((t) => t.externalKey === "ENG-2");
    expect(two).toMatchObject({
      source: "linear",
      status: "doing",
      externalStatus: "In Progress",
      assignee: "小王",
      labels: ["Bug"],
    });

    // 外部条目只能改本地字段。
    const blocked = await call("PATCH", `/api/work-items/${two?.id ?? ""}`, {
      title: "改名",
    });
    expect(blocked.status).toBe(400);

    const second = await call("POST", "/api/integrations/linear/sync");
    expect(second.body.lastSync).toMatchObject({ added: 0, updated: 2 });
    expect(
      (await call("GET", "/api/work-items?kind=task")).body.items,
    ).toHaveLength(2);
  });

  it("状态映射", () => {
    expect(linearStatus("backlog")).toBe("todo");
    expect(linearStatus("triage")).toBe("todo");
    expect(linearStatus("started")).toBe("doing");
    expect(linearStatus("completed")).toBe("done");
    expect(linearStatus("canceled")).toBe("canceled");
  });
});
