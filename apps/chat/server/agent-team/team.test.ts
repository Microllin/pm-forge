import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import type { UIMessageChunk } from "ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openDb, type Db } from "../db.js";
import { createFauxSetup, type FauxSetup } from "../pi/faux.js";
import { DEFAULT_TITLE, createRunner, type Runner } from "../pi/runner.js";
import { newSessionHeader, piPaths, type PiPaths } from "../pi/runtime.js";
import { createSessionStore, type SessionStore } from "../sessions.js";
import { BUILTIN_AGENTS, seedBuiltinAgents } from "./builtin.js";
import { createRunStore, type RunStore } from "./runs.js";
import { createTeam, toMember, type Team, type TeamLimits } from "./team.js";
import { createToolRegistry } from "./tools.js";
import { formatWebSearch, parseWebSearchResponse } from "./web-search.js";

/**
 * 智能体团队：真实的 pi + 脚本化的假模型（faux）。
 *
 * 假模型的回复队列是全进程共用的，并行时谁先取到不确定——所以每一步都是一个
 * 「路由函数」：看这条会话的第一句用户消息（子智能体收到的是「# 任务\nALPHA:…」）
 * 和已经拿到几个工具结果，决定这一步该回什么。
 */

let dir: string;
let paths: PiPaths;
let db: Db;
let store: SessionStore;
let runs: RunStore;
let setup: FauxSetup;
let team: Team;
let runner: Runner;

type Ctx = Parameters<FauxResponseFactory>[0];
const firstUser = (c: Ctx): string => {
  const m = c.messages.find((x) => x.role === "user");
  const content = m?.content;
  if (typeof content === "string") return content;
  return (content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
};
const toolResults = (c: Ctx): number =>
  c.messages.filter((m) => m.role === "toolResult").length;
const lastToolText = (c: Ctx): string => {
  const m = [...c.messages].reverse().find((x) => x.role === "toolResult");
  return (m?.content ?? [])
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("");
};

/** 把一组脚本装成足够多份路由函数（每次模型调用消耗一份）。 */
function script(
  route: (c: Ctx) => ReturnType<typeof fauxAssistantMessage>,
): void {
  setup.faux.setResponses(
    Array.from({ length: 200 }, () => (c: Ctx) => route(c)),
  );
}

const agentMd = (name: string, extra = ""): string =>
  `---\nname: ${name}\ndescription: 测试成员 ${name}\ntools: product_overview, Read, Bash\n${extra}---\n\n你是 ${name}。`;

async function make(
  limits: Partial<TeamLimits> = {},
  tokensPerSecond?: number,
): Promise<void> {
  setup = await createFauxSetup(
    paths,
    tokensPerSecond === undefined ? {} : { tokensPerSecond },
  );
  const provision = () =>
    Promise.resolve({
      key: "faux",
      setup,
      defaultModel: setup.model,
      defaultThinking: "off" as const,
    });
  team = createTeam({
    paths,
    registry: createToolRegistry({ db }),
    runs,
    provision,
    webTarget: () => Promise.resolve(null),
    limits,
  });
  runner = createRunner({
    store,
    paths,
    provision,
    profile: (s) => ({
      tools: [
        team.delegateTool({
          sessionId: s.id,
          productId: s.productId,
          depth: 0,
          parentRunId: null,
        }),
      ],
      promptExtra: () => team.rosterPrompt(),
    }),
  });
}

function newSession(id = "s1"): string {
  store.create({
    id,
    title: DEFAULT_TITLE,
    header: newSessionHeader(paths, id),
  });
  return id;
}

async function chat(id: string, message: string): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  await runner.chat({
    sessionId: id,
    message,
    onChunk: (c) => chunks.push(c),
    signal: new AbortController().signal,
  });
  return chunks;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-team-"));
  paths = piPaths(dir);
  db = openDb(IN_MEMORY);
  store = createSessionStore(db);
  runs = createRunStore(db);
  await writeFile(
    join(paths.agentsDir, "alpha.md"),
    agentMd("alpha", "can_delegate: beta\n"),
  );
  await writeFile(
    join(paths.agentsDir, "beta.md"),
    agentMd("beta", "can_delegate: alpha\n"),
  );
});

afterEach(async () => {
  runner.disposeAll();
  await rm(dir, { recursive: true, force: true });
});

describe("花名册", () => {
  it("只收平台内能用的成员；不认识的工具名（给 Claude Code 的）静默忽略", async () => {
    await writeFile(
      join(paths.agentsDir, "cc-only.md"),
      "---\nname: cc-only\ndescription: x\ntools: Read, Bash\n---\nhi",
    );
    await make();
    const names = team.members().map((m) => m.name);
    expect(names).toEqual(["alpha", "beta"]);
    expect(team.members()[0]?.tools).toEqual(["product_overview"]);
    expect(team.rosterPrompt()).toContain("**alpha**");
    expect(team.rosterPrompt()).not.toContain("cc-only");
  });

  it("toMember：max_turns 有上限，model: inherit 等于没写", () => {
    const reg = createToolRegistry({ db });
    const m = toMember(
      agentMd("x", "max_turns: 999\nmodel: inherit\n"),
      reg,
      30,
    );
    expect(m?.maxTurns).toBe(100);
    expect(m?.model).toBeUndefined();
  });

  it("内置智能体只播一次：用户删掉的不会复活", async () => {
    const d = await mkdtemp(join(tmpdir(), "seed-"));
    expect(seedBuiltinAgents(db, d).sort()).toEqual(
      Object.keys(BUILTIN_AGENTS).sort(),
    );
    await rm(join(d, "tech-expert.md"));
    expect(seedBuiltinAgents(db, d)).toEqual([]);
    await rm(d, { recursive: true, force: true });
    // 内置的四个都能在平台里跑（tools 里都有平台工具）。
    const reg = createToolRegistry({
      db,
      files: {} as never,
      evidence: {} as never,
    });
    for (const md of Object.values(BUILTIN_AGENTS))
      expect(toMember(md, reg, 30)).toBeDefined();
  });
});

describe("派活", () => {
  it("协调者派 alpha → alpha 自己调工具 → 结论交回协调者；运行记录落库；进度实时推送", async () => {
    await make();
    script((c) => {
      const u = firstUser(c);
      if (u.startsWith("# 任务\nALPHA")) {
        return toolResults(c) === 0
          ? fauxAssistantMessage(fauxToolCall("product_overview", {}), {
              stopReason: "toolUse",
            })
          : fauxAssistantMessage("ALPHA结论：查过了，没有产品");
      }
      return toolResults(c) === 0
        ? fauxAssistantMessage(
            fauxToolCall("delegate", {
              agent: "alpha",
              task: "ALPHA 查产品",
              reason: "需要查证",
            }),
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage(
            `汇总：${lastToolText(c).includes("ALPHA结论") ? "收到" : "没收到"}`,
          );
    });
    const id = newSession();
    const chunks = await chat(id, "帮我看看产品");

    const final = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta: string }).delta)
      .join("");
    expect(final).toContain("汇总：收到");
    const updates = chunks.filter(
      (c) =>
        c.type === "tool-output-available" &&
        (c as { preliminary?: boolean }).preliminary,
    );
    expect(updates.length).toBeGreaterThan(0);

    const [run] = runs.bySession(id);
    expect(run).toMatchObject({
      agent: "alpha",
      status: "done",
      depth: 1,
      toolCalls: 1,
      reason: "需要查证",
    });
    expect(run?.result).toContain("ALPHA结论");
    expect(runs.transcript(run?.id ?? "").length).toBeGreaterThan(1);
  });

  it("同一条回复里的两个 delegate 并行执行", async () => {
    await make({}, 40);
    let peak = 0;
    script((c) => {
      const u = firstUser(c);
      peak = Math.max(peak, team.active());
      if (u.startsWith("# 任务\n"))
        return fauxAssistantMessage(
          `${u.slice(5, 10)} 的结论，写长一点让它跑一会儿`,
        );
      return toolResults(c) === 0
        ? fauxAssistantMessage(
            [
              fauxToolCall("delegate", {
                agent: "alpha",
                task: "A 任务",
                reason: "r",
              }),
              fauxToolCall("delegate", {
                agent: "beta",
                task: "B 任务",
                reason: "r",
              }),
            ],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage("好了");
    });
    const id = newSession();
    await chat(id, "并行");
    expect(runs.bySession(id).map((r) => r.status)).toEqual(["done", "done"]);
    expect(peak).toBe(2);
  });

  it("可以再派一层，但第 2 层不能再往下派（最深 2 层）", async () => {
    await make();
    script((c) => {
      const u = firstUser(c);
      const n = toolResults(c);
      if (u.startsWith("# 任务\nALPHA")) {
        return n === 0
          ? fauxAssistantMessage(
              fauxToolCall("delegate", {
                agent: "beta",
                task: "BETA 子问题",
                reason: "r",
              }),
              { stopReason: "toolUse" },
            )
          : fauxAssistantMessage("alpha 完成");
      }
      if (u.startsWith("# 任务\nBETA")) {
        return n === 0
          ? fauxAssistantMessage(
              fauxToolCall("delegate", {
                agent: "alpha",
                task: "ALPHA 再往下",
                reason: "r",
              }),
              { stopReason: "toolUse" },
            )
          : fauxAssistantMessage(`beta 完成：${lastToolText(c).slice(0, 40)}`);
      }
      return n === 0
        ? fauxAssistantMessage(
            fauxToolCall("delegate", {
              agent: "alpha",
              task: "ALPHA 顶层",
              reason: "r",
            }),
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage("结束");
    });
    const id = newSession();
    await chat(id, "嵌套");
    const [top] = runs.bySession(id).filter((r) => r.depth === 1);
    const kids = runs.children(top?.id ?? "");
    expect(kids).toHaveLength(1);
    expect(kids[0]).toMatchObject({ agent: "beta", depth: 2, status: "done" });
    // 第 2 层没有 delegate 工具：它的尝试被 pi 拒掉，不产生第 3 层。
    expect(runs.children(kids[0]?.id ?? "")).toHaveLength(0);
    expect(runs.recent(10).every((r) => r.depth <= 2)).toBe(true);
  });

  it("派给不存在的成员：告诉协调者有谁可派，不建运行记录", async () => {
    await make();
    script((c) =>
      toolResults(c) === 0
        ? fauxAssistantMessage(
            fauxToolCall("delegate", {
              agent: "nobody",
              task: "x",
              reason: "r",
            }),
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage(lastToolText(c)),
    );
    const id = newSession();
    const chunks = await chat(id, "派个不存在的");
    const text = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta: string }).delta)
      .join("");
    expect(text).toContain("可派：alpha、beta");
    expect(runs.bySession(id)).toHaveLength(0);
  });
});

describe("预算与停止", () => {
  it("超过轮数上限：判失败，把原因交回协调者", async () => {
    await writeFile(
      join(paths.agentsDir, "alpha.md"),
      agentMd("alpha", "max_turns: 3\n"),
    );
    await make();
    script((c) => {
      if (firstUser(c).startsWith("# 任务\nALPHA"))
        return fauxAssistantMessage(fauxToolCall("product_overview", {}), {
          stopReason: "toolUse",
        });
      return toolResults(c) === 0
        ? fauxAssistantMessage(
            fauxToolCall("delegate", {
              agent: "alpha",
              task: "ALPHA 死循环",
              reason: "r",
            }),
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage(lastToolText(c));
    });
    const id = newSession();
    const chunks = await chat(id, "跑");
    const [run] = runs.bySession(id);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("轮数上限");
    const text = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta: string }).delta)
      .join("");
    expect(text).toContain("由你决定");
  });

  it("用户停止主对话：子智能体级联停止，记为 stopped", async () => {
    await make({}, 5);
    script((c) => {
      if (firstUser(c).startsWith("# 任务\nALPHA"))
        return fauxAssistantMessage(
          "这是一段很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长的结论",
        );
      return toolResults(c) === 0
        ? fauxAssistantMessage(
            fauxToolCall("delegate", {
              agent: "alpha",
              task: "ALPHA 慢活",
              reason: "r",
            }),
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage("停了");
    });
    const id = newSession();
    const done = chat(id, "跑慢活");
    await until(() => team.active() === 1);
    runner.abort(id);
    await done;
    await until(() => runs.bySession(id)[0]?.status !== "running");
    expect(runs.bySession(id)[0]?.status).toBe("stopped");
    expect(team.active()).toBe(0);
  });

  it("并发上限满了排队，不拒绝", async () => {
    await make({ maxConcurrent: 1 }, 40);
    let peak = 0;
    script((c) => {
      peak = Math.max(peak, team.active());
      if (firstUser(c).startsWith("# 任务\n"))
        return fauxAssistantMessage("子结论写长一点");
      return toolResults(c) === 0
        ? fauxAssistantMessage(
            [
              fauxToolCall("delegate", {
                agent: "alpha",
                task: "A",
                reason: "r",
              }),
              fauxToolCall("delegate", {
                agent: "beta",
                task: "B",
                reason: "r",
              }),
            ],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage("好");
    });
    const id = newSession();
    await chat(id, "排队");
    expect(peak).toBe(1);
    expect(runs.bySession(id).map((r) => r.status)).toEqual(["done", "done"]);
  });

  it("服务重启时还标着 running 的记为 stopped", () => {
    runs.start({
      id: "r1",
      sessionId: null,
      parentRunId: null,
      depth: 1,
      agent: "a",
      task: "t",
      reason: "",
      model: null,
    });
    expect(runs.sweepOrphans()).toBe(1);
    expect(runs.get("r1")?.status).toBe("stopped");
  });
});

describe("联网搜索解析", () => {
  it("正文 + 引用链接 + 搜索结果里的链接都收进来源", () => {
    const r = parseWebSearchResponse({
      content: [
        { type: "server_tool_use" },
        {
          type: "web_search_tool_result",
          content: [
            { url: "https://a.com", title: "A" },
            { url: "https://b.com", title: "B" },
          ],
        },
        {
          type: "text",
          text: "GLM-5.3 已发布",
          citations: [{ url: "https://a.com", title: "A 站" }],
        },
      ],
      usage: { server_tool_use: { web_search_requests: 1 } },
    });
    expect(r.answer).toBe("GLM-5.3 已发布");
    expect(r.sources.map((s) => s.url)).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
    expect(r.searches).toBe(1);
    expect(formatWebSearch("q", r)).toContain("[A 站](https://a.com)");
  });

  it("接口报错：抛出带原因的错误", () => {
    expect(() =>
      parseWebSearchResponse({ error: { message: "quota" } }),
    ).toThrow("quota");
  });
});
