import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { zipSync, strToU8 } from "fflate";

import { HttpError } from "./errors.js";
import { createSkillStore, type SkillStore } from "./skills.js";

/**
 * 技能库。断言都落在**磁盘上的结果**（目录、软链、文件内容），不是返回值的形状：
 * pi 加载的是文件，所以文件对了才算对。
 *
 * 分发目标全在临时目录里：测试绝不能写真实的 ~/.pi/agent/skills。
 */

let dir: string;
let store: SkillStore;
let targets: { pi: string };

const md = (name: string, description = "测试用技能。写 PRD 时用。") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n照这个来。\n`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chat-skills-"));
  targets = {
    pi: join(dir, "t", "pi"),
  };
  store = createSkillStore({ dir: join(dir, "skills"), targetDirs: targets });
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
    const created = await store.create(md("write-prd"));
    expect(created.name).toBe("write-prd");
    expect(created.description).toBe("测试用技能。写 PRD 时用。");
    expect(created.fileCount).toBe(1);

    expect((await store.list()).map((s) => s.name)).toEqual(["write-prd"]);
    const got = await store.get("write-prd");
    expect(got.content).toContain("照这个来。");
    expect(got.files).toEqual(["SKILL.md"]);
  });

  it("改内容就地覆盖 SKILL.md", async () => {
    await store.create(md("write-prd"));
    const next = md("write-prd", "改过的描述。").replace(
      "照这个来。",
      "改过的正文。",
    );
    const saved = await store.update("write-prd", next);
    expect(saved.description).toBe("改过的描述。");
    expect(
      await readFile(join(dir, "skills", "write-prd", "SKILL.md"), "utf8"),
    ).toContain("改过的正文。");
  });

  it("改 frontmatter 的 name 连目录一起改名，分发过的软链跟着重建", async () => {
    await store.create(md("write-prd"));
    await store.distribute("write-prd", ["pi"]);

    const renamed = await store.update("write-prd", md("write-spec"));
    expect(renamed.name).toBe("write-spec");
    expect((await store.list()).map((s) => s.name)).toEqual(["write-spec"]);
    // 旧名的链不能留下来变成悬空链，新名要有链。
    expect(renamed.distribution.pi).toBe("linked");
    const stale = await readFile(
      join(targets.pi, "write-prd", "SKILL.md"),
      "utf8",
    ).catch(() => null);
    expect(stale).toBeNull();
    expect(
      await readFile(join(targets.pi, "write-spec", "SKILL.md"), "utf8"),
    ).toContain("write-spec");
  });

  it("删除会先摘掉自己建的软链，不留悬空链", async () => {
    await store.create(md("write-prd"));
    await store.distribute("write-prd", ["pi"]);
    await store.remove("write-prd");

    expect(await store.list()).toEqual([]);
    for (const target of [targets.pi]) {
      expect(
        await readFile(join(target, "write-prd", "SKILL.md"), "utf8").catch(
          () => null,
        ),
      ).toBeNull();
    }
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

    await store.create(md("write-prd"));
    expect(await rejection(() => store.create(md("write-prd")))).toEqual({
      status: 409,
      message: "已有同名技能：write-prd",
    });
  });

  it("读不存在的技能回 404", async () => {
    expect((await rejection(() => store.get("nope"))).status).toBe(404);
  });

  it("没有 SKILL.md 的目录不算技能（pi 也不会加载它）", async () => {
    await mkdir(join(dir, "skills", "half-done"), { recursive: true });
    await writeFile(join(dir, "skills", "half-done", "notes.md"), "随手记");
    expect(await store.list()).toEqual([]);
  });
});

describe("zip 导入", () => {
  it("带附属文件的 zip 整棵子树进来", async () => {
    const zip = zipSync({
      "write-prd/SKILL.md": strToU8(md("write-prd")),
      "write-prd/references/checklist.md": strToU8("# 清单\n- 一\n"),
    });
    const skill = await store.importZip(Buffer.from(zip).toString("base64"));
    expect(skill.files).toEqual(["references/checklist.md", "SKILL.md"]);
    expect(
      await readFile(
        join(dir, "skills", "write-prd", "references", "checklist.md"),
        "utf8",
      ),
    ).toContain("- 一");
  });

  it("越界路径（zip-slip）整份拒掉，不留半个技能", async () => {
    const zip = zipSync({
      "write-prd/SKILL.md": strToU8(md("write-prd")),
      "write-prd/../../escaped.md": strToU8("跑出去了"),
    });
    expect(
      (
        await rejection(() =>
          store.importZip(Buffer.from(zip).toString("base64")),
        )
      ).message,
    ).toContain("越界");
    expect(await store.list()).toEqual([]);
  });

  it("没有 SKILL.md 的 zip 拒掉", async () => {
    const zip = zipSync({ "stuff/readme.md": strToU8("# 不是技能") });
    expect(
      (
        await rejection(() =>
          store.importZip(Buffer.from(zip).toString("base64")),
        )
      ).message,
    ).toContain("SKILL.md");
  });
});

describe("frontmatter 解析", () => {
  it("支持 YAML 折叠块标量（>- 加缩进续行），不再把描述显示成「>-」", async () => {
    // 实测 baoyu-translate 就是这个写法。
    const content = [
      "---",
      "name: folded-desc",
      "description: >-",
      "  第一行描述，",
      "  第二行描述。Use when 需要验证折叠块。",
      "---",
      "",
      "正文",
    ].join("\n");
    const skill = await store.create(content);
    expect(skill.description).toBe(
      "第一行描述， 第二行描述。Use when 需要验证折叠块。",
    );
    // 列表里也要是全文，否则搜索搜不到。
    expect((await store.list())[0]?.description).toContain("折叠块");
  });

  it("支持字面块标量（|-），保留换行", async () => {
    const content = [
      "---",
      "name: literal-desc",
      "description: |-",
      "  第一行",
      "  第二行",
      "---",
      "正文",
    ].join("\n");
    const skill = await store.create(content);
    expect(skill.description).toBe("第一行\n第二行");
  });

  it("块标量后面跟着别的键时，不把那些键吞进描述", async () => {
    const content = [
      "---",
      "name: mixed",
      "description: >-",
      "  一句描述。",
      "license: MIT",
      "---",
      "正文",
    ].join("\n");
    const skill = await store.create(content);
    expect(skill.description).toBe("一句描述。");
    expect(skill.description).not.toContain("MIT");
  });
});

describe("对模型隐藏（frontmatter 的 disable-model-invocation）", () => {
  it("开关写进 frontmatter，再关掉就整行去掉", async () => {
    await store.create(md("write-prd"));
    expect((await store.get("write-prd")).hidden).toBe(false);

    const hidden = await store.setHidden("write-prd", true);
    expect(hidden.hidden).toBe(true);
    expect(hidden.content).toContain("disable-model-invocation: true");

    const shown = await store.setHidden("write-prd", false);
    expect(shown.hidden).toBe(false);
    expect(shown.content).not.toContain("disable-model-invocation");
    // name / description 一个都不能被改动过。
    expect(shown.name).toBe("write-prd");
    expect(shown.description).toBe("测试用技能。写 PRD 时用。");
  });

  it("只动那一行：正文、其它字段、注释原样保留", async () => {
    const original = [
      "---",
      "name: write-prd",
      "# 这行注释不该被动",
      "description: 测试用技能。写 PRD 时用。",
      "license: MIT",
      "---",
      "",
      "# 正文标题",
      "",
      "正文内容。",
      "",
    ].join("\n");
    await store.create(original);
    const hidden = await store.setHidden("write-prd", true);
    expect(hidden.content).toContain("# 这行注释不该被动");
    expect(hidden.content).toContain("license: MIT");
    expect(hidden.content).toContain("# 正文标题");
    expect(hidden.content).toContain("正文内容。");
  });

  it("列表里也看得出哪个被隐藏了", async () => {
    await store.create(md("write-prd"));
    await store.create(md("verify-feature"));
    await store.setHidden("write-prd", true);
    const list = await store.list();
    expect(list.find((s) => s.name === "write-prd")?.hidden).toBe(true);
    expect(list.find((s) => s.name === "verify-feature")?.hidden).toBe(false);
  });

  it("重复设成同一个值不会白写一次盘（mtime 不变）", async () => {
    await store.create(md("write-prd"));
    const before = (await store.get("write-prd")).updatedAt;
    await new Promise((r) => setTimeout(r, 12));
    const again = await store.setHidden("write-prd", false);
    expect(again.updatedAt).toBe(before);
  });
});

describe("文件夹导入", () => {
  const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

  it("带附属文件的目录整棵进来", async () => {
    const skill = await store.importTree([
      { path: "SKILL.md", base64: b64(md("write-prd")) },
      { path: "references/checklist.md", base64: b64("# 清单\n- 一\n") },
      { path: "scripts/run.sh", base64: b64("echo hi\n") },
    ]);
    expect(skill.name).toBe("write-prd");
    expect(skill.files).toEqual([
      "references/checklist.md",
      "scripts/run.sh",
      "SKILL.md",
    ]);
    expect(
      await readFile(
        join(dir, "skills", "write-prd", "scripts", "run.sh"),
        "utf8",
      ),
    ).toBe("echo hi\n");
  });

  it("没有顶层 SKILL.md：直接拒，并说清该选哪一层目录", async () => {
    const res = await rejection(() =>
      store.importTree([
        { path: "write-prd/SKILL.md", base64: b64(md("write-prd")) },
      ]),
    );
    expect(res.status).toBe(400);
    expect(res.message).toContain("顶层 SKILL.md");
    expect(await store.list()).toEqual([]);
  });

  it("跳过隐藏文件（macOS 选文件夹必带 .DS_Store）", async () => {
    const skill = await store.importTree([
      { path: "SKILL.md", base64: b64(md("write-prd")) },
      { path: ".DS_Store", base64: b64("junk") },
      { path: ".git/config", base64: b64("[core]") },
    ]);
    expect(skill.files).toEqual(["SKILL.md"]);
    expect(skill.fileCount).toBe(1);
  });

  it("越界路径整份丢弃，不留半个技能", async () => {
    const res = await rejection(() =>
      store.importTree([
        { path: "SKILL.md", base64: b64(md("write-prd")) },
        { path: "../escaped.md", base64: b64("跑出去了") },
      ]),
    );
    expect(res.message).toContain("越界");
    expect(await store.list()).toEqual([]);
    expect(
      await readFile(join(dir, "skills", "escaped.md"), "utf8").catch(
        () => null,
      ),
    ).toBeNull();
  });

  it("frontmatter 不合格照样拒（与手写新建同一套校验）", async () => {
    const res = await rejection(() =>
      store.importTree([
        { path: "SKILL.md", base64: b64("---\nname: no-desc\n---\n正文") },
      ]),
    );
    expect(res.message).toContain("description");
  });

  it("重名拒绝，不覆盖已有技能", async () => {
    await store.create(md("write-prd"));
    const res = await rejection(() =>
      store.importTree([{ path: "SKILL.md", base64: b64(md("write-prd")) }]),
    );
    expect(res.status).toBe(409);
  });
});

describe("读技能目录里的文件", () => {
  it("读得到文本，附带字节数", async () => {
    await store.importTree([
      {
        path: "SKILL.md",
        base64: Buffer.from(md("write-prd")).toString("base64"),
      },
      {
        path: "references/checklist.md",
        base64: Buffer.from("# 清单", "utf8").toString("base64"),
      },
    ]);
    const file = await store.readFile("write-prd", "references/checklist.md");
    expect(file.text).toBe("# 清单");
    expect(file.bytes).toBeGreaterThan(0);
  });

  it("二进制文件不返回内容，只报大小（拿去渲染只会是乱码）", async () => {
    await store.importTree([
      {
        path: "SKILL.md",
        base64: Buffer.from(md("write-prd")).toString("base64"),
      },
      {
        path: "assets/logo.png",
        base64: Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x01]).toString("base64"),
      },
    ]);
    const file = await store.readFile("write-prd", "assets/logo.png");
    expect(file.text).toBeNull();
    expect(file.bytes).toBe(5);
  });

  it("越界路径与不存在的文件都拒", async () => {
    await store.create(md("write-prd"));
    expect(
      (await rejection(() => store.readFile("write-prd", "../../etc/passwd")))
        .message,
    ).toContain("越界");
    expect(
      (await rejection(() => store.readFile("write-prd", "nope.md"))).status,
    ).toBe(404);
  });
});

describe("分发到本机 CLI 目录", () => {
  it("软链建好后状态是 linked，撤销后回 absent", async () => {
    await store.create(md("write-prd"));
    const on = await store.distribute("write-prd", ["pi"]);
    expect(on.distribution).toEqual({ pi: "linked" });
    expect(
      await readFile(join(targets.pi, "write-prd", "SKILL.md"), "utf8"),
    ).toContain("write-prd");

    const off = await store.undistribute("write-prd", ["pi"]);
    expect(off.distribution).toEqual({ pi: "absent" });
  });

  it("目标目录已有同名的别人的东西：标 blocked，绝不覆盖", async () => {
    await store.create(md("write-prd"));
    await mkdir(join(targets.pi, "write-prd"), { recursive: true });
    await writeFile(join(targets.pi, "write-prd", "SKILL.md"), "别人的技能");

    const after = await store.distribute("write-prd", ["pi"]);
    expect(after.distribution.pi).toBe("blocked");
    expect(
      await readFile(join(targets.pi, "write-prd", "SKILL.md"), "utf8"),
    ).toBe("别人的技能");
  });

  it("指向别处的同名软链也算 blocked，撤销时不会误摘", async () => {
    await store.create(md("write-prd"));
    const foreign = join(dir, "foreign-skill");
    await mkdir(foreign, { recursive: true });
    await mkdir(targets.pi, { recursive: true });
    await symlink(foreign, join(targets.pi, "write-prd"), "dir");

    expect((await store.get("write-prd")).distribution.pi).toBe("blocked");
    await store.undistribute("write-prd", ["pi"]);
    expect((await store.get("write-prd")).distribution.pi).toBe("blocked");
  });
});
