import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { IN_MEMORY, openDb, type Db } from "./db.js";
import { createFileStore, openFilesIndex } from "./files/store.js";
import { createKeyStore } from "./model-config.js";
import { piPaths } from "./pi/runtime.js";
import { createSessionStore } from "./sessions.js";
import { createSkillStore } from "./skills.js";
import { BUILTIN_WIKI } from "./wiki-builtin.js";

const PORT = 4400;
const HOST = `127.0.0.1:${String(PORT)}`;

let db: Db;
let dir: string;
let index: Db;
let files: ReturnType<typeof createFileStore>;
let app: ReturnType<typeof createApp>["app"];
let store: ReturnType<typeof createSessionStore>;

/** 事实源：一个文档目录 + 一个代码目录，wiki 两头都要读。 */
function seed(root: string): void {
  const mk = (...p: string[]) =>
    mkdirSync(join(root, ...p), { recursive: true });
  const write = (p: string[], text: string): void => {
    writeFileSync(join(root, ...p), text, "utf8");
  };
  mk("01-products", "alpha", "prd");
  write(["01-products", "alpha", "README.md"], "# Alpha\n一个示例产品。");
  write(["01-products", "alpha", "prd", "需求规格.md"], "# PRD\n正文");
  mk("代码库", "alpha", "server");
  write(["代码库", "alpha", "server", "app.ts"], "export const app = 1;");
  // 精读要用：一个带「表结构」的代码子目录、一份依赖目录、一份凭据文件
  mk("代码库", "alpha", "server", "schema");
  write(
    ["代码库", "alpha", "server", "schema", "user.go"],
    "type User struct { ID int; Email string; Balance int64 }",
  );
  mk("代码库", "alpha", "node_modules", "left-pad");
  write(
    ["代码库", "alpha", "node_modules", "left-pad", "index.js"],
    "module.exports = 'THIRD_PARTY';",
  );
  write(
    ["代码库", "alpha", "server", "config.json"],
    '{"apiKey":"sk-abcdefghijklmnopqrstuvwxyz"}',
  );
  // 参考资料：产品目录之外的手册与能力地图
  mk("docs", "manual");
  write(["docs", "manual", "01-登录.md"], "# 登录\n点右上角「登录」。");
  write(["01-products", "能力地图.md"], "# 能力地图\n24 个能力域。");
  // 别的产品：精读路径越界时不该被读到
  mk("01-products", "beta");
  write(["01-products", "beta", "机密.md"], "BETA_SECRET");
}

beforeEach(() => {
  db = openDb(IN_MEMORY);
  dir = mkdtempSync(join(tmpdir(), "pmforge-wiki-"));
  const filesDir = join(dir, "files");
  mkdirSync(filesDir, { recursive: true });
  seed(filesDir);
  index = openFilesIndex();
  files = createFileStore(filesDir, index);
  store = createSessionStore(db);
  ({ app } = createApp({
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
    files,
    security: { port: PORT, webPort: 3200, extraOrigins: [] },
  }));
});
afterEach(async () => {
  await app.close();
  index.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function call(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url,
    headers: { host: HOST },
    ...(body === undefined ? {} : { payload: body as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    body:
      res.body === ""
        ? undefined
        : (JSON.parse(res.body) as Record<string, unknown>),
  };
}

const errorOf = (r: { body?: Record<string, unknown> | undefined }) =>
  (r.body?.error as { code: string; message: string }).message;

function fakeAnswer(sessionId: string, text: string): void {
  store.append(sessionId, [
    {
      id: `a-${String(store.entries(sessionId).length)}`,
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  ]);
}

interface Page {
  id: string;
  title: string;
  number: string;
  length: number;
  source: string;
  children: Page[];
}

/**
 * `call()` 回的是 `Record<string, unknown>`，直接断言成带 children 的递归类型
 * TS 会判「两边重叠不足」。测试里这是安全的（形状由服务端测试本身保证），
 * 所以统一走一个转换函数，而不是在十几处各写一遍 `as unknown as`。
 */
const asPage = (v: unknown): Page => v as Page;

/** 建一个绑好两个目录的产品。 */
let seq = 0;
async function newProduct(options: { folder?: boolean; code?: boolean } = {}) {
  // 产品线名唯一：同名第二次会 409，而那时 product.id 是 undefined，
  // 测试会以「意外通过」的方式骗过自己（挂载测试第一版就是这么假过的）。
  seq += 1;
  const line = (
    await call("POST", "/api/product-lines", { name: `CR-${String(seq)}` })
  ).body as { id: string };
  const product = (
    await call("POST", `/api/product-lines/${line.id}/products`, {
      name: `Alpha-${String(seq)}`,
      description: "示例产品",
      ...(options.folder === false ? {} : { folderPath: "/01-products/alpha" }),
      ...(options.code === false ? {} : { codePath: "/代码库/alpha" }),
    })
  ).body as { id: string };
  return product.id;
}

const tree = async (productId: string): Promise<Page[]> =>
  (await call("GET", `/api/products/${productId}/wiki`)).body?.pages as Page[];

/* ── 章节树 ───────────────────────────────────────────────────────── */

describe("章节树", () => {
  it("新产品的 wiki 是空的，不预置任何章节", async () => {
    const id = await newProduct();
    expect(await tree(id)).toEqual([]);
  });

  it("恢复出厂目录灌进 13 章，正文都是空的", async () => {
    const id = await newProduct();
    const r = await call("POST", `/api/products/${id}/wiki/reset`);
    expect(r.status).toBe(200);
    const pages = r.body?.pages as Page[];
    expect(pages).toHaveLength(BUILTIN_WIKI.length);
    expect(pages.every((p) => p.length === 0)).toBe(true);
  });

  it("显示编号由位次算出来，不入库——插一章不用改后面全部", async () => {
    const id = await newProduct();
    await call("POST", `/api/products/${id}/wiki/reset`);
    const before = await tree(id);
    expect(before.map((p) => p.number).slice(0, 3)).toEqual(["01", "02", "03"]);
    // 把第 2 章往上挪一位，编号应当跟着位次走，而不是跟着数据走
    const second = before[1];
    expect(second).toBeDefined();
    await call("POST", `/api/wiki-pages/${second?.id ?? ""}/move`, {
      delta: -1,
    });
    const after = await tree(id);
    expect(after[0]?.title).toBe(second?.title);
    expect(after[0]?.number).toBe("01");
  });

  it("子节编号拼成 06.1 这种形状", async () => {
    const id = await newProduct();
    const chapter = asPage(
      (await call("POST", `/api/products/${id}/wiki`, { title: "架构" })).body,
    );
    await call("POST", `/api/products/${id}/wiki`, {
      title: "分层",
      parentId: chapter.id,
    });
    const pages = await tree(id);
    expect(pages[0]?.children[0]?.number).toBe("01.1");
  });

  it("只支持两层：往子节下面再挂会被拒", async () => {
    const id = await newProduct();
    const chapter = asPage(
      (await call("POST", `/api/products/${id}/wiki`, { title: "架构" })).body,
    );
    const section = asPage(
      (
        await call("POST", `/api/products/${id}/wiki`, {
          title: "分层",
          parentId: chapter.id,
        })
      ).body,
    );
    const bad = await call("POST", `/api/products/${id}/wiki`, {
      title: "再往下",
      parentId: section.id,
    });
    expect(bad.status).toBe(400);
    expect(errorOf(bad)).toContain("两层");
  });

  it("同层重名被拒，不同层同名可以", async () => {
    const id = await newProduct();
    const chapter = asPage(
      (await call("POST", `/api/products/${id}/wiki`, { title: "架构" })).body,
    );
    const dup = await call("POST", `/api/products/${id}/wiki`, {
      title: "架构",
    });
    expect(dup.status).toBe(409);
    // 子节叫「架构」不冲突
    const child = await call("POST", `/api/products/${id}/wiki`, {
      title: "架构",
      parentId: chapter.id,
    });
    expect(child.status).toBe(201);
  });

  it("跨产品挂载被拒（上一轮在功能树上踩过的坑）", async () => {
    const a = await newProduct();
    const b = await newProduct();
    const pageB = asPage(
      (await call("POST", `/api/products/${b}/wiki`, { title: "B 章" })).body,
    );
    const bad = await call("POST", `/api/products/${a}/wiki`, {
      title: "想挂到 B 下",
      parentId: pageB.id,
    });
    expect(bad.status).toBe(400);
    expect(errorOf(bad)).toContain("不属于这个产品");
  });

  it("产品不存在时返回 404，而不是空树或 500", async () => {
    expect((await call("GET", "/api/products/nope/wiki")).status).toBe(404);
    expect(
      (await call("POST", "/api/products/nope/wiki", { title: "x" })).status,
    ).toBe(404);
  });

  it("改过正文的页来源变成 manual——否则重新生成会无声盖掉手写内容", async () => {
    const id = await newProduct();
    const page = asPage(
      (await call("POST", `/api/products/${id}/wiki`, { title: "章" })).body,
    );
    await call("PATCH", `/api/wiki-pages/${page.id}`, {
      content: "## 手写\n正文",
    });
    const got = (await call("GET", `/api/wiki-pages/${page.id}`)).body as {
      source: string;
      content: string;
      path: { number: string }[];
    };
    expect(got.source).toBe("manual");
    expect(got.content).toContain("手写");
    expect(got.path).toHaveLength(1);
  });

  it("树接口不带正文，单页接口才带——13 章正文不该每次渲染都拉一遍", async () => {
    const id = await newProduct();
    const page = asPage(
      (await call("POST", `/api/products/${id}/wiki`, { title: "章" })).body,
    );
    await call("PATCH", `/api/wiki-pages/${page.id}`, {
      content: "x".repeat(500),
    });
    const pages = await tree(id);
    expect(pages[0]).not.toHaveProperty("content");
    expect(pages[0]?.length).toBe(500);
  });

  it("恢复出厂目录会删掉写好的正文，所以默认先拦一次", async () => {
    const id = await newProduct();
    await call("POST", `/api/products/${id}/wiki/reset`);
    const pages = await tree(id);
    await call("PATCH", `/api/wiki-pages/${pages[0]?.id ?? ""}`, {
      content: "写了很久的正文",
    });
    const blocked = await call("POST", `/api/products/${id}/wiki/reset`);
    expect(blocked.status).toBe(409);
    expect(errorOf(blocked)).toContain("1 页");
    // 确认过才放行
    const forced = await call("POST", `/api/products/${id}/wiki/reset`, {
      force: true,
    });
    expect(forced.status).toBe(200);
  });
});

/* ── AI 两步 ──────────────────────────────────────────────────────── */

describe("AI 规划目录", () => {
  it("两个目录都没绑时拦下，并说清去哪绑", async () => {
    const id = await newProduct({ folder: false, code: false });
    const r = await call("POST", "/api/analysis/wiki-outline", {
      productId: id,
    });
    expect(r.status).toBe(409);
    expect(errorOf(r)).toContain("事实底座");
  });

  it("只绑了代码目录也能起——wiki 的后几章本来就靠代码", async () => {
    const id = await newProduct({ folder: false });
    const r = await call("POST", "/api/analysis/wiki-outline", {
      productId: id,
    });
    expect(r.status).toBe(201);
  });

  it("提示词同时带上文档与代码两个根，并把出厂目录作为参照给出", async () => {
    const id = await newProduct();
    const started = (
      await call("POST", "/api/analysis/wiki-outline", { productId: id })
    ).body as { prompt: string; title: string };
    expect(started.title).toContain("AI 规划 Wiki 目录：Alpha");
    expect(started.prompt).toContain('根="/01-products/alpha"');
    expect(started.prompt).toContain('根="/代码库/alpha"');
    expect(started.prompt).toContain("参照不是模板");
    expect(started.prompt).toContain("产品快照");
    // 压住「按目录结构编章节」那条跑偏
    expect(started.prompt).toContain("不该变成章名");
  });

  it("提示词如实交代事实源覆盖情况：没绑的说没绑，并说明事实是快照、补绑后要重新发起", async () => {
    const docsOnly = await newProduct({ code: false });
    const p1 = (
      await call("POST", "/api/analysis/wiki-outline", { productId: docsOnly })
    ).body as { prompt: string };
    expect(p1.prompt).toContain("文档目录：已绑定 `/01-products/alpha`");
    expect(p1.prompt).toContain("代码目录：**未绑定**");
    // 真实撞上过：中途补绑后在原对话里说「代码我绑定了」，模型让用户贴目录树
    expect(p1.prompt).toContain("不要让他把代码或目录树贴进来");
    expect(p1.prompt).toContain("AI 重新规划目录");
  });

  it("绑了但读不到的目录不再静默丢掉，提示词里说清是读取失败", async () => {
    const id = await newProduct();
    rmSync(join(dir, "files", "代码库", "alpha"), {
      recursive: true,
      force: true,
    });
    const started = (
      await call("POST", "/api/analysis/wiki-outline", { productId: id })
    ).body as { prompt: string };
    expect(started.prompt).toContain("`/代码库/alpha`，但**这次读取失败**");
    expect(started.prompt).not.toContain('根="/代码库/alpha"');
  });

  it("应用目录：整棵写进去，子节跟着父章走", async () => {
    const id = await newProduct();
    const started = (
      await call("POST", "/api/analysis/wiki-outline", { productId: id })
    ).body as { sessionId: string };
    fakeAnswer(
      started.sessionId,
      `分析如下。\n\n\`\`\`json\n${JSON.stringify({
        pages: [
          { title: "产品快照", brief: "写一句话定义" },
          {
            title: "架构分层",
            brief: "写分层",
            children: [{ title: "服务端", brief: "写服务端" }],
          },
        ],
        uncertain: ["没有埋点数据，没规划指标章"],
      })}\n\`\`\``,
    );
    const result = (
      await call("GET", `/api/analysis/${started.sessionId}/result`)
    ).body as { kind: string; uncertain: string[] };
    expect(result.kind).toBe("wiki-outline");
    expect(result.uncertain[0]).toContain("埋点");

    const applied = await call(
      "POST",
      `/api/analysis/${started.sessionId}/apply-wiki-outline`,
    );
    expect(applied.status).toBe(200);
    const pages = applied.body?.pages as Page[];
    expect(pages.map((p) => p.title)).toEqual(["产品快照", "架构分层"]);
    expect(pages[1]?.children[0]?.title).toBe("服务端");
    expect(pages[0]?.source).toBe("ai");
  });

  it("重新规划只清没写正文的页，写过的留着并如实报出来", async () => {
    const id = await newProduct();
    await call("POST", `/api/products/${id}/wiki/reset`);
    const pages = await tree(id);
    await call("PATCH", `/api/wiki-pages/${pages[0]?.id ?? ""}`, {
      content: "手写的第一章",
    });
    const started = (
      await call("POST", "/api/analysis/wiki-outline", {
        productId: id,
        mode: "replace",
      })
    ).body as { sessionId: string };
    fakeAnswer(
      started.sessionId,
      `\`\`\`json\n${JSON.stringify({ pages: [{ title: "全新一章", brief: "x" }] })}\n\`\`\``,
    );
    const applied = (
      await call(
        "POST",
        `/api/analysis/${started.sessionId}/apply-wiki-outline`,
      )
    ).body as { skipped: string[]; pages: Page[] };
    expect(applied.skipped.join()).toContain("保留未动");
    expect(applied.pages.map((p) => p.title)).toEqual([
      pages[0]?.title,
      "全新一章",
    ]);
  });
});

describe("AI 写某一页", () => {
  const startPage = async () => {
    const id = await newProduct();
    const page = asPage(
      (
        await call("POST", `/api/products/${id}/wiki`, {
          title: "架构分层",
          brief: "写清分几层、为什么",
        })
      ).body,
    );
    const started = (
      await call("POST", "/api/analysis/wiki-page", { pageId: page.id })
    ).body as { sessionId: string; prompt: string; title: string };
    return { productId: id, page, started };
  };

  it("提示词带上整本目录与证据等级要求", async () => {
    const { started } = await startPage();
    expect(started.title).toBe("AI 写 Wiki：01 架构分层");
    expect(started.prompt).toContain("写清分几层、为什么");
    expect(started.prompt).toContain("[待核实]");
    expect(started.prompt).toContain("===WIKI===");
    // 不要用一级标题：页面标题已经占了
    expect(started.prompt).toContain("不要用 `#`");
  });

  it("正文走分隔符信封，里面的代码围栏不会把它截断", async () => {
    const { page, started } = await startPage();
    const body = [
      "## 分层",
      "",
      "服务端分三层 [已核实]（见 `server/app.ts`）。",
      "",
      "```ts",
      "export const app = 1;",
      "```",
      "",
      "缓存策略未知 [待核实]。",
    ].join("\n");
    fakeAnswer(
      started.sessionId,
      `我打算这么写。\n\n===WIKI===\n${body}\n===/WIKI===\n\n\`\`\`json\n${JSON.stringify(
        { sources: ["server/app.ts"], gaps: ["缓存策略"] },
      )}\n\`\`\``,
    );
    const result = (
      await call("GET", `/api/analysis/${started.sessionId}/result`)
    ).body as {
      kind: string;
      content: string;
      sources: string[];
      gaps: string[];
      hadContent: boolean;
      pageTitle: string;
    };
    expect(result.kind).toBe("wiki-page");
    expect(result.pageTitle).toBe("01 架构分层");
    expect(result.hadContent).toBe(false);
    // 围栏完整保留，没有在 ``` 处被截断
    expect(result.content).toContain("export const app = 1;");
    expect(result.content).toContain("[待核实]");
    expect(result.sources).toEqual(["server/app.ts"]);
    expect(result.gaps).toEqual(["缓存策略"]);

    const applied = await call(
      "POST",
      `/api/analysis/${started.sessionId}/apply-wiki-page`,
    );
    expect(applied.status).toBe(200);
    const got = (await call("GET", `/api/wiki-pages/${page.id}`)).body as {
      content: string;
      source: string;
    };
    expect(got.content).toContain("export const app = 1;");
    expect(got.source).toBe("ai");
  });

  it("元数据 json 块缺失时正文照样可用——它只是抽查线索", async () => {
    const { started } = await startPage();
    fakeAnswer(started.sessionId, "===WIKI===\n## 分层\n正文\n===/WIKI===");
    const result = (
      await call("GET", `/api/analysis/${started.sessionId}/result`)
    ).body as { content: string; sources: string[] };
    expect(result.content).toContain("## 分层");
    expect(result.sources).toEqual([]);
  });

  it("信封缺失时报错，不把「好的，我来写」这种对话口吻当正文收进去", async () => {
    const { started } = await startPage();
    fakeAnswer(started.sessionId, "好的，我来写这一章。首先分层是……");
    const r = await call("GET", `/api/analysis/${started.sessionId}/result`);
    expect(r.status).toBe(400);
    expect(errorOf(r)).toContain("===WIKI===");
  });

  it("重写时把已有正文带进提示词，并标明会被覆盖", async () => {
    const { page, started: first } = await startPage();
    fakeAnswer(first.sessionId, "===WIKI===\n## 旧的\n旧正文\n===/WIKI===");
    await call("POST", `/api/analysis/${first.sessionId}/apply-wiki-page`);

    const again = (
      await call("POST", "/api/analysis/wiki-page", { pageId: page.id })
    ).body as { sessionId: string; prompt: string };
    expect(again.prompt).toContain("旧正文");
    expect(again.prompt).toContain("不要原样复述");
    fakeAnswer(again.sessionId, "===WIKI===\n## 新的\n新正文\n===/WIKI===");
    const result = (
      await call("GET", `/api/analysis/${again.sessionId}/result`)
    ).body as { hadContent: boolean };
    expect(result.hadContent).toBe(true);
  });
});

/* ── 参考资料与单章精读 ───────────────────────────────────────────── */

describe("参考资料", () => {
  it("产品可以挂多条参考资料（目录或文件），代码库下的路径被拒", async () => {
    const id = await newProduct();
    const ok = await call("PATCH", `/api/products/${id}`, {
      refPaths: ["/docs/manual", "/01-products/能力地图.md", "/docs/manual"],
    });
    expect(ok.status).toBe(200);
    expect(ok.body?.refPaths).toEqual([
      "/docs/manual",
      "/01-products/能力地图.md",
    ]);
    const bad = await call("PATCH", `/api/products/${id}`, {
      refPaths: ["/代码库/alpha"],
    });
    expect(bad.status).toBe(400);
  });

  it("规划目录时读参考资料：文件把正文带上，目录给出树", async () => {
    const id = await newProduct();
    await call("PATCH", `/api/products/${id}`, {
      refPaths: ["/docs/manual", "/01-products/能力地图.md"],
    });
    const started = (
      await call("POST", "/api/analysis/wiki-outline", { productId: id })
    ).body as { prompt: string };
    expect(started.prompt).toContain("参考资料：已绑定 `/docs/manual`");
    expect(started.prompt).toContain('根="/docs/manual"');
    expect(started.prompt).toContain("01-登录.md");
    expect(started.prompt).toContain("24 个能力域");
    // 要求每章给精读路径
    expect(started.prompt).toContain("每一章、每一节都要给 `sources`");
  });
});

describe("单章精读", () => {
  const plan = async (sources: unknown[]) => {
    const id = await newProduct();
    await call("PATCH", `/api/products/${id}`, {
      refPaths: ["/docs/manual"],
    });
    const started = (
      await call("POST", "/api/analysis/wiki-outline", { productId: id })
    ).body as { sessionId: string };
    fakeAnswer(
      started.sessionId,
      `\`\`\`json\n${JSON.stringify({
        pages: [{ title: "数据模型", brief: "列出核心表", sources }],
      })}\n\`\`\``,
    );
    const applied = (
      await call(
        "POST",
        `/api/analysis/${started.sessionId}/apply-wiki-outline`,
      )
    ).body as {
      pages: (Page & { sources: string[] })[];
      droppedSources?: string[];
    };
    return { id, applied };
  };

  it("应用目录时精读路径过归属闸：相对路径解析到真实根，越界与不存在的丢掉并报出", async () => {
    const { applied } = await plan([
      "server/schema", // 相对路径：解析到代码根下
      "/docs/manual/01-登录.md", // 参考资料里的文件
      "/01-products/beta", // 别的产品，越界
      "/", // 整个文件库，越界
      "/代码库/alpha/不存在", // 不存在
    ]);
    expect(applied.pages[0]?.sources).toEqual([
      "/代码库/alpha/server/schema",
      "/docs/manual/01-登录.md",
    ]);
    expect(applied.droppedSources).toEqual([
      "/01-products/beta",
      "/",
      "/代码库/alpha/不存在",
    ]);
  });

  it("写正文时读精读路径下的源代码正文；依赖目录与凭据文件不读", async () => {
    const { applied } = await plan(["/代码库/alpha/server"]);
    const pageId = applied.pages[0]?.id ?? "";
    const started = (await call("POST", "/api/analysis/wiki-page", { pageId }))
      .body as {
      prompt: string;
      focus: { files: number };
      skippedDocs: { path: string }[];
    };
    expect(started.prompt).toContain(
      '<源文件 路径="/代码库/alpha/server/schema/user.go">',
    );
    expect(started.prompt).toContain("Balance int64");
    expect(started.prompt).not.toContain("THIRD_PARTY");
    expect(started.prompt).not.toContain("sk-abcdefghij");
    expect(started.skippedDocs.map((d) => d.path)).toContain(
      "/代码库/alpha/server/config.json",
    );
    expect(started.focus.files).toBeGreaterThan(0);
  });

  it("手改的精读路径越界时，写正文照样不读，并在提示词里说明已忽略", async () => {
    const { applied } = await plan([]);
    const pageId = applied.pages[0]?.id ?? "";
    await call("PATCH", `/api/wiki-pages/${pageId}`, {
      sources: ["/01-products/beta", "/代码库/alpha/server/schema"],
    });
    const started = (await call("POST", "/api/analysis/wiki-page", { pageId }))
      .body as { prompt: string };
    expect(started.prompt).not.toContain("BETA_SECRET");
    expect(started.prompt).toContain("已忽略：/01-products/beta");
    expect(started.prompt).toContain("Balance int64");
  });

  it("没指定精读路径的章：提示词明说没有源代码正文，引导去填路径", async () => {
    const { applied } = await plan([]);
    const started = (
      await call("POST", "/api/analysis/wiki-page", {
        pageId: applied.pages[0]?.id ?? "",
      })
    ).body as { prompt: string };
    expect(started.prompt).toContain("这一章没有指定精读路径");
    expect(started.prompt).not.toContain("<源文件");
  });
});
