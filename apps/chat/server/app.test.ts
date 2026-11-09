import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

import { createApp } from "./app.js";
import { createAgentStore } from "./agents.js";
import { IN_MEMORY, openDb, type Db } from "./db.js";
import { createKeyStore } from "./model-config.js";
import { createFauxSetup } from "./pi/faux.js";
import { createSkillStore } from "./skills.js";
import { piPaths, type PiPaths } from "./pi/runtime.js";

/**
 * HTTP 契约。错了前端 useChat 会**静默**不工作，所以逐条钉住：协议头、分帧、
 * [DONE] 收尾、无活跃轮次回 204、安全闸、没配模型时以「失败的回答」返回。
 */

let dir: string;
let db: Db;
let paths: PiPaths;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chat-app-"));
  db = openDb(IN_MEMORY);
  paths = piPaths(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 技能库：目录与分发目标全在临时目录里，测试绝不碰真实的 ~/.pi。 */
function skillStore() {
  return createSkillStore({
    dir: paths.skillsDir,
    targetDirs: {
      pi: join(dir, "targets", "pi"),
    },
  });
}

/** 执行体库：同理，分发目标也指向临时目录。 */
function agentStore() {
  return createAgentStore({
    dir: paths.agentsDir,
    targetDirs: { pi: join(dir, "targets", "pi-agents") },
  });
}

async function fauxApp() {
  const setup = await createFauxSetup(paths);
  const { app, runner } = createApp({
    auth: false,
    db,
    paths,
    keys: createKeyStore(dir, {}),
    skills: skillStore(),
    security: false,
    provision: () =>
      Promise.resolve({
        key: "faux",
        setup,
        defaultModel: setup.model,
        defaultThinking: "off",
      }),
  });
  return { app, runner, setup };
}

function frames(body: string): {
  chunks: { type: string; [k: string]: unknown }[];
  done: boolean;
} {
  const parts = body.split("\n\n").filter((f) => f !== "");
  const done = parts.at(-1) === "data: [DONE]";
  return {
    done,
    chunks: parts
      .filter((f) => f !== "data: [DONE]")
      .map((f) => JSON.parse(f.slice(6)) as { type: string }),
  };
}

describe("会话 CRUD", () => {
  it("新建 → 列表 → 改名 → 删除", async () => {
    const { app } = await fauxApp();
    const created = await app.inject({ method: "POST", url: "/api/sessions" });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();
    expect(
      (await app.inject({ url: "/api/sessions" })).json<{
        sessions: unknown[];
      }>().sessions,
    ).toHaveLength(1);
    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/sessions/${id}`,
      payload: { title: "改过" },
    });
    expect(renamed.json<{ title: string }>().title).toBe("改过");
    expect(
      (await app.inject({ method: "DELETE", url: `/api/sessions/${id}` }))
        .statusCode,
    ).toBe(204);
    expect(
      (await app.inject({ url: `/api/sessions/${id}/messages` })).statusCode,
    ).toBe(404);
  });
});

describe("POST /chat", () => {
  it("UI Message Stream v1：协议头、逐帧 data:、[DONE] 收尾；历史随后可读", async () => {
    const { app, setup } = await fauxApp();
    const { id } = (
      await app.inject({ method: "POST", url: "/api/sessions" })
    ).json<{ id: string }>();
    setup.faux.setResponses([fauxAssistantMessage(fauxText("你好"))]);

    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/chat`,
      payload: { message: "hi" },
    });
    expect(res.headers["x-vercel-ai-ui-message-stream"]).toBe("v1");
    expect(res.headers["content-type"]).toContain("text/event-stream");
    const { chunks, done } = frames(res.body);
    expect(done).toBe(true);
    expect(chunks[0]?.type).toBe("start");
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });

    const history = (
      await app.inject({ url: `/api/sessions/${id}/messages` })
    ).json<{
      messages: { role: string }[];
      streaming: boolean;
    }>();
    expect(history.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history.streaming).toBe(false);
  });

  it("没配模型：以一条失败的回答返回原因（而不是网络错误）", async () => {
    const { app } = createApp({
      auth: false,
      db,
      paths,
      keys: createKeyStore(dir, {}),
      skills: skillStore(),
      security: false,
    });
    const { id } = (
      await app.inject({ method: "POST", url: "/api/sessions" })
    ).json<{ id: string }>();
    const res = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/chat`,
      payload: { message: "hi" },
    });
    const { chunks, done } = frames(res.body);
    expect(done).toBe(true);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "data-error",
        data: { message: "还没有接入任何模型，去设置里添加一个 provider" },
      }),
    );
  });

  it("会话不存在：404，不开流", async () => {
    const { app } = await fauxApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/nope/chat",
      payload: { message: "hi" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("续流 / 排队 / 停止", () => {
  it("没有活跃轮次：续流 204，排队拒绝", async () => {
    const { app } = await fauxApp();
    const { id } = (
      await app.inject({ method: "POST", url: "/api/sessions" })
    ).json<{ id: string }>();
    expect(
      (await app.inject({ url: `/api/sessions/${id}/chat/stream` })).statusCode,
    ).toBe(204);
    const queued = await app.inject({
      method: "POST",
      url: `/api/sessions/${id}/queue`,
      payload: { message: "x" },
    });
    expect(queued.json()).toEqual({ queued: false, pending: 0 });
    expect(
      (await app.inject({ method: "POST", url: `/api/sessions/${id}/abort` }))
        .statusCode,
    ).toBe(204);
  });
});

describe("模型接入", () => {
  it("多个 provider：自定义中转 + 内置；可用模型是并集；key 只写不读", async () => {
    const keys = createKeyStore(dir, {});
    const { app } = createApp({
      auth: false,
      db,
      paths,
      keys,
      skills: skillStore(),
      security: false,
    });
    const relay = await app.inject({
      method: "PUT",
      url: "/api/providers/custom/relay",
      payload: {
        baseUrl: "https://relay.invalid",
        api: "anthropic-messages",
        models: ["claude-opus-4-8", "自定义模型"],
        key: "sk-relay-secret",
      },
    });
    expect(relay.statusCode).toBe(200);
    const builtin = await app.inject({
      method: "PUT",
      url: "/api/providers/anthropic/key",
      payload: { key: "sk-anthropic-secret" },
    });
    expect(builtin.statusCode).toBe(204);

    const providers = await app.inject({ url: "/api/providers" });
    expect(providers.body).not.toContain("secret");
    const configured = providers.json<{
      configured: { id: string; kind: string; keySource: string }[];
    }>().configured;
    expect(configured.map((p) => [p.id, p.kind, p.keySource])).toEqual([
      ["relay", "custom", "file"],
      ["anthropic", "builtin", "file"],
    ]);

    const models = (await app.inject({ url: "/api/models" })).json<{
      models: { provider: string; id: string; inheritedFrom: string | null }[];
      defaultModel: { provider: string; modelId: string } | null;
    }>();
    const relayModels = models.models.filter((m) => m.provider === "relay");
    // 中转模型按同 id 同协议继承 pi 内置目录（含 adaptive thinking 的 compat）；目录里没有的不继承。
    expect(relayModels).toEqual([
      expect.objectContaining({
        id: "claude-opus-4-8",
        inheritedFrom: "anthropic/claude-opus-4-8",
      }),
      expect.objectContaining({ id: "自定义模型", inheritedFrom: null }),
    ]);
    expect(models.models.some((m) => m.provider === "anthropic")).toBe(true);
    expect(models.defaultModel).not.toBeNull();
  });

  it("默认模型：设置后新会话用它；移除 provider 时默认模型一并清掉", async () => {
    const keys = createKeyStore(dir, {});
    const { app } = createApp({
      auth: false,
      db,
      paths,
      keys,
      skills: skillStore(),
      security: false,
    });
    await app.inject({
      method: "PUT",
      url: "/api/providers/custom/relay",
      payload: {
        baseUrl: "https://relay.invalid",
        api: "openai-completions",
        models: ["模型 A", "模型 B"],
        key: "k",
      },
    });
    await app.inject({
      method: "PUT",
      url: "/api/defaults",
      payload: {
        defaultModel: { provider: "relay", modelId: "模型 B" },
        defaultThinking: "low",
      },
    });
    const { id } = (
      await app.inject({ method: "POST", url: "/api/sessions" })
    ).json<{ id: string }>();
    const state = (
      await app.inject({ url: `/api/sessions/${id}/model` })
    ).json<{ modelId: string; thinkingLevel: string }>();
    expect(state).toMatchObject({ modelId: "模型 B", thinkingLevel: "low" });

    const switched = await app.inject({
      method: "PUT",
      url: `/api/sessions/${id}/model`,
      payload: { provider: "relay", modelId: "模型 A" },
    });
    expect(switched.json<{ modelId: string }>().modelId).toBe("模型 A");

    await app.inject({ method: "DELETE", url: "/api/providers/relay" });
    const providers = (await app.inject({ url: "/api/providers" })).json<{
      defaultModel: unknown;
      configured: unknown[];
    }>();
    expect(providers.defaultModel).toBeNull();
    expect(providers.configured).toEqual([]);
  });

  it("自定义中转不能占用 pi 内置 provider 的名字；非法 id 被拒", async () => {
    const { app } = createApp({
      auth: false,
      db,
      paths,
      keys: createKeyStore(dir, {}),
      skills: skillStore(),
      security: false,
    });
    const clash = await app.inject({
      method: "PUT",
      url: "/api/providers/custom/anthropic",
      payload: {
        baseUrl: "https://x.invalid",
        api: "anthropic-messages",
        models: ["m"],
      },
    });
    expect(clash.statusCode).toBe(400);
    const bad = await app.inject({
      method: "PUT",
      url: "/api/providers/custom/..%2Fetc",
      payload: {
        baseUrl: "https://x.invalid",
        api: "anthropic-messages",
        models: ["m"],
      },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("上一版的单份配置自动迁移成一个自定义 provider + 默认模型", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('model', ?)").run(
      JSON.stringify({
        providerId: "relay",
        modelId: "claude-opus-4-8",
        thinkingLevel: "high",
        custom: { baseUrl: "https://relay.invalid", api: "anthropic-messages" },
      }),
    );
    const { app } = createApp({
      auth: false,
      db,
      paths,
      keys: createKeyStore(dir, {}),
      skills: skillStore(),
      security: false,
    });
    const providers = (await app.inject({ url: "/api/providers" })).json<{
      configured: { id: string; models: string[] }[];
      defaultModel: unknown;
      defaultThinking: string;
    }>();
    expect(providers.configured[0]).toMatchObject({
      id: "relay",
      models: ["claude-opus-4-8"],
    });
    expect(providers.defaultModel).toEqual({
      provider: "relay",
      modelId: "claude-opus-4-8",
    });
    expect(providers.defaultThinking).toBe("high");
  });

  it("拉取模型：优先用刚填的 key；没填就用已保存的；都没有则提示先填", async () => {
    const keys = createKeyStore(dir, {});
    const seen: string[] = [];
    const probeFetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string>).authorization ?? "");
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: "模型 A" }] }), {
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;
    const { app } = createApp({
      auth: false,
      db,
      paths,
      keys,
      skills: skillStore(),
      security: false,
      probeFetch,
    });
    const body = {
      baseUrl: "https://relay.invalid",
      api: "openai-completions",
      providerId: "relay",
    };

    const noKey = await app.inject({
      method: "POST",
      url: "/api/model/probe",
      payload: body,
    });
    expect(noKey.statusCode).toBe(400);
    expect(
      noKey.json<{ error: { message: string } }>().error.message,
    ).toContain("先填 API key");

    const inline = await app.inject({
      method: "POST",
      url: "/api/model/probe",
      payload: { ...body, key: "sk-inline" },
    });
    expect(inline.json()).toEqual({ models: ["模型 A"] });

    await keys.set("relay", "sk-saved");
    await app.inject({
      method: "POST",
      url: "/api/model/probe",
      payload: body,
    });
    expect(seen).toEqual(["Bearer sk-inline", "Bearer sk-saved"]);
  });
});

describe("安全闸", () => {
  const secured = () =>
    createApp({
      auth: false,
      db,
      paths,
      keys: createKeyStore(dir, {}),
      skills: skillStore(),
      security: { port: 4400, webPort: 3200, extraOrigins: [] },
    }).app;

  it("陌生 Host（DNS rebinding）被拒", async () => {
    const res = await secured().inject({
      url: "/api/health",
      headers: { host: "evil.example:4400" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("跨站写请求被拒；本站前端放行", async () => {
    const app = secured();
    const evil = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { host: "127.0.0.1:4400", origin: "https://evil.example" },
    });
    expect(evil.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { host: "127.0.0.1:4400", origin: "http://127.0.0.1:3200" },
    });
    expect(ok.statusCode).toBe(201);
  });
});

describe("技能接口", () => {
  const skillApp = () =>
    createApp({
      auth: false,
      db,
      paths,
      keys: createKeyStore(dir, {}),
      skills: skillStore(),
      security: false,
    }).app;

  const md = (name: string, description = "写 PRD 时用。") =>
    `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`;

  it("建、列、读、改、删走完一整圈", async () => {
    const app = skillApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: md("write-prd") },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ name: string }>().name).toBe("write-prd");

    const listed = await app.inject({ url: "/api/skills" });
    expect(
      listed.json<{ skills: { name: string }[] }>().skills.map((s) => s.name),
    ).toEqual(["write-prd"]);

    const got = await app.inject({ url: "/api/skills/write-prd" });
    expect(got.json<{ content: string }>().content).toContain("正文");

    // 改 frontmatter 的 name：连目录一起改名，旧名就 404 了。
    const renamed = await app.inject({
      method: "PUT",
      url: "/api/skills/write-prd",
      payload: { content: md("write-spec") },
    });
    expect(renamed.json<{ name: string }>().name).toBe("write-spec");
    expect(
      (await app.inject({ url: "/api/skills/write-prd" })).statusCode,
    ).toBe(404);

    const removed = await app.inject({
      method: "DELETE",
      url: "/api/skills/write-spec",
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (await app.inject({ url: "/api/skills" })).json<{ skills: unknown[] }>()
        .skills,
    ).toEqual([]);
  });

  it("fastify 自己的 4xx 不会被翻成 500（空 JSON body 就该是 400）", async () => {
    const res = await skillApp().inject({
      method: "POST",
      url: "/api/skills",
      headers: { "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).not.toBe(
      "服务内部错误",
    );
  });

  it("frontmatter 不合格回 400 并说清缺什么", async () => {
    const res = await skillApp().inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: "---\nname: no-desc\n---\n正文" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain(
      "description",
    );
  });

  it("分发传的是期望集合：没列出来的目标会被摘掉", async () => {
    const app = skillApp();
    await app.inject({
      method: "POST",
      url: "/api/skills",
      payload: { content: md("write-prd") },
    });
    const both = await app.inject({
      method: "PUT",
      url: "/api/skills/write-prd/distribution",
      payload: { targets: ["pi"] },
    });
    expect(both.json<{ distribution: unknown }>().distribution).toEqual({
      pi: "linked",
    });
    const one = await app.inject({
      method: "PUT",
      url: "/api/skills/write-prd/distribution",
      payload: { targets: [] },
    });
    expect(one.json<{ distribution: unknown }>().distribution).toEqual({
      pi: "absent",
    });
    // 旧目标名已经不认：去掉 Claude 之后传 claude 应当被拒，而不是静默忽略。
    const legacy = await app.inject({
      method: "PUT",
      url: "/api/skills/write-prd/distribution",
      payload: { targets: ["claude"] },
    });
    expect(legacy.statusCode).toBe(400);
  });
});

describe("执行体接口", () => {
  const agentApp = () =>
    createApp({
      auth: false,
      db,
      paths,
      keys: createKeyStore(dir, {}),
      skills: skillStore(),
      agents: agentStore(),
      security: false,
    }).app;

  const md = (name: string, extra = "") =>
    `---\nname: ${name}\ndescription: 只读核代码事实。写 PRD 要核现状时派它。\n${extra}---\n\n纪律\n`;

  it("建、列、读、改、删走完一整圈", async () => {
    const app = agentApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { content: md("codebase-auditor", "tools: Read, Grep\n") },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ tools: string[] }>().tools).toEqual(["Read", "Grep"]);

    const listed = await app.inject({ url: "/api/agents" });
    expect(
      listed.json<{ agents: { name: string }[] }>().agents.map((a) => a.name),
    ).toEqual(["codebase-auditor"]);

    const got = await app.inject({ url: "/api/agents/codebase-auditor" });
    expect(got.json<{ content: string }>().content).toContain("纪律");

    // 改 frontmatter 的 name：连文件一起改名，旧名就 404 了。
    const renamed = await app.inject({
      method: "PUT",
      url: "/api/agents/codebase-auditor",
      payload: { content: md("code-auditor") },
    });
    expect(renamed.json<{ name: string }>().name).toBe("code-auditor");
    expect(
      (await app.inject({ url: "/api/agents/codebase-auditor" })).statusCode,
    ).toBe(404);

    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/api/agents/code-auditor",
        })
      ).statusCode,
    ).toBe(204);
  });

  it("frontmatter 不合格回 400 并说清缺什么", async () => {
    const res = await agentApp().inject({
      method: "POST",
      url: "/api/agents",
      payload: { content: "---\nname: no-desc\n---\n纪律" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: { message: string } }>().error.message).toContain(
      "description",
    );
  });

  it("分发传的是期望集合：传空数组就撤销", async () => {
    const app = agentApp();
    await app.inject({
      method: "POST",
      url: "/api/agents",
      payload: { content: md("codebase-auditor") },
    });
    const on = await app.inject({
      method: "PUT",
      url: "/api/agents/codebase-auditor/distribution",
      payload: { targets: ["pi"] },
    });
    expect(on.json<{ distribution: unknown }>().distribution).toEqual({
      pi: "linked",
    });
    const off = await app.inject({
      method: "PUT",
      url: "/api/agents/codebase-auditor/distribution",
      payload: { targets: [] },
    });
    expect(off.json<{ distribution: unknown }>().distribution).toEqual({
      pi: "absent",
    });
  });

  it("不传 agents 依赖时这组接口整体不注册（404，不是 500）", async () => {
    const app = createApp({
      auth: false,
      db,
      paths,
      keys: createKeyStore(dir, {}),
      skills: skillStore(),
      security: false,
    }).app;
    expect((await app.inject({ url: "/api/agents" })).statusCode).toBe(404);
  });
});
