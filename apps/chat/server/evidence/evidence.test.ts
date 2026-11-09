import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { IN_MEMORY, openDb, type Db } from "../db.js";
import {
  createFileStore,
  openFilesIndex,
  type FileStore,
} from "../files/store.js";
import { createCatalog } from "../products.js";
import { parseDocHead } from "./atlas.js";
import {
  EVIDENCE_CLOSE,
  EVIDENCE_OPEN,
  renderEvidenceBrief,
  splitEvidence,
} from "./brief.js";
import { createModelExpander, parseTerms } from "./expand.js";
import { createEvidenceService, type BriefState } from "./index.js";
import { extractKeywords, mergeKeywords } from "./keywords.js";
import { resolveLibrary } from "./library.js";
import { rankEntries } from "./locate.js";
import { pickTiered, renderTieredBrief } from "./tiers.js";

/**
 * 事实依据是平台规范的基础组件：AI 每次干活前拿到的依据就是它挑的。
 *
 * 这个服务里它比在别处更要紧——对话会话**没有文件工具**（`noTools: "all"`），
 * 所以依据只能靠这里把正文读出来喂进去。守四件事：
 *   ① 依据库 = 产品绑定的目录，绑了但找不到的要如实报；
 *   ② 按任务能从文件里挑对（跨中英文），并带上正文；
 *   ③ 手选范围只能缩小，不能凭空扩权；
 *   ④ 交给 AI 的清单带规则、续聊不重复、短句不打扰。
 */

let dir: string;
let files: FileStore;
let index: Db;
let db: Db;

function write(path: string, body: string): void {
  const abs = join(files.root, ...path.split("/").filter(Boolean));
  mkdirSync(join(abs, ".."), { recursive: true });
  // 直接落盘再让 store 自己索引：与用户从 Finder 放进去是同一条路。
  writeFileSync(abs, body);
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-ev-")));
  db = openDb(IN_MEMORY);
  index = openFilesIndex();
  files = createFileStore(join(dir, "files"), index);
});

afterEach(() => {
  db.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 建产品：文档目录 / 代码目录 / 参考资料三样都挂上。 */
async function seedProduct(): Promise<string> {
  for (const [path, body] of [
    ["/文档/计费/退款流程.md", "# 退款流程\n\n## 审批\n用户发起退款后……"],
    ["/文档/计费/充值.md", "# 充值\n\n## 支付渠道"],
    ["/文档/登录/登录方式.md", "# 登录方式\n短信、扫码"],
    ["/代码库/src/billing/refund.ts", "export function refundOrder() {}\n"],
    ["/代码库/src/billing/topup.ts", "export function topup() {}\n"],
    ["/代码库/src/auth/login.ts", "export function login() {}\n"],
  ] as const) {
    write(path, body);
  }
  // 让索引看到这些文件：list 一层就会对齐该层索引（磁盘是真相源，索引按需对齐）。
  for (const p of [
    "/文档",
    "/文档/计费",
    "/文档/登录",
    "/代码库",
    "/代码库/src",
    "/代码库/src/billing",
    "/代码库/src/auth",
  ]) {
    await files.list(p);
  }
  const catalog = createCatalog(db);
  const line = catalog.createLine({ name: "产品线" });
  const product = catalog.createProduct(line.id, {
    name: "RouteHub",
    folderPath: "/文档",
    codePath: "/代码库",
    refPaths: ["/文档/登录/登录方式.md"],
  });
  return product.id;
}

describe("依据库", () => {
  it("取产品绑定的目录；绑了但找不到的如实报出来", async () => {
    await seedProduct();
    const catalog = createCatalog(db);
    const line = catalog.list()[0];
    if (line === undefined) throw new Error("没有产品线");
    const product = line.products[0];
    if (product === undefined) throw new Error("没有产品");
    catalog.updateProduct(product.id, { refPaths: ["/不存在/的文件"] });

    const lib = resolveLibrary(createCatalog(db), product.id, (p) =>
      files.exists(p),
    );
    expect(lib.productName).toBe("RouteHub");
    expect(lib.sources.map((s) => [s.kind, s.path])).toEqual([
      ["doc", "/文档"],
      ["code", "/代码库"],
    ]);
    expect(lib.missing).toEqual(["/不存在/的文件"]);
  });

  it("没有产品语境：空库", () => {
    const lib = resolveLibrary(createCatalog(db), null, (p) => files.exists(p));
    expect(lib.productName).toBeNull();
    expect(lib.sources).toEqual([]);
  });
});

describe("关键词", () => {
  it("中文整段 + 英文拆驼峰，套话被过滤", () => {
    const terms = extractKeywords(
      "请用 generate-prd 方法论，为退款审批撰写产出物 billingRefund",
    ).map((k) => k.term);
    expect(terms).toContain("退款审批");
    expect(terms).toContain("refund");
    expect(terms).not.toContain("方法");
    expect(terms).not.toContain("prd");
  });

  it("合并去重，同词取最高权重", () => {
    expect(
      mergeKeywords(
        [{ term: "Refund", weight: 3 }],
        [{ term: "refund", weight: 1 }],
      ),
    ).toEqual([{ term: "refund", weight: 3 }]);
  });

  it("文档标题：front-matter 优先，章节截取", () => {
    expect(parseDocHead("---\ntitle: 退款流程\n---\n# 别的\n## 审批")).toEqual({
      title: "退款流程",
      headings: ["别的", "审批"],
    });
  });
});

describe("打分", () => {
  it("路径、标题、正文命中都算分；文档与代码都能被抓到", () => {
    const source = {
      key: "/文档",
      kind: "doc" as const,
      path: "/文档",
      label: "文档目录",
      isFile: false,
    };
    const hits = rankEntries({
      entries: [
        {
          path: "/文档/计费/退款流程.md",
          sourceKey: "/文档",
          isDoc: true,
          title: "退款流程",
          headings: ["审批"],
        },
        {
          path: "/文档/登录/登录方式.md",
          sourceKey: "/文档",
          isDoc: true,
          title: "登录方式",
          headings: [],
        },
      ],
      keywords: [
        { term: "退款", weight: 3 },
        { term: "refund", weight: 3 },
      ],
      content: new Map([["/文档/计费/退款流程.md", new Set(["退款"])]]),
      sources: new Map([["/文档", source]]),
    });
    expect(hits[0]?.path).toBe("/文档/计费/退款流程.md");
    expect(hits[0]?.matched).toContain("退款");
    expect(hits.some((h) => h.path.includes("登录"))).toBe(false);
  });
});

describe("定位与清单", () => {
  const service = (expand?: (input: { task: string }) => Promise<string[]>) =>
    createEvidenceService({
      files,
      catalog: createCatalog(db),
      ...(expand === undefined ? {} : { expand }),
    });

  it("扩写词让中文任务命中英文代码路径；正文一并带上", async () => {
    const id = await seedProduct();
    const svc = service(() => Promise.resolve(["退款", "refund"]));
    const r = await svc.locate({ productId: id }, "写一份退款 PRD");
    const paths = r.files.map((f) => f.path);
    expect(paths[0]).toBe("/文档/计费/退款流程.md");
    expect(paths).toContain("/代码库/src/billing/refund.ts");
    expect(paths).not.toContain("/代码库/src/auth/login.ts");
    // 正文必须带上：这个服务里 AI 读不到文件。
    expect(r.files[0]?.content).toContain("退款流程");
  });

  it("扩写失败退回本地关键词，文档仍能定位", async () => {
    const id = await seedProduct();
    const svc = service(() => Promise.reject(new Error("down")));
    const r = await svc.locate({ productId: id }, "写一份退款 PRD");
    expect(r.files[0]?.path).toBe("/文档/计费/退款流程.md");
  });

  it("手选范围只能缩小：库外路径不认", async () => {
    const id = await seedProduct();
    const svc = service(() => Promise.resolve(["登录", "login"]));
    const lib = svc.library({ productId: id, scope: ["/代码库", "/etc"] });
    expect(lib.sources.map((s) => s.path)).toEqual(["/代码库"]);
  });

  it("清单：首轮带规则与范围，续聊只补新的，短句不打扰", async () => {
    const id = await seedProduct();
    const svc = service(() => Promise.resolve(["退款", "refund"]));
    const state: BriefState = { first: true, given: new Set() };

    const first = await svc.brief({ productId: id }, "写一份退款 PRD", state);
    const split = splitEvidence(`${first ?? ""}\n\n正文`);
    expect(split.body).toBe("正文");
    expect(split.brief).toContain("【本次事实依据】");
    expect(split.brief).toContain("退款流程.md");
    expect(split.brief).toContain("依据范围");
    expect(split.brief).toContain("<事实来源");
    expect(split.brief).toContain("待核实");
    expect(state.first).toBe(false);

    expect(await svc.brief({ productId: id }, "继续", state)).toBeNull();
    expect(
      await svc.brief({ productId: id }, "再看看退款 PRD 的细节", state),
    ).toBeNull();
  });

  it("消息自带依据段（入口已按任务分层精选）：不再另定位，只记下给过的文件", async () => {
    const id = await seedProduct();
    const svc = service(() => Promise.resolve(["退款", "refund"]));
    const state: BriefState = { first: true, given: new Set() };
    const own = `${EVIDENCE_OPEN}\n<事实来源 路径="/文档/计费/退款流程.md" 层级="PRD">\n正文\n</事实来源>\n${EVIDENCE_CLOSE}\n\n写一份退款 PRD`;
    expect(await svc.brief({ productId: id }, own, state)).toBeNull();
    expect(state.first).toBe(false);
    expect([...state.given]).toEqual(["/文档/计费/退款流程.md"]);
    // 续聊时不会把同一份再塞一遍。
    const next = await svc.brief(
      { productId: id },
      "退款流程里审批那一段再展开说说",
      state,
    );
    expect(next ?? "").not.toContain('路径="/文档/计费/退款流程.md"');
  });

  it("依据分层：代码 > PRD > 其他；归档目录排除；每层各自封顶，没用完的让给别层", () => {
    const file = (path: string, kind: "doc" | "code", score: number) => ({
      path,
      kind,
      sourceLabel: "x",
      title: null,
      matched: ["退款"],
      score,
      content: "x".repeat(100),
      truncated: false,
    });
    const tiered = pickTiered(
      [
        {
          library: {
            product: null,
            productName: "A",
            sources: [],
            missing: [],
          },
          searched: [],
          keywords: [],
          hits: [],
          files: [
            file("/文档/prd/退款.md", "doc", 9),
            file("/文档/roadmap.md", "doc", 8),
            file("/文档/_archive/旧退款.md", "doc", 99),
            file("/代码库/refund.ts", "code", 5),
            file("/文档/规格/需求规格-退款.md", "doc", 3),
          ],
          skipped: [],
          truncated: [],
          elapsedMs: 0,
        },
      ],
      {
        prdPaths: new Set(),
        budgets: { code: 1000, prd: 150, other: 1000 },
      },
    );
    // 按层排：代码 → PRD → 其他，层内按分数。
    expect(tiered.files.map((f) => [f.path, f.tier])).toEqual([
      ["/代码库/refund.ts", "code"],
      ["/文档/prd/退款.md", "prd"],
      ["/文档/规格/需求规格-退款.md", "prd"],
      ["/文档/roadmap.md", "other"],
    ]);
    // PRD 层预算 150：第二份只剩 50 字（别层没用完的只让给「整份超出」的，不补截断的）。
    expect(
      tiered.files.find((f) => f.path === "/文档/规格/需求规格-退款.md")
        ?.content,
    ).toHaveLength(50);
    expect(tiered.stale).toBe(1);
    const text = renderTieredBrief(tiered);
    expect(text.startsWith(EVIDENCE_OPEN)).toBe(true);
    expect(text.indexOf("第一层 · 代码")).toBeLessThan(
      text.indexOf("第二层 · PRD"),
    );
    expect(text).toContain("附上的代码里找不到 ≠ 代码里没有");
  });

  it("代码层没命中几份：空出的预算让给 PRD 层里超出的", () => {
    const doc = (path: string, score: number) => ({
      path,
      kind: "doc" as const,
      sourceLabel: "x",
      title: null,
      matched: ["退款"],
      score,
      content: "x".repeat(100),
      truncated: false,
    });
    const tiered = pickTiered(
      [
        {
          library: {
            product: null,
            productName: "A",
            sources: [],
            missing: [],
          },
          searched: [],
          keywords: [],
          hits: [],
          files: [
            doc("/prd/a.md", 3),
            doc("/prd/b.md", 2),
            doc("/prd/c.md", 1),
          ],
          skipped: [],
          truncated: [],
          elapsedMs: 0,
        },
      ],
      { prdPaths: new Set(), budgets: { code: 150, prd: 100, other: 0 } },
    );
    expect(tiered.files.map((f) => f.path)).toEqual([
      "/prd/a.md",
      "/prd/b.md",
      "/prd/c.md",
    ]);
    expect(tiered.files[2]?.content).toHaveLength(50);
    expect(tiered.dropped).toEqual({ code: 0, prd: 0, other: 0 });
  });

  it("有产品但没绑依据：首轮明说，让 AI 标待核实", async () => {
    const catalog = createCatalog(db);
    const line = catalog.createLine({ name: "线" });
    const product = catalog.createProduct(line.id, { name: "空产品" });
    const svc = service();
    const text = await svc.brief({ productId: product.id }, "写 PRD", {
      first: true,
      given: new Set(),
    });
    expect(text).toContain("还没有绑定任何事实依据");
  });

  it("普通对话（不属于任何产品）：不注入", async () => {
    const svc = service();
    expect(
      await svc.brief({ productId: null }, "随便聊聊天气", {
        first: true,
        given: new Set(),
      }),
    ).toBeNull();
  });

  it("疑似凭据：只报路径，不附正文", async () => {
    const id = await seedProduct();
    write(
      "/文档/退款私钥.md",
      "# 退款\n\nsk-abcdefghijklmnopqrstuvwxyz123456\n",
    );
    await files.list("/文档");
    const svc = service(() => Promise.resolve(["退款"]));
    const r = await svc.locate({ productId: id }, "退款怎么做");
    expect(r.skipped.map((s) => s.path)).toContain("/文档/退款私钥.md");
    expect(r.files.some((f) => f.path === "/文档/退款私钥.md")).toBe(false);
    const text = renderEvidenceBrief(r, { first: true, task: "退款" });
    expect(text).toContain("只记了路径没附正文");
  });
});

describe("真实仓库口径（在 RouteHub 上调出来的三条）", () => {
  const source = {
    key: "/代码库",
    kind: "code" as const,
    path: "/代码库",
    label: "代码目录",
    isFile: false,
  };
  const entry = (path: string, isDoc = false) => ({
    path,
    sourceKey: "/代码库",
    isDoc,
    title: null,
    headings: [],
  });
  const rank = (paths: { path: string; isDoc?: boolean }[]) =>
    rankEntries({
      entries: paths.map((p) => entry(p.path, p.isDoc)),
      keywords: [{ term: "approval", weight: 3 }],
      content: new Map(),
      sources: new Map([["/代码库", source]]),
    });

  it("代码目录里的说明文档算「文档」，不占代码名额", () => {
    const hits = rank([
      { path: "/代码库/docs/approval.md", isDoc: true },
      { path: "/代码库/src/approval.go" },
    ]);
    expect(hits.find((h) => h.path.endsWith(".md"))?.kind).toBe("doc");
    expect(hits.find((h) => h.path.endsWith(".go"))?.kind).toBe("code");
  });

  it("测试文件与归档目录降权，排在正式实现之后", () => {
    const hits = rank([
      { path: "/代码库/src/approval_test.go" },
      { path: "/代码库/_archive/approval.go" },
      { path: "/代码库/src/approval.go" },
    ]);
    expect(hits[0]?.path).toBe("/代码库/src/approval.go");
  });

  it("依赖目录（node_modules 等）不进地图", async () => {
    write("/代码库/node_modules/x/approval.js", "export const approval = 1;");
    write("/代码库/src/approval.ts", "export const approval = 1;");
    await files.list("/代码库");
    await files.list("/代码库/src");
    await files.list("/代码库/node_modules");
    await files.list("/代码库/node_modules/x");
    const { createAtlas } = await import("./atlas.js");
    const { entries } = await createAtlas(files).entriesFor([source]);
    expect(entries.map((e) => e.path)).toEqual(["/代码库/src/approval.ts"]);
  });
});

describe("扩写", () => {
  it("从模型回复里捞数组，容忍前后废话", () => {
    expect(parseTerms('好的：["退款","refund"] 完')).toEqual([
      "退款",
      "refund",
    ]);
    expect(parseTerms("不是数组")).toEqual([]);
  });

  it("没配模型返回空，超时也返回空", async () => {
    const none = createModelExpander(() => undefined);
    expect(await none({ task: "a", productName: null, local: [] })).toEqual([]);
    const slow = createModelExpander(
      () => () => new Promise<string>(() => undefined),
      10,
    );
    expect(await slow({ task: "a", productName: null, local: [] })).toEqual([]);
  });
});
