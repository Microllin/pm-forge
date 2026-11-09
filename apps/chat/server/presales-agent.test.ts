import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { IN_MEMORY, openDb, type Db } from "./db.js";
import {
  createFileStore,
  openFilesIndex,
  type FileStore,
} from "./files/store.js";
import { createKeyStore } from "./model-config.js";
import { piPaths } from "./pi/runtime.js";
import { computeTodos, type PresalesAgent } from "./presales-agent.js";
import { createSessionStore, type SessionStore } from "./sessions.js";
import { createSkillStore } from "./skills.js";

/**
 * 售前助手与巡检：
 * - 巡检待办是纯规则（缺口 / 模板缺项 / 文件丢失 / 没审过 / 审完又换文件 / 待定修订 / 草稿待审定）；
 * - 助手是一库一条的真会话，身份与工具只给 presales-agent 会话；
 * - 工具走本服务接口：读清单看得到标准 vs 实际，起草只落成草稿版、现行版不动；
 * - 「上传后自动审阅」开着才自动发起，关了不发。
 */

const HOST = "127.0.0.1:4400";
let dir: string;
let db: Db;
let index: Db;
let files: FileStore;
let store: SessionStore;
let app: ReturnType<typeof createApp>["app"];
let agent: PresalesAgent;
let reviewCalls = 0;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-presales-agent-")));
  db = openDb(IN_MEMORY);
  index = openFilesIndex();
  mkdirSync(join(dir, "files"));
  files = createFileStore(join(dir, "files"), index);
  store = createSessionStore(db);
  reviewCalls = 0;
  ({ app, presalesAgent: agent } = createApp({
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
    security: { port: 4400, webPort: 3200, extraOrigins: [] },
    fillRunner: {
      chat({ sessionId, onChunk }) {
        reviewCalls += 1;
        store.append(sessionId, [
          {
            type: "message",
            id: randomUUID(),
            message: {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: '```json\n{"verdict":"可用","summary":"","issues":[]}\n```',
                },
              ],
            },
          },
        ]);
        onChunk({ type: "finish", finishReason: "stop" });
        return Promise.resolve();
      },
      abort: () => undefined,
    },
  }));
});

afterEach(async () => {
  await new Promise((r) => setTimeout(r, 30));
  await app.close();
  db.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
async function call<T>(
  method: "GET" | "POST",
  url: string,
  payload?: object | Buffer,
  query = "",
): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method,
    url: encodeURI(`${url}${query}`),
    headers: {
      host: HOST,
      ...(Buffer.isBuffer(payload)
        ? { "content-type": "application/octet-stream" }
        : {}),
    },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    status: res.statusCode,
    body: res.body === "" ? (undefined as T) : res.json<T>(),
  };
}

interface SlotView {
  id: string;
  title: string;
  current: { id: string } | null;
  versions: { id: string; status: string; filePath: string }[];
}

async function seedLib(): Promise<{ libId: string; slots: SlotView[] }> {
  const lib = await call<{ lib: { id: string }; slots: SlotView[] }>(
    "POST",
    "/api/presales",
    {},
  );
  return { libId: lib.body.lib.id, slots: lib.body.slots };
}

const runTool = async (
  sessionId: string,
  name: string,
  params: Record<string, unknown>,
): Promise<string> => {
  const session = store.get(sessionId);
  if (session === undefined) throw new Error("no session");
  const tool = agent.profile(session)?.tools?.find((t) => t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  const out = await (
    tool.execute as unknown as (
      id: string,
      p: unknown,
    ) => Promise<{ content: { text: string }[] }>
  )("t1", params);
  return out.content.map((c) => c.text).join("");
};

describe("computeTodos", () => {
  const base = {
    lib: {
      id: "l",
      name: "库",
      productId: null,
      templateId: "t",
      templateName: "模板",
    },
    stages: [{ code: "S1", label: "初步接触" }],
  };
  const slot = (over: Record<string, unknown>) => ({
    id: "s1",
    title: "白皮书",
    stage: "S1",
    priority: true,
    audience: "external" as const,
    guide: "",
    checkpoints: [],
    link: "linked" as const,
    templateItem: null,
    versions: [],
    current: null,
    ...over,
  });
  const v = (id: string, status = "current", name = "白皮书.docx") => ({
    id,
    version: "v1.0",
    status: status as "current",
    fileName: name,
    fileExists: true,
    updatedAt: 1000,
    createdAt: 1000,
  });

  it("模板缺项（必备 = 高）、条目缺口、草稿待审定各出一条", () => {
    const todos = computeTodos(
      {
        ...base,
        slots: [
          slot({}),
          slot({
            id: "s2",
            title: "FAQ",
            priority: false,
            versions: [v("d1", "draft", "FAQ.md")],
          }),
        ],
        templateGaps: [
          {
            id: "g1",
            name: "POC方案",
            stageCode: "S1",
            stageLabel: "初步接触",
            required: true,
            audience: "external",
          },
        ],
      },
      { reviews: {}, busy: false },
      2000,
    );
    expect(todos.map((t) => [t.id, t.level])).toEqual([
      ["gap:g1", "high"],
      ["missing:s1", "high"],
      ["draft:s2", "mid"],
    ]);
    expect(todos[0]?.actions).toEqual(["add"]);
    expect(todos[1]?.actions).toEqual(["upload", "draft"]);
  });

  it("文件丢失为高，且不再报没审过", () => {
    const todos = computeTodos(
      {
        ...base,
        slots: [slot({ current: { ...v("c1"), fileExists: false } })],
        templateGaps: [],
      },
      { reviews: {}, busy: false },
      2000,
    );
    expect(todos.map((t) => t.id)).toEqual(["lost:s1"]);
  });

  it("没审过 / 审完又换文件 / 有待定 P0 / 半年没更新", () => {
    const cur = v("c2");
    const brief = (versionId: string, pending: number, p0: number) => ({
      id: "j",
      versionId,
      status: "done",
      error: null,
      verdict: "需修改",
      counts: { total: pending, p0, pending, accepted: 0, applied: 0 },
    });
    const one = (reviews: Record<string, ReturnType<typeof brief>>) =>
      computeTodos(
        { ...base, slots: [slot({ current: cur })], templateGaps: [] },
        { reviews, busy: false },
        2000,
      ).map((t) => `${t.id}/${t.level}`);
    expect(one({})).toEqual(["unreviewed:s1/mid"]);
    expect(one({ s1: brief("c1", 0, 0) })).toEqual(["stale-review:s1/mid"]);
    expect(one({ s1: brief("c2", 3, 1) })).toEqual(["pending:s1/high"]);
    expect(one({ s1: brief("c2", 0, 0) })).toEqual([]);
    expect(
      computeTodos(
        { ...base, slots: [slot({ current: cur })], templateGaps: [] },
        { reviews: { s1: brief("c2", 0, 0) }, busy: false },
        1000 + 200 * 24 * 3600 * 1000,
      ).map((t) => t.id),
    ).toEqual(["old:s1"]);
  });

  it("视频这类读不出文字的不报「没审过」", () => {
    const todos = computeTodos(
      {
        ...base,
        slots: [slot({ current: v("c1", "current", "演示.mp4") })],
        templateGaps: [],
      },
      { reviews: {}, busy: false },
      2000,
    );
    expect(todos).toEqual([]);
  });
});

describe("售前助手", () => {
  it("一库一条会话：重复取拿到同一条，身份与工具只给它", async () => {
    const { libId } = await seedLib();
    const a = await call<{ sessionId: string }>(
      "POST",
      `/api/presales/${libId}/agent/session`,
      {},
    );
    const b = await call<{ sessionId: string }>(
      "POST",
      `/api/presales/${libId}/agent/session`,
      {},
    );
    expect(a.status).toBe(200);
    expect(b.body.sessionId).toBe(a.body.sessionId);
    const session = store.get(a.body.sessionId);
    expect(session?.task).toEqual({ kind: "presales-agent", libId });
    const profile = session === undefined ? undefined : agent.profile(session);
    expect(profile?.systemPrompt).toContain("售前助手");
    expect(profile?.tools?.map((t) => t.name)).toEqual([
      "presales_overview",
      "presales_read_material",
      "presales_start_review",
      "presales_review_result",
      "presales_write_draft",
    ]);

    // 普通对话不受影响。
    const plain = await call<{ id: string }>("POST", "/api/sessions", {});
    const row = store.get(plain.body.id);
    expect(row === undefined ? "x" : agent.profile(row)).toBeUndefined();

    const state = await call<{ sessionId: string; autoReview: boolean }>(
      "GET",
      `/api/presales/${libId}/agent`,
    );
    expect(state.body.sessionId).toBe(a.body.sessionId);
    expect(state.body.autoReview).toBe(true);
  });

  it("读清单看得到标准与缺口；起草只落草稿、现行版不动；读得到草稿正文", async () => {
    const { libId, slots } = await seedLib();
    const target = slots[0];
    if (target === undefined) throw new Error("模板没铺出条目");
    const { body } = await call<{ sessionId: string }>(
      "POST",
      `/api/presales/${libId}/agent/session`,
      {},
    );

    const overview = await runTool(body.sessionId, "presales_overview", {});
    expect(overview).toContain("标准 vs 实际");
    expect(overview).toContain(target.title);
    expect(overview).toContain("巡检待办");

    const saved = await runTool(body.sessionId, "presales_write_draft", {
      material: target.title,
      fileName: "测试草稿",
      markdown: "# 草稿\n并发上限 100（待核实）",
    });
    expect(saved).toContain("草稿");

    const detail = await call<{ slots: SlotView[] }>(
      "GET",
      `/api/presales/${libId}`,
    );
    const after = detail.body.slots.find((s) => s.id === target.id);
    expect(after?.current).toBeNull();
    expect(after?.versions.map((v) => v.status)).toEqual(["draft"]);
    expect(after?.versions[0]?.filePath).toMatch(
      /^\/临时区\/售前\/.+\/AI草稿\/测试草稿\.md$/,
    );

    const text = await runTool(body.sessionId, "presales_read_material", {
      material: target.title,
    });
    expect(text).toContain("并发上限 100");

    // 待办里出现「草稿待审定」。
    const state = await call<{ todos: { id: string }[] }>(
      "GET",
      `/api/presales/${libId}/agent`,
    );
    expect(state.body.todos.map((t) => t.id)).toContain(`draft:${target.id}`);

    await expect(
      runTool(body.sessionId, "presales_read_material", {
        material: "不存在的",
      }),
    ).rejects.toThrow(/找不到材料/);
  });

  it("上传后自动审阅：开着就发起，关掉不发", async () => {
    const { libId, slots } = await seedLib();
    const [first, second] = slots;
    if (first === undefined || second === undefined)
      throw new Error("模板条目不够");

    await call(
      "POST",
      `/api/presales/slots/${first.id}/upload`,
      Buffer.from("# A"),
      "?name=a.md",
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(reviewCalls).toBe(1);

    await call("POST", `/api/presales/${libId}/agent/patrol`, {
      autoReview: false,
    });
    await call(
      "POST",
      `/api/presales/slots/${second.id}/upload`,
      Buffer.from("# B"),
      "?name=b.md",
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(reviewCalls).toBe(1);
  });
});
