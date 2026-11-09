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
import { LifecyclePage } from "./LifecyclePage";

/**
 * 前端测试直接打真服务端（对话服务的 createApp + 内存 SQLite），不写假后端：
 * 校验、重名、删除保护这些行为以服务端为准，假后端会和它漂移。口径与
 * products/ProductsPage.test.tsx 一致。
 */
let db: Db;
let dir: string;
let server: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  db = openDb(IN_MEMORY);
  dir = mkdtempSync(join(tmpdir(), "pmforge-lifecycle-web-"));
  ({ app: server } = createApp({
    auth: false,
    db,
    paths: piPaths(dir),
    keys: createKeyStore(dir, {}),
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

function renderPage(): void {
  render(
    <StrictMode>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <LifecyclePage />
      </QueryClientProvider>
    </StrictMode>,
  );
}

const list = () => screen.getByRole("navigation", { name: "模板列表" });
const detail = () => screen.getByRole("region", { name: "模板详情" });

describe("生命周期规范", () => {
  it("进来就看到出厂模板「标准 SaaS Web 产品」，阶段按 L0.1→L5.2 排开", async () => {
    renderPage();
    expect(
      await within(list()).findByRole("button", {
        name: /标准 SaaS Web 产品/,
      }),
    ).toBeInTheDocument();
    // 阶段代号与名称
    expect(await within(detail()).findByText("L0.1")).toBeInTheDocument();
    expect(within(detail()).getByText("L5.2")).toBeInTheDocument();
    // 「想法卡」既是 L0.1 的阶段名也是它下面的产出物名，所以这里是两处
    expect(within(detail()).getAllByText("想法卡")).toHaveLength(2);
    expect(within(detail()).getByText("上线后指标复盘")).toBeInTheDocument();
    // 用户点名的那几件产出物都在
    expect(
      within(detail()).getByText("产品定位与范围（产品一页纸）"),
    ).toBeInTheDocument();
    expect(
      within(detail()).getByText("阶段规划（Roadmap）"),
    ).toBeInTheDocument();
    // 文案被 JSX 拆成多个文本节点，按归一化后的整段比，别逐节点找
    expect(
      within(detail()).getByText(
        (_t, node) =>
          (node?.textContent ?? "").replace(/\s+/g, " ").trim() ===
          "11 个阶段 · 13 件产出物 · 暂无产品绑定",
      ),
    ).toBeInTheDocument();
  });

  it("产出物默认收起；点开看到判定要点与文件线索", async () => {
    renderPage();
    // 锚在开头：展开按钮的可访问名是「想法卡 必交 N 条判定要点」，
    // 操作按钮则以「编辑产出物 / 删除产出物」开头，不会撞上。
    const toggle = await within(detail()).findByRole("button", {
      name: /^想法卡/,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText(/谁的什么痛点：具体到人和场景/),
    ).toBeInTheDocument();
    expect(screen.getByText("idea-card")).toBeInTheDocument();
  });

  it("新建模板：出现在列表里并被选中，详情是空的", async () => {
    renderPage();
    await within(list()).findByRole("button", { name: /标准 SaaS Web 产品/ });
    await userEvent.click(screen.getByRole("button", { name: "新建模板" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByLabelText("模板名称"),
      "内部工具精简档",
    );
    await userEvent.type(
      within(dialog).getByLabelText("适用说明"),
      "没有市场可算、没有 PMF 可测",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(
        within(detail()).getByRole("heading", { name: "内部工具精简档" }),
      ).toBeInTheDocument();
    });
    expect(within(detail()).getByText(/还没有阶段/)).toBeInTheDocument();
  });

  it("模板重名：错误显示在对话框里，窗不关", async () => {
    renderPage();
    await within(list()).findByRole("button", { name: /标准 SaaS Web 产品/ });
    await userEvent.click(screen.getByRole("button", { name: "新建模板" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByLabelText("模板名称"),
      "标准 SaaS Web 产品",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "已有同名模板「标准 SaaS Web 产品」",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("加阶段、加产出物：判定要点一行一条", async () => {
    renderPage();
    await within(detail()).findByText("L0.1");
    await userEvent.click(screen.getByRole("button", { name: "新建阶段" }));
    let dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("代号"), "L6");
    await userEvent.type(within(dialog).getByLabelText("阶段名称"), "退场");
    await userEvent.type(
      within(dialog).getByLabelText("这一阶段回答什么问题"),
      "什么时候该停掉",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "创建" }));
    await waitFor(() => {
      expect(within(detail()).getByText("L6")).toBeInTheDocument();
    });

    // 新阶段排在最后，它的「加产出物」按钮也是最后一个
    const addButtons = within(detail()).getAllByRole("button", {
      name: "加产出物",
    });
    const lastAdd = addButtons.at(-1);
    if (!lastAdd) throw new Error("没有「加产出物」按钮");
    await userEvent.click(lastAdd);
    dialog = await screen.findByRole("dialog");
    await userEvent.type(
      within(dialog).getByLabelText("产出物名称"),
      "退场决策记录",
    );
    await userEvent.type(
      within(dialog).getByLabelText("判定要点（一行一条）"),
      "为什么停\n存量客户怎么办",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "创建" }));

    const artifact = await within(detail()).findByRole("button", {
      name: /^退场决策记录/,
    });
    expect(artifact).toHaveTextContent("2 条判定要点");
    await userEvent.click(artifact);
    expect(screen.getByText("为什么停")).toBeInTheDocument();
    expect(screen.getByText("存量客户怎么办")).toBeInTheDocument();
  });

  it("上移 / 下移阶段；第一个的上移是禁用的", async () => {
    renderPage();
    await within(detail()).findByText("L0.1");
    expect(
      within(detail()).getByRole("button", { name: "上移阶段 想法卡" }),
    ).toBeDisabled();

    await userEvent.click(
      within(detail()).getByRole("button", { name: "下移阶段 想法卡" }),
    );
    await waitFor(() => {
      const codes = within(detail())
        .getAllByText(/^L[0-9.]+$/)
        .map((e) => e.textContent);
      expect(codes.slice(0, 2)).toEqual(["L0.2", "L0.1"]);
    });
  });

  it("出厂模板改坏了能恢复；自建模板没有「恢复出厂」按钮", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await within(detail()).findByText("L0.1");

    await userEvent.click(
      within(detail()).getByRole("button", { name: "删除阶段 想法卡" }),
    );
    await waitFor(() => {
      expect(within(detail()).queryByText("L0.1")).not.toBeInTheDocument();
    });

    await userEvent.click(
      within(detail()).getByRole("button", { name: /恢复出厂/ }),
    );
    await waitFor(() => {
      expect(within(detail()).getByText("L0.1")).toBeInTheDocument();
    });
    confirm.mockRestore();
  });

  it("复制模板：带「副本」后缀、连阶段带产出物，且不是出厂模板", async () => {
    renderPage();
    await within(detail()).findByText("L0.1");
    await userEvent.click(
      within(detail()).getByRole("button", { name: /复制/ }),
    );
    await waitFor(() => {
      expect(
        within(detail()).getByRole("heading", {
          name: "标准 SaaS Web 产品 副本",
        }),
      ).toBeInTheDocument();
    });
    // 复制出来的被选中，阶段都在，但没有「恢复出厂」
    expect(within(detail()).getByText("L5.2")).toBeInTheDocument();
    expect(
      within(detail()).queryByRole("button", { name: /恢复出厂/ }),
    ).not.toBeInTheDocument();
  });
});
