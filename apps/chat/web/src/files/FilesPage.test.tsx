import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
import { StrictMode, useState } from "react";

import { createApp } from "../../../server/app";
import { IN_MEMORY, openDb, type Db } from "../../../server/db";
import { createFileStore, openFilesIndex } from "../../../server/files/store";
import { createKeyStore } from "../../../server/model-config";
import { piPaths } from "../../../server/pi/runtime";
import { createSkillStore } from "../../../server/skills";
import { EditorView } from "@codemirror/view";

import { FilesPage } from "./FilesPage";
import { FILES_HOME, type FilesLocation } from "./location";

/**
 * 前端测试直接打真服务端（createApp + 真实临时目录上的文件存储），不写假后端：
 * 重名、改名、删除保护、版本冲突这些行为以服务端为准。
 */
let dir: string;
let root: string;
let db: Db;
let index: Db;
let server: ReturnType<typeof createApp>["app"];

/** 浏览器的请求体（字符串 / Blob / File）转成 inject 能吃的 Buffer。 */
async function bodyOf(
  body: BodyInit | null | undefined,
): Promise<Buffer | string | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Blob) {
    const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error("读取失败"));
      reader.readAsArrayBuffer(body);
    });
    return Buffer.from(buf);
  }
  throw new Error("测试桥不支持这种请求体");
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-files-web-")));
  root = join(dir, "files");
  mkdirSync(root);
  db = openDb(IN_MEMORY);
  index = openFilesIndex();
  ({ app: server } = createApp({
    auth: false,
    db,
    paths: piPaths(dir),
    keys: createKeyStore(dir, {}),
    skills: createSkillStore({
      dir: join(dir, "skills"),
      targetDirs: {
        pi: join(dir, "t", "pi"),
      },
    }),
    files: createFileStore(root, index),
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
      const payload = await bodyOf(init?.body);
      const res = await server.inject({
        method: (init?.method ?? "GET") as "GET",
        url,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        ...(payload === undefined ? {} : { payload }),
      });
      // 响应头原样转发（打包下载要读 Content-Disposition 里的文件名）。
      const headers = new Headers();
      for (const [key, value] of Object.entries(res.headers)) {
        if (typeof value === "string") headers.set(key, value);
      }
      return new Response(
        res.statusCode === 204 ? null : new Uint8Array(res.rawPayload),
        { status: res.statusCode, headers },
      );
    }),
  );
});
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await server.close();
  db.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

function Harness({
  initial = FILES_HOME,
  hide,
}: {
  initial?: FilesLocation;
  hide?: readonly string[];
}): React.JSX.Element {
  const [location, setLocation] = useState(initial);
  return (
    <FilesPage
      location={location}
      onLocation={setLocation}
      {...(hide === undefined ? {} : { hide })}
    />
  );
}
function renderPage(initial?: FilesLocation, hide?: readonly string[]): void {
  render(
    <StrictMode>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <Harness
          {...(initial === undefined ? {} : { initial })}
          {...(hide === undefined ? {} : { hide })}
        />
      </QueryClientProvider>
    </StrictMode>,
  );
}

const table = () => screen.getByRole("table", { name: "文件" });
const rowNames = () =>
  within(table())
    .getAllByRole("row")
    .slice(1)
    .map((r) => r.querySelector(".files-name span")?.textContent);
const dialog = () => screen.getByRole("dialog");
/**
 * 在 CodeMirror 编辑器里输入。jsdom 不实现 contenteditable 的输入事件，userEvent.type
 * 打不进去；用编辑器自己的 API 插入文本（与用户输入走同一条 updateListener）。
 */
async function typeInEditor(text: string): Promise<void> {
  const content = await screen.findByLabelText("编辑内容");
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("没找到编辑器");
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  view.focus();
}
async function fillName(value: string, submit: RegExp | string): Promise<void> {
  const input = within(dialog()).getByLabelText("名称");
  await userEvent.clear(input);
  await userEvent.type(input, value);
  await userEvent.click(within(dialog()).getByRole("button", { name: submit }));
}

describe("文件夹与列表", () => {
  it("空目录提示；新建文件夹后出现在列表与左侧树；点进去再从面包屑回来", async () => {
    renderPage();
    expect(
      await screen.findByText("这个文件夹是空的，上传或新建一个吧"),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /新建文件夹/ }));
    await fillName("PRD", "创建");
    await waitFor(() => {
      expect(rowNames()).toEqual(["PRD"]);
    });
    expect(existsSync(join(root, "PRD"))).toBe(true);
    expect(
      within(screen.getByRole("tree", { name: "文件夹" })).getByRole("button", {
        name: "PRD",
      }),
    ).toBeInTheDocument();

    await userEvent.click(within(table()).getByRole("button", { name: "PRD" }));
    expect(
      await screen.findByText("这个文件夹是空的，上传或新建一个吧"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "当前位置" })).getByText(
        "PRD",
      ),
    ).toBeInTheDocument();
    await userEvent.click(
      within(screen.getByRole("navigation", { name: "当前位置" })).getByRole(
        "button",
        { name: "文件" },
      ),
    );
    expect(
      await within(table()).findByRole("button", { name: "PRD" }),
    ).toBeInTheDocument();
  });

  it("重名：错误显示在对话框里，对话框不关", async () => {
    mkdirSync(join(root, "PRD"));
    renderPage();
    await screen.findByRole("table", { name: "文件" });
    await userEvent.click(screen.getByRole("button", { name: /新建文件夹/ }));
    await fillName("PRD", "创建");
    expect(await within(dialog()).findByRole("alert")).toHaveTextContent(
      "已有同名的文件或文件夹「PRD」",
    );
  });

  it("文件夹在前、按名称排序，显示大小与类型图标", async () => {
    mkdirSync(join(root, "素材"));
    mkdirSync(join(root, "PRD"));
    writeFileSync(join(root, "说明.md"), "# 说明");
    writeFileSync(join(root, "a.txt"), "x".repeat(2048));
    renderPage();
    await screen.findByRole("table", { name: "文件" });
    expect(rowNames()).toEqual(["PRD", "素材", "a.txt", "说明.md"]);
    expect(within(table()).getByText("2.0 KB")).toBeInTheDocument();
  });
});

describe("新建与编辑", () => {
  it("新建 Markdown：不写扩展名自动补 .md，直接进编辑；Ctrl/⌘+S 保存落盘，预览渲染", async () => {
    renderPage();
    await screen.findByText("这个文件夹是空的，上传或新建一个吧");
    await userEvent.click(
      screen.getByRole("button", { name: /新建 Markdown/ }),
    );
    await fillName("周会纪要", "创建并编辑");
    await typeInEditor("# 本周进展\n- 完成文件模块");
    await userEvent.keyboard("{Control>}s{/Control}");
    expect(await screen.findByRole("status")).toHaveTextContent("已保存");
    expect(readFileSync(join(root, "周会纪要.md"), "utf8")).toBe(
      "# 本周进展\n- 完成文件模块",
    );

    await userEvent.click(screen.getByRole("button", { name: /预览/ }));
    expect(
      screen.getByRole("heading", { name: "本周进展" }),
    ).toBeInTheDocument();
  });

  it("打开后文件在别处被改过：保存被拒并说明原因，磁盘内容不被覆盖", async () => {
    writeFileSync(join(root, "doc.md"), "v1");
    renderPage({ folder: "/", file: "/doc.md" });
    await userEvent.click(await screen.findByRole("button", { name: /编辑/ }));
    writeFileSync(join(root, "doc.md"), "别处改过的 v2");
    await typeInEditor("我的修改");
    await userEvent.click(screen.getByRole("button", { name: /保存/ }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "文件在你打开之后被修改过，请重新打开后再保存",
    );
    expect(readFileSync(join(root, "doc.md"), "utf8")).toBe("别处改过的 v2");
  });

  it("有未保存的修改时点「返回」要确认；取消则留在编辑器", async () => {
    writeFileSync(join(root, "doc.md"), "v1");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage({ folder: "/", file: "/doc.md" });
    await userEvent.click(await screen.findByRole("button", { name: /编辑/ }));
    await typeInEditor("改了");
    await userEvent.click(screen.getByRole("button", { name: /返回/ }));
    expect(confirm).toHaveBeenCalledWith("有未保存的修改，放弃吗？");
    expect(screen.getByLabelText("编辑内容")).toBeInTheDocument();
  });
});

describe("上传", () => {
  it("上传多个文件；同名不覆盖，自动改名并在提示里说明", async () => {
    writeFileSync(join(root, "需求.md"), "旧的");
    renderPage();
    await screen.findByRole("table", { name: "文件" });
    await userEvent.upload(screen.getByLabelText("选择要上传的文件"), [
      new File(["# 新的"], "需求.md", { type: "text/markdown" }),
      new File(["hello"], "说明.txt", { type: "text/plain" }),
    ]);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "已上传 2 个文件；同名已自动改名：需求.md → 需求 (1).md",
    );
    expect(readFileSync(join(root, "需求.md"), "utf8")).toBe("旧的");
    expect(readFileSync(join(root, "需求 (1).md"), "utf8")).toBe("# 新的");
    await waitFor(() => {
      expect(rowNames()).toEqual(["说明.txt", "需求 (1).md", "需求.md"]);
    });
  });
});

describe("查看器", () => {
  it("Markdown 默认渲染，可切源码；文本带行号", async () => {
    writeFileSync(join(root, "a.md"), "# 标题\n\n正文");
    writeFileSync(join(root, "b.py"), "print(1)\nprint(2)\n");
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "a.md" }));
    expect(
      await screen.findByRole("heading", { name: "标题" }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /源码/ }));
    expect(await screen.findByLabelText("源码")).toHaveTextContent("# 标题");

    await userEvent.click(screen.getByRole("button", { name: /返回/ }));
    await userEvent.click(await screen.findByRole("button", { name: "b.py" }));
    expect(await screen.findByText("3 行")).toBeInTheDocument();
  });

  it("HTML 在无同源权限的 sandbox iframe 里预览", async () => {
    writeFileSync(
      join(root, "页面.html"),
      "<h1>hi</h1><script>parent.document.title='x'</script>",
    );
    renderPage({ folder: "/", file: "/页面.html" });
    const frame = await screen.findByTitle("页面.html");
    expect(frame.tagName).toBe("IFRAME");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>hi</h1>");
  });

  it("图片与 PDF 走原始内容地址；不支持的格式给下载", async () => {
    writeFileSync(
      join(root, "图.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]),
    );
    writeFileSync(join(root, "方案.docx"), Buffer.from("PK\u0003\u0004"));
    renderPage({ folder: "/", file: "/图.png" });
    const img = await screen.findByRole("img", { name: "图.png" });
    expect(img.getAttribute("src")).toMatch(
      /^\/api\/files\/raw\/%E5%9B%BE\.png\?path=%2F%E5%9B%BE\.png&v=/,
    );
    await userEvent.click(screen.getByRole("button", { name: /返回/ }));
    await userEvent.click(
      await screen.findByRole("button", { name: "方案.docx" }),
    );
    expect(
      await screen.findByText("暂不支持在线预览这种格式。"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /下载查看/ }).getAttribute("href"),
    ).toContain("download=1");
  });
});

describe("改名 / 移动 / 删除 / 搜索", () => {
  it("改名：只选中主文件名；落盘生效", async () => {
    writeFileSync(join(root, "旧名.md"), "x");
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "重命名 旧名.md" }),
    );
    const input = within(dialog()).getByLabelText<HTMLInputElement>("名称");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 2]);
    await fillName("新名.md", "保存");
    await waitFor(() => {
      expect(rowNames()).toEqual(["新名.md"]);
    });
    expect(existsSync(join(root, "新名.md"))).toBe(true);
  });

  it("移动到…：在文件夹树里选目标", async () => {
    mkdirSync(join(root, "归档"));
    writeFileSync(join(root, "x.md"), "x");
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "移动 x.md" }),
    );
    await userEvent.click(
      await within(screen.getByRole("tree", { name: "目标文件夹" })).findByRole(
        "button",
        { name: "归档" },
      ),
    );
    await userEvent.click(
      within(dialog()).getByRole("button", { name: "移动到这里" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "已移动到「归档」",
    );
    expect(existsSync(join(root, "归档", "x.md"))).toBe(true);
  });

  it("删除非空文件夹：先说明里面有什么，再确认一次才连同内容删除", async () => {
    mkdirSync(join(root, "A", "B"), { recursive: true });
    writeFileSync(join(root, "A", "B", "x.md"), "x");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "删除 A" }),
    );
    await waitFor(() => {
      expect(existsSync(join(root, "A"))).toBe(false);
    });
    expect(confirm.mock.calls.map((c) => c[0])).toEqual([
      "删除「A」？",
      "文件夹「A」里还有 1 个文件夹、1 个文件，连同里面的内容一起删除？",
    ]);
  });

  it("搜索全部文件夹，结果带位置，点开进入查看器", async () => {
    mkdirSync(join(root, "PRD", "2026"), { recursive: true });
    writeFileSync(join(root, "PRD", "2026", "文件模块需求.md"), "# 文件模块");
    writeFileSync(join(root, "其他.md"), "x");
    // 让索引知道深层文件（正式环境里服务启动时会重建一次）
    await server.inject({ method: "POST", url: "/api/files/reindex" });
    renderPage();
    await screen.findByRole("table", { name: "文件" });
    await userEvent.type(screen.getByLabelText("搜索文件"), "文件模块");
    const results = await screen.findByRole("table", { name: "搜索结果" });
    expect(within(results).getByText("/PRD/2026")).toBeInTheDocument();
    await userEvent.click(
      within(results).getByRole("button", { name: "文件模块需求.md" }),
    );
    expect(
      await screen.findByRole("heading", { name: "文件模块" }),
    ).toBeInTheDocument();
  });
});

describe("代码编辑器", () => {
  it("源码以只读的高亮编辑器显示（带行号）；点编辑后可编辑", async () => {
    writeFileSync(join(root, "hello.py"), "def hello():\n    return 1\n");
    renderPage({ folder: "/", file: "/hello.py" });
    const source = await screen.findByLabelText("源码");
    expect(source.getAttribute("contenteditable")).toBe("false");
    expect(
      source.closest(".cm-editor")?.querySelector(".cm-lineNumbers"),
    ).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /编辑/ }));
    expect(
      (await screen.findByLabelText("编辑内容")).getAttribute(
        "contenteditable",
      ),
    ).toBe("true");
  });
});

describe("多选与批量", () => {
  it("勾选两项 → 批量移动到别的文件夹", async () => {
    mkdirSync(join(root, "归档"));
    writeFileSync(join(root, "a.md"), "a");
    writeFileSync(join(root, "b.md"), "b");
    writeFileSync(join(root, "c.md"), "c");
    renderPage();
    await userEvent.click(await screen.findByLabelText("选择 a.md"));
    await userEvent.click(screen.getByLabelText("选择 b.md"));
    const bar = screen.getByRole("toolbar", { name: "批量操作" });
    expect(bar).toHaveTextContent("已选 2 项");
    await userEvent.click(within(bar).getByRole("button", { name: /移动到/ }));
    expect(within(dialog()).getByRole("heading")).toHaveTextContent(
      "把选中的 2 项移动到…",
    );
    await userEvent.click(
      await within(screen.getByRole("tree", { name: "目标文件夹" })).findByRole(
        "button",
        { name: "归档" },
      ),
    );
    await userEvent.click(
      within(dialog()).getByRole("button", { name: "移动到这里" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "已移动到「归档」 2 项",
    );
    expect(readdirSync(join(root, "归档")).sort()).toEqual(["a.md", "b.md"]);
    expect(
      screen.queryByRole("toolbar", { name: "批量操作" }),
    ).not.toBeInTheDocument();
  });

  it("Shift 点选一段；全选；批量删除前说明文件夹会连同内容删除", async () => {
    mkdirSync(join(root, "A"));
    writeFileSync(join(root, "A", "x.md"), "x");
    for (const n of ["1.md", "2.md", "3.md"]) writeFileSync(join(root, n), n);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    // 同一个 user 实例才共享「Shift 按住」的键盘状态。
    const user = userEvent.setup();
    await user.click(await screen.findByLabelText("选择 1.md"));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByLabelText("选择 3.md"));
    await user.keyboard("{/Shift}");
    expect(screen.getByRole("toolbar", { name: "批量操作" })).toHaveTextContent(
      "已选 3 项",
    );

    await userEvent.click(screen.getByLabelText("全选"));
    expect(screen.getByRole("toolbar", { name: "批量操作" })).toHaveTextContent(
      "已选 4 项",
    );
    await userEvent.click(
      within(screen.getByRole("toolbar", { name: "批量操作" })).getByRole(
        "button",
        { name: /删除/ },
      ),
    );
    expect(confirm).toHaveBeenCalledWith(
      "删除选中的 4 项？其中 1 个文件夹会连同里面的内容一起删除。",
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("已删除 4 项");
    expect(readdirSync(root)).toEqual([]);
  });

  it("批量下载：打成一个 zip，用响应里的中文文件名保存", async () => {
    writeFileSync(join(root, "a.md"), "a");
    writeFileSync(join(root, "b.md"), "b");
    const created = vi.fn<(blob: Blob) => string>(() => "blob:mock");
    vi.stubGlobal(
      "URL",
      Object.assign(URL, {
        createObjectURL: created,
        revokeObjectURL: vi.fn(),
      }),
    );
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this.download);
    });
    renderPage();
    await userEvent.click(await screen.findByLabelText("全选"));
    await userEvent.click(
      within(screen.getByRole("toolbar", { name: "批量操作" })).getByRole(
        "button",
        { name: /下载/ },
      ),
    );
    await waitFor(() => {
      expect(clicked).toEqual(["文件（2 项）.zip"]);
    });
    const blob = created.mock.calls[0]?.[0];
    expect(blob?.size).toBeGreaterThan(0);
  });

  it("单项复制到当前文件夹：自动改名，并在提示里说明", async () => {
    writeFileSync(join(root, "a.md"), "a");
    renderPage();
    await userEvent.click(
      await screen.findByRole("button", { name: "复制 a.md" }),
    );
    // 复制到原处是合法的：按钮不置灰
    await userEvent.click(
      within(dialog()).getByRole("button", { name: "复制到这里" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "已复制到「文件」（同名已改为「a (1).md」）",
    );
    expect(readFileSync(join(root, "a (1).md"), "utf8")).toBe("a");
  });
});

describe("上传文件夹", () => {
  it("保留目录结构；顶层同名文件夹整个改名；隐藏文件跳过", async () => {
    mkdirSync(join(root, "项目资料"));
    const withPath = (content: string, name: string, rel: string) => {
      const f = new File([content], name);
      Object.defineProperty(f, "webkitRelativePath", { value: rel });
      return f;
    };
    renderPage();
    await screen.findByRole("table", { name: "文件" });
    await userEvent.upload(screen.getByLabelText("选择要上传的文件夹"), [
      withPath("# a", "a.md", "项目资料/设计/a.md"),
      withPath("b", "b.txt", "项目资料/b.txt"),
      withPath("x", ".DS_Store", "项目资料/.DS_Store"),
    ]);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "已上传 2 个文件；同名文件夹已改名：项目资料 → 项目资料 (1)；跳过 1 个隐藏文件",
    );
    expect(
      readFileSync(join(root, "项目资料 (1)", "设计", "a.md"), "utf8"),
    ).toBe("# a");
    expect(readdirSync(join(root, "项目资料"))).toEqual([]);
  });
});

describe("按内容搜索", () => {
  it("内容命中的结果带「内容」标记与上下文片段", async () => {
    writeFileSync(join(root, "周会.md"), "第一项：讨论季度复盘的时间安排");
    await server.inject({ method: "POST", url: "/api/files/reindex" });
    renderPage();
    await screen.findByRole("table", { name: "文件" });
    await userEvent.type(screen.getByLabelText("搜索文件"), "季度复盘");
    const results = await screen.findByRole("table", { name: "搜索结果" });
    expect(within(results).getByText("内容")).toBeInTheDocument();
    expect(
      within(results).getByText("第一项：讨论季度复盘的时间安排"),
    ).toBeInTheDocument();
  });
});

describe("大文件失败后重试", () => {
  /** 换一个上传上限不同的服务端（fetch 桥每次调用时读 server，换掉即生效）。 */
  async function restartWith(uploadLimit?: number): Promise<void> {
    await server.close();
    ({ app: server } = createApp({
      auth: false,
      db,
      paths: piPaths(dir),
      keys: createKeyStore(dir, {}),
      skills: createSkillStore({
        dir: join(dir, "skills"),
        targetDirs: {
          pi: join(dir, "t", "pi"),
        },
      }),
      files: createFileStore(
        root,
        index,
        uploadLimit === undefined ? {} : { uploadLimit },
      ),
      security: false,
    }));
  }

  it("超过上限的文件失败并说明原因；放宽上限后「重试失败的」原样补传到同一个文件夹", async () => {
    await restartWith(1024 * 1024);
    const withPath = (content: BlobPart, name: string, rel: string) => {
      const f = new File([content], name);
      Object.defineProperty(f, "webkitRelativePath", { value: rel });
      return f;
    };
    renderPage();
    await screen.findByText("这个文件夹是空的，上传或新建一个吧");
    await userEvent.upload(screen.getByLabelText("选择要上传的文件夹"), [
      withPath("小", "说明.md", "项目/说明.md"),
      withPath(
        new Uint8Array(1.5 * 1024 * 1024),
        "录屏.mp4",
        "项目/视频/录屏.mp4",
      ),
    ]);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "已上传 1 个文件；失败 1 个：项目/视频/录屏.mp4（文件超过 1 MB 上限）",
    );

    await restartWith(); // 相当于调大 PMFORGE_CHAT_FILE_LIMIT_MB 后重启
    await userEvent.click(
      within(alert).getByRole("button", { name: "重试失败的 1 个" }),
    );
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("已上传 1 个文件");
    });
    expect(
      screen.queryByRole("button", { name: /重试失败的/ }),
    ).not.toBeInTheDocument();
    // 补传到原来那个「项目」里，而不是再建一个「项目 (1)」
    expect(readdirSync(root)).toEqual(["项目"]);
    expect(readFileSync(join(root, "项目", "视频", "录屏.mp4")).length).toBe(
      1.5 * 1024 * 1024,
    );
  });
});

describe("文件库藏起代码库", () => {
  it("列表与树上都看不到 /代码库；记住的位置落在里面时退回根", async () => {
    mkdirSync(join(root, "product-docs"));
    mkdirSync(join(root, "代码库", "router"), { recursive: true });
    writeFileSync(join(root, "代码库", "router", "a.ts"), "x");
    renderPage({ folder: "/代码库/router", file: null }, ["/代码库"]);
    const list = await screen.findByRole("region", { name: "文件列表区" });
    expect(await within(list).findByText("product-docs")).toBeInTheDocument();
    expect(within(list).queryByText("代码库")).not.toBeInTheDocument();
    expect(within(list).queryByText("a.ts")).not.toBeInTheDocument();
    const tree = screen.getByRole("tree", { name: "文件夹" });
    await within(tree).findByText("product-docs");
    expect(within(tree).queryByText("代码库")).not.toBeInTheDocument();
  });
});
