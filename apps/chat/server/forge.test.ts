import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentStore } from "./agents.js";
import { createApp } from "./app.js";
import { IN_MEMORY, openDb, type Db } from "./db.js";
import { checkDraftPath, type Forge, type ForgeDraft } from "./forge.js";
import { createKeyStore } from "./model-config.js";
import { newSessionHeader, piPaths } from "./pi/runtime.js";
import { createSessionStore, type SessionStore } from "./sessions.js";
import { createSkillStore } from "./skills.js";

/**
 * AI 工坊：
 * - 三种入口都开一条工坊会话 + 一份草稿；AI 只能写草稿，人点保存才进库；
 * - 草稿每次写都按库的同一把尺子校验；同名冲突、缺 frontmatter 在保存前就拦下；
 * - 修改模式：保存只动改过的附属文件；原件在编辑期间被改过时拒绝覆盖，除非确认；
 * - 沉淀模式：只读普通对话，工坊自己的会话不当素材。
 */

const HOST = "127.0.0.1:4400";
let dir: string;
let db: Db;
let store: SessionStore;
let app: ReturnType<typeof createApp>["app"];
let forge: Forge;

const SKILL = (name: string, extra = ""): string =>
  `---\nname: ${name}\ndescription: 写竞品分析。用户说「竞品分析」「对标」时用。\n---\n\n# 竞品分析\n\n## 步骤\n1. 先问目标${extra}\n`;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-forge-")));
  db = openDb(IN_MEMORY);
  store = createSessionStore(db);
  ({ app, forge } = createApp({
    auth: false,
    db,
    paths: piPaths(dir),
    keys: createKeyStore(dir, {}),
    skills: createSkillStore({
      dir: join(dir, "skills"),
      targetDirs: { pi: join(dir, "t", "pi") },
    }),
    agents: createAgentStore({
      dir: join(dir, "agents"),
      targetDirs: { pi: join(dir, "t", "agents") },
    }),
    security: { port: 4400, webPort: 3200, extraOrigins: [] },
  }));
});

afterEach(async () => {
  await app.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
async function call<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
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
    body: res.body === "" ? (undefined as T) : res.json<T>(),
  };
}

const open = async (
  kind: "skill" | "agent",
  mode: "create" | "edit" | "distill",
  name?: string,
) =>
  (
    await call<{ sessionId: string; reused: boolean; kickoff: string | null }>(
      "POST",
      "/api/forge",
      { kind, mode, ...(name === undefined ? {} : { name }) },
    )
  ).body;

const draft = async (id: string) =>
  (await call<ForgeDraft & { stale: boolean }>("GET", `/api/forge/${id}`)).body;

const tool = async (
  sessionId: string,
  name: string,
  params: Record<string, unknown> = {},
): Promise<string> => {
  const session = store.get(sessionId);
  if (session === undefined) throw new Error("no session");
  const t = forge.profile(session)?.tools?.find((x) => x.name === name);
  if (t === undefined) throw new Error(`no tool ${name}`);
  const out = await (
    t.execute as unknown as (
      id: string,
      p: unknown,
    ) => Promise<{ content: { text: string }[] }>
  )("t1", params);
  return out.content.map((c) => c.text).join("");
};

describe("AI 新建技能", () => {
  it("草稿逐次校验，保存后连附属文件一起进库", async () => {
    const { sessionId, kickoff } = await open("skill", "create");
    expect(kickoff).toBeNull();
    expect(store.get(sessionId)?.task).toEqual({
      kind: "forge",
      of: "skill",
      mode: "create",
    });

    const bad = await tool(sessionId, "draft_write", {
      path: "SKILL.md",
      content: "# 没有 frontmatter",
    });
    expect(bad).toContain("缺 name");
    expect(
      (await call("POST", `/api/forge/${sessionId}/save`, {})).status,
    ).toBe(400);

    await tool(sessionId, "draft_write", {
      path: "SKILL.md",
      content: SKILL("competitor-analysis"),
    });
    await tool(sessionId, "draft_write", {
      path: "references/template.md",
      content: "# 模板",
    });
    const d = await draft(sessionId);
    expect(d.problems.errors).toEqual([]);
    expect(d.name).toBe("competitor-analysis");

    const saved = await call<{ name: string; draft: ForgeDraft }>(
      "POST",
      `/api/forge/${sessionId}/save`,
      {},
    );
    expect(saved.status).toBe(200);
    expect(saved.body.name).toBe("competitor-analysis");
    expect(saved.body.draft.dirty).toBe(false);
    expect(saved.body.draft.target).toBe("competitor-analysis");

    const skill = await call<{ files: string[] }>(
      "GET",
      "/api/skills/competitor-analysis",
    );
    expect([...skill.body.files].sort()).toEqual([
      "SKILL.md",
      "references/template.md",
    ]);
  });

  it("和库里重名时保存前就报出来", async () => {
    await call("POST", "/api/skills", { content: SKILL("dup") });
    const { sessionId } = await open("skill", "create");
    const out = await tool(sessionId, "draft_write", {
      path: "SKILL.md",
      content: SKILL("dup"),
    });
    expect(out).toContain("已经有「dup」");
    expect(
      (await call("POST", `/api/forge/${sessionId}/save`, {})).status,
    ).toBe(400);
  });

  it("草稿路径不许越界", () => {
    expect(() => checkDraftPath("skill", "../x.md")).toThrow();
    expect(() => checkDraftPath("skill", ".git/config")).toThrow();
    expect(() => checkDraftPath("skill", "/etc/passwd")).toThrow();
    expect(checkDraftPath("skill", "./references/a.md")).toBe(
      "references/a.md",
    );
    expect(() => checkDraftPath("agent", "x.md")).toThrow();
  });

  it("draft_base_on 把现有技能载入，保存变成更新而不是重复新建", async () => {
    await call("POST", "/api/skills", { content: SKILL("base") });
    const { sessionId } = await open("skill", "distill");
    await tool(sessionId, "draft_base_on", { name: "base" });
    await tool(sessionId, "draft_edit", {
      path: "SKILL.md",
      old_text: "1. 先问目标",
      new_text: "1. 先问目标与目标用户",
    });
    expect((await draft(sessionId)).problems.errors).toEqual([]);
    const saved = await call<{ name: string }>(
      "POST",
      `/api/forge/${sessionId}/save`,
      {},
    );
    expect(saved.body.name).toBe("base");
    const skill = await call<{ content: string }>("GET", "/api/skills/base");
    expect(skill.body.content).toContain("先问目标与目标用户");
  });
});

describe("AI 修改技能", () => {
  it("载入现有内容，只写改过的附属文件，删掉的同步删", async () => {
    await call("POST", "/api/skills/tree", {
      files: [
        {
          path: "SKILL.md",
          base64: Buffer.from(SKILL("prd")).toString("base64"),
        },
        {
          path: "references/a.md",
          base64: Buffer.from("A").toString("base64"),
        },
        {
          path: "references/b.md",
          base64: Buffer.from("B").toString("base64"),
        },
      ],
    });
    const { sessionId } = await open("skill", "edit", "prd");
    const before = await draft(sessionId);
    expect(Object.keys(before.files).sort()).toEqual([
      "SKILL.md",
      "references/a.md",
      "references/b.md",
    ]);
    expect(before.dirty).toBe(false);

    // 同一个技能再点「AI 修改」：没改过就开新的；改过没保存就接着用。
    await tool(sessionId, "draft_write", {
      path: "references/a.md",
      content: "A2",
    });
    await tool(sessionId, "draft_delete", { path: "references/b.md" });
    const again = await open("skill", "edit", "prd");
    expect(again).toMatchObject({ sessionId, reused: true });

    await call("POST", `/api/forge/${sessionId}/save`, {});
    const skill = await call<{ files: string[] }>("GET", "/api/skills/prd");
    expect([...skill.body.files].sort()).toEqual([
      "SKILL.md",
      "references/a.md",
    ]);
    const a = await call<{ text: string }>(
      "GET",
      "/api/skills/prd/file?path=references%2Fa.md",
    );
    expect(a.body.text).toBe("A2");
  });

  it("原件在编辑期间被手改过：先拒，确认后才覆盖", async () => {
    await call("POST", "/api/skills", { content: SKILL("x") });
    const { sessionId } = await open("skill", "edit", "x");
    await tool(sessionId, "draft_edit", {
      path: "SKILL.md",
      old_text: "1. 先问目标",
      new_text: "1. AI 改的",
    });
    await call("PUT", "/api/skills/x", {
      content: SKILL("x", "\n2. 人手改的"),
    });
    expect((await draft(sessionId)).stale).toBe(true);

    const refused = await call<{ error: { message: string } }>(
      "POST",
      `/api/forge/${sessionId}/save`,
      {},
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain("被别处改过");

    const forced = await call("POST", `/api/forge/${sessionId}/save`, {
      force: true,
    });
    expect(forced.status).toBe(200);
    const skill = await call<{ content: string }>("GET", "/api/skills/x");
    expect(skill.body.content).toContain("AI 改的");
  });

  it("人在右侧手改草稿，AI 下一轮能看到", async () => {
    const { sessionId } = await open("skill", "create");
    await call("PUT", `/api/forge/${sessionId}/file`, {
      path: "SKILL.md",
      content: SKILL("hand"),
    });
    expect(await tool(sessionId, "draft_view")).toContain("name: hand");
    const session = store.get(sessionId);
    const extra = session ? forge.profile(session)?.promptExtra?.() : "";
    expect(extra).toContain("name: hand");
  });

  it("放弃连会话一起删", async () => {
    const { sessionId } = await open("skill", "create");
    expect((await call("DELETE", `/api/forge/${sessionId}`)).status).toBe(204);
    expect(store.get(sessionId)).toBeUndefined();
    expect((await call("GET", `/api/forge/${sessionId}`)).status).toBe(404);
  });
});

describe("从历史沉淀", () => {
  const seedChat = (title: string, user: string, ai: string): string => {
    const header = newSessionHeader(piPaths(dir)) as { id: string };
    const row = store.create({ id: header.id, title, header });
    let parentId: string | null = null;
    const entry = (role: "user" | "assistant", t: string) => {
      const id = randomUUID().slice(0, 8);
      const e = {
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message:
          role === "user"
            ? { role, content: t, timestamp: Date.now() }
            : {
                role,
                content: [{ type: "text", text: t }],
                timestamp: Date.now(),
              },
      };
      parentId = id;
      return e;
    };
    store.append(row.id, [entry("user", user), entry("assistant", ai)]);
    return row.id;
  };

  it("自动开场；只列普通对话，工坊自己的会话不当素材", async () => {
    const chat = seedChat(
      "竞品定价讨论",
      "帮我对比三家定价",
      "按席位与用量两种…",
    );
    const { sessionId, kickoff } = await open("skill", "distill");
    expect(kickoff).toContain("扫描最近的对话历史");

    const list = await tool(sessionId, "history_list");
    expect(list).toContain(chat);
    expect(list).toContain("竞品定价讨论");
    expect(list).toContain("帮我对比三家定价");
    expect(list).not.toContain(sessionId);

    expect(
      await tool(sessionId, "history_list", { keyword: "席位" }),
    ).toContain(chat);
    expect(
      await tool(sessionId, "history_list", { keyword: "不存在的词" }),
    ).toContain("没有包含");

    const read = await tool(sessionId, "history_read", { sessionId: chat });
    expect(read).toContain("### 用户\n帮我对比三家定价");
    expect(read).toContain("### AI\n按席位与用量两种");
    await expect(
      tool(sessionId, "history_read", { sessionId }),
    ).rejects.toThrow("工坊对话不作为素材");
  });
});

describe("AI 新建智能体", () => {
  it("工具名不认识只警告；保存后进智能体库", async () => {
    const { sessionId } = await open("agent", "create");
    expect(await tool(sessionId, "tool_catalog")).toContain("history_search");
    const out = await tool(sessionId, "draft_write", {
      path: "AGENT.md",
      content:
        "---\nname: pricing-scout\ndescription: 查竞品定价。\ntools: web_search, bash\nskills: nope\n---\n\n你是定价侦察员。\n",
    });
    expect(out).toContain("bash");
    expect(out).toContain("nope");
    const d = await draft(sessionId);
    expect(d.problems.errors).toEqual([]);
    expect(d.problems.warnings).toHaveLength(2);

    const saved = await call<{ name: string }>(
      "POST",
      `/api/forge/${sessionId}/save`,
      {},
    );
    expect(saved.body.name).toBe("pricing-scout");
    expect((await call("GET", "/api/agents/pricing-scout")).status).toBe(200);
  });

  it("草稿清单按类型过滤，标出没保存的", async () => {
    const a = await open("agent", "create");
    await call("PUT", `/api/forge/${a.sessionId}/file`, {
      path: "AGENT.md",
      content: "---\nname: z\ndescription: d\n---\n",
    });
    await open("skill", "create");
    const list = await call<{
      drafts: { sessionId: string; dirty: boolean; name: string | null }[];
    }>("GET", "/api/forge?kind=agent");
    expect(list.body.drafts).toEqual([
      expect.objectContaining({
        sessionId: a.sessionId,
        dirty: true,
        name: "z",
      }),
    ]);
  });
});
