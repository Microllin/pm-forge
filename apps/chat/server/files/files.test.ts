import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { join } from "node:path";

import { strFromU8, unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { IN_MEMORY, openDb, type Db } from "../db.js";
import { createKeyStore } from "../model-config.js";
import { piPaths } from "../pi/runtime.js";
import { createSkillStore } from "../skills.js";
import { detectKind, looksLikeText } from "./kinds.js";
import { assertValidName, normalizePath } from "./paths.js";
import {
  createFileStore,
  openFilesIndex,
  type FileEntry,
  type FileItem,
  type BatchResult,
  type SearchHit,
} from "./store.js";

describe("类型判定", () => {
  it("UTF-8 文本：从大文件截出的样本断在中文字符中间也算文本", () => {
    const text = Buffer.from("中文内容".repeat(10));
    expect(looksLikeText(text.subarray(0, text.length - 1), true)).toBe(true);
    expect(looksLikeText(Buffer.alloc(0))).toBe(true);
  });

  it("空字节多、非法 UTF-8、PDF 文件头：都不是文本", () => {
    expect(looksLikeText(Buffer.from([0x41, 0, 0, 0, 0x42, 0, 0, 0]))).toBe(
      false,
    );
    expect(looksLikeText(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(false); // latin1 的 café
    expect(looksLikeText(Buffer.from("%PDF-1.4\nplain ascii body"))).toBe(
      false,
    );
  });

  it("扩展名分大类，像文本的再看内容", () => {
    const text = Buffer.from("hello");
    expect(detectKind("a.md", text)).toBe("markdown");
    expect(detectKind("a.HTML", text)).toBe("html");
    expect(detectKind("a.ts", text)).toBe("text");
    expect(detectKind("Makefile", text)).toBe("text");
    expect(detectKind("a.png", text)).toBe("image");
    expect(detectKind("a.svg", text)).toBe("image");
    expect(detectKind("a.pdf", Buffer.from("%PDF-1.7"))).toBe("pdf");
    expect(detectKind("a.pdf", text)).toBe("other"); // 扩展名是 pdf、内容不是
    expect(detectKind("a.docx", text)).toBe("other"); // 已知二进制格式不嗅探
    expect(detectKind("a.md", Buffer.from([0, 0, 0, 0]))).toBe("other");
  });
});

describe("路径与名称", () => {
  it("规范化；拒绝 . 与 ..", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("a//b/")).toBe("/a/b");
    expect(() => normalizePath("/a/../b")).toThrow("路径不能包含 . 或 ..");
    expect(() => normalizePath("/a\\b")).toThrow("路径包含非法字符");
  });

  it("隐藏文件按路径也访问不到（列表过滤不等于读删过滤）", () => {
    // 列表里看不见 .git / .env，不代表按路径读不到；克隆下来的仓库必然带 .git/config，
    // 里面常有 token。读写删共用 normalizePath，这一处挡住就都挡住了。
    for (const p of [
      "/代码库/repo/.git/config",
      "/产品/.env",
      "/产品/a/.npmrc",
    ]) {
      expect(() => normalizePath(p), p).toThrow("隐藏文件不能在这里访问");
    }
    // 正常的点号出现在名字中间不受影响。
    expect(normalizePath("/产品/v1.2 说明.md")).toBe("/产品/v1.2 说明.md");
  });

  it("名称：不能为空、不能有斜杠、不能以点开头、首尾不能有空格", () => {
    expect(() => {
      assertValidName(" ");
    }).toThrow("名称不能为空");
    expect(() => {
      assertValidName("a/b");
    }).toThrow("名称不能包含 / 或 \\");
    expect(() => {
      assertValidName(".env");
    }).toThrow("名称不能以 . 开头");
    expect(() => {
      assertValidName(" a");
    }).toThrow("名称首尾不能有空格");
    expect(() => {
      assertValidName("需求 v1.md");
    }).not.toThrow();
  });
});

/* ── 接口（真实目录 + 真实 HTTP） ───────────────────────────────────────── */

const HOST = "127.0.0.1:4400";
let dir: string;
let root: string;
let db: Db;
let index: Db;
let app: ReturnType<typeof createApp>["app"];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-files-")));
  root = join(dir, "files");
  mkdirSync(root);
  db = openDb(IN_MEMORY);
  index = openFilesIndex();
  ({ app } = createApp({
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
    security: { port: 4400, webPort: 3200, extraOrigins: [] },
  }));
});
afterEach(async () => {
  await app.close();
  db.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

const q = (path: string) => encodeURIComponent(path);

async function put(
  path: string,
  body: string | Buffer,
  mode = "create",
  headers: Record<string, string> = {},
) {
  const res = await app.inject({
    method: "PUT",
    url: `/api/files/content?path=${q(path)}&mode=${mode}`,
    headers: {
      host: HOST,
      "content-type": "application/octet-stream",
      ...headers,
    },
    payload: typeof body === "string" ? Buffer.from(body) : body,
  });
  return {
    status: res.statusCode,
    body: res.json<{
      entry: FileEntry;
      created: boolean;
      error?: { message: string };
    }>(),
  };
}
async function call(
  method: "GET" | "POST" | "DELETE",
  url: string,
  payload?: object,
) {
  const res = await app.inject({
    method,
    url,
    headers: { host: HOST },
    ...(payload ? { payload } : {}),
  });
  return { status: res.statusCode, res };
}
const list = async (path = "/") =>
  (await call("GET", `/api/files/list?path=${q(path)}`)).res.json<{
    entries: FileEntry[];
  }>().entries;
const names = async (path = "/") => (await list(path)).map((e) => e.name);
const search = async (term: string) =>
  (await call("GET", `/api/files/search?q=${q(term)}`)).res.json<{
    hits: SearchHit[];
  }>().hits;
const errorOf = (r: { res: { json: () => unknown } }) =>
  (r.res.json() as { error: { message: string } }).error.message;

describe("文件夹", () => {
  it("新建（可嵌套）；列表文件夹在前、按名称排序；同名 409", async () => {
    expect(await names()).toEqual([]);
    expect(
      (await call("POST", "/api/files/folders", { path: "/PRD" })).status,
    ).toBe(201);
    expect(
      (await call("POST", "/api/files/folders", { path: "/PRD/2026" })).status,
    ).toBe(201);
    await put("/说明.md", "# hi");
    await call("POST", "/api/files/folders", { path: "/素材" });
    expect(await names()).toEqual(["PRD", "素材", "说明.md"]);
    expect(await names("/PRD")).toEqual(["2026"]);

    const dup = await call("POST", "/api/files/folders", { path: "/PRD" });
    expect(dup.status).toBe(409);
    expect(errorOf(dup)).toBe("已有同名的文件或文件夹「PRD」");
    expect(
      (await call("POST", "/api/files/folders", { path: "/不存在/子" })).status,
    ).toBe(404);
  });

  it("删除：非空文件夹不带 recursive 时 409 且什么都不删；带上才删", async () => {
    await call("POST", "/api/files/folders", { path: "/A" });
    await call("POST", "/api/files/folders", { path: "/A/B" });
    await put("/A/B/x.md", "x");
    await put("/A/y.txt", "y");
    const blocked = await call("DELETE", `/api/files/entry?path=${q("/A")}`);
    expect(blocked.status).toBe(409);
    expect(errorOf(blocked)).toBe("文件夹「A」里还有 1 个文件夹、2 个文件");
    expect(existsSync(join(root, "A/B/x.md"))).toBe(true);

    expect(
      (await call("DELETE", `/api/files/entry?path=${q("/A")}&recursive=1`))
        .status,
    ).toBe(204);
    expect(await names()).toEqual([]);
    expect(
      (await call("DELETE", `/api/files/entry?path=${q("/A")}`)).status,
    ).toBe(404);
  });
});

describe("文件", () => {
  it("上传：create 同名 409；autorename 自动改成「名称 (1)」；overwrite 覆盖", async () => {
    const first = await put("/周会.md", "# 第一版");
    expect(first.status).toBe(201);
    expect(first.body.entry).toMatchObject({
      name: "周会.md",
      kind: "markdown",
      isDir: false,
      size: 11,
    });

    const dup = await put("/周会.md", "# 又一份");
    expect(dup.status).toBe(409);
    expect(dup.body.error?.message).toBe("已有同名的文件或文件夹「周会.md」");

    expect((await put("/周会.md", "副本", "autorename")).body.entry.name).toBe(
      "周会 (1).md",
    );
    expect((await put("/周会.md", "副本", "autorename")).body.entry.name).toBe(
      "周会 (2).md",
    );

    const over = await put("/周会.md", "# 第二版", "overwrite");
    expect(over.status).toBe(200);
    expect(over.body.created).toBe(false);
    expect(readFileSync(join(root, "周会.md"), "utf8")).toBe("# 第二版");
  });

  it("文本类带内容返回；二进制不带并说明原因；空文件内容是空串", async () => {
    await put("/a.md", "# 标题\n正文");
    await put(
      "/img.png",
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0]),
    );
    await put("/空.txt", "");
    const md = (
      await call("GET", `/api/files/item?path=${q("/a.md")}&content=1`)
    ).res.json<FileItem>();
    expect(md).toMatchObject({ kind: "markdown", content: "# 标题\n正文" });
    const png = (
      await call("GET", `/api/files/item?path=${q("/img.png")}&content=1`)
    ).res.json<FileItem>();
    expect(png).toMatchObject({
      kind: "image",
      content: null,
      contentOmitted: "not-text",
    });
    const empty = (
      await call("GET", `/api/files/item?path=${q("/空.txt")}&content=1`)
    ).res.json<FileItem>();
    expect(empty).toMatchObject({ kind: "text", content: "" });
    // 不要内容时不读文件
    expect(
      (
        await call("GET", `/api/files/item?path=${q("/a.md")}`)
      ).res.json<FileItem>().content,
    ).toBeNull();
  });

  it("保存带 If-Match：期间被改过就 412、文件保持原样；版本对得上才覆盖", async () => {
    const { entry } = (await put("/doc.md", "v1")).body;
    // 模拟别处（Finder / 另一个窗口）改了文件：内容长度变了，版本随之变化。
    writeFileSync(join(root, "doc.md"), "v2 改过了");
    const stale = await put("/doc.md", "我的修改", "overwrite", {
      "if-match": `"${entry.version}"`,
    });
    expect(stale.status).toBe(412);
    expect(stale.body.error?.message).toBe(
      "文件在你打开之后被修改过，请重新打开后再保存",
    );
    expect(readFileSync(join(root, "doc.md"), "utf8")).toBe("v2 改过了");

    const fresh = (
      await call("GET", `/api/files/item?path=${q("/doc.md")}`)
    ).res.json<FileItem>();
    expect(
      (
        await put("/doc.md", "我的修改", "overwrite", {
          "if-match": fresh.version,
        })
      ).status,
    ).toBe(200);
    expect(readFileSync(join(root, "doc.md"), "utf8")).toBe("我的修改");
  });

  it("写入是原子的：目录里不会残留临时文件", async () => {
    await put("/a.md", "1");
    await put("/a.md", "2", "overwrite");
    await put("/a.md", "3", "autorename");
    await put("/a.md", "4"); // 409
    expect(readdirSync(root).sort()).toEqual(["a (1).md", "a.md"]);
  });

  it("移动 / 改名；目标已存在 409；文件夹不能移进自己里面", async () => {
    await call("POST", "/api/files/folders", { path: "/A" });
    await call("POST", "/api/files/folders", { path: "/A/B" });
    await put("/x.md", "x");
    await put("/A/y.md", "y");

    const renamed = await call("POST", "/api/files/move", {
      from: "/x.md",
      to: "/改名后.md",
    });
    expect(renamed.res.json<FileEntry>()).toMatchObject({
      path: "/改名后.md",
      kind: "markdown",
    });
    expect(
      (
        await call("POST", "/api/files/move", {
          from: "/改名后.md",
          to: "/A/改名后.md",
        })
      ).status,
    ).toBe(200);
    expect(await names("/A")).toEqual(["B", "y.md", "改名后.md"]);

    const clash = await call("POST", "/api/files/move", {
      from: "/A/改名后.md",
      to: "/A/y.md",
    });
    expect(clash.status).toBe(409);
    expect(errorOf(clash)).toBe("目标位置已有「y.md」");

    const intoSelf = await call("POST", "/api/files/move", {
      from: "/A",
      to: "/A/B/A",
    });
    expect(intoSelf.status).toBe(400);
    expect(errorOf(intoSelf)).toBe("不能把文件夹移动到它自己里面");

    // 只改大小写：在大小写不敏感的文件系统（macOS 默认）上目标「已存在」的就是它自己
    expect(
      (
        await call("POST", "/api/files/move", {
          from: "/A/y.md",
          to: "/A/Y.md",
        })
      ).status,
    ).toBe(200);
    expect(await names("/A")).toContain("Y.md");

    // 整个文件夹移走后，子树在搜索里跟着换路径
    expect(
      (await call("POST", "/api/files/move", { from: "/A", to: "/新A" }))
        .status,
    ).toBe(200);
    expect((await search("改名后")).map((h) => h.path)).toEqual([
      "/新A/改名后.md",
    ]);
  });
});

describe("在线查看的安全头", () => {
  it("文本类（含 HTML、Markdown）以 text/plain 下发，带 nosniff 与 sandbox CSP", async () => {
    await put("/页面.html", "<script>alert(1)</script>");
    const res = (await call("GET", `/api/files/raw?path=${q("/页面.html")}`))
      .res;
    expect(res.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toMatch(/^sandbox;/);
    expect(res.body).toBe("<script>alert(1)</script>");
  });

  it("SVG 以图片类型下发但同样带 sandbox CSP；PDF 不带（否则内置阅读器打不开）", async () => {
    await put(
      "/图.svg",
      "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    );
    await put("/规格.pdf", "%PDF-1.4\n%%EOF");
    const svg = (await call("GET", `/api/files/raw?path=${q("/图.svg")}`)).res;
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(svg.headers["content-security-policy"]).toMatch(/^sandbox;/);
    const pdf = (await call("GET", `/api/files/raw?path=${q("/规格.pdf")}`))
      .res;
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.headers["content-security-policy"]).toBeUndefined();
  });

  it("地址末尾的文件名只给浏览器看，定位以 path 为准", async () => {
    await put("/规格.pdf", "%PDF-1.4\n%%EOF");
    const res = (
      await call(
        "GET",
        `/api/files/raw/${q("任意名字.pdf")}?path=${q("/规格.pdf")}`,
      )
    ).res;
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
  });

  it("下载：attachment，中文文件名走 RFC 5987", async () => {
    await put("/需求文档.md", "x");
    const res = (
      await call("GET", `/api/files/raw?path=${q("/需求文档.md")}&download=1`)
    ).res;
    expect(res.headers["content-disposition"]).toBe(
      `attachment; filename="____.md"; filename*=UTF-8''${encodeURIComponent("需求文档.md")}`,
    );
  });
});

describe("路径安全", () => {
  it("带 .. 的路径一律 400，不会读到根目录外", async () => {
    writeFileSync(join(dir, "secret.txt"), "机密");
    const res = await call(
      "GET",
      `/api/files/item?path=${q("/../secret.txt")}&content=1`,
    );
    expect(res.status).toBe(400);
  });

  it("根目录里指向外面的软链：列表里看不到，按路径访问也被拒", async () => {
    mkdirSync(join(dir, "outside"));
    writeFileSync(join(dir, "outside", "secret.txt"), "机密");
    symlinkSync(join(dir, "outside"), join(root, "捷径"));
    expect(await names()).toEqual([]);
    const res = await call(
      "GET",
      `/api/files/item?path=${q("/捷径/secret.txt")}&content=1`,
    );
    expect(res.status).toBe(400);
    expect(errorOf(res)).toBe("路径包含符号链接，不支持访问");
    expect((await put("/捷径/new.md", "x")).status).toBe(400);
  });

  it("以点开头的名字不能新建；隐藏文件不出现在列表里", async () => {
    expect((await put("/.env", "x")).status).toBe(400);
    writeFileSync(join(root, ".DS_Store"), "x");
    expect(await names()).toEqual([]);
  });

  it("外站 Origin 的写请求被安全闸挡下", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/files/content?path=${q("/a.md")}`,
      headers: {
        host: HOST,
        origin: "https://evil.example",
        "content-type": "application/octet-stream",
      },
      payload: Buffer.from("x"),
    });
    expect(res.statusCode).toBe(403);
    expect(existsSync(join(root, "a.md"))).toBe(false);
  });
});

describe("索引（磁盘是真相源）", () => {
  it("在磁盘上直接加 / 删的文件：列一次目录就对齐，搜索随之更新", async () => {
    await call("POST", "/api/files/folders", { path: "/PRD" });
    writeFileSync(join(root, "PRD", "外部新增.md"), "# 外部");
    // 还没列过这一层：索引里没有
    expect(await search("外部")).toEqual([]);
    expect(await names("/PRD")).toEqual(["外部新增.md"]);
    expect((await search("外部")).map((h) => [h.path, h.match])).toEqual([
      ["/PRD/外部新增.md", "name"],
    ]);

    rmSync(join(root, "PRD", "外部新增.md"));
    expect(await names("/PRD")).toEqual([]);
    expect(await search("外部")).toEqual([]);
  });

  it("重建索引覆盖整棵树；搜索不把 % _ 当通配符", async () => {
    mkdirSync(join(root, "a", "b"), { recursive: true });
    writeFileSync(join(root, "a", "b", "深处_文件.md"), "x");
    writeFileSync(join(root, "100%.txt"), "x");
    expect(
      (await call("POST", "/api/files/reindex")).res.json<{ count: number }>()
        .count,
    ).toBe(4);
    expect((await search("深处")).map((h) => h.path)).toEqual([
      "/a/b/深处_文件.md",
    ]);
    expect((await search("%")).map((h) => h.name)).toEqual(["100%.txt"]);
  });
});

describe("复制", () => {
  it("同一文件夹里复制：自动改名为「名称 (1)」；复制到别处保持原名", async () => {
    await call("POST", "/api/files/folders", { path: "/归档" });
    await put("/周会.md", "# 周会");
    const same = await call("POST", "/api/files/copy", {
      from: "/周会.md",
      to: "/周会.md",
    });
    expect(same.status).toBe(201);
    expect(same.res.json<FileEntry>().name).toBe("周会 (1).md");
    const other = await call("POST", "/api/files/copy", {
      from: "/周会.md",
      to: "/归档/周会.md",
    });
    expect(other.res.json<FileEntry>().path).toBe("/归档/周会.md");
    expect(readFileSync(join(root, "归档", "周会.md"), "utf8")).toBe("# 周会");
  });

  it("复制文件夹连同内容；软链不复制；不能复制进自己里面；不留临时文件", async () => {
    mkdirSync(join(root, "A", "B"), { recursive: true });
    writeFileSync(join(root, "A", "B", "x.md"), "x");
    writeFileSync(join(root, "A", "y.txt"), "y");
    mkdirSync(join(dir, "outside"));
    symlinkSync(join(dir, "outside"), join(root, "A", "捷径"));
    const copied = await call("POST", "/api/files/copy", {
      from: "/A",
      to: "/A",
    });
    expect(copied.res.json<FileEntry>()).toMatchObject({
      name: "A (1)",
      isDir: true,
    });
    expect(readFileSync(join(root, "A (1)", "B", "x.md"), "utf8")).toBe("x");
    expect(readdirSync(join(root, "A (1)")).sort()).toEqual(["B", "y.txt"]);

    const intoSelf = await call("POST", "/api/files/copy", {
      from: "/A",
      to: "/A/B/A",
    });
    expect(intoSelf.status).toBe(400);
    expect(errorOf(intoSelf)).toBe("不能把文件夹复制到它自己里面");
    expect(readdirSync(root).sort()).toEqual(["A", "A (1)"]);
  });
});

describe("批量", () => {
  it("批量移动：逐项报告，冲突的那一项失败、其他照常", async () => {
    await call("POST", "/api/files/folders", { path: "/目标" });
    await put("/a.md", "a");
    await put("/b.md", "b");
    await put("/目标/b.md", "已存在");
    const res = await call("POST", "/api/files/batch", {
      action: "move",
      paths: ["/a.md", "/b.md"],
      target: "/目标",
    });
    const body = res.res.json<BatchResult>();
    expect(body.succeeded.map((s) => s.path)).toEqual(["/a.md"]);
    expect(body.failed).toEqual([
      { path: "/b.md", message: "目标位置已有「b.md」" },
    ]);
    expect(await names("/目标")).toEqual(["a.md", "b.md"]);
    expect(await names()).toEqual(["目标", "b.md"]);
  });

  it("批量删除：同时选了文件夹和它里面的东西，只处理外层，不报「不存在」", async () => {
    mkdirSync(join(root, "A"));
    writeFileSync(join(root, "A", "x.md"), "x");
    writeFileSync(join(root, "y.md"), "y");
    const res = await call("POST", "/api/files/batch", {
      action: "delete",
      paths: ["/A", "/A/x.md", "/y.md"],
    });
    const body = res.res.json<BatchResult>();
    expect(body.failed).toEqual([]);
    expect(body.succeeded.map((s) => s.path)).toEqual(["/A", "/y.md"]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("批量复制到另一个文件夹；移动 / 复制缺目标 400", async () => {
    await call("POST", "/api/files/folders", { path: "/备份" });
    await put("/a.md", "a");
    await put("/b.md", "b");
    const res = await call("POST", "/api/files/batch", {
      action: "copy",
      paths: ["/a.md", "/b.md"],
      target: "/备份",
    });
    expect(res.res.json<BatchResult>().succeeded).toHaveLength(2);
    expect(await names("/备份")).toEqual(["a.md", "b.md"]);
    expect(await names()).toEqual(["备份", "a.md", "b.md"]);
    expect(
      (
        await call("POST", "/api/files/batch", {
          action: "move",
          paths: ["/a.md"],
        })
      ).status,
    ).toBe(400);
  });
});

describe("打包下载", () => {
  it("文件夹 + 文件打成一个 zip，目录结构保留，中文名不乱", async () => {
    mkdirSync(join(root, "PRD", "2026"), { recursive: true });
    writeFileSync(join(root, "PRD", "2026", "需求.md"), "# 需求");
    writeFileSync(join(root, "PRD", "说明.txt"), "说明");
    writeFileSync(join(root, "PRD", ".DS_Store"), "隐藏");
    writeFileSync(
      join(root, "封面.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    const res = await app.inject({
      method: "POST",
      url: "/api/files/zip",
      headers: { host: HOST },
      payload: { paths: ["/PRD", "/封面.png"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/zip");
    expect(res.headers["content-disposition"]).toContain(
      encodeURIComponent("文件（2 项）.zip"),
    );
    const files = unzipSync(new Uint8Array(res.rawPayload));
    expect(Object.keys(files).sort()).toEqual([
      "PRD/2026/需求.md",
      "PRD/说明.txt",
      "封面.png",
    ]);
    expect(strFromU8(files["PRD/2026/需求.md"] ?? new Uint8Array())).toBe(
      "# 需求",
    );
  });
});

describe("上传整个文件夹", () => {
  it("新建文件夹可自动改名；parents=1 时缺失的上级文件夹自动新建", async () => {
    await call("POST", "/api/files/folders", { path: "/项目资料" });
    const auto = await call("POST", "/api/files/folders", {
      path: "/项目资料",
      autorename: true,
    });
    expect(auto.res.json<FileEntry>().name).toBe("项目资料 (1)");

    const res = await app.inject({
      method: "PUT",
      url: `/api/files/content?path=${q("/项目资料 (1)/设计/稿/a.md")}&mode=create&parents=1`,
      headers: { host: HOST, "content-type": "application/octet-stream" },
      payload: Buffer.from("# a"),
    });
    expect(res.statusCode).toBe(201);
    expect(
      readFileSync(join(root, "项目资料 (1)", "设计", "稿", "a.md"), "utf8"),
    ).toBe("# a");
    expect(await names("/项目资料 (1)/设计")).toEqual(["稿"]);
  });

  it("上级路径里有同名文件 409；不带 parents 时缺上级 404；上级名称非法 400", async () => {
    await put("/设计", "我是文件");
    const clash = await app.inject({
      method: "PUT",
      url: `/api/files/content?path=${q("/设计/a.md")}&parents=1`,
      headers: { host: HOST, "content-type": "application/octet-stream" },
      payload: Buffer.from("x"),
    });
    expect(clash.statusCode).toBe(409);
    expect((await put("/没有/a.md", "x")).status).toBe(404);
    const hidden = await app.inject({
      method: "PUT",
      url: `/api/files/content?path=${q("/.git/a.md")}&parents=1`,
      headers: { host: HOST, "content-type": "application/octet-stream" },
      payload: Buffer.from("x"),
    });
    expect(hidden.statusCode).toBe(400);
    expect(existsSync(join(root, ".git"))).toBe(false);
  });
});

describe("按内容搜索", () => {
  it("≥ 3 个字走全文索引，带上下文片段；名称命中排在前面且不重复", async () => {
    await put("/季度复盘.md", "# 季度复盘\n本季度完成文件模块");
    await put("/周会.md", "第一项：讨论季度复盘的时间安排。\n第二项：其他");
    await put("/图.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    const hits = await search("季度复盘");
    expect(hits.map((h) => [h.name, h.match])).toEqual([
      ["季度复盘.md", "name"],
      ["周会.md", "content"],
    ]);
    expect(hits[1]?.snippet).toBe(
      "第一项：讨论季度复盘的时间安排。 第二项：其他",
    );
  });

  it("1–2 个字（trigram 搜不了）回退为子串查找；英文不区分大小写", async () => {
    await put("/a.md", "这次的 OKR 复盘");
    expect((await search("复盘")).map((h) => h.name)).toEqual(["a.md"]);
    expect((await search("okr")).map((h) => h.name)).toEqual(["a.md"]);
  });

  it("覆盖 / 移动 / 删除后索引跟着变；二进制与超大文本不进全文索引", async () => {
    await put("/a.md", "旧的内容甲乙丙");
    await put("/a.md", "新的内容丁戊己", "overwrite");
    expect(await search("甲乙丙")).toEqual([]);
    expect((await search("丁戊己")).map((h) => h.path)).toEqual(["/a.md"]);

    await call("POST", "/api/files/folders", { path: "/归档" });
    await call("POST", "/api/files/move", { from: "/a.md", to: "/归档/a.md" });
    expect((await search("丁戊己")).map((h) => h.path)).toEqual(["/归档/a.md"]);

    await call("DELETE", `/api/files/entry?path=${q("/归档")}&recursive=1`);
    expect(await search("丁戊己")).toEqual([]);

    await put(
      "/bin.dat",
      Buffer.concat([Buffer.from("甲乙丙丁"), Buffer.alloc(64)]),
    );
    await put("/big.txt", `${"x".repeat(1024 * 1024)}甲乙丙丁`);
    expect(await search("甲乙丙丁")).toEqual([]);
  });

  it("在 Finder 里改过的文本：重建索引后能按新内容搜到", async () => {
    writeFileSync(join(root, "外部.md"), "外部写入的子丑寅");
    expect(await search("子丑寅")).toEqual([]);
    await call("POST", "/api/files/reindex");
    expect((await search("子丑寅")).map((h) => h.path)).toEqual(["/外部.md"]);
  });
});

describe("大文件上传（边收边写盘）", () => {
  it("超过旧上限 50 MB 的文件也能传，内容逐字节一致", async () => {
    const big = Buffer.alloc(60 * 1024 * 1024, 7);
    big.write("PK\u0003\u0004", 0); // 像个 pptx
    const res = await put("/整体PPT.pptx", big);
    expect(res.status).toBe(201);
    expect(res.body.entry).toMatchObject({ size: big.length, kind: "other" });
    expect(readFileSync(join(root, "整体PPT.pptx")).equals(big)).toBe(true);
  });

  describe("超过上限", () => {
    let small: ReturnType<typeof createApp>["app"];
    beforeEach(() => {
      ({ app: small } = createApp({
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
        files: createFileStore(root, index, { uploadLimit: 1024 * 1024 }),
        security: false,
      }));
    });
    afterEach(async () => {
      await small.close();
    });

    it("声明的长度超过上限：不读请求体直接 413，提示是中文", async () => {
      const res = await small.inject({
        method: "PUT",
        url: `/api/files/content?path=${q("/大.mp4")}`,
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.alloc(2 * 1024 * 1024),
      });
      expect(res.statusCode).toBe(413);
      expect(res.json<{ error: { message: string } }>().error.message).toBe(
        "文件超过 1 MB 上限",
      );
      expect(readdirSync(root)).toEqual([]);
    });

    it("没声明长度（流式）时边写边数，超了就中断，不留半个文件", async () => {
      const chunks = Array.from({ length: 40 }, () =>
        Buffer.alloc(64 * 1024, 1),
      ); // 2.5 MB
      const res = await small.inject({
        method: "PUT",
        url: `/api/files/content?path=${q("/大.mp4")}`,
        headers: { "content-type": "application/octet-stream" },
        payload: Readable.from(chunks),
      });
      expect(res.statusCode).toBe(413);
      expect(readdirSync(root)).toEqual([]); // 临时文件也清掉了
    });
  });
});
