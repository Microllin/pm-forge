import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../../../server/app";
import { IN_MEMORY, openDb, type Db } from "../../../server/db";
import { createKeyStore } from "../../../server/model-config";
import { piPaths } from "../../../server/pi/runtime";
import { createSkillStore } from "../../../server/skills";
import { ProductsPage } from "./ProductsPage";

/**
 * 前端测试直接打真服务端（对话服务的 createApp + 内存 SQLite），不写假后端：
 * 校验、重名、删除保护这些行为以服务端为准，假后端会和它漂移。
 */
let db: Db;
let dir: string;
let server: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  db = openDb(IN_MEMORY);
  dir = mkdtempSync(join(tmpdir(), "pmforge-products-web-"));
  ({ app: server } = createApp({
    auth: false,
    db,
    paths: piPaths(dir),
    keys: createKeyStore(dir, {}),
    // 技能目录与分发目标都在临时目录里，绝不碰真实的 ~/.pi。
    skills: createSkillStore({
      dir: join(dir, "skills"),
      targetDirs: {
        pi: join(dir, "targets", "pi"),
      },
    }),
    security: false,
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const res = await server.inject({
        method: (init?.method ?? "GET") as "GET",
        url,
        // 与浏览器一致：只有带请求体时才有 content-type（无体的 DELETE 带它会被 fastify 拒）。
        headers: {
          host: "127.0.0.1:4400",
          ...(typeof init?.body === "string"
            ? { "content-type": "application/json" }
            : {}),
        },
        ...(typeof init?.body === "string" ? { payload: init.body } : {}),
      });
      return new Response(res.statusCode === 204 ? null : res.body, {
        status: res.statusCode,
        headers: { "content-type": "application/json" },
      });
    }),
  );
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function renderApp(): void {
  render(
    <StrictMode>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ProductsPage
          onAnalysis={() => undefined}
          onOpenProduct={() => undefined}
        />
      </QueryClientProvider>
    </StrictMode>,
  );
}

/** 产品行上的「更多」菜单：绑目录 / 编辑 / 删除这些低频操作都收在里面。 */
async function openMore(product: string): Promise<HTMLElement> {
  const row = screen
    .getByRole("button", { name: `打开 ${product} 的产出物` })
    .closest("li");
  if (row === null) throw new Error(`找不到产品行 ${product}`);
  const buttons = within(row as HTMLElement).getAllByRole("button");
  const more = buttons.find((b) => b.textContent.includes("更多"));
  if (more === undefined) throw new Error(`找不到「更多」按钮 ${product}`);
  await userEvent.click(more);
  return row;
}
const menuItem = (label: RegExp | string) =>
  screen.getByRole("menuitem", { name: label });

async function fillDialog(name: string, description = ""): Promise<void> {
  const dialog = await screen.findByRole("dialog");
  const nameInput = within(dialog).getByLabelText("名称");
  await userEvent.clear(nameInput);
  await userEvent.type(nameInput, name);
  if (description)
    await userEvent.type(within(dialog).getByLabelText("描述"), description);
  await userEvent.click(
    within(dialog).getByRole("button", { name: /创建|保存/ }),
  );
}

async function seed(): Promise<void> {
  const post = async (url: string, body: unknown) =>
    (
      await server.inject({
        method: "POST",
        url,
        headers: { host: "127.0.0.1:4400" },
        payload: body as object,
      })
    ).json<{
      id: string;
    }>();
  const cr = await post("/api/product-lines", {
    name: "RouteHub",
    description: "大模型路由平台",
  });
  await post("/api/product-lines", { name: "DevSuite" });
  for (const name of ["ModelHub", "SecHub", "OpsHub"])
    await post(`/api/product-lines/${cr.id}/products`, { name });
}

const lineList = () => screen.getByRole("navigation", { name: "产品线列表" });
const productNames = () =>
  within(screen.getByRole("list", { name: "产品列表" }))
    .getAllByRole("listitem")
    .map((li) => li.querySelector("strong")?.textContent);

describe("产品线", () => {
  it("空库：显示空状态；新建后出现在左侧并被选中", async () => {
    renderApp();
    expect(await screen.findByText("还没有产品线")).toBeInTheDocument();
    // 空状态里的按钮（侧栏的 + 也叫「新建产品线」）。
    await userEvent.click(
      within(screen.getByRole("region", { name: "产品线详情" })).getByRole(
        "button",
        {
          name: "新建产品线",
        },
      ),
    );
    await fillDialog("RouteHub", "大模型路由平台");
    expect(
      await screen.findByRole("heading", { level: 2, name: "RouteHub" }),
    ).toBeInTheDocument();
    expect(screen.getByText("大模型路由平台")).toBeInTheDocument();
    expect(
      within(lineList()).getByRole("button", { name: /RouteHub/ }),
    ).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("重名：错误显示在对话框里，对话框不关", async () => {
    await seed();
    renderApp();
    await screen.findByRole("heading", { level: 2, name: "RouteHub" });
    await userEvent.click(screen.getByRole("button", { name: "新建产品线" }));
    await fillDialog("routehub");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "已有同名产品线「routehub」",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("编辑名称与描述；Esc 关闭对话框不保存", async () => {
    await seed();
    renderApp();
    await screen.findByRole("heading", { level: 2, name: "RouteHub" });
    await userEvent.click(screen.getByRole("button", { name: /编辑$/ }));
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /编辑$/ }));
    expect(
      within(screen.getByRole("dialog")).getByLabelText("名称"),
    ).toHaveValue("RouteHub");
    await fillDialog("RouteHub 产品线");
    expect(
      await screen.findByRole("heading", {
        level: 2,
        name: "RouteHub 产品线",
      }),
    ).toBeInTheDocument();
  });

  it("删除非空产品线：不弹确认，直接说明原因；空产品线确认后删除", async () => {
    await seed();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderApp();
    await screen.findByRole("heading", { level: 2, name: "RouteHub" });
    await userEvent.click(screen.getByRole("button", { name: /删除$/ }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "「RouteHub」下还有 3 个产品，先移走或删除它们",
    );
    expect(confirm).not.toHaveBeenCalled();

    await userEvent.click(
      within(lineList()).getByRole("button", { name: /DevSuite/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: /删除$/ }));
    expect(confirm).toHaveBeenCalledWith("删除产品线「DevSuite」？");
    await waitFor(() => {
      expect(
        within(lineList()).queryByRole("button", { name: /DevSuite/ }),
      ).not.toBeInTheDocument();
    });
    // 删掉选中的那条后落回第一条。
    expect(
      screen.getByRole("heading", { level: 2, name: "RouteHub" }),
    ).toBeInTheDocument();
  });
});

describe("产品", () => {
  it("在选中的产品线下新建；左侧计数跟着变", async () => {
    await seed();
    renderApp();
    await screen.findByRole("heading", { level: 2, name: "RouteHub" });
    expect(productNames()).toEqual(["ModelHub", "SecHub", "OpsHub"]);
    await userEvent.click(screen.getByRole("button", { name: "新建产品" }));
    expect(
      screen.getByRole("heading", { name: "在「RouteHub」下新建产品" }),
    ).toBeInTheDocument();
    await fillDialog("SkillCenter", "生态站");
    await waitFor(() => {
      expect(productNames()).toEqual([
        "ModelHub",
        "SecHub",
        "OpsHub",
        "SkillCenter",
      ]);
    });
    expect(screen.getByText("生态站")).toBeInTheDocument();
    expect(
      within(lineList()).getByRole("button", { name: /RouteHub/ }),
    ).toHaveTextContent("4");
  });

  it("编辑时改「所属产品线」：从当前列表移走，出现在目标产品线", async () => {
    await seed();
    renderApp();
    await screen.findByRole("heading", { level: 2, name: "RouteHub" });
    await openMore("OpsHub");
    await userEvent.click(menuItem("编辑"));
    const dialog = screen.getByRole("dialog");
    const lineSelect = within(dialog).getByRole("combobox", {
      name: /所属产品线/,
    });
    expect(lineSelect).toHaveTextContent("RouteHub");
    await userEvent.click(lineSelect);
    await userEvent.click(screen.getByRole("option", { name: "DevSuite" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(productNames()).toEqual(["ModelHub", "SecHub"]);
    });
    await userEvent.click(
      within(lineList()).getByRole("button", { name: /DevSuite/ }),
    );
    expect(productNames()).toEqual(["OpsHub"]);
  });

  it("删除：取消则不删，确认后消失；删光后显示空提示", async () => {
    await seed();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderApp();
    await screen.findByRole("heading", { level: 2, name: "RouteHub" });
    await openMore("SecHub");
    await userEvent.click(menuItem("删除"));
    expect(productNames()).toHaveLength(3);

    confirm.mockReturnValue(true);
    for (const name of ["SecHub", "ModelHub", "OpsHub"]) {
      await openMore(name);
      await userEvent.click(menuItem("删除"));
      await waitFor(() => {
        expect(
          screen.queryByRole("button", { name: `打开 ${name} 的产出物` }),
        ).not.toBeInTheDocument();
      });
    }
    expect(screen.getByText("这条产品线下还没有产品")).toBeInTheDocument();
  });
});
