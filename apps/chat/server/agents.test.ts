import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createAgentStore, type AgentStore } from "./agents.js";
import { HttpError } from "./errors.js";

/**
 * 执行体库。与 skills.test.ts 同一条断言原则：落在**磁盘上的结果**
 * （文件、软链、内容），不是返回值的形状——Claude Code 加载的是文件。
 *
 * 分发目标全在临时目录里：测试绝不能写真实的 ~/.pi/agent/agents。
 */

let dir: string;
let store: AgentStore;
let piDir: string;

const md = (
  name: string,
  extra: Record<string, string> = {},
  description = "只读核代码事实。写 PRD 要核现状时派它。",
) =>
  [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
    "---",
    "",
    `# ${name}`,
    "",
    "干活的纪律写在这里。",
    "",
  ].join("\n");

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chat-agents-"));
  piDir = join(dir, "t", "pi");
  store = createAgentStore({
    dir: join(dir, "agents"),
    targetDirs: { pi: piDir },
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 取出 HttpError 的状态码与文案，断言「拒得对、还说清了为什么」。 */
async function rejection(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (cause) {
    if (cause instanceof HttpError)
      return { status: cause.status, message: cause.message };
    throw cause;
  }
  throw new Error("本该被拒绝");
}

describe("增删改查", () => {
  it("新建后能列出、能读回原文；名字取自 frontmatter", async () => {
    const created = await store.create(md("codebase-auditor"));
    expect(created.name).toBe("codebase-auditor");
    expect(created.description).toContain("只读核代码事实");

    expect((await store.list()).map((a) => a.name)).toEqual([
      "codebase-auditor",
    ]);
    expect((await store.get("codebase-auditor")).content).toContain(
      "干活的纪律写在这里。",
    );
    // 一个执行体就是一个 .md，不是目录。
    expect(
      await readFile(join(dir, "agents", "codebase-auditor.md"), "utf8"),
    ).toContain("name: codebase-auditor");
  });

  it("tools / model / skills 解析出来，空 tools 表示继承全部工具", async () => {
    const full = await store.create(
      md("codebase-auditor", {
        tools: "Read, Grep, Bash",
        model: "sonnet",
        skills: "audit-codebase, verify-delivery",
      }),
    );
    expect(full.tools).toEqual(["Read", "Grep", "Bash"]);
    expect(full.model).toBe("sonnet");
    expect(full.skills).toEqual(["audit-codebase", "verify-delivery"]);

    const bare = await store.create(md("adversary"));
    expect(bare.tools).toEqual([]);
    expect(bare.model).toBeUndefined();
    expect(bare.skills).toEqual([]);
  });

  it("改内容就地覆盖那个 .md", async () => {
    await store.create(md("codebase-auditor"));
    const saved = await store.update(
      "codebase-auditor",
      md("codebase-auditor", { model: "opus" }).replace(
        "干活的纪律写在这里。",
        "改过的纪律。",
      ),
    );
    expect(saved.model).toBe("opus");
    expect(
      await readFile(join(dir, "agents", "codebase-auditor.md"), "utf8"),
    ).toContain("改过的纪律。");
  });

  it("改 frontmatter 的 name 连文件一起改名，分发过的软链跟着重建", async () => {
    await store.create(md("codebase-auditor"));
    await store.distribute("codebase-auditor", ["pi"]);

    const renamed = await store.update("codebase-auditor", md("code-auditor"));
    expect(renamed.name).toBe("code-auditor");
    expect((await store.list()).map((a) => a.name)).toEqual(["code-auditor"]);
    expect(renamed.distribution.pi).toBe("linked");
    // 旧名的链不能留下来变成悬空链。
    expect(
      await lstat(join(piDir, "codebase-auditor.md")).catch(() => null),
    ).toBeNull();
    expect(await readFile(join(piDir, "code-auditor.md"), "utf8")).toContain(
      "name: code-auditor",
    );
  });

  it("删除会先摘掉自己建的软链，不留悬空链", async () => {
    await store.create(md("codebase-auditor"));
    await store.distribute("codebase-auditor", ["pi"]);
    await store.remove("codebase-auditor");

    expect(await store.list()).toEqual([]);
    expect(
      await lstat(join(piDir, "codebase-auditor.md")).catch(() => null),
    ).toBeNull();
  });

  it("缺 name / 缺 description / 名字不合法 / 重名都拒，并说清原因", async () => {
    expect(
      (
        await rejection(() =>
          store.create("---\ndescription: 有描述没名字\n---\n正文"),
        )
      ).message,
    ).toContain("name");
    expect(
      (await rejection(() => store.create("---\nname: no-desc\n---\n正文")))
        .message,
    ).toContain("description");
    expect(
      (await rejection(() => store.create(md("Bad_Name")))).message,
    ).toContain("不合法");

    await store.create(md("codebase-auditor"));
    expect(await rejection(() => store.create(md("codebase-auditor")))).toEqual(
      { status: 409, message: "已有同名执行体：codebase-auditor" },
    );
  });

  it("读不存在的执行体回 404", async () => {
    expect((await rejection(() => store.get("nope"))).status).toBe(404);
  });

  it("目录里的非 .md 与名字不合法的文件不算执行体", async () => {
    await store.create(md("codebase-auditor"));
    await writeFile(join(dir, "agents", "notes.txt"), "随手记");
    await writeFile(join(dir, "agents", "Bad_Name.md"), md("whatever"));
    expect((await store.list()).map((a) => a.name)).toEqual([
      "codebase-auditor",
    ]);
  });
});

describe("分发到 pi", () => {
  it("分发建软链，撤销只摘自己的那条", async () => {
    await store.create(md("codebase-auditor"));
    const on = await store.distribute("codebase-auditor", ["pi"]);
    expect(on.distribution.pi).toBe("linked");
    expect(
      (await lstat(join(piDir, "codebase-auditor.md"))).isSymbolicLink(),
    ).toBe(true);

    const off = await store.undistribute("codebase-auditor", ["pi"]);
    expect(off.distribution.pi).toBe("absent");
    expect(
      await lstat(join(piDir, "codebase-auditor.md")).catch(() => null),
    ).toBeNull();
  });

  it("目标目录已有同名真文件：不覆盖，状态报 blocked", async () => {
    await store.create(md("codebase-auditor"));
    await mkdir(piDir, { recursive: true });
    await writeFile(join(piDir, "codebase-auditor.md"), "别人的东西");

    const result = await store.distribute("codebase-auditor", ["pi"]);
    expect(result.distribution.pi).toBe("blocked");
    expect(await readFile(join(piDir, "codebase-auditor.md"), "utf8")).toBe(
      "别人的东西",
    );

    // 撤销也不能删别人的文件。
    await store.undistribute("codebase-auditor", ["pi"]);
    expect(await readFile(join(piDir, "codebase-auditor.md"), "utf8")).toBe(
      "别人的东西",
    );
  });
});

describe("预加载的 skill 是否存在", () => {
  it("点名了技能库里没有的 skill：详情里报出来", async () => {
    const withSkills = createAgentStore({
      dir: join(dir, "agents"),
      targetDirs: { pi: piDir },
      knownSkills: () => ["audit-codebase"],
    });
    await withSkills.create(
      md("codebase-auditor", { skills: "audit-codebase, 拼错的名字" }),
    );
    const got = await withSkills.get("codebase-auditor");
    expect(got.missingSkills).toEqual(["拼错的名字"]);
  });

  it("没注入技能库时不报缺失（那只说明调用方没给）", async () => {
    await store.create(md("codebase-auditor", { skills: "audit-codebase" }));
    expect((await store.get("codebase-auditor")).missingSkills).toEqual([]);
  });
});

describe("frontmatter 解析", () => {
  it("description 用折叠块标量（>-）时取全文，不显示成「>-」", async () => {
    const content = [
      "---",
      "name: folded",
      "description: >-",
      "  第一行描述，",
      "  第二行描述。Use when 要核事实。",
      "tools: Read, Grep",
      "---",
      "",
      "正文",
    ].join("\n");
    const agent = await store.create(content);
    expect(agent.description).toBe(
      "第一行描述， 第二行描述。Use when 要核事实。",
    );
    // 块标量后面的键不能被吞进描述里。
    expect(agent.tools).toEqual(["Read", "Grep"]);
  });
});
