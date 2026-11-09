import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ChatView } from "./ChatView";
import { setReasoningDisplay } from "../settings/ui-prefs";

/**
 * 前端侧端到端：假后端吐真实格式的 UI Message Stream，断言
 * useChat → assistant-ui → 部件渲染这一整条链画得出来，且请求形状、
 * 排队与停止的接线是对的。协议本身由服务端测试用官方解析器验过。
 */

const enc = new TextEncoder();
type Chunk = Record<string, unknown>;

/** 可控的 SSE 响应：先吐 head；有 tail 时等 release() 再吐并收尾。 */
function sse(head: Chunk[], tail: Chunk[] = []) {
  let release = (): void => undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const body = new ReadableStream<Uint8Array>({
    async start(c) {
      const write = (x: Chunk) =>
        c.enqueue(enc.encode(`data: ${JSON.stringify(x)}\n\n`));
      head.forEach(write);
      if (tail.length > 0) await gate;
      tail.forEach(write);
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
  return {
    response: new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "x-vercel-ai-ui-message-stream": "v1",
      },
    }),
    release,
  };
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

const TURN: Chunk[] = [
  { type: "start", messageId: "m1" },
  { type: "start-step" },
  { type: "reasoning-start", id: "r" },
  { type: "reasoning-delta", id: "r", delta: "想一想" },
  { type: "reasoning-end", id: "r" },
  { type: "text-start", id: "t" },
  { type: "text-delta", id: "t", delta: "这是回答" },
  { type: "text-end", id: "t" },
  { type: "finish-step" },
  { type: "finish", finishReason: "stop" },
];

let calls: { url: string; method?: string; body?: string }[];
let sessionModel: Record<string, unknown>;

const MODELS = {
  models: [
    {
      provider: "relay",
      id: "模型 A",
      name: "模型 A",
      reasoning: true,
      contextWindow: 200000,
      inheritedFrom: null,
    },
    {
      provider: "relay",
      id: "opus-like",
      name: "opus-like",
      reasoning: true,
      contextWindow: 1000000,
      inheritedFrom: "x/y",
    },
  ],
  defaultModel: { provider: "relay", modelId: "模型 A" },
  defaultThinking: "medium",
  problem: null,
};

/** 会话模型相关的假接口（GET 当前、PUT 切模型 / 切思考强度）。 */
function modelRoutes(url: string, init?: RequestInit): Response | undefined {
  if (url.endsWith("/api/models")) return json(MODELS);
  if (url.endsWith("/model") && init?.method === "PUT") {
    const ref = JSON.parse(init.body as string) as {
      modelId: string;
      provider: string;
    };
    sessionModel = {
      ...sessionModel,
      modelId: ref.modelId,
      provider: ref.provider,
    };
    return json(sessionModel);
  }
  if (url.endsWith("/thinking") && init?.method === "PUT") {
    sessionModel = {
      ...sessionModel,
      thinkingLevel: (JSON.parse(init.body as string) as { level: string })
        .level,
    };
    return json(sessionModel);
  }
  if (url.endsWith("/model")) return json(sessionModel);
  return undefined;
}
let history: unknown;
let chatResponse: () => Response;

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;

beforeEach(() => {
  calls = [];
  sessionModel = {
    provider: "relay",
    modelId: "模型 A",
    thinkingLevel: "medium",
    thinkingLevels: ["off", "low", "medium", "high"],
  };
  history = {
    messages: [
      { id: "u0", role: "user", parts: [{ type: "text", text: "早" }] },
      {
        id: "a0",
        role: "assistant",
        parts: [{ type: "text", text: "早上好", state: "done" }],
      },
    ],
    streaming: false,
  };
  chatResponse = () => sse(TURN).response;
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      calls.push({
        url,
        ...(init?.method ? { method: init.method } : {}),
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      const model = modelRoutes(url, init);
      if (model) return Promise.resolve(model);
      if (url.endsWith("/messages")) return Promise.resolve(json(history));
      if (url.endsWith("/chat")) return Promise.resolve(chatResponse());
      if (url.endsWith("/queue"))
        return Promise.resolve(json({ queued: true, pending: 1 }));
      if (url.endsWith("/abort"))
        return Promise.resolve(new Response(null, { status: 204 }));
      if (url.endsWith("/api/staging/drafts"))
        return Promise.resolve(
          json({ draftPath: "/临时区/对话/2026-10-31/早上好.md" }, 201),
        );
      return Promise.resolve(json({ sessions: [] }));
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderChat() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // 与 main.tsx 一致地包 StrictMode：开发模式下 effect 会挂载→卸载→再挂载，
  // 「只跑一次」的逻辑在这里最容易出错（续流就曾因此静默失效）。
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <ChatView sessionId="s1" />
      </QueryClientProvider>
    </StrictMode>,
  );
}

const input = () => screen.getByLabelText("输入消息");

describe("ChatView", () => {
  it("先显示库里的历史", async () => {
    renderChat();
    expect(await screen.findByText("早上好")).toBeInTheDocument();
    expect(screen.getByText("早")).toBeInTheDocument();
  });

  it("存到临时区：把这条回答的正文连同会话一起交给服务端", async () => {
    renderChat();
    await screen.findByText("早上好");
    await userEvent.click(screen.getByRole("button", { name: /^存到临时区/ }));
    expect(await screen.findByText("已存到临时区")).toBeInTheDocument();
    const post = calls.find((c) => c.url.endsWith("/api/staging/drafts"));
    expect(post?.method).toBe("POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      sessionId: "s1",
      markdown: "早上好",
    });
  });

  it("发送：请求体只带这一句；思考与正文都渲染出来", async () => {
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "你好{Enter}");
    expect(await screen.findByText("这是回答")).toBeInTheDocument();
    expect(screen.getByText("思考过程")).toBeInTheDocument();
    const post = calls.find((c) => c.url.endsWith("/chat"));
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ message: "你好" });
  });

  it("流式中再发：走排队接口，不开第二条流，排队的那句立刻可见", async () => {
    const turn = sse(TURN.slice(0, 2), TURN.slice(2));
    chatResponse = () => turn.response;
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "第一句{Enter}");
    await screen.findByRole("button", { name: "停止" });
    await userEvent.type(input(), "补一句{Enter}");
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/queue"))).toBe(true);
    });
    expect(await screen.findByText("补一句")).toBeInTheDocument();
    expect(calls.filter((c) => c.url.endsWith("/chat"))).toHaveLength(1);
    turn.release();
    expect(await screen.findByText("这是回答")).toBeInTheDocument();
  });

  it("停止：请求服务端停（/abort），服务端收尾带来「已停止」标记", async () => {
    const turn = sse(TURN.slice(0, 2), [
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: "半截" },
      { type: "text-end", id: "t" },
      { type: "data-stopped", id: "s", data: {} },
      { type: "finish-step" },
      { type: "abort", reason: "用户停止" },
      { type: "finish", finishReason: "stop" },
    ]);
    chatResponse = () => turn.response;
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "长任务{Enter}");
    await userEvent.click(await screen.findByRole("button", { name: "停止" }));
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith("/abort"))).toBe(true);
    });
    turn.release(); // 服务端停下 pi 后把这一轮收尾
    expect(await screen.findByText(/已停止/)).toBeInTheDocument();
    expect(screen.getByText("半截")).toBeInTheDocument();
  });

  it("调用技能时显示工具卡片：名字、入参、技能正文都能展开看", async () => {
    // 服务端把 skill 工具的调用翻成 tool-* chunk（见 server/pi/stream.ts）。
    // 模型侧的工具不在前端的类型注册表里，assistant-ui 走 tools.Fallback 渲染，
    // 这条链断了的表现是「技能明明调了，界面上什么都没有」。
    chatResponse = () =>
      sse([
        { type: "start", messageId: "m-tool" },
        { type: "start-step" },
        {
          type: "tool-input-available",
          toolCallId: "c1",
          toolName: "skill",
          input: { name: "write-prd" },
        },
        {
          type: "tool-output-available",
          toolCallId: "c1",
          output: { text: "# 写 PRD\n先确认立项四问。" },
        },
        { type: "finish-step" },
        { type: "start-step" },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "按立项四问来" },
        { type: "text-end", id: "t" },
        { type: "finish-step" },
        { type: "finish", finishReason: "stop" },
      ]).response;
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "帮我写 PRD{enter}");

    const card = await screen.findByRole("button", { name: /skill/ });
    expect(await screen.findByText("按立项四问来")).toBeInTheDocument();
    await userEvent.click(card);
    expect(screen.getByText(/write-prd/)).toBeInTheDocument();
    expect(screen.getByText(/先确认立项四问/)).toBeInTheDocument();
  });

  it("历史里被停止的回答，刷新后照样有标记", async () => {
    history = {
      messages: [
        { id: "u", role: "user", parts: [{ type: "text", text: "写" }] },
        {
          id: "a",
          role: "assistant",
          parts: [
            { type: "text", text: "半截", state: "done" },
            { type: "data-stopped", id: "a:s", data: {} },
          ],
        },
      ],
      streaming: false,
    };
    renderChat();
    expect(await screen.findByText(/已停止/)).toBeInTheDocument();
  });

  it("模型错误（data-error）翻成人话，原文保留", async () => {
    chatResponse = () =>
      sse([
        { type: "start", messageId: "m2" },
        { type: "start-step" },
        {
          type: "data-error",
          id: "e",
          data: { message: "401 invalid api key" },
        },
        { type: "finish-step" },
        { type: "finish", finishReason: "error" },
      ]).response;
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "hi{Enter}");
    expect(await screen.findByText(/API key 无效/)).toBeInTheDocument();
    expect(screen.getByText("401 invalid api key")).toBeInTheDocument();
  });

  it("历史里的错误刷新后照样显示", async () => {
    history = {
      messages: [
        { id: "u", role: "user", parts: [{ type: "text", text: "hi" }] },
        {
          id: "a",
          role: "assistant",
          parts: [
            {
              type: "data-error",
              id: "a:e",
              data: { message: "429 rate limit" },
            },
          ],
        },
      ],
      streaming: false,
    };
    renderChat();
    expect(await screen.findByText(/限流/)).toBeInTheDocument();
  });

  it("历史显示有一轮在跑：自动续流", async () => {
    history = {
      messages: [
        { id: "u", role: "user", parts: [{ type: "text", text: "写长文" }] },
      ],
      streaming: true,
    };
    vi.mocked(fetch).mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = urlOf(input);
        calls.push({ url });
        const model = modelRoutes(url, init);
        if (model) return Promise.resolve(model);
        if (url.endsWith("/messages")) return Promise.resolve(json(history));
        if (url.endsWith("/chat/stream"))
          return Promise.resolve(sse(TURN).response);
        return Promise.resolve(json({}));
      },
    );
    renderChat();
    expect(await screen.findByText("这是回答")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/chat/stream"))).toBe(true);
  });
});

describe("对话中切换模型（pi 的 /model 与 Shift+Tab）", () => {
  it("输入框下显示当前模型与思考强度", async () => {
    renderChat();
    expect(
      await screen.findByRole("button", { name: /模型 A/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /medium/ })).toBeInTheDocument();
  });

  it("点模型名打开选择器，选中后切换（PUT /model）", async () => {
    renderChat();
    await userEvent.click(
      await screen.findByRole("button", { name: /模型 A/ }),
    );
    await userEvent.click(
      await screen.findByRole("option", { name: /opus-like/ }),
    );
    expect(
      await screen.findByRole("button", { name: /opus-like/ }),
    ).toBeInTheDocument();
    const put = calls.find(
      (c) => c.url.endsWith("/model") && c.method === "PUT",
    );
    expect(JSON.parse(put?.body ?? "{}")).toEqual({
      provider: "relay",
      modelId: "opus-like",
    });
  });

  it("输入 /model opus 回车：打开选择器并预填搜索，不当成消息发出", async () => {
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "/model opus{Enter}");
    const search = await screen.findByLabelText("搜索模型");
    expect(search).toHaveValue("opus");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.keyboard("{Enter}");
    expect(
      await screen.findByRole("button", { name: /opus-like/ }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/chat"))).toBe(false);
  });

  it("Shift+Tab 切到下一档思考强度", async () => {
    renderChat();
    await screen.findByRole("button", { name: /medium/ });
    await userEvent.click(input());
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(
      await screen.findByRole("button", { name: /high/ }),
    ).toBeInTheDocument();
    const put = calls.find((c) => c.url.endsWith("/thinking"));
    expect(JSON.parse(put?.body ?? "{}")).toEqual({ level: "high" });
  });

  it("回答中的模型标注只显示模型名", async () => {
    chatResponse = () =>
      sse([
        { type: "start", messageId: "m3" },
        { type: "start-step" },
        { type: "data-model", id: "dm", data: { model: "relay/opus-like" } },
        { type: "text-start", id: "t" },
        { type: "text-delta", id: "t", delta: "答" },
        { type: "text-end", id: "t" },
        { type: "finish-step" },
        { type: "finish", finishReason: "stop" },
      ]).response;
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "hi{Enter}");
    const label = await screen.findByTitle("relay/opus-like");
    expect(label).toHaveTextContent("opus-like");
  });
});

describe("手动点名技能（/skill）", () => {
  const SKILLS = {
    skills: [
      {
        name: "generate-prd",
        description: "写 PRD 时用。",
        hidden: false,
        promptBytes: 1024,
        fileCount: 1,
        updatedAt: 0,
        distribution: { pi: "absent" },
      },
      {
        name: "baoyu-comic",
        description: "画漫画用。",
        hidden: true,
        promptBytes: 0,
        fileCount: 1,
        updatedAt: 0,
        distribution: { pi: "absent" },
      },
    ],
    promptBytes: 1024,
  };

  beforeEach(() => {
    // 套在外层 beforeEach 装好的那个 fetch 上：只接管 /api/skills，其余原样转给它。
    const base = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (urlOf(input).endsWith("/api/skills")) {
          return Promise.resolve(json(SKILLS));
        }
        return base(input, init);
      }),
    );
  });

  it("输入 /skill 回车：打开技能选择器，不当成消息发出去", async () => {
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "/skill{enter}");
    expect(
      await screen.findByRole("dialog", { name: "选择技能" }),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith("/chat"))).toBe(false);
  });

  it("选中后把 /skill:名字 填回输入框（技能通常还要带一句做什么）", async () => {
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "/skill{enter}");
    await userEvent.click(
      await screen.findByRole("button", { name: /generate-prd/ }),
    );
    expect(input()).toHaveValue("/skill:generate-prd ");
    expect(calls.some((c) => c.url.endsWith("/chat"))).toBe(false);
  });

  it("隐藏的技能也列出来，并标明只能点名用", async () => {
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "/skill{enter}");
    await screen.findByRole("dialog", { name: "选择技能" });
    expect(screen.getByLabelText("对模型隐藏，只能点名用")).toBeInTheDocument();
  });

  it("带冒号的真命令照常发出去（由服务端展开成技能正文）", async () => {
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "/skill:generate-prd 登录改造{enter}");
    await waitFor(() => {
      const sent = calls.find((c) => c.url.endsWith("/chat"));
      expect(JSON.parse(sent?.body ?? "{}")).toEqual({
        message: "/skill:generate-prd 登录改造",
      });
    });
  });
});

describe("上游失败后的自动重试", () => {
  /** 服务端把 pi 的 auto_retry_* 翻成 transient 的 data-retry（见 server/pi/stream.ts）。 */
  const RETRY_TURN: Chunk[] = [
    { type: "start", messageId: "m-retry" },
    { type: "start-step" },
    {
      type: "data-retry",
      transient: true,
      data: {
        attempt: 1,
        maxAttempts: 3,
        delayMs: 500,
        message: "Request timed out.",
      },
    },
  ];
  const RETRY_TAIL: Chunk[] = [
    {
      type: "data-retry",
      transient: true,
      data: { attempt: 1, done: true, success: true },
    },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "重试之后的回答" },
    { type: "text-end", id: "t" },
    { type: "finish-step" },
    { type: "finish", finishReason: "stop" },
  ];

  it("重试中显示「正在自动重试（第 N / M 次）」+ 原始错误；恢复后改口「已恢复」", async () => {
    const gate = sse(RETRY_TURN, RETRY_TAIL);
    chatResponse = () => gate.response;
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "问一句{enter}");

    expect(
      await screen.findByText("上游失败，正在自动重试（第 1 / 3 次）"),
    ).toBeInTheDocument();
    // 原始错误降级为灰色小字，供排障。
    expect(screen.getByText("Request timed out.")).toBeInTheDocument();

    gate.release();
    await screen.findByText("重试之后的回答");
    // 答完仍留一行，解释「刚才为什么那么慢」。
    expect(
      screen.getByText("上游失败过，自动重试后已恢复（第 1 次）"),
    ).toBeInTheDocument();
  });

  it("重试到底还是失败：只留那条错误，不再重复说重试", async () => {
    chatResponse = () =>
      sse([
        ...RETRY_TURN,
        {
          type: "data-retry",
          transient: true,
          data: {
            attempt: 3,
            done: true,
            success: false,
            message: "Overloaded",
          },
        },
        {
          type: "data-error",
          id: "e",
          data: { message: "上游连续失败：Overloaded" },
        },
        { type: "finish", finishReason: "error" },
      ]).response;
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "问一句{enter}");

    expect(await screen.findByText(/上游连续失败/)).toBeInTheDocument();
    expect(screen.queryByText(/正在自动重试/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已恢复/)).not.toBeInTheDocument();
  });

  it("下一次发送时清掉上一轮的重试提示", async () => {
    const gate = sse(RETRY_TURN, RETRY_TAIL);
    chatResponse = () => gate.response;
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "问一句{enter}");
    await screen.findByText(/正在自动重试/);
    gate.release();
    await screen.findByText("重试之后的回答");

    chatResponse = () => sse(TURN).response;
    await userEvent.type(input(), "再问一句{enter}");
    await screen.findByText("这是回答");
    // 只查提示行（上一轮的回答正文里也有「重试」两个字，不该跟着被清）。
    expect(screen.queryByText(/自动重试/)).not.toBeInTheDocument();
    expect(screen.queryByText(/已恢复/)).not.toBeInTheDocument();
    expect(screen.getByText("重试之后的回答")).toBeInTheDocument();
  });
});

describe("思考过程的展开方式（设置里的「界面」选项）", () => {
  /** 这组用例只关心思考部件的开合，所以把一轮拆成「思考中」与「答完」两段。 */
  const THINKING_HEAD: Chunk[] = [
    { type: "start", messageId: "m-think" },
    { type: "start-step" },
    { type: "reasoning-start", id: "r" },
    { type: "reasoning-delta", id: "r", delta: "先掂量一下这题" },
  ];
  const THINKING_TAIL: Chunk[] = [
    { type: "reasoning-end", id: "r" },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "结论是这样" },
    { type: "text-end", id: "t" },
    { type: "finish-step" },
    { type: "finish", finishReason: "stop" },
  ];

  afterEach(() => {
    setReasoningDisplay("collapsed");
  });

  const thinkingText = () => screen.queryByText("先掂量一下这题");

  it("折叠（默认）：思考时也只露标题，点开才看正文", async () => {
    const gate = sse(THINKING_HEAD, THINKING_TAIL);
    chatResponse = () => gate.response;
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "想想{enter}");

    expect(await screen.findByText("思考中")).toBeInTheDocument();
    expect(thinkingText()).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /思考中/ }));
    expect(thinkingText()).toBeInTheDocument();
    // 放完要等这一轮真的落完：流还在跑就卸载组件，会冲出 unhandled rejection。
    gate.release();
    await screen.findByText("结论是这样");
  });

  it("边想边看：思考时自动展开，这一段思考结束后自动收起", async () => {
    setReasoningDisplay("streaming");
    const gate = sse(THINKING_HEAD, THINKING_TAIL);
    chatResponse = () => gate.response;
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "想想{enter}");

    // 没点任何东西，正文自己就出来了。
    expect(await screen.findByText("先掂量一下这题")).toBeInTheDocument();
    gate.release();
    await screen.findByText("结论是这样");
    await waitFor(() => {
      expect(thinkingText()).not.toBeInTheDocument();
    });
  });

  it("始终展开：答完了也还摊着", async () => {
    setReasoningDisplay("expanded");
    chatResponse = () => sse([...THINKING_HEAD, ...THINKING_TAIL]).response;
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "想想{enter}");

    await screen.findByText("结论是这样");
    expect(thinkingText()).toBeInTheDocument();
  });

  it("手动点过就以手动为准：边想边看模式下点收起，答完也不会被强行弹开", async () => {
    setReasoningDisplay("streaming");
    const gate = sse(THINKING_HEAD, THINKING_TAIL);
    chatResponse = () => gate.response;
    renderChat();
    await screen.findByText("早上好");
    await userEvent.type(input(), "想想{enter}");

    await screen.findByText("先掂量一下这题");
    await userEvent.click(screen.getByRole("button", { name: /思考中/ }));
    expect(thinkingText()).not.toBeInTheDocument();
    gate.release();
    await screen.findByText("结论是这样");
    expect(thinkingText()).not.toBeInTheDocument();
  });
});
