import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { AgentsPage } from "./AgentsPage";

/**
 * 执行体页（列表 + 展览）。断言落在「发给服务端的请求」与「人看到什么」上，
 * 校验与写盘都在服务端——前端再抄一份校验规则必然会走偏。
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { "content-type": "application/json" },
  });

const AUDITOR = {
  name: "codebase-auditor",
  description: "只读核代码事实。写 PRD 要核现状时派它。",
  tools: ["Read", "Grep"],
  model: "sonnet",
  skills: ["audit-codebase", "拼错的名字"],
  updatedAt: 0,
  distribution: { pi: "absent" },
};
const CURATOR = {
  name: "artifact-curator",
  description: "批量维护产出物元信息。",
  tools: [],
  skills: [],
  updatedAt: 0,
  distribution: { pi: "linked" },
};
const DETAIL = {
  ...AUDITOR,
  content:
    "---\nname: codebase-auditor\ndescription: 只读核代码事实。\ntools: Read, Grep\n---\n\n## 纪律\n\n只读，不改任何文件。\n",
  missingSkills: ["拼错的名字"],
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function setup(options: { agents?: unknown[] } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith("/api/agents") && method === "GET") {
        return Promise.resolve(
          json({ agents: options.agents ?? [CURATOR, AUDITOR] }),
        );
      }
      if (url.endsWith("/api/agents") && method === "POST") {
        return Promise.resolve(json(DETAIL, 201));
      }
      if (url.includes("/distribution")) {
        return Promise.resolve(
          json({ ...DETAIL, distribution: { pi: "linked" } }),
        );
      }
      if (url.includes("/api/agents/codebase-auditor")) {
        return Promise.resolve(json(DETAIL));
      }
      if (url.includes("/api/agents/artifact-curator")) {
        return Promise.resolve(
          json({ ...CURATOR, content: "---\n---\n正文", missingSkills: [] }),
        );
      }
      return Promise.resolve(json({}, 404));
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <AgentsPage />
    </QueryClientProvider>,
  );
  return calls;
}

describe("执行体列表", () => {
  it("按名称排序列出，行上直接报工具与可写与否", async () => {
    setup();
    expect(await screen.findByText("artifact-curator")).toBeInTheDocument();
    expect(screen.getByText(/Read · Grep/)).toBeInTheDocument();
    // 没写 tools = 继承全部工具，这不是「没有工具」，而且意味着可写。
    expect(screen.getByText(/继承全部工具/)).toBeInTheDocument();
    expect(screen.getAllByText("可写")).toHaveLength(1);
    expect(
      screen.getByTitle("已分发到 ~/.pi/agent/agents"),
    ).toBeInTheDocument();
  });

  it("搜索按名称或描述过滤；没命中时说清是谁没命中", async () => {
    setup();
    await screen.findByText("codebase-auditor");
    const box = screen.getByLabelText("搜索执行体");
    await userEvent.type(box, "产出物");
    expect(screen.queryByText("codebase-auditor")).not.toBeInTheDocument();
    expect(screen.getByText("artifact-curator")).toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, "不存在的东西");
    expect(
      screen.getByText(/没有匹配「不存在的东西」的执行体/),
    ).toBeInTheDocument();
  });

  it("空态说清这里是什么、该做什么", async () => {
    setup({ agents: [] });
    expect(await screen.findByText(/还没有执行体/)).toBeInTheDocument();
  });
});

describe("展览（详情）", () => {
  it("点开：默认看渲染后的正文，能力与配置摆在正文之前", async () => {
    setup();
    await userEvent.click(await screen.findByText("codebase-auditor"));
    expect(
      await screen.findByRole("heading", { name: "纪律" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("执行体定义内容")).not.toBeInTheDocument();
    expect(screen.getByText("能力与配置")).toBeInTheDocument();
    // 模型在列表行与详情各显一次，这里只关心详情里那一份。
    expect(screen.getAllByText("sonnet").length).toBeGreaterThanOrEqual(1);
  });

  it("点名了技能库里没有的 skill：明确报出来，不让它变成哑故障", async () => {
    setup();
    await userEvent.click(await screen.findByText("codebase-auditor"));
    expect(
      await screen.findByText(/技能库里找不到：拼错的名字/),
    ).toBeInTheDocument();
  });

  it("分发：把期望集合发给服务端（撤销就是发空数组）", async () => {
    const calls = setup();
    await userEvent.click(await screen.findByText("codebase-auditor"));
    await userEvent.click(
      await screen.findByRole("button", { name: /^分发$/ }),
    );
    await waitFor(() => {
      expect(calls.find((c) => c.url.includes("/distribution"))).toMatchObject({
        method: "PUT",
        body: { targets: ["pi"] },
      });
    });
  });
});

describe("新建", () => {
  it("预填骨架，并提示保存后会叫什么", async () => {
    const calls = setup();
    await userEvent.click(await screen.findByRole("button", { name: "新建" }));
    const editor = screen.getByLabelText<HTMLTextAreaElement>("执行体定义内容");
    expect(editor.value).toContain("name: my-agent");
    // 模板里就写好 tools 与纪律：空白输入框不会提醒任何一条。
    expect(editor.value).toContain("tools:");
    expect(screen.getByText(/保存后会叫「my-agent」/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => {
      expect(
        calls.find((c) => c.url.endsWith("/api/agents") && c.method === "POST"),
      ).toBeDefined();
    });
  });
});
