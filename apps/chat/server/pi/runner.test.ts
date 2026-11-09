import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
} from "@earendil-works/pi-ai";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";

import { IN_MEMORY, openDb } from "../db.js";
import { createSessionStore, type SessionStore } from "../sessions.js";
import { createFauxSetup, type FauxSetup } from "./faux.js";
import { historyToUiMessages, runningHistory } from "./history.js";
import {
  DEFAULT_TITLE,
  createRunner,
  type Runner,
  type RunnerDeps,
} from "./runner.js";
import { newSessionHeader, piPaths, type PiPaths } from "./runtime.js";

/**
 * 运行器：真实的 pi + 脚本化的假模型（faux）。断言都落在「前端会看到什么」：
 * chunk 交给 AI SDK 官方解析器还原成 UIMessage 再比，而不是比 chunk 序列。
 */

let dir: string;
let paths: PiPaths;
let store: SessionStore;
let setup: FauxSetup;
let runner: Runner;

async function makeRunner(
  tokensPerSecond?: number,
  evidence?: RunnerDeps["evidence"],
): Promise<void> {
  setup = await createFauxSetup(
    paths,
    tokensPerSecond === undefined ? {} : { tokensPerSecond },
  );
  runner = createRunner({
    store,
    paths,
    provision: () =>
      Promise.resolve({
        key: "faux",
        setup,
        defaultModel: setup.model,
        defaultThinking: "medium",
      }),
    ...(evidence === undefined ? {} : { evidence }),
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

async function parse(chunks: UIMessageChunk[]): Promise<UIMessage> {
  let last: UIMessage | undefined;
  for await (const m of readUIMessageStream({
    stream: new ReadableStream<UIMessageChunk>({
      start(c) {
        for (const x of chunks) c.enqueue(x);
        c.close();
      },
    }),
    terminateOnError: false,
  })) {
    last = m;
  }
  if (!last) throw new Error("没有解析出消息");
  return last;
}

const visible = (m: UIMessage | undefined) =>
  (m?.parts ?? [])
    .filter((p) => p.type !== "step-start")
    .map((p) => {
      const o = p as Record<string, unknown>;
      return { type: o.type, text: o.text, data: o.data };
    });

const texts = (m: UIMessage) =>
  m.parts.flatMap((p) => (p.type === "text" ? [p.text] : []));

/** 等到条件成立（轮询）。流式场景下比固定 sleep 稳。 */
async function until(check: () => boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chat-runner-"));
  paths = piPaths(dir);
  // 自动重试的退避改短，免得重试用例要等好几秒。
  await writeFile(
    join(paths.agentDir, "settings.json"),
    JSON.stringify({
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
    }),
  );
  store = createSessionStore(openDb(IN_MEMORY));
});

afterEach(async () => {
  runner.disposeAll();
  await rm(dir, { recursive: true, force: true });
});

describe("一轮对话", () => {
  it("思考 + 正文流成一条 assistant 消息；条目落库；第一句话成为标题", async () => {
    await makeRunner();
    const id = newSession();
    setup.faux.setResponses([
      fauxAssistantMessage([fauxThinking("先想一下"), fauxText("你好呀")]),
    ]);
    const chunks: UIMessageChunk[] = [];
    await runner.chat({
      sessionId: id,
      message: "打个招呼",
      onChunk: (c) => chunks.push(c),
      signal: new AbortController().signal,
    });

    expect(chunks[0]?.type).toBe("start");
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
    const message = await parse(chunks);
    expect(visible(message).map((p) => p.type)).toEqual([
      "data-model",
      "reasoning",
      "text",
    ]);
    // 每条回答标注是哪个模型答的（pi 的 AssistantMessage 记着实际作答的模型）。
    expect(visible(message)[0]?.data).toEqual({ model: "faux/faux-chat" });
    expect(texts(message)).toEqual(["你好呀"]);

    expect(store.entries(id).length).toBeGreaterThan(0);
    expect(store.get(id)?.title).toBe("打个招呼");
    expect(runner.activeRun(id)).toBeUndefined();
  });

  it("刷新后从库里还原的历史与流式时看到的一致", async () => {
    await makeRunner();
    const id = newSession();
    setup.faux.setResponses([
      fauxAssistantMessage([fauxThinking("想"), fauxText("答案")]),
    ]);
    const chunks: UIMessageChunk[] = [];
    await runner.chat({
      sessionId: id,
      message: "问题",
      onChunk: (c) => chunks.push(c),
      signal: new AbortController().signal,
    });
    const live = await parse(chunks);
    const history = historyToUiMessages(
      paths.cwd,
      store.header(id),
      store.entries(id),
    );
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(visible(history[1])).toEqual(visible(live));
  });
});

describe("连接与运行解耦", () => {
  it("连接断开不中断 agent；续流先重放再接实时，内容完整不重复", async () => {
    await makeRunner(400);
    const id = newSession();
    const long = "一二三四五六七八九十".repeat(20);
    setup.faux.setResponses([fauxAssistantMessage(fauxText(long))]);

    const first = new AbortController();
    const firstChunks: UIMessageChunk[] = [];
    const chatting = runner.chat({
      sessionId: id,
      message: "写长文",
      onChunk: (c) => firstChunks.push(c),
      signal: first.signal,
    });
    await until(
      () => firstChunks.filter((c) => c.type === "text-delta").length >= 3,
    );
    first.abort(); // 浏览器刷新

    const resumed: UIMessageChunk[] = [];
    const ok = await runner.resume(
      id,
      (c) => resumed.push(c),
      new AbortController().signal,
    );
    await chatting;

    expect(ok).toBe(true);
    expect(resumed[0]?.type).toBe("start");
    expect(resumed.at(-1)?.type).toBe("finish");
    expect(texts(await parse(resumed)).join("")).toBe(long);
  });

  it("没有在跑的轮次时 resume 返回 false", async () => {
    await makeRunner();
    const id = newSession();
    expect(
      await runner.resume(id, () => undefined, new AbortController().signal),
    ).toBe(false);
  });

  it("轮中途的历史：上一轮保留、本轮问题补上、本轮半截不重复", async () => {
    await makeRunner(300);
    const id = newSession();
    setup.faux.setResponses([fauxAssistantMessage(fauxText("上一轮的回答"))]);
    await runner.chat({
      sessionId: id,
      message: "上一轮",
      onChunk: () => undefined,
      signal: new AbortController().signal,
    });

    setup.faux.setResponses([
      fauxAssistantMessage(fauxText("这一轮".repeat(40))),
    ]);
    const chunks: UIMessageChunk[] = [];
    const chatting = runner.chat({
      sessionId: id,
      message: "这一轮的问题",
      onChunk: (c) => chunks.push(c),
      signal: new AbortController().signal,
    });
    await until(() => chunks.some((c) => c.type === "text-delta"));
    const run = runner.activeRun(id);
    if (!run) throw new Error("应当在跑");
    const history = runningHistory(
      paths.cwd,
      store.header(id),
      store.entries(id),
      {
        ...run,
        sessionId: id,
      },
    );
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    const [, previous, current] = history;
    if (!previous || !current) throw new Error("历史条数不对");
    expect(texts(previous)).toEqual(["上一轮的回答"]);
    expect(texts(current)).toEqual(["这一轮的问题"]);
    await chatting;
  });
});

describe("排队与停止", () => {
  it("流式中排队：同一轮里投递，出现 data-user 分界，只有一条流", async () => {
    await makeRunner(400);
    const id = newSession();
    setup.faux.setResponses([
      fauxAssistantMessage(fauxText("第一段回答".repeat(10))),
      fauxAssistantMessage(fauxText("收到补充")),
    ]);
    const chunks: UIMessageChunk[] = [];
    const chatting = runner.chat({
      sessionId: id,
      message: "第一句",
      onChunk: (c) => chunks.push(c),
      signal: new AbortController().signal,
    });
    await until(() => chunks.some((c) => c.type === "text-delta"));
    const queued = await runner.queue(id, "补一句");
    expect(queued.queued).toBe(true);
    await chatting;

    expect(chunks.filter((c) => c.type === "start")).toHaveLength(1);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: "data-queue", transient: true }),
    );
    const message = await parse(chunks);
    expect(message.parts.find((p) => p.type === "data-user")).toMatchObject({
      data: { text: "补一句" },
    });
    expect(texts(message).at(-1)).toBe("收到补充");
  });

  it("空闲时排队被拒（否则消息进队列却永远等不到投递）", async () => {
    await makeRunner();
    const id = newSession();
    expect(await runner.queue(id, "x")).toEqual({ queued: false, pending: 0 });
  });

  it("停止：本轮以 abort + finish 收尾，不报错", async () => {
    await makeRunner(200);
    const id = newSession();
    setup.faux.setResponses([
      fauxAssistantMessage(fauxText("很长".repeat(100))),
    ]);
    const chunks: UIMessageChunk[] = [];
    const chatting = runner.chat({
      sessionId: id,
      message: "写",
      onChunk: (c) => chunks.push(c),
      signal: new AbortController().signal,
    });
    await until(() => chunks.some((c) => c.type === "text-delta"));
    runner.abort(id);
    await chatting;
    expect(chunks.map((c) => c.type).slice(-2)).toEqual(["abort", "finish"]);
    // 停止标记是消息的一部分，刷新后由历史还原（stopReason=aborted）成同样的部件。
    expect(chunks.some((c) => c.type === "data-stopped")).toBe(true);
    const history = historyToUiMessages(
      paths.cwd,
      store.header(id),
      store.entries(id),
    );
    expect(history.at(-1)?.parts.some((p) => p.type === "data-stopped")).toBe(
      true,
    );
    expect(chunks.some((c) => c.type === "data-error")).toBe(false);
    expect(runner.busy()).toBe(false);
  });
});

describe("切换模型与思考强度（pi 的 /model 与 Shift+Tab）", () => {
  it("新会话用默认模型；切换后下一轮用新模型作答并标注", async () => {
    await makeRunner();
    const id = newSession();
    expect((await runner.sessionModel(id)).modelId).toBe(setup.model.id);

    const state = await runner.setModel(id, {
      provider: setup.alt.provider,
      modelId: setup.alt.id,
    });
    expect(state.modelId).toBe(setup.alt.id);

    let answeredBy = "";
    setup.faux.setResponses([
      (_ctx, _opts, _state, model) => {
        answeredBy = model.id;
        return fauxAssistantMessage(fauxText("好"));
      },
    ]);
    const chunks: UIMessageChunk[] = [];
    await runner.chat({
      sessionId: id,
      message: "hi",
      onChunk: (c) => chunks.push(c),
      signal: new AbortController().signal,
    });
    expect(answeredBy).toBe(setup.alt.id);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: "data-model",
        data: { model: `faux/${setup.alt.id}` },
      }),
    );
  });

  it("发第一句话之前切的模型也生效（pi 自己只在有消息时才恢复）", async () => {
    await makeRunner();
    const id = newSession();
    await runner.setModel(id, {
      provider: setup.alt.provider,
      modelId: setup.alt.id,
    });
    runner.disposeAll(); // 模拟重启：从库里恢复
    expect((await runner.sessionModel(id)).modelId).toBe(setup.alt.id);
  });

  it("中途切换的模型在重启后保留；历史里每段回答标着各自的模型", async () => {
    await makeRunner();
    const id = newSession();
    setup.faux.setResponses([fauxAssistantMessage(fauxText("一"))]);
    await runner.chat({
      sessionId: id,
      message: "第一句",
      onChunk: () => undefined,
      signal: new AbortController().signal,
    });
    await runner.setModel(id, {
      provider: setup.alt.provider,
      modelId: setup.alt.id,
    });
    setup.faux.setResponses([fauxAssistantMessage(fauxText("二"))]);
    await runner.chat({
      sessionId: id,
      message: "第二句",
      onChunk: () => undefined,
      signal: new AbortController().signal,
    });

    runner.disposeAll();
    expect((await runner.sessionModel(id)).modelId).toBe(setup.alt.id);
    const history = historyToUiMessages(
      paths.cwd,
      store.header(id),
      store.entries(id),
    );
    const labels = history
      .filter((m) => m.role === "assistant")
      .map(
        (m) =>
          (
            m.parts.find((p) => p.type === "data-model") as
              { data?: { model?: string } } | undefined
          )?.data?.model,
      );
    expect(labels).toEqual([`faux/${setup.model.id}`, `faux/${setup.alt.id}`]);
  });

  it("思考强度：切换后写进 transcript；只给模型支持的档位", async () => {
    await makeRunner();
    const id = newSession();
    const state = await runner.setThinking(id, "high");
    expect(state.thinkingLevel).toBe("high");
    expect(state.thinkingLevels).toContain("high");
    runner.disposeAll();
    expect((await runner.sessionModel(id)).thinkingLevel).toBe("high");
  });

  it("回答进行中不能切换；不可用的模型被拒", async () => {
    await makeRunner(200);
    const id = newSession();
    await expect(
      runner.setModel(id, { provider: "nope", modelId: "x" }),
    ).rejects.toThrow("没有可用的模型");
    setup.faux.setResponses([fauxAssistantMessage(fauxText("长".repeat(80)))]);
    const chunks: UIMessageChunk[] = [];
    const chatting = runner.chat({
      sessionId: id,
      message: "写",
      onChunk: (c) => chunks.push(c),
      signal: new AbortController().signal,
    });
    await until(() => chunks.some((c) => c.type === "text-delta"));
    await expect(
      runner.setModel(id, {
        provider: setup.alt.provider,
        modelId: setup.alt.id,
      }),
    ).rejects.toThrow("回答进行中");
    await chatting;
  });
});

describe("错误", () => {
  it("模型错误：落成 data-error，finishReason=error；刷新后历史里仍在", async () => {
    await makeRunner();
    const id = newSession();
    setup.faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "401 invalid api key",
      }),
    ]);
    const chunks: UIMessageChunk[] = [];
    await runner.chat({
      sessionId: id,
      message: "hi",
      onChunk: (c) => chunks.push(c),
      signal: new AbortController().signal,
    });
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "error" });
    const live = await parse(chunks);
    expect(live.parts.find((p) => p.type === "data-error")).toMatchObject({
      data: { message: "401 invalid api key" },
    });
    const history = historyToUiMessages(
      paths.cwd,
      store.header(id),
      store.entries(id),
    );
    expect(
      history[1]?.parts.find((p) => p.type === "data-error"),
    ).toMatchObject({
      data: { message: "401 invalid api key" },
    });
  });

  it("失败后自动重试成功：不报错；刷新后失败那次也不冒出来", async () => {
    await makeRunner();
    const id = newSession();
    setup.faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Request timed out.",
      }),
      fauxAssistantMessage(fauxText("重试成功")),
    ]);
    const chunks: UIMessageChunk[] = [];
    await runner.chat({
      sessionId: id,
      message: "hi",
      onChunk: (c) => chunks.push(c),
      signal: new AbortController().signal,
    });
    expect(chunks.some((c) => c.type === "data-error")).toBe(false);
    expect(chunks.at(-1)).toEqual({ type: "finish", finishReason: "stop" });
    expect(texts(await parse(chunks))).toEqual(["重试成功"]);
    const history = historyToUiMessages(
      paths.cwd,
      store.header(id),
      store.entries(id),
    );
    expect(visible(history[1]).filter((p) => p.type !== "data-model")).toEqual([
      { type: "text", text: "重试成功", data: undefined },
    ]);
  });

  it("重试对用户可见：先报「正在重试」，成功后报「已恢复」，且不进消息部件", async () => {
    await makeRunner();
    const id = newSession();
    setup.faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Request timed out.",
      }),
      fauxAssistantMessage(fauxText("重试成功")),
    ]);
    const chunks: UIMessageChunk[] = [];
    await runner.chat({
      sessionId: id,
      message: "hi",
      onChunk: (c) => chunks.push(c),
      signal: new AbortController().signal,
    });

    const retries = chunks.filter((c) => c.type === "data-retry");
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({
      type: "data-retry",
      transient: true,
      data: { attempt: 1, message: "Request timed out." },
    });
    expect(
      (retries[0] as { data: { maxAttempts?: number } }).data.maxAttempts,
    ).toBeGreaterThan(0);
    expect(retries[1]).toMatchObject({
      type: "data-retry",
      transient: true,
      data: { done: true, success: true },
    });
    // transient 的部件不进消息：刷新后 pi 的 transcript 里本就没有失败那次，
    // 提示要是进了部件，流式与历史就对不上了。
    expect(visible(await parse(chunks)).map((p) => p.type)).not.toContain(
      "data-retry",
    );
  });

  it("一个字都没输出就失败重试：提示照样发（此时还没有 start，不能吞掉）", async () => {
    await makeRunner();
    const id = newSession();
    setup.faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "Overloaded",
      }),
      fauxAssistantMessage(fauxText("第二次成了")),
    ]);
    const chunks: UIMessageChunk[] = [];
    await runner.chat({
      sessionId: id,
      message: "hi",
      onChunk: (c) => chunks.push(c),
      signal: new AbortController().signal,
    });
    const first = chunks.find((c) => c.type === "data-retry");
    expect(first).toMatchObject({ data: { message: "Overloaded" } });
    expect(texts(await parse(chunks))).toEqual(["第二次成了"]);
  });

  it("没配模型：chat 直接抛出给人看的原因", async () => {
    await makeRunner();
    const id = newSession();
    const broken = createRunner({
      store,
      paths,
      provision: () => Promise.reject(new Error("还没有配置模型")),
    });
    await expect(
      broken.chat({
        sessionId: id,
        message: "hi",
        onChunk: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("还没有配置模型");
  });
});

describe("事实依据（平台规范）", () => {
  /** 让假模型把这次请求里的最后一条用户消息记下来再正常作答。 */
  function captureLastPrompt(sink: string[]): void {
    setup.faux.setResponses([
      (context) => {
        const last = [...context.messages]
          .reverse()
          .find((m) => m.role === "user");
        if (last !== undefined) {
          const content = last.content;
          sink.push(
            typeof content === "string"
              ? content
              : content
                  .flatMap((c) => (c.type === "text" ? [c.text] : []))
                  .join(""),
          );
        }
        return fauxAssistantMessage(fauxText("收到"));
      },
    ]);
  }

  it("依据段放在消息最前面；续聊时状态跨轮保留", async () => {
    const seen: { first: boolean }[] = [];
    await makeRunner(undefined, {
      brief: (session, message, state) => {
        seen.push({ first: state.first });
        const text = state.first
          ? `<pmforge-evidence>依据:${session.productId ?? "无"}</pmforge-evidence>`
          : null;
        state.first = false;
        return Promise.resolve(text);
      },
    });
    const id = store.create({
      id: "s1",
      title: DEFAULT_TITLE,
      header: newSessionHeader(paths, "s1"),
      productId: "p1",
    }).id;

    const prompts: string[] = [];
    captureLastPrompt(prompts);
    await runner.chat({
      sessionId: id,
      message: "写退款 PRD",
      onChunk: () => undefined,
      signal: new AbortController().signal,
    });
    expect(prompts[0]).toContain(
      "<pmforge-evidence>依据:p1</pmforge-evidence>",
    );
    expect(prompts[0]?.trim().endsWith("写退款 PRD")).toBe(true);
    expect(seen[0]?.first).toBe(true);

    // 第二轮：不再算首轮（状态在同一个活会话里保留）。
    captureLastPrompt(prompts);
    await runner.chat({
      sessionId: id,
      message: "再补充一下审批流程",
      onChunk: () => undefined,
      signal: new AbortController().signal,
    });
    expect(seen[1]?.first).toBe(false);
  });

  it("依据定位失败不阻断对话：原样发出消息", async () => {
    await makeRunner(undefined, {
      brief: () => Promise.reject(new Error("boom")),
    });
    const id = newSession();
    const prompts: string[] = [];
    captureLastPrompt(prompts);
    await runner.chat({
      sessionId: id,
      message: "你好",
      onChunk: () => undefined,
      signal: new AbortController().signal,
    });
    expect(prompts[0]?.trim()).toBe("你好");
  });

  it("服务重启后续聊不算首轮（不重复整套规则）", async () => {
    const seen: boolean[] = [];
    await makeRunner(undefined, {
      brief: (_session, _message, state) => {
        seen.push(state.first);
        return Promise.resolve(null);
      },
    });
    const id = newSession();
    // 先聊一句落库，再重启运行器。
    setup.faux.setResponses([fauxAssistantMessage(fauxText("一"))]);
    await runner.chat({
      sessionId: id,
      message: "第一句",
      onChunk: () => undefined,
      signal: new AbortController().signal,
    });
    runner.disposeAll();
    await makeRunner(undefined, {
      brief: (_session, _message, state) => {
        seen.push(state.first);
        return Promise.resolve(null);
      },
    });
    setup.faux.setResponses([fauxAssistantMessage(fauxText("二"))]);
    await runner.chat({
      sessionId: id,
      message: "接着聊退款怎么做",
      onChunk: () => undefined,
      signal: new AbortController().signal,
    });
    expect(seen.at(-1)).toBe(false);
  });
});
