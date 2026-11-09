import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { IN_MEMORY, openDb, type Db } from "../db.js";
import { createFileStore, openFilesIndex } from "../files/store.js";
import type { Template } from "../lifecycle.js";
import { createKeyStore } from "../model-config.js";
import { piPaths } from "../pi/runtime.js";
import { createSessionStore } from "../sessions.js";
import { createSkillStore } from "../skills.js";
import { renderScan, scanFolder } from "./scan.js";
import { extractJsonBlock, summarize } from "./tasks.js";

/**
 * 两个 AI 分析（识别产线与产品、比对产出物）。
 *
 * 模型不参与测试：分析跑在真对话里，而「这一轮回答是什么」在测试里由
 * `store.append()` 直接造一条 assistant 条目——这样校验的是**我们这侧的契约**
 * （怎么采集事实、怎么从回答里取结果、漏答怎么算），而不是模型今天的心情。
 */
const PORT = 4400;
const HOST = `127.0.0.1:${String(PORT)}`;

let db: Db;
let dir: string;
let filesDir: string;
let index: Db;
let files: ReturnType<typeof createFileStore>;
let app: ReturnType<typeof createApp>["app"];
let store: ReturnType<typeof createSessionStore>;

/** 造一棵产品库目录。刻意**不放** product.yaml —— 用户明说「不是所有产品库都是标准的」。 */
function seedTree(root: string): void {
  const mk = (...parts: string[]) => {
    const abs = join(root, ...parts);
    mkdirSync(abs, { recursive: true });
    return abs;
  };
  const write = (rel: string[], text: string): void => {
    writeFileSync(join(root, ...rel), text, "utf8");
  };

  mk("01-products", "alpha", "prd");
  mk("01-products", "alpha", "verify");
  mk("01-products", "beta");
  mk("01-products", "_archive", "old", "deep");
  write(["01-products", "README.md"], "# 产品库\n两个产品：alpha 与 beta。");
  write(["01-products", "alpha", "README.md"], "# Alpha\n做 A 的。");
  write(
    ["01-products", "_archive", "old", "README.md"],
    "# 归档\n不该抢占预算的那份。",
  );
  write(["01-products", "alpha", "prd", "立项PR-FAQ.md"], "# PR-FAQ\n正文");
  write(["01-products", "alpha", "prd", "需求规格.md"], "# PRD\n正文");

  /*
   * 「事实底座 → 代码」那一层。功能架构分析只认 /代码库 下的路径
   * （products.ts 的 codePathField 会把指到文档库的绑定拒掉）。
   */
  mk("代码库", "alpha", "app", "pages");
  mk("代码库", "beta");
  write(["代码库", "alpha", "README.md"], "# Alpha 代码\n这是 alpha 的仓库。");
  write(
    ["代码库", "alpha", "app", "pages", "login.vue"],
    "<template>登录</template>",
  );
  write(["代码库", "beta", "main.go"], "package main");
  // 凭据防线要测：名字命中与正文命中各放一份
  write(
    ["代码库", "alpha", "docker-compose.yml"],
    "services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: hunter2\n",
  );
  write(
    ["代码库", "alpha", "config.json"],
    '{"note":"名字无辜","apiKey":"sk-abcdefghijklmnopqrstuvwxyz"}',
  );
}

beforeEach(() => {
  db = openDb(IN_MEMORY);
  dir = mkdtempSync(join(tmpdir(), "pmforge-analysis-"));
  filesDir = join(dir, "files");
  mkdirSync(filesDir, { recursive: true });
  seedTree(filesDir);
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

/** 往会话里塞一条 assistant 回答。pi 条目最少要有 id / type / message。 */
function fakeAnswer(sessionId: string, text: string): void {
  store.append(sessionId, [
    {
      id: `a-${String(store.entries(sessionId).length)}`,
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text }] },
    },
  ]);
}

const jsonBlock = (data: unknown) =>
  `先说结论。\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;

/* ── 目录采集 ─────────────────────────────────────────────────────── */

describe("目录采集", () => {
  it("只要目录骨架时，普通文件不列，说明文件仍然登记", async () => {
    const scan = await scanFolder(files, "/01-products", { onlyFolders: true });
    expect(scan.outline).toContain("alpha/");
    expect(scan.outline).toContain("beta/");
    // 普通文件（PRD 正文）不进骨架
    expect(scan.outline).not.toContain("需求规格.md");
    // README 既进骨架也读正文
    expect(scan.outline).toContain("README.md");
    expect(scan.docs.map((d) => d.path)).toContain("/01-products/README.md");
  });

  it("说明文件按深度优先分配预算：浅的先读，归档深处的靠后", async () => {
    const scan = await scanFolder(files, "/01-products", { onlyFolders: true });
    const paths = scan.docs.map((d) => d.path);
    expect(paths[0]).toBe("/01-products/README.md");
    expect(paths.indexOf("/01-products/alpha/README.md")).toBeLessThan(
      paths.indexOf("/01-products/_archive/old/README.md"),
    );
  });

  it("要看文件名时（比对用），PRD 文件名出现在骨架里", async () => {
    const scan = await scanFolder(files, "/01-products/alpha", { maxDepth: 4 });
    expect(scan.outline).toContain("立项PR-FAQ.md");
    expect(scan.outline).toContain("需求规格.md");
  });

  it("大仓库：第一个顶层目录再大，后面的顶层目录也都要露出名字", async () => {
    // 复现 RouteHub：apps/ 下几百个子目录，原来深度优先会把 600 节点预算全吃在 apps/ 里，
    // server/、infra/ 连名字都出不来。
    const repo = join(filesDir, "代码库", "big");
    for (let i = 0; i < 40; i += 1)
      for (let j = 0; j < 20; j += 1)
        mkdirSync(join(repo, "apps", `app${String(i)}`, `mod${String(j)}`), {
          recursive: true,
        });
    mkdirSync(join(repo, "server", "internal"), { recursive: true });
    mkdirSync(join(repo, "infra"), { recursive: true });
    const scan = await scanFolder(files, "/代码库/big", { maxDepth: 4 });
    const top = scan.outline.split("\n").filter((l) => l.startsWith("- "));
    expect(top).toEqual(["- apps/", "- infra/", "- server/"]);
    // 第二层也先于更深的层分到预算
    expect(scan.outline).toContain("  - internal/");
    expect(scan.stats.truncated).toBe(true);
    // 树形缩进不乱：app0 的子模块紧跟在 app0 下面
    const lines = scan.outline.split("\n");
    const at = lines.indexOf("  - app0/");
    expect(lines[at + 1]).toBe("    - mod0/");
  });

  it("依赖与构建产物目录只列名字不展开", async () => {
    const repo = join(filesDir, "代码库", "deps");
    mkdirSync(join(repo, "node_modules", "@types", "estree"), {
      recursive: true,
    });
    mkdirSync(join(repo, "web", "dist", "assets"), { recursive: true });
    mkdirSync(join(repo, "web", "src"), { recursive: true });
    const scan = await scanFolder(files, "/代码库/deps", { maxDepth: 4 });
    expect(scan.outline).toContain("- node_modules/（依赖或构建产物，未展开）");
    expect(scan.outline).toContain("dist/（依赖或构建产物，未展开）");
    expect(scan.outline).not.toContain("@types");
    expect(scan.outline).not.toContain("assets");
    expect(scan.outline).toContain("- src/");
  });

  it("渲染成提示词段：带根路径；树被截断时明说，免得模型据此断言「缺少」", () => {
    const text = renderScan({
      root: "/x",
      outline: "- a/",
      docs: [{ path: "/x/README.md", content: "正文", truncated: true }],
      stats: { dirs: 1, nodes: 1, truncated: true },
      skipped: [],
    });
    expect(text).toContain('<目录事实 根="/x">');
    expect(text).toContain("已被截断");
    expect(text).toContain('<说明文件 路径="/x/README.md" 截断="是">');
  });
});

/* ── json 块提取 ──────────────────────────────────────────────────── */

describe("从回答里取 json", () => {
  it("取最后一个块：追问后自然就是最新那版", () => {
    const text = [
      "第一版",
      "```json",
      '{"v":1}',
      "```",
      "你说得对，改一下",
      "```json",
      '{"v":2}',
      "```",
    ].join("\n");
    expect(extractJsonBlock(text)).toBe('{"v":2}');
  });

  it("忘了加围栏也能捞出来", () => {
    expect(extractJsonBlock('结论如下 {"v":3} 完')).toBe('{"v":3}');
  });

  it("压根没有 json 就返回 null", () => {
    expect(extractJsonBlock("我觉得挺好的")).toBe(null);
  });
});

/* ── 识别产线与产品 ───────────────────────────────────────────────── */

describe("识别产线与产品", () => {
  const start = async (folderPath = "/01-products") =>
    (await call("POST", "/api/analysis/discover", { folderPath })).body as {
      sessionId: string;
      prompt: string;
      title: string;
    };

  it("发起：建一条带标记的会话，提示词里带上目录事实", async () => {
    const started = await start();
    expect(started.title).toBe("AI 识别产线与产品：/01-products");
    expect(started.prompt).toContain('<目录事实 根="/01-products">');
    expect(started.prompt).toContain("alpha/");
    // 没有 product.yaml 的仓库也要能跑：提示词里要有「没有声明文件就看目录结构」这条
    expect(started.prompt).toContain("没有声明文件就看目录结构");
    const sessions = (await call("GET", "/api/sessions")).body?.sessions as {
      id: string;
      task: { kind: string; folderPath: string } | null;
    }[];
    expect(sessions.find((s) => s.id === started.sessionId)?.task).toEqual({
      kind: "discover",
      folderPath: "/01-products",
      paths: ["/01-products"],
    });
  });

  it("路径不存在：报错而不是对着空树瞎猜；指到文件上：当一份资料读进来", async () => {
    const miss = await call("POST", "/api/analysis/discover", {
      folderPath: "/没有这个目录",
    });
    expect(miss.status).toBe(404);
    // 多选后可以勾单个文件（比如能力地图），它的正文直接给 AI
    const file = await call("POST", "/api/analysis/discover", {
      folderPath: "/01-products/README.md",
    });
    expect(file.status).toBe(201);
    expect(file.body?.prompt).toContain("两个产品：alpha 与 beta。");
  });

  it("还没回答 / 回答里没有 json：说清下一步怎么办，不硬塞半个结果", async () => {
    const started = await start();
    const empty = await call(
      "GET",
      `/api/analysis/${started.sessionId}/result`,
    );
    expect(empty.status).toBe(400);
    expect(errorOf(empty)).toContain("还没有回答");

    fakeAnswer(started.sessionId, "我看了一下，挺复杂的。");
    const noJson = await call(
      "GET",
      `/api/analysis/${started.sessionId}/result`,
    );
    expect(errorOf(noJson)).toContain("没有找到 json 结果块");

    fakeAnswer(started.sessionId, "```json\n{不是合法 json\n```");
    expect(
      errorOf(await call("GET", `/api/analysis/${started.sessionId}/result`)),
    ).toContain("解析失败");
  });

  it("正常解析：产线、产品与 uncertain 都出来", async () => {
    const started = await start();
    fakeAnswer(
      started.sessionId,
      jsonBlock({
        lines: [
          {
            name: "示例产品线",
            description: "两个产品",
            folderPath: "/01-products",
            reason: "README 说的",
            products: [
              {
                name: "Alpha",
                description: "做 A 的",
                folderPath: "/01-products/alpha",
              },
              { name: "Beta", folderPath: "/01-products/beta" },
            ],
          },
        ],
        uncertain: ["_archive 看不出是不是产品"],
      }),
    );
    const r = await call("GET", `/api/analysis/${started.sessionId}/result`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      kind: "discover",
      uncertain: ["_archive 看不出是不是产品"],
    });
    const lines = r.body?.lines as { name: string; products: unknown[] }[];
    expect(lines[0]?.name).toBe("示例产品线");
    expect(lines[0]?.products).toHaveLength(2);
  });

  it("应用：建产线与产品；再点一次只跳过不报错", async () => {
    const started = await start();
    const payload = {
      lines: [
        {
          name: "示例产品线",
          description: "两个产品",
          folderPath: "/01-products",
          products: [
            {
              name: "Alpha",
              description: "",
              folderPath: "/01-products/alpha",
              templateId: "",
            },
          ],
        },
      ],
    };
    const first = await call(
      "POST",
      `/api/analysis/${started.sessionId}/apply`,
      payload,
    );
    expect(first.body).toMatchObject({
      createdLines: ["示例产品线"],
      createdProducts: ["Alpha"],
      skipped: [],
    });
    // 产品确实带上了目录绑定
    const lines = (await call("GET", "/api/product-lines")).body?.lines as {
      name: string;
      folderPath: string | null;
      products: { name: string; folderPath: string | null }[];
    }[];
    expect(lines[0]).toMatchObject({
      name: "示例产品线",
      folderPath: "/01-products",
    });
    expect(lines[0]?.products[0]?.folderPath).toBe("/01-products/alpha");

    const again = await call(
      "POST",
      `/api/analysis/${started.sessionId}/apply`,
      payload,
    );
    expect(again.status).toBe(200);
    expect(again.body?.createdProducts).toEqual([]);
    expect((again.body?.skipped as unknown[]).length).toBe(2);
  });

  it("发起：代码库的仓库清单也交给 AI，好把产品对上代码目录", async () => {
    const started = await start();
    expect(started.prompt).toContain('<代码库 根="/代码库">');
    expect(started.prompt).toContain("- /代码库/alpha");
    expect(started.prompt).toContain("- /代码库/beta");
    expect(started.prompt).toContain("codePath");
    expect(started.prompt).toContain("refPaths");
  });

  it("多选：文档文件夹、单个文件、代码仓库一起交给 AI，只给勾了的仓库", async () => {
    const r = await call("POST", "/api/analysis/discover", {
      paths: [
        "/01-products",
        "/01-products/alpha/prd/需求规格.md",
        "/代码库/alpha",
      ],
    });
    expect(r.status).toBe(201);
    const prompt = r.body?.prompt as string;
    expect(prompt).toContain('<目录事实 根="/01-products">');
    expect(prompt).toContain(
      '<目录事实 根="/01-products/alpha/prd/需求规格.md">',
    );
    expect(prompt).toContain("# PRD\n正文");
    expect(prompt).toContain('<代码库 根="/代码库" 范围="使用者勾选">');
    expect(prompt).toContain("- /代码库/alpha");
    expect(prompt).not.toContain("- /代码库/beta");
    // 浅看一层勾选的仓库，好让 AI 对得准
    expect(prompt).toContain('<目录事实 根="/代码库/alpha">');
    const sessions = (await call("GET", "/api/sessions")).body?.sessions as {
      id: string;
      task: { paths?: string[] } | null;
    }[];
    expect(
      sessions.find((x) => x.id === r.body?.sessionId)?.task?.paths,
    ).toHaveLength(3);
  });

  it("多选：根目录、整个代码库、不存在的仓库都报错", async () => {
    for (const paths of [
      ["/"],
      ["/代码库"],
      ["/01-products", "/代码库/没有"],
    ]) {
      const r = await call("POST", "/api/analysis/discover", { paths });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    const none = await call("POST", "/api/analysis/discover", { paths: [] });
    expect(none.status).toBe(400);
  });

  it("取结果：代码目录与参考资料只留真实存在且放对地方的，其余如实列出", async () => {
    const started = await start();
    fakeAnswer(
      started.sessionId,
      jsonBlock({
        lines: [
          {
            name: "示例产品线",
            products: [
              {
                name: "Alpha",
                folderPath: "/01-products/alpha",
                codePath: "/代码库/alpha",
                refPaths: [
                  "/01-products/alpha/prd/需求规格.md",
                  "/01-products/alpha", // 就是文档目录本身，不重复挂
                  "/01-products/没有这份.md",
                  "/代码库/alpha/README.md",
                ],
              },
              {
                name: "Beta",
                folderPath: "/01-products/beta",
                codePath: "/代码库/不存在",
              },
            ],
          },
        ],
      }),
    );
    const r = await call("GET", `/api/analysis/${started.sessionId}/result`);
    const products = (
      r.body?.lines as {
        products: {
          codePath: string;
          refPaths: string[];
          droppedPaths: { path: string; why: string }[];
        }[];
      }[]
    )[0]?.products;
    expect(products?.[0]).toMatchObject({
      codePath: "/代码库/alpha",
      refPaths: ["/01-products/alpha/prd/需求规格.md"],
      droppedPaths: [
        { path: "/01-products/没有这份.md", why: "文件库里找不到" },
        {
          path: "/代码库/alpha/README.md",
          why: "代码不放参考资料，走代码目录",
        },
      ],
    });
    expect(products?.[1]).toMatchObject({
      codePath: "",
      droppedPaths: [{ path: "/代码库/不存在", why: "文件库里找不到" }],
    });
  });

  it("应用：三样依据一起入库；已有产品重新识别只补空着的依据", async () => {
    const started = await start();
    const product = {
      name: "Alpha",
      description: "",
      folderPath: "/01-products/alpha",
      templateId: "",
    };
    // 第一轮：只有文档目录（模拟旧版识别建出来的产品）
    await call("POST", `/api/analysis/${started.sessionId}/apply`, {
      lines: [{ name: "示例产品线", products: [product] }],
    });
    // 第二轮：带上代码目录与参考资料，外加一条前端塞进来的假路径
    const again = await call(
      "POST",
      `/api/analysis/${started.sessionId}/apply`,
      {
        lines: [
          {
            name: "示例产品线",
            products: [
              {
                ...product,
                description: "不该覆盖",
                codePath: "/代码库/alpha",
                refPaths: ["/01-products/alpha/prd/需求规格.md", "/伪造/路径"],
              },
            ],
          },
        ],
      },
    );
    expect(again.body?.filledProducts).toEqual(["Alpha"]);
    const lines = (await call("GET", "/api/product-lines")).body?.lines as {
      products: {
        description: string;
        codePath: string | null;
        refPaths: string[];
      }[];
    }[];
    expect(lines[0]?.products[0]).toMatchObject({
      description: "",
      codePath: "/代码库/alpha",
      refPaths: ["/01-products/alpha/prd/需求规格.md"],
    });
  });

  it("普通对话上调分析接口：拒绝", async () => {
    const session = (await call("POST", "/api/sessions")).body as {
      id: string;
    };
    const r = await call("GET", `/api/analysis/${session.id}/result`);
    expect(r.status).toBe(400);
    expect(errorOf(r)).toBe("这条会话不是一次 AI 分析");
  });
});

/* ── 比对产出物 ───────────────────────────────────────────────────── */

describe("比对产出物", () => {
  const builtin = async (): Promise<Template> => {
    const list = (await call("GET", "/api/lifecycle-templates")).body
      ?.templates as Template[];
    const hit = list.find((t) => t.builtin);
    if (!hit) throw new Error("没有出厂模板");
    return hit;
  };
  /** 每次建在自己的产品线下：产品线名全局唯一，复用同一个名字第二次就 409 了。 */
  let seq = 0;
  const newProduct = async (options: {
    templateId?: string;
    folderPath?: string;
  }) => {
    seq += 1;
    const line = (
      await call("POST", "/api/product-lines", { name: `L${String(seq)}` })
    ).body as { id: string };
    return (
      await call("POST", `/api/product-lines/${line.id}/products`, {
        name: "Alpha",
        ...options,
      })
    ).body as { id: string; name: string };
  };

  it("没绑模板 / 没绑目录：409 并说清去哪儿补", async () => {
    const bare = await newProduct({});
    const noTemplate = await call("POST", "/api/analysis/compare", {
      productId: bare.id,
    });
    expect(noTemplate.status).toBe(409);
    expect(errorOf(noTemplate)).toContain("还没绑生命周期规范");

    const t = await builtin();
    const noFolder = await newProduct({ templateId: t.id });
    const r = await call("POST", "/api/analysis/compare", {
      productId: noFolder.id,
    });
    expect(r.status).toBe(409);
    expect(errorOf(r)).toContain("还没绑文件夹");
  });

  it("发起：提示词带清单、判定要点与文件线索", async () => {
    const t = await builtin();
    const product = await newProduct({
      templateId: t.id,
      folderPath: "/01-products/alpha",
    });
    const started = (
      await call("POST", "/api/analysis/compare", { productId: product.id })
    ).body as { prompt: string; sessionId: string; title: string };
    expect(started.title).toBe("AI 比对产出物：Alpha");
    expect(started.prompt).toContain("### L0.1 想法卡 · 想法卡（必交）");
    expect(started.prompt).toContain("文件线索：想法卡 / idea / idea-card");
    expect(started.prompt).toContain("判定要点：");
    // 比对要看得到文件名
    expect(started.prompt).toContain("立项PR-FAQ.md");
  });

  it("模型漏答的产出物按「缺」计——漏判不能等于通过", async () => {
    const t = await builtin();
    const product = await newProduct({
      templateId: t.id,
      folderPath: "/01-products/alpha",
    });
    const started = (
      await call("POST", "/api/analysis/compare", { productId: product.id })
    ).body as { sessionId: string };
    // 13 件里只答 1 件
    fakeAnswer(
      started.sessionId,
      jsonBlock({
        findings: [
          { artifact: "立项 PR-FAQ", status: "present", files: ["/x.md"] },
        ],
      }),
    );
    const r = await call("GET", `/api/analysis/${started.sessionId}/result`);
    const summary = r.body?.summary as {
      total: number;
      present: number;
      missing: number;
    };
    expect(summary.total).toBe(13);
    expect(summary.present).toBe(1);
    expect(summary.missing).toBe(12);
    const findings = r.body?.findings as {
      artifact: string;
      judged: boolean;
      note: string;
    }[];
    const dropped = findings.find((f) => f.artifact === "想法卡");
    expect(dropped?.judged).toBe(false);
    expect(dropped?.note).toContain("按「缺」计");
  });

  it("改写了产出物名的 finding 对不上行，照样按「缺」计", async () => {
    const t = await builtin();
    const product = await newProduct({
      templateId: t.id,
      folderPath: "/01-products/alpha",
    });
    const started = (
      await call("POST", "/api/analysis/compare", { productId: product.id })
    ).body as { sessionId: string };
    fakeAnswer(
      started.sessionId,
      jsonBlock({
        findings: [{ artifact: "PR-FAQ（我自己改的名）", status: "present" }],
      }),
    );
    const r = await call("GET", `/api/analysis/${started.sessionId}/result`);
    expect((r.body?.summary as { present: number }).present).toBe(0);
  });

  it("存为最近一次：产品行能读到，重跑覆盖而不是堆历史", async () => {
    const t = await builtin();
    const product = await newProduct({
      templateId: t.id,
      folderPath: "/01-products/alpha",
    });
    const run = async (status: "present" | "missing") => {
      const started = (
        await call("POST", "/api/analysis/compare", { productId: product.id })
      ).body as { sessionId: string };
      fakeAnswer(
        started.sessionId,
        jsonBlock({
          findings: [{ artifact: "立项 PR-FAQ", status }],
        }),
      );
      return call("POST", `/api/analysis/${started.sessionId}/save`);
    };

    const first = await run("present");
    expect((first.body?.summary as { present: number }).present).toBe(1);
    const second = await run("missing");
    expect((second.body?.summary as { present: number }).present).toBe(0);

    // 只有一条：product_id 是主键，重跑覆盖
    const all = (await call("GET", "/api/product-checks")).body
      ?.checks as unknown[];
    expect(all).toHaveLength(1);
    const one = await call("GET", `/api/products/${product.id}/check`);
    expect((one.body?.summary as { present: number }).present).toBe(0);
  });

  it("没比对过的产品：404，不是空结果", async () => {
    const product = await newProduct({});
    const r = await call("GET", `/api/products/${product.id}/check`);
    expect(r.status).toBe(404);
    expect(errorOf(r)).toBe("这个产品还没有比对过");
  });
});

/* ── 汇总口径 ─────────────────────────────────────────────────────── */

describe("汇总", () => {
  const template = (): Template => ({
    id: "t",
    name: "T",
    description: "",
    builtin: false,
    createdAt: 1,
    updatedAt: 1,
    productCount: 0,
    stages: [
      {
        id: "s",
        templateId: "t",
        code: "L1",
        label: "阶段",
        question: "",
        createdAt: 1,
        updatedAt: 1,
        artifacts: [
          {
            id: "a1",
            stageId: "s",
            name: "必交件",
            required: true,
            guide: "",
            checkpoints: [],
            fileHints: [],
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: "a2",
            stageId: "s",
            name: "选填件",
            required: false,
            guide: "",
            checkpoints: [],
            fileHints: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    ],
  });

  it("requiredGap 只数必交项——它才是「还差多少」真正要紧的那个数", () => {
    const { summary } = summarize(template(), {
      findings: [
        {
          artifact: "必交件",
          status: "partial",
          files: [],
          missedCheckpoints: ["漏了这条"],
          note: "",
        },
        {
          artifact: "选填件",
          status: "missing",
          files: [],
          missedCheckpoints: [],
          note: "",
        },
      ],
    });
    expect(summary).toEqual({
      total: 2,
      present: 0,
      partial: 1,
      missing: 1,
      requiredGap: 1,
    });
  });
});

/* ── 功能架构 ─────────────────────────────────────────────────────── */

describe("功能架构", () => {
  let seq = 0;
  const newProduct = async (options: { codePath?: string }) => {
    seq += 1;
    const line = (
      await call("POST", "/api/product-lines", { name: `A${String(seq)}` })
    ).body as { id: string };
    return (
      await call("POST", `/api/product-lines/${line.id}/products`, {
        name: "Alpha",
        ...options,
      })
    ).body as { id: string; name: string; codePath: string | null };
  };

  const featureTree = async (productId: string) =>
    ((await call("GET", `/api/products/${productId}/features`)).body
      ?.features ?? []) as {
      id: string;
      name: string;
      duty: string;
      evidence: string[];
      source: string;
      level: number;
      children: { id: string; name: string; source: string }[];
    }[];

  it("没绑代码目录：409 并指明去「事实底座 → 代码」上传", async () => {
    const bare = await newProduct({});
    const r = await call("POST", "/api/analysis/architecture", {
      productId: bare.id,
    });
    expect(r.status).toBe(409);
    expect(errorOf(r)).toContain("事实底座 → 代码");
  });

  it("根级分析：提示词压住「技术分层」与「目录名当功能名」两种跑偏", async () => {
    const product = await newProduct({ codePath: "/代码库/alpha" });
    const started = (
      await call("POST", "/api/analysis/architecture", {
        productId: product.id,
      })
    ).body as { prompt: string; sessionId: string; title: string };
    expect(started.title).toBe("AI 分析功能架构：Alpha");
    expect(started.prompt).toContain("**一级功能**");
    expect(started.prompt).toContain("不是技术分层");
    expect(started.prompt).toContain("不要把目录名直接抄成功能名");
    expect(started.prompt).toContain("每条必须带代码证据");
    expect(started.prompt).toContain('<目录事实 根="/代码库/alpha">');
  });

  it("应用：嵌套结果整棵写进去，层级与证据都对", async () => {
    const product = await newProduct({ codePath: "/代码库/alpha" });
    const started = (
      await call("POST", "/api/analysis/architecture", {
        productId: product.id,
      })
    ).body as { sessionId: string };
    fakeAnswer(
      started.sessionId,
      jsonBlock({
        features: [
          {
            name: "接入",
            duty: "让客户把模型接进来",
            evidence: ["prd/", "verify/"],
            children: [
              { name: "Key 管理", duty: "发 key", evidence: ["prd/Key管理"] },
            ],
          },
          { name: "计费", duty: "算钱", evidence: ["prd/"] },
        ],
        uncertain: ["_archive 看不出是不是功能"],
      }),
    );
    const applied = await call(
      "POST",
      `/api/analysis/${started.sessionId}/apply-architecture`,
    );
    expect(applied.status).toBe(200);
    expect(applied.body?.created).toEqual(["接入", "Key 管理", "计费"]);

    const tree = await featureTree(product.id);
    expect(tree.map((n) => n.name)).toEqual(["接入", "计费"]);
    expect(tree[0]?.level).toBe(1);
    expect(tree[0]?.evidence).toEqual(["prd/", "verify/"]);
    expect(tree[0]?.children.map((c) => c.name)).toEqual(["Key 管理"]);
    expect(tree[0]?.source).toBe("ai");
  });

  it("向下拆一层（append）：只补不覆盖，已存在的同名跳过", async () => {
    const product = await newProduct({ codePath: "/代码库/alpha" });
    const first = (
      await call("POST", "/api/analysis/architecture", {
        productId: product.id,
      })
    ).body as { sessionId: string };
    fakeAnswer(
      first.sessionId,
      jsonBlock({
        features: [{ name: "接入", evidence: ["app/pages/login.vue"] }],
      }),
    );
    await call("POST", `/api/analysis/${first.sessionId}/apply-architecture`);
    const root = (await featureTree(product.id))[0];
    expect(root).toBeDefined();

    // 对「接入」拆一层
    const expand = (
      await call("POST", "/api/analysis/architecture", {
        productId: product.id,
        nodeId: root?.id,
        mode: "append",
      })
    ).body as { sessionId: string; prompt: string; title: string };
    expect(expand.title).toBe("AI 拆解功能：接入");
    // 提示词要交代「现在在拆哪一支」，否则模型不知道自己该产出第几层
    expect(expand.prompt).toContain("现在在拆哪一支");
    expect(expand.prompt).toContain("只拆最后那一个");

    fakeAnswer(
      expand.sessionId,
      jsonBlock({
        features: [
          { name: "Key 管理", evidence: ["app/pages"] },
          { name: "配额", evidence: ["app"] },
        ],
      }),
    );
    await call("POST", `/api/analysis/${expand.sessionId}/apply-architecture`);
    expect(
      (await featureTree(product.id))[0]?.children.map((c) => c.name),
    ).toEqual(["Key 管理", "配额"]);

    // 再拆一次、结果里有重名：跳过而不是报错，也不产生重复节点
    const again = (
      await call("POST", "/api/analysis/architecture", {
        productId: product.id,
        nodeId: root?.id,
        mode: "append",
      })
    ).body as { sessionId: string; prompt: string };
    // 已有的子功能要写进提示词，让它别重复产出
    expect(again.prompt).toContain("Key 管理、配额");
    fakeAnswer(
      again.sessionId,
      jsonBlock({
        features: [
          { name: "Key 管理" },
          { name: "审批", evidence: ["prd/审批"] },
        ],
      }),
    );
    const r = await call(
      "POST",
      `/api/analysis/${again.sessionId}/apply-architecture`,
    );
    expect(r.body).toMatchObject({ created: ["审批"], skipped: ["Key 管理"] });
    expect((await featureTree(product.id))[0]?.children).toHaveLength(3);
  });

  it("重新分析这一支（replace）：先清空再写，且事前点名手改过的节点", async () => {
    const product = await newProduct({ codePath: "/代码库/alpha" });
    const start = (
      await call("POST", "/api/analysis/architecture", {
        productId: product.id,
      })
    ).body as { sessionId: string };
    fakeAnswer(
      start.sessionId,
      jsonBlock({
        features: [
          {
            name: "接入",
            evidence: ["app"],
            children: [{ name: "旧子功能" }, { name: "另一个" }],
          },
        ],
      }),
    );
    await call("POST", `/api/analysis/${start.sessionId}/apply-architecture`);
    const root = (await featureTree(product.id))[0];
    const manual = root?.children[0];
    // 手改一个子节点：它应该被记成 manual
    await call("PATCH", `/api/feature-nodes/${manual?.id ?? ""}`, {
      duty: "我自己写的职责",
    });
    expect((await featureTree(product.id))[0]?.children[0]?.source).toBe(
      "manual",
    );

    const redo = (
      await call("POST", "/api/analysis/architecture", {
        productId: product.id,
        nodeId: root?.id,
        mode: "replace",
      })
    ).body as { sessionId: string; prompt: string; title: string };
    expect(redo.title).toBe("AI 重新分析功能：接入");
    // replace 时不把已有子功能喂进去（否则它会沿用上一轮的错）
    expect(redo.prompt).toContain("这是一次**重新分析**");

    fakeAnswer(redo.sessionId, jsonBlock({ features: [{ name: "全新的" }] }));
    // 取结果时要点名「会覆盖掉你手改过的这几个」
    const preview = await call("GET", `/api/analysis/${redo.sessionId}/result`);
    expect(preview.body?.manualAtRisk).toEqual(["旧子功能"]);

    await call("POST", `/api/analysis/${redo.sessionId}/apply-architecture`);
    expect(
      (await featureTree(product.id))[0]?.children.map((c) => c.name),
    ).toEqual(["全新的"]);
  });

  it("手工增删改；同一层不重名；删父连带删子", async () => {
    const product = await newProduct({ codePath: "/代码库/alpha" });
    const created = await call("POST", `/api/products/${product.id}/features`, {
      name: "手工功能",
      duty: "我加的",
      evidence: " prd/ \n\n verify/ ",
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ source: "manual", level: 1 });
    expect(created.body?.evidence).toEqual(["prd/", "verify/"]);

    const id = (created.body as { id: string }).id;
    const clash = await call("POST", `/api/products/${product.id}/features`, {
      name: "手工功能",
    });
    expect(clash.status).toBe(409);
    expect(errorOf(clash)).toBe("同一层下已有功能「手工功能」");

    // 一级与二级可以同名（不同层，不冲突）
    const child = await call("POST", `/api/products/${product.id}/features`, {
      name: "手工功能",
      parentId: id,
    });
    expect(child.status).toBe(201);

    expect((await call("DELETE", `/api/feature-nodes/${id}`)).status).toBe(204);
    expect(await featureTree(product.id)).toHaveLength(0);
  });

  it("节点的代码证据决定「向下拆一层」的扫描面", async () => {
    const product = await newProduct({ codePath: "/代码库" });
    const node = (
      await call("POST", `/api/products/${product.id}/features`, {
        name: "Alpha 的事",
        evidence: "alpha",
      })
    ).body as { id: string };
    const started = (
      await call("POST", "/api/analysis/architecture", {
        productId: product.id,
        nodeId: node.id,
      })
    ).body as { prompt: string };
    // 扫描面收窄到 /01-products/alpha，所以只看得到 alpha 下的东西
    expect(started.prompt).toContain('根="/代码库/alpha"');
    expect(started.prompt).toContain("login.vue");
    expect(started.prompt).not.toContain("main.go");
  });

  it("证据指向的路径读不到了：说清要去改证据，而不是静默退回整库", async () => {
    const product = await newProduct({ codePath: "/代码库" });
    const node = (
      await call("POST", `/api/products/${product.id}/features`, {
        name: "指向不存在的",
        evidence: "没有这个目录",
      })
    ).body as { id: string };
    const r = await call("POST", "/api/analysis/architecture", {
      productId: product.id,
      nodeId: node.id,
    });
    expect(r.status).toBe(409);
    expect(errorOf(r)).toContain("先改一下它的证据");
  });
});

/* ── 凭据防线与路径归属（评审发现的真风险，补回归） ──────────────── */

describe("凭据防线", () => {
  it("名字命中的凭据文件只报文件名、不报正文", async () => {
    const files = createFileStore(filesDir, openFilesIndex());
    const scan = await scanFolder(files, "/代码库/alpha", { maxDepth: 3 });
    // docker-compose.yml 按名字就拒，正文（含 POSTGRES_PASSWORD）绝不进 docs
    expect(scan.docs.map((d) => d.path)).not.toContain(
      "/代码库/alpha/docker-compose.yml",
    );
    expect(scan.skipped).toContainEqual({
      path: "/代码库/alpha/docker-compose.yml",
      reason: "名称疑似凭据文件",
    });
    expect(JSON.stringify(scan.docs)).not.toContain("hunter2");
  });

  it("名字无辜但正文像凭据的，照样只报名字", async () => {
    const files = createFileStore(filesDir, openFilesIndex());
    const scan = await scanFolder(files, "/代码库/alpha", { maxDepth: 3 });
    expect(scan.skipped).toContainEqual({
      path: "/代码库/alpha/config.json",
      reason: "正文疑似含凭据",
    });
    expect(JSON.stringify(scan.docs)).not.toContain("sk-abcdefghij");
  });

  it("提示词里如实写出「这些文件存在但没给正文」，免得模型当成缺失", async () => {
    const files = createFileStore(filesDir, openFilesIndex());
    const scan = await scanFolder(files, "/代码库/alpha", { maxDepth: 3 });
    const text = renderScan(scan);
    expect(text).toContain("疑似含凭据，只给文件名不给正文");
    expect(text).toContain("不要据此判断「缺少配置」");
    expect(text).not.toContain("hunter2");
  });

  it("发起分析的响应里把跳过的文件报给界面，不静默", async () => {
    const line = (await call("POST", "/api/product-lines", { name: "S1" }))
      .body as { id: string };
    const product = (
      await call("POST", `/api/product-lines/${line.id}/products`, {
        name: "Alpha",
        codePath: "/代码库/alpha",
      })
    ).body as { id: string };
    const started = await call("POST", "/api/analysis/architecture", {
      productId: product.id,
    });
    expect(started.body?.skippedDocs).toContainEqual({
      path: "/代码库/alpha/docker-compose.yml",
      reason: "名称疑似凭据文件",
    });
  });
});

describe("路径归属", () => {
  const newLine = async (name: string) =>
    (await call("POST", "/api/product-lines", { name })).body as { id: string };

  it("代码目录必须在 /代码库 下——指到文档库会被拒", async () => {
    const line = await newLine("P1");
    const r = await call("POST", `/api/product-lines/${line.id}/products`, {
      name: "X",
      codePath: "/01-products/alpha",
    });
    expect(r.status).toBe(400);
    expect(errorOf(r)).toContain("/代码库");
  });

  it("带 .. 的路径在入口就被拒，不是等采集时才报", async () => {
    const line = await newLine("P2");
    const r = await call("POST", `/api/product-lines/${line.id}/products`, {
      name: "X",
      folderPath: "/01-products/../../etc",
    });
    expect(r.status).toBe(400);
  });

  it("模型把证据写成 / 时越界被丢弃，退回产品自己的代码目录", async () => {
    const line = await newLine("P3");
    const product = (
      await call("POST", `/api/product-lines/${line.id}/products`, {
        name: "X",
        codePath: "/代码库/alpha",
      })
    ).body as { id: string };
    const node = (
      await call("POST", `/api/products/${product.id}/features`, {
        name: "越界的",
        // 「/」在库里是合法路径，但不在这个产品的代码目录内
        evidence: "/\n/01-products",
      })
    ).body as { id: string };
    const started = (
      await call("POST", "/api/analysis/architecture", {
        productId: product.id,
        nodeId: node.id,
      })
    ).body as { prompt: string };
    // 退回 /代码库/alpha，没有把文档库扫进来
    expect(started.prompt).toContain('根="/代码库/alpha"');
    expect(started.prompt).not.toContain("02-presales");
    expect(started.prompt).not.toContain("立项PR-FAQ.md");
  });

  it("证据指向文件时退到它所在的文件夹，而不是报「读不到」", async () => {
    const line = await newLine("P4");
    const product = (
      await call("POST", `/api/product-lines/${line.id}/products`, {
        name: "X",
        codePath: "/代码库/alpha",
      })
    ).body as { id: string };
    const node = (
      await call("POST", `/api/products/${product.id}/features`, {
        name: "指到文件",
        evidence: "app/pages/login.vue",
      })
    ).body as { id: string };
    const started = await call("POST", "/api/analysis/architecture", {
      productId: product.id,
      nodeId: node.id,
    });
    expect(started.status).toBe(201);
    expect((started.body as { prompt: string }).prompt).toContain(
      '根="/代码库/alpha/app/pages"',
    );
  });
});

describe("跨产品挂载（评审实测的数据错乱）", () => {
  it("把子功能挂到别的产品的节点下：拒绝", async () => {
    const mk = async (lineName: string) => {
      const line = (
        await call("POST", "/api/product-lines", { name: lineName })
      ).body as { id: string };
      return (
        await call("POST", `/api/product-lines/${line.id}/products`, {
          name: "P",
        })
      ).body as { id: string };
    };
    const a = await mk("X1");
    const b = await mk("X2");
    const nodeB = (
      await call("POST", `/api/products/${b.id}/features`, { name: "B 的功能" })
    ).body as { id: string };

    const bad = await call("POST", `/api/products/${a.id}/features`, {
      name: "想挂到 B 下面",
      parentId: nodeB.id,
    });
    expect(bad.status).toBe(400);
    expect(errorOf(bad)).toContain("不属于这个产品");

    // B 的树没有被污染
    const tree = (await call("GET", `/api/products/${b.id}/features`)).body
      ?.features as { children: unknown[] }[];
    expect(tree[0]?.children).toHaveLength(0);
  });
});
