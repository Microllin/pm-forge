import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SkillsPage } from "./SkillsPage";

/**
 * 技能页（列表 + 展览）。断言落在「发给服务端的请求」与「人看到什么」上，
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

const SUMMARY = {
  name: "write-prd",
  description: "写 PRD 时用。",
  hidden: false,
  promptBytes: 1024,
  fileCount: 2,
  updatedAt: 0,
  distribution: { pi: "linked" },
};
const OTHER = {
  name: "verify-feature",
  description: "验收功能时用。",
  hidden: true,
  promptBytes: 0,
  fileCount: 1,
  updatedAt: 0,
  distribution: { pi: "absent" },
};
const DETAIL = {
  ...SUMMARY,
  content:
    "---\nname: write-prd\ndescription: 写 PRD 时用。\n---\n\n## 第一步\n\n先确认立项四问。\n",
  files: ["SKILL.md", "references/checklist.md"],
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function setup(options: { createStatus?: number; skills?: unknown[] } = {}) {
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
      if (url.endsWith("/api/skills") && method === "GET") {
        return Promise.resolve(
          json({
            skills: options.skills ?? [SUMMARY, OTHER],
            promptBytes: 15_258,
          }),
        );
      }
      if (url.endsWith("/api/skills") && method === "POST") {
        if (options.createStatus !== undefined) {
          return Promise.resolve(
            json(
              {
                error: {
                  code: "BAD_REQUEST",
                  message: "SKILL.md 的 frontmatter 缺 description。",
                },
              },
              options.createStatus,
            ),
          );
        }
        return Promise.resolve(json(DETAIL, 201));
      }
      if (url.endsWith("/api/skills/tree")) {
        const files = (init?.body as string | undefined) ?? "";
        // 回一个名字跟着请求走的技能，便于断言「哪几个被导入了」。
        const name = files.includes("verify") ? "verify-feature" : "write-prd";
        return Promise.resolve(json({ ...DETAIL, name }, 201));
      }
      if (url.includes("/file?path=")) {
        return Promise.resolve(
          json({
            path: "references/checklist.md",
            text: "# 清单\n- 附属文件里的这一行",
            bytes: 20,
          }),
        );
      }
      if (url.includes("/visibility")) {
        const raw = typeof init?.body === "string" ? init.body : "{}";
        const body = JSON.parse(raw) as { hidden: boolean };
        return Promise.resolve(json({ ...DETAIL, hidden: body.hidden }));
      }
      if (url.includes("/distribution")) return Promise.resolve(json(DETAIL));
      if (url.includes("/api/skills/write-prd"))
        return Promise.resolve(json(DETAIL));
      if (url.includes("/api/skills/verify-feature")) {
        return Promise.resolve(
          json({ ...DETAIL, ...OTHER, files: ["SKILL.md"] }),
        );
      }
      return Promise.resolve(json({}, 404));
    }),
  );
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SkillsPage />
    </QueryClientProvider>,
  );
  return calls;
}

/** 造一个带 webkitRelativePath 的 File（文件夹选择器给的就是这个形状）。 */
function folderFile(relPath: string, content = "x"): File {
  const file = new File([content], relPath.split("/").at(-1) ?? "f");
  Object.defineProperty(file, "webkitRelativePath", { value: relPath });
  return file;
}

const md = (name: string) =>
  `---\nname: ${name}\ndescription: 测试用。\n---\n\n正文\n`;

describe("技能列表", () => {
  it("列出技能，元信息压到一行：文件数只给数字、已分发只给一个点", async () => {
    setup();
    expect(await screen.findByText("write-prd")).toBeInTheDocument();
    expect(screen.getByText("验收功能时用。")).toBeInTheDocument();
    // 27 行里重复 54 个文字标签是噪音，细节交给 title。
    expect(screen.getByTitle("2 个文件")).toBeInTheDocument();
    expect(
      screen.getByTitle("已分发到 pi（~/.pi/agent/skills）"),
    ).toBeInTheDocument();
  });

  it("搜索按名称或描述过滤；没命中时说清是谁没命中", async () => {
    setup();
    await screen.findByText("write-prd");
    const box = screen.getByLabelText("搜索技能");
    await userEvent.type(box, "验收");
    expect(screen.queryByText("write-prd")).not.toBeInTheDocument();
    expect(screen.getByText("verify-feature")).toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, "不存在的东西");
    expect(
      screen.getByText(/没有匹配「不存在的东西」的技能/),
    ).toBeInTheDocument();
  });

  it("空态说清这里是什么、该做什么", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(json({ skills: [], promptBytes: 0 }))),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <SkillsPage />
      </QueryClientProvider>,
    );
    expect(await screen.findByText(/还没有技能/)).toBeInTheDocument();
  });
});

describe("展览（详情）", () => {
  it("点开一个技能：默认看渲染后的正文，不是源码框", async () => {
    setup();
    await userEvent.click(await screen.findByText("write-prd"));
    // Markdown 渲染出了标题结构，而不是把 ## 原样显示。
    expect(
      await screen.findByRole("heading", { name: "第一步" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("SKILL.md 内容")).not.toBeInTheDocument();
    expect(screen.queryByText("## 第一步")).not.toBeInTheDocument();
  });

  it("附属文件默认收起（49 个的技能会把正文挤没），展开后可点开看内容", async () => {
    const calls = setup();
    await userEvent.click(await screen.findByText("write-prd"));
    // 收起时清单不可见，只报数量。
    expect(await screen.findByText(/附属文件（1）/)).toBeInTheDocument();
    // hidden 的 <ul> 里的按钮在无障碍树里直接不存在，这正是我们要的。
    expect(
      screen.queryByRole("button", { name: /references\/checklist\.md/ }),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "展开附属文件清单" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: /references\/checklist\.md/ }),
    );
    expect(await screen.findByText(/附属文件里的这一行/)).toBeInTheDocument();
    expect(
      calls.some((c) => c.url.includes("/file?path=references%2Fchecklist.md")),
    ).toBe(true);
  });

  it("分发开关在详情里：只有 pi 一个目标，已分发时点「撤销分发」提交空集合", async () => {
    const calls = setup();
    await userEvent.click(await screen.findByText("write-prd"));
    expect(screen.queryByText(/Claude/)).not.toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole("button", { name: "撤销分发" }),
    );
    await waitFor(() => {
      const put = calls.find((c) => c.url.includes("/distribution"));
      expect(put?.body).toEqual({ targets: [] });
    });
  });

  it("点「编辑」才切到源码，保存走 PUT", async () => {
    const calls = setup();
    await userEvent.click(await screen.findByText("write-prd"));
    await userEvent.click(await screen.findByRole("button", { name: /编辑/ }));
    const editor = screen.getByLabelText<HTMLTextAreaElement>("SKILL.md 内容");
    expect(editor.value).toContain("name: write-prd");
    await userEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => {
      expect(
        calls.some(
          (c) => c.method === "PUT" && c.url.endsWith("/api/skills/write-prd"),
        ),
      ).toBe(true);
    });
  });
});

describe("提示词成本", () => {
  it("页头报「对模型可见几个、每轮占多少 KB、已隐藏几个」", async () => {
    setup();
    expect(
      await screen.findByText(
        /对模型可见 1 个，每轮占提示词 14\.9 KB；已隐藏 1 个/,
      ),
    ).toBeInTheDocument();
  });

  it("详情报这个技能自己占多少；隐藏的那个说「不占」", async () => {
    setup();
    await userEvent.click(await screen.findByText("write-prd"));
    expect(
      await screen.findByText(/在每轮系统提示词里占 1\.0 KB/),
    ).toBeInTheDocument();
  });
});

describe("对模型隐藏", () => {
  it("列表里标出被隐藏的技能", async () => {
    setup();
    await screen.findByText("verify-feature");
    expect(screen.getByLabelText("对模型隐藏")).toBeInTheDocument();
  });

  it("详情里一键隐藏：PUT visibility，并解释它仍可点名用", async () => {
    const calls = setup();
    await userEvent.click(await screen.findByText("write-prd"));
    // 列表行里那个「对模型隐藏」是图标标记，不是按钮；这里要的是详情里的开关。
    const toggle = await screen.findByRole("button", { name: "对模型隐藏" });
    expect(toggle.getAttribute("title")).toMatch(/仍可点名用/);
    await userEvent.click(toggle);
    await waitFor(() => {
      const put = calls.find((c) => c.url.includes("/visibility"));
      expect(put?.body).toEqual({ hidden: true });
    });
  });
});

describe("列表排序", () => {
  it("可按文件数排，不再只能按字母（27 个时常用的会被压到后面）", async () => {
    setup();
    await screen.findByText("write-prd");
    const names = () =>
      screen
        .getAllByText(/^(write-prd|verify-feature)$/)
        .map((n) => n.textContent);
    expect(names()).toEqual(["verify-feature", "write-prd"]); // 名称序
    await userEvent.click(screen.getByRole("button", { name: "文件数" }));
    expect(names()).toEqual(["write-prd", "verify-feature"]); // 2 个文件的排前面
  });
});

describe("删除", () => {
  it("内联确认条，不用浏览器弹窗", async () => {
    const calls = setup();
    const confirmSpy = vi.fn();
    vi.stubGlobal("confirm", confirmSpy);
    await userEvent.click(await screen.findByText("write-prd"));
    await userEvent.click(await screen.findByRole("button", { name: /删除/ }));
    expect(screen.getByText(/目录与软链都会删掉/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => {
      expect(
        calls.some(
          (c) =>
            c.method === "DELETE" && c.url.endsWith("/api/skills/write-prd"),
        ),
      ).toBe(true);
    });
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});

describe("导入", () => {
  it("新建预填骨架，保存时把全文 POST 上去", async () => {
    const calls = setup();
    await userEvent.click(await screen.findByRole("button", { name: "新建" }));
    const editor = screen.getByLabelText<HTMLTextAreaElement>("SKILL.md 内容");
    expect(editor.value).toContain("description:");
    await userEvent.click(screen.getByRole("button", { name: /保存/ }));
    await waitFor(() => {
      const post = calls.find(
        (c) => c.method === "POST" && c.url.endsWith("/api/skills"),
      );
      expect((post?.body as { content: string }).content).toContain("name:");
    });
  });

  it("服务端拒了就显示它的原话，不自己编一套校验", async () => {
    setup({ createStatus: 400 });
    await userEvent.click(await screen.findByRole("button", { name: "新建" }));
    await userEvent.click(screen.getByRole("button", { name: /保存/ }));
    expect(await screen.findByText(/缺 description/)).toBeInTheDocument();
  });

  it("文件夹自带 SKILL.md：当成一个技能导入", async () => {
    const calls = setup();
    await screen.findByText("write-prd");
    fireEvent.change(screen.getByLabelText("导入技能文件夹"), {
      target: {
        files: [
          folderFile("write-prd/SKILL.md", md("write-prd")),
          folderFile("write-prd/references/checklist.md", "# 清单"),
        ],
      },
    });
    await waitFor(() => {
      const trees = calls.filter((c) => c.url.endsWith("/api/skills/tree"));
      expect(trees).toHaveLength(1);
      const files = (trees[0]?.body as { files: { path: string }[] }).files;
      // 路径已相对技能根，所选目录名被剥掉。
      expect(files.map((f) => f.path).sort()).toEqual([
        "SKILL.md",
        "references/checklist.md",
      ]);
    });
    expect(await screen.findByText(/已导入 1 个技能/)).toBeInTheDocument();
  });

  it("选的是技能库根目录：每个含 SKILL.md 的子目录各导一个，逐个报结果", async () => {
    const calls = setup();
    await screen.findByText("write-prd");
    fireEvent.change(screen.getByLabelText("导入技能文件夹"), {
      target: {
        files: [
          folderFile("skills/write-prd/SKILL.md", md("write-prd")),
          folderFile("skills/verify-feature/SKILL.md", md("verify-feature")),
          folderFile("skills/README.md", "# 不是技能"),
          folderFile("skills/.DS_Store", "junk"),
        ],
      },
    });
    await waitFor(() => {
      expect(
        calls.filter((c) => c.url.endsWith("/api/skills/tree")),
      ).toHaveLength(2);
    });
    expect(await screen.findByText(/已导入 2 个技能/)).toBeInTheDocument();
  });

  it("文件夹里没有 SKILL.md：不报「成功 0 个」，而是说清该选哪一层", async () => {
    setup();
    await screen.findByText("write-prd");
    fireEvent.change(screen.getByLabelText("导入技能文件夹"), {
      target: { files: [folderFile("notes/随手记.md", "# 笔记")] },
    });
    expect(await screen.findByText(/没有 SKILL\.md/)).toBeInTheDocument();
  });
});
