import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";

import { App } from "./App";

/** 外壳只管切菜单：各页面的接口在这里给最小可用的假数据。 */
const json = (d: unknown) =>
  new Response(JSON.stringify(d), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

/** 临时区里的条目。默认空；个别测试里放一条。 */
let stagingItems: unknown[] = [];

function route(url: string): Response {
  if (url.endsWith("/api/staging"))
    return json({
      root: "/临时区",
      items: stagingItems,
      counts: {
        chat: stagingItems.length,
        agent: 0,
        fill: 0,
        presales: 0,
      },
    });
  if (url.includes("/api/staging/target"))
    return json({
      path: decodeURIComponent(url.slice(url.indexOf("path=") + 5)),
      problem: null,
      exists: false,
    });
  if (url.endsWith("/api/staging/discard")) return json({ discarded: 1 });
  if (url.endsWith("/api/staging/apply"))
    return json({
      applied: [{ key: "draft:1", title: "席位 PRD", path: "/产品/席位.md" }],
      replaced: [],
      failed: [],
    });
  if (url.endsWith("/api/sessions"))
    return json({
      sessions: [
        {
          id: "s1",
          title: "第一个对话",
          createdAt: 1,
          updatedAt: 1,
          streaming: false,
        },
        {
          id: "s2",
          title: "第二个对话",
          createdAt: 2,
          updatedAt: 2,
          streaming: false,
        },
      ],
    });
  if (url.endsWith("/messages"))
    return json({ messages: [], streaming: false });
  if (url.endsWith("/model"))
    return json({
      provider: "relay",
      modelId: "模型 A",
      thinkingLevel: "medium",
      thinkingLevels: ["off", "medium"],
    });
  if (url.endsWith("/api/models"))
    return json({
      models: [],
      defaultModel: null,
      defaultThinking: "medium",
      problem: null,
    });
  if (url.endsWith("/api/providers"))
    return json({
      configured: [],
      catalog: [],
      defaultModel: null,
      defaultThinking: "medium",
    });
  if (url.endsWith("/api/pi"))
    return json({
      installed: "1.2.0",
      installedAt: null,
      latest: "1.2.0",
      latestAt: null,
      updateAvailable: false,
      repository: null,
      upgrading: false,
      registryError: null,
    });
  if (url.endsWith("/api/skills")) return json({ skills: [] });
  if (url.endsWith("/api/agents"))
    return json({
      agents: [
        {
          name: "codebase-auditor",
          description: "只读核代码事实。",
          tools: ["Read", "Grep"],
          skills: [],
          updatedAt: 1,
          distribution: { pi: "absent" },
        },
      ],
    });
  if (url.endsWith("/api/lifecycle-templates"))
    return json({
      templates: [
        {
          id: "t1",
          name: "标准 SaaS Web 产品",
          description: "",
          builtin: true,
          createdAt: 1,
          updatedAt: 1,
          stages: [],
          productCount: 0,
        },
      ],
    });
  if (url.includes("/api/files/list")) return json({ path: "/", entries: [] });
  if (url.endsWith("/api/code-repos"))
    return json({
      repos: [
        {
          name: "RouteHub",
          path: "/代码库/RouteHub",
          files: 9975,
          bytes: 387 * 1024 * 1024,
          modifiedAt: 1_792_000_000_000,
          createdAt: 1_792_000_000_000,
          products: [{ id: "p1", name: "ModelHub" }],
          git: {
            remote: "https://github.com/acme/RouteHub.git",
            branch: "main",
            commit: "abc1234",
          },
        },
      ],
    });
  if (url.endsWith("/api/product-lines"))
    return json({
      lines: [
        {
          id: "l1",
          name: "RouteHub",
          description: "",
          createdAt: 1,
          updatedAt: 1,
          products: [
            {
              id: "p1",
              lineId: "l1",
              name: "ModelHub",
              description: "",
              templateId: null,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      ],
    });
  if (url.endsWith("/api/work-items?kind=request"))
    return json({ items: [workItem] });
  if (url.endsWith("/api/work-items?kind=task")) return json({ items: [] });
  if (url.endsWith("/api/work-items/w1/chat"))
    return json({ sessionId: "s1", prompt: "## 用户需求", item: workItem });
  if (url.endsWith("/api/integrations/linear"))
    return json({
      connected: false,
      keyHint: null,
      scope: "mine",
      teamKey: "",
      includeDone: false,
      lastSync: null,
    });
  return new Response(null, { status: 404 });
}

const workItem = {
  id: "w1",
  kind: "request",
  source: "manual",
  externalKey: null,
  url: null,
  title: "导出 Excel 报表",
  description: "客户每周要手抄数据",
  status: "todo",
  externalStatus: null,
  priority: 2,
  requester: "客户 A",
  assignee: "",
  labels: [],
  team: "",
  productId: null,
  productName: null,
  sessionId: null,
  externalUpdatedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

beforeEach(() => {
  window.location.hash = "";
  localStorage.removeItem("pmforge-chat.rail-narrow");
  stagingItems = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        route(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        ),
      ),
    ),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderApp(): void {
  render(
    <StrictMode>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <App />
      </QueryClientProvider>
    </StrictMode>,
  );
}

const rail = () => screen.getByRole("navigation", { name: "一级菜单" });
const menu = (name: string) => within(rail()).getByRole("button", { name });
const tabbar = () => screen.getByRole("navigation", { name: "二级菜单" });

describe("一级菜单", () => {
  it("控制台、对话、临时区、任务与需求、产品、售前材料、事实底座、页面快照、市场情报、技能、执行体、设置；默认进控制台", async () => {
    renderApp();
    expect(
      within(rail())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "控制台",
      "对话",
      "临时区",
      "任务与需求",
      "用户需求",
      "内部任务",
      "产品",
      "售前材料",
      "材料清单",
      "售前模板",
      "事实底座",
      "文件库",
      "代码库",
      "页面快照",
      "市场情报",
      "技能",
      "执行体",
      "设置",
    ]);
    expect(menu("控制台")).toHaveAttribute("aria-current", "page");
    // 控制台的最近动态里列出会话。
    expect(await screen.findByText("第一个对话")).toBeInTheDocument();
  });

  it("临时区：每一行都有确认和丢弃，只作用于这一份", async () => {
    stagingItems = [
      {
        key: "draft:1",
        source: "chat",
        productId: "p1",
        productName: "ModelHub",
        title: "席位 PRD",
        origin: "对话：席位",
        draftPath: "/临时区/对话/2026-10-31/席位 PRD.md",
        target: "/产品/席位 PRD.md",
        targetEditable: true,
        willReplace: false,
        note: null,
        exists: true,
        sessionId: null,
        createdAt: 1,
      },
    ];
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    window.location.hash = "#staging";
    renderApp();
    await userEvent.click(
      await screen.findByRole("button", { name: "确认 席位 PRD" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "确认入库" });
    expect(within(dialog).getByRole("heading")).toHaveTextContent(
      "确认 1 份产出？",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));

    await userEvent.click(
      screen.getByRole("button", { name: "丢弃 席位 PRD" }),
    );
    expect(await screen.findByText("已丢弃 1 份")).toBeInTheDocument();
    const discard = vi
      .mocked(fetch)
      .mock.calls.find(
        ([u]) => typeof u === "string" && u.endsWith("/api/staging/discard"),
      );
    expect(JSON.parse(discard?.[1]?.body as string)).toEqual({
      keys: ["draft:1"],
    });
  });

  it("临时区：角标是待确认数；确认时能改去处，提交的是改过的去处", async () => {
    stagingItems = [
      {
        key: "draft:1",
        source: "chat",
        productId: "p1",
        productName: "ModelHub",
        title: "席位 PRD",
        origin: "对话：席位",
        draftPath: "/临时区/对话/2026-10-31/席位 PRD.md",
        target: "/产品/席位 PRD.md",
        targetEditable: true,
        willReplace: false,
        note: null,
        exists: true,
        sessionId: null,
        createdAt: 1,
      },
    ];
    renderApp();
    expect(
      await within(rail()).findByLabelText("1 项待确认"),
    ).toBeInTheDocument();
    await userEvent.click(menu("临时区"));
    expect(window.location.hash).toBe("#staging");
    expect(await screen.findByText("席位 PRD")).toBeInTheDocument();
    expect(screen.getByText("/产品/席位 PRD.md")).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("checkbox", { name: "选中 席位 PRD" }),
    );
    await userEvent.click(screen.getByRole("button", { name: /确认所选/ }));
    const dialog = await screen.findByRole("dialog", { name: "确认入库" });
    const input = within(dialog).getByRole("textbox");
    await userEvent.clear(input);
    await userEvent.type(input, "/产品/席位.md");
    expect(
      await within(dialog).findByText("新文件，不会覆盖任何内容"),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "确认" }));

    expect(await screen.findByText(/已确认 1 份/)).toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls;
    const apply = calls.find(
      ([u]) => typeof u === "string" && u.endsWith("/api/staging/apply"),
    );
    expect(JSON.parse(apply?.[1]?.body as string)).toEqual({
      items: [{ key: "draft:1", target: "/产品/席位.md" }],
    });
  });

  it("任务与需求：需求清单一键开对话，带到对话页；任务页未接入时引导接 Linear", async () => {
    renderApp();
    await userEvent.click(menu("用户需求"));
    expect(window.location.hash).toBe("#work");
    expect(
      await screen.findByDisplayValue("导出 Excel 报表"),
    ).toBeInTheDocument();
    // 新需求直接在表格顶上那一行输入。
    expect(screen.getByRole("textbox", { name: "新需求" })).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "开始对话：导出 Excel 报表" }),
    );
    expect(window.location.hash).toBe("#chat");
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(
          ([u]) =>
            typeof u === "string" && u.endsWith("/api/work-items/w1/chat"),
        ),
    ).toBe(true);

    await userEvent.click(menu("内部任务"));
    expect(window.location.hash).toBe("#work/tasks");
    expect(await screen.findByText("还没有接入 Linear")).toBeInTheDocument();
    // 任务只能拉取，没有新建入口。
    expect(screen.queryByRole("button", { name: "新建需求" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "接入 Linear" }));
    expect(
      await screen.findByRole("dialog", { name: "接入 Linear" }),
    ).toBeInTheDocument();
  });

  it("切到产品：显示产品线，hash 变成 #products", async () => {
    renderApp();
    await userEvent.click(menu("产品"));
    expect(
      await screen.findByRole("heading", { level: 2, name: "RouteHub" }),
    ).toBeInTheDocument();
    expect(screen.getByText("ModelHub")).toBeInTheDocument();
    expect(window.location.hash).toBe("#products");
    expect(menu("产品")).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("第一个对话")).not.toBeInTheDocument();
  });

  it("刷新时按 hash 恢复菜单", async () => {
    window.location.hash = "#products";
    renderApp();
    expect(
      await screen.findByRole("heading", { level: 2, name: "RouteHub" }),
    ).toBeInTheDocument();
    expect(menu("产品")).toHaveAttribute("aria-current", "page");
  });

  it("事实底座下分「文件库」「代码库」两个去处，画在左侧菜单里", async () => {
    renderApp();
    await userEvent.click(menu("文件库"));
    expect(
      await screen.findByText("这个文件夹是空的，上传或新建一个吧"),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe("#files");
    expect(menu("文件库")).toHaveAttribute("aria-current", "page");
    // 二级菜单在左侧，不再有顶部标签栏
    expect(
      screen.queryByRole("navigation", { name: "二级菜单" }),
    ).not.toBeInTheDocument();

    // 代码库是仓库清单：体量与绑定的产品
    await userEvent.click(menu("代码库"));
    expect(window.location.hash).toBe("#files/code");
    const table = await screen.findByRole("region", { name: "仓库清单" });
    expect(table).toHaveTextContent("RouteHub");
    expect(table).toHaveTextContent("9,975");
    expect(table).toHaveTextContent("ModelHub");
    expect(menu("代码库")).toHaveAttribute("aria-current", "page");
  });

  it("事实底座可以收起二级菜单（展开的侧栏里）", async () => {
    // 默认是图标栏，二级菜单总是摊开；人展开侧栏后才能收起某一组。
    localStorage.setItem("pmforge-chat.rail-narrow", "0");
    renderApp();
    await userEvent.click(menu("事实底座"));
    expect(
      within(rail()).queryByRole("button", { name: "文件库" }),
    ).not.toBeInTheDocument();
    await userEvent.click(menu("事实底座"));
    expect(menu("文件库")).toBeInTheDocument();
  });

  it("技能是一级菜单", async () => {
    renderApp();
    await userEvent.click(menu("技能"));
    expect(
      await screen.findByRole("heading", { name: "技能" }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe("#skills");
    expect(menu("技能")).toHaveAttribute("aria-current", "page");
  });

  it("执行体是一级菜单，与技能并列而不是它的子标签", async () => {
    renderApp();
    await userEvent.click(menu("执行体"));
    expect(
      await screen.findByRole("heading", { name: "执行体" }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe("#agents");
    expect(menu("执行体")).toHaveAttribute("aria-current", "page");
    // 列表读的是 /api/agents，不是技能那份清单
    expect(await screen.findByText("codebase-auditor")).toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "二级菜单" }),
    ).not.toBeInTheDocument();
  });

  it("设置是一级菜单：模型接入与 pi 版本在这里", async () => {
    renderApp();
    await userEvent.click(menu("设置"));
    expect(
      await screen.findByRole("heading", { name: "设置" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "模型接入" }),
    ).toBeInTheDocument();
    expect(window.location.hash).toBe("#settings");
  });

  it("对话里打开的会话：切到产品再切回来，仍停在原会话", async () => {
    renderApp();
    await userEvent.click(menu("对话"));
    await userEvent.click(
      await screen.findByRole("button", { name: "第二个对话" }),
    );
    expect(
      screen.getByRole("button", { name: "第二个对话" }).closest(".session"),
    ).toHaveClass("active");

    await userEvent.click(menu("产品"));
    await screen.findByRole("heading", { level: 2, name: "RouteHub" });
    await userEvent.click(menu("对话"));
    expect(
      (await screen.findByRole("button", { name: "第二个对话" })).closest(
        ".session",
      ),
    ).toHaveClass("active");
    expect(screen.getByLabelText("输入消息")).toBeInTheDocument();
  });
});

describe("二级菜单（标签栏）", () => {
  it("只有产品菜单有标签；其余菜单不渲染标签栏", async () => {
    renderApp();
    // 对话菜单：没有标签栏，不留空白条
    expect(
      screen.queryByRole("navigation", { name: "二级菜单" }),
    ).not.toBeInTheDocument();

    await userEvent.click(menu("产品"));
    expect(
      within(tabbar())
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual([
      "产品",
      "图谱",
      "数据结构",
      "页面",
      "Wiki",
      "生命周期规范",
      "AI 补齐",
    ]);
    expect(
      within(tabbar()).getByRole("button", { name: "产品" }),
    ).toHaveAttribute("aria-current", "page");
  });

  it("切到生命周期规范：hash 变成 #products/lifecycle，看到模板列表", async () => {
    renderApp();
    await userEvent.click(menu("产品"));
    await userEvent.click(
      within(tabbar()).getByRole("button", { name: "生命周期规范" }),
    );
    expect(window.location.hash).toBe("#products/lifecycle");
    expect(
      await screen.findByRole("navigation", { name: "模板列表" }),
    ).toBeInTheDocument();
    // 产品页已让位
    expect(
      screen.queryByRole("navigation", { name: "产品线列表" }),
    ).not.toBeInTheDocument();
    // 一级菜单仍停在「产品」
    expect(menu("产品")).toHaveAttribute("aria-current", "page");
  });

  it("刷新时按 hash 恢复到二级标签；认不出的标签退回默认页", async () => {
    window.location.hash = "#products/lifecycle";
    renderApp();
    expect(
      await screen.findByRole("navigation", { name: "模板列表" }),
    ).toBeInTheDocument();

    cleanup();
    window.location.hash = "#products/乱写的";
    renderApp();
    expect(
      await screen.findByRole("heading", { level: 2, name: "RouteHub" }),
    ).toBeInTheDocument();
  });
});
