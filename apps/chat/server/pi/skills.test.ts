import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";

import { createFauxSetup } from "./faux.js";
import {
  newSessionHeader,
  openAgentSession,
  piPaths,
  type PiPaths,
} from "./runtime.js";
import { SKILL_TOOL_NAME, scanSkills, skillsPromptSection } from "./skills.js";

/**
 * skill 接到 pi 上这件事，只有一个验收口径：**模型是不是真拿到了**。
 *
 * 所以断言落在两处真实的东西上：模型收到的系统提示词（faux 响应工厂能看到
 * 完整 transcript），以及工具返回给模型的内容。全程真实的 pi，只有模型是假的。
 */

let dir: string;
let paths: PiPaths;

const md = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;

async function putSkill(
  name: string,
  description: string,
  body: string,
): Promise<void> {
  await mkdir(join(paths.skillsDir, name), { recursive: true });
  await writeFile(
    join(paths.skillsDir, name, "SKILL.md"),
    md(name, description, body),
    "utf8",
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chat-pi-skills-"));
  paths = piPaths(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("提示词里的技能清单", () => {
  it("没有技能时不写这一段（空的清单只会让模型以为有东西可加载）", () => {
    expect(skillsPromptSection(paths.skillsDir)).toBe("");
  });

  it("有技能时给出名字、描述、位置与加载方式", async () => {
    await putSkill("write-prd", "写 PRD 时用。", "# 写 PRD\n先问清楚再写。");
    const section = skillsPromptSection(paths.skillsDir);
    expect(section).toContain("<name>write-prd</name>");
    expect(section).toContain("写 PRD 时用。");
    expect(section).toContain(join(paths.skillsDir, "write-prd", "SKILL.md"));
    expect(section).toContain(SKILL_TOOL_NAME);
    // 正文不进提示词：清单只负责路由，正文等模型要的时候再给。
    expect(section).not.toContain("先问清楚再写");
  });

  it("disable-model-invocation 的技能不进清单", async () => {
    await mkdir(join(paths.skillsDir, "manual-only"), { recursive: true });
    await writeFile(
      join(paths.skillsDir, "manual-only", "SKILL.md"),
      "---\nname: manual-only\ndescription: 只手动调。\ndisable-model-invocation: true\n---\n正文\n",
    );
    expect(scanSkills(paths.skillsDir)).toEqual([]);
  });
});

describe("手动点名 /skill:名字", () => {
  it("解析命令与参数", async () => {
    const { parseSkillCommand } = await import("./skills.js");
    expect(parseSkillCommand("/skill:generate-prd")).toEqual({
      name: "generate-prd",
      args: "",
    });
    expect(parseSkillCommand("/skill:generate-prd 写登录改造的 PRD")).toEqual({
      name: "generate-prd",
      args: "写登录改造的 PRD",
    });
    // 不是命令的照常当普通消息。
    expect(parseSkillCommand("帮我写 PRD")).toBeNull();
    expect(parseSkillCommand("/skills")).toBeNull();
    expect(parseSkillCommand("/skill:")).toBeNull();
  });

  it("展开成「技能正文 + 用户请求」；名字不存在时返回 null（照原话发）", async () => {
    const { expandSkillCommand } = await import("./skills.js");
    await putSkill("write-prd", "写 PRD 时用。", "第一步：先确认立项四问。");
    const text = await expandSkillCommand(
      paths.skillsDir,
      "/skill:write-prd 登录改造",
    );
    expect(text).toContain("第一步：先确认立项四问。");
    expect(text).toContain("用户请求：登录改造");
    expect(text?.startsWith("/skill:write-prd 登录改造")).toBe(true);
    expect(await expandSkillCommand(paths.skillsDir, "/skill:nope")).toBeNull();
  });

  it("历史里折回成命令原文，不把正文摊开（流式与历史同形）", async () => {
    const { expandSkillCommand, collapseSkillCommand } =
      await import("./skills.js");
    await putSkill("write-prd", "写 PRD 时用。", "正文很长。".repeat(50));
    const expanded =
      (await expandSkillCommand(
        paths.skillsDir,
        "/skill:write-prd 登录改造",
      )) ?? "";
    expect(collapseSkillCommand(expanded)).toBe("/skill:write-prd 登录改造");
    // 普通消息原样返回。
    expect(collapseSkillCommand("普通一句话")).toBe("普通一句话");
  });

  it("点名时模型真的拿到了正文（不依赖它自己决定调工具）", async () => {
    await putSkill("write-prd", "写 PRD 时用。", "口令：先确认立项四问。");
    const setup = await createFauxSetup(paths);
    const seen: string[] = [];
    setup.faux.setResponses([
      (context) => {
        seen.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(fauxText("好"));
      },
    ]);
    const { createRunner } = await import("./runner.js");
    const { createSessionStore } = await import("../sessions.js");
    const { openDb, IN_MEMORY } = await import("../db.js");
    const store = createSessionStore(openDb(IN_MEMORY));
    const header = newSessionHeader(paths, "s-skill");
    store.create({ id: "s-skill", title: "新对话", header });
    const runner = createRunner({
      store,
      paths,
      provision: () =>
        Promise.resolve({
          key: "faux",
          setup,
          defaultModel: setup.model,
          defaultThinking: "off",
        }),
    });
    await runner.chat({
      sessionId: "s-skill",
      message: "/skill:write-prd 登录改造",
      onChunk: () => undefined,
      signal: new AbortController().signal,
    });
    // 一轮之内就拿到了正文，没有先调工具那一跳。
    expect(seen[0]).toContain("口令：先确认立项四问。");
    expect(seen[0]).toContain("用户请求：登录改造");
    runner.disposeAll();
  });
});

describe("隐藏的技能仍能点名加载", () => {
  it("不进清单，但模型按名字调 skill 工具时照样拿得到正文", async () => {
    const { createSkillStore } = await import("../skills.js");
    const store = createSkillStore({
      dir: paths.skillsDir,
      targetDirs: {
        pi: join(dir, "t", "pi"),
      },
    });
    await store.create(
      md("hidden-skill", "被隐藏的技能。", "隐藏技能的正文标记。"),
    );
    await store.setHidden("hidden-skill", true);
    // 清单里没有它。
    expect(skillsPromptSection(paths.skillsDir)).not.toContain("hidden-skill");

    const setup = await createFauxSetup(paths);
    const seen: string[] = [];
    setup.faux.setResponses([
      () =>
        fauxAssistantMessage([
          fauxToolCall(SKILL_TOOL_NAME, { name: "hidden-skill" }),
        ]),
      (context) => {
        seen.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(fauxText("拿到了"));
      },
    ]);
    const opened = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header: newSessionHeader(paths),
      entries: [],
    });
    await opened.session.prompt("用 hidden-skill 这个技能");
    // 界面上那句「仍可在对话里点名调用」必须是真的。
    expect(seen[0]).toContain("隐藏技能的正文标记。");
    opened.dispose();
  });

  it("名字拼错时只列可见的，不把隐藏的推回模型眼前", async () => {
    const { createSkillStore } = await import("../skills.js");
    const store = createSkillStore({
      dir: paths.skillsDir,
      targetDirs: {
        pi: join(dir, "t", "pi"),
      },
    });
    await store.create(md("visible-one", "可见。", "正文"));
    await store.create(md("hidden-one", "隐藏。", "正文"));
    await store.setHidden("hidden-one", true);

    const setup = await createFauxSetup(paths);
    const seen: string[] = [];
    setup.faux.setResponses([
      () =>
        fauxAssistantMessage([fauxToolCall(SKILL_TOOL_NAME, { name: "typo" })]),
      (context) => {
        seen.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(fauxText("换一个"));
      },
    ]);
    const opened = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header: newSessionHeader(paths),
      entries: [],
    });
    await opened.session.prompt("随便");
    expect(seen[0]).toContain("visible-one");
    expect(seen[0]).not.toContain("hidden-one");
    opened.dispose();
  });
});

describe("提示词成本（promptCost）", () => {
  it("总量跟着真实提示词走：多一个技能就多一块，差值只是那行固定说明", async () => {
    const { promptCost } = await import("./skills.js");
    const sectionBytes = () =>
      Buffer.byteLength(skillsPromptSection(paths.skillsDir), "utf8");

    await putSkill("a-skill", "描述 A。", "正文");
    const one = promptCost(paths.skillsDir).total;
    const gapOne = sectionBytes() - one;

    await putSkill("b-skill", "描述 B。", "正文");
    await putSkill("c-skill", "描述 C。", "正文");
    const three = promptCost(paths.skillsDir).total;
    const gapThree = sectionBytes() - three;

    expect(three).toBeGreaterThan(one);
    // 提示词段 = pi 的清单 + 我们加的那行「用 skill 工具加载」。那一行是固定的，
    // 所以差值与技能数无关；若将来格式变了，这条会红。
    expect(gapThree).toBe(gapOne);
    expect(gapOne).toBeGreaterThan(0);
  });

  it("每个技能的占用 = 隐藏它能省下的字节（描述越长省得越多）", async () => {
    const { promptCost } = await import("./skills.js");
    await putSkill("short-one", "短。", "正文");
    await putSkill("long-one", "很长的描述。".repeat(50), "正文");
    const cost = promptCost(paths.skillsDir);
    expect(cost.perSkill["long-one"]).toBeGreaterThan(
      (cost.perSkill["short-one"] ?? 0) * 5,
    );
    // 两个加起来略小于总量：总量里还有固定的说明行。
    const sum = Object.values(cost.perSkill).reduce((a, b) => a + b, 0);
    expect(sum).toBeLessThan(cost.total);
  });

  it("隐藏的技能不在账上（它本来就不进提示词）", async () => {
    const { createSkillStore } = await import("../skills.js");
    const { promptCost } = await import("./skills.js");
    const store = createSkillStore({
      dir: paths.skillsDir,
      targetDirs: {
        pi: join(dir, "t", "pi"),
      },
    });
    await store.create(md("keep-me", "留着。", "正文"));
    await store.create(md("hide-me", "要隐藏。".repeat(40), "正文"));
    const before = promptCost(paths.skillsDir);
    await store.setHidden("hide-me", true);
    const after = promptCost(paths.skillsDir);
    expect(after.perSkill["hide-me"]).toBeUndefined();
    expect(after.total).toBeLessThan(before.total);
  });

  it("一个技能都没有时为 0，不报 NaN", async () => {
    const { promptCost } = await import("./skills.js");
    expect(promptCost(paths.skillsDir)).toEqual({ total: 0, perSkill: {} });
  });
});

describe("对模型隐藏与提示词体积", () => {
  it("技能页点了隐藏之后，pi 的解析器就不再把它列给模型", async () => {
    const { createSkillStore } = await import("../skills.js");
    const store = createSkillStore({
      dir: paths.skillsDir,
      targetDirs: {
        pi: join(dir, "t", "pi"),
      },
    });
    await store.create(md("keep-me", "留着的技能。", "正文"));
    await store.create(md("hide-me", "要隐藏的技能。", "正文"));
    expect(
      scanSkills(paths.skillsDir)
        .map((s) => s.name)
        .sort(),
    ).toEqual(["hide-me", "keep-me"]);

    await store.setHidden("hide-me", true);
    // 这里用的是 pi 自己的 loadSkillsFromDir，不是我们的 hidden 字段。
    expect(scanSkills(paths.skillsDir).map((s) => s.name)).toEqual(["keep-me"]);
    expect(skillsPromptSection(paths.skillsDir)).not.toContain("hide-me");
  });

  it("隐藏能按住提示词体积：隐藏掉描述很长的那些，提示词显著变小", async () => {
    const { createSkillStore } = await import("../skills.js");
    const store = createSkillStore({
      dir: paths.skillsDir,
      targetDirs: {
        pi: join(dir, "t", "pi"),
      },
    });
    const long = "很长的描述。".repeat(80);
    await store.create(md("short-one", "短描述。", "正文"));
    for (const n of ["long-a", "long-b", "long-c"]) {
      await store.create(md(n, long, "正文"));
    }
    const before = skillsPromptSection(paths.skillsDir).length;
    for (const n of ["long-a", "long-b", "long-c"]) {
      await store.setHidden(n, true);
    }
    const after = skillsPromptSection(paths.skillsDir).length;
    expect(after).toBeLessThan(before / 3);
  });
});

describe("模型侧的实际行为", () => {
  it("模型看到清单、调 skill 工具拿到正文，下一轮正文就在上下文里", async () => {
    await putSkill(
      "write-prd",
      "写 PRD 时用。",
      "# 写 PRD\n第一步：先确认立项四问。",
    );
    const setup = await createFauxSetup(paths);
    const systems: string[] = [];
    setup.faux.setResponses([
      // 第一轮：看到清单，决定加载这个技能。
      (context) => {
        systems.push(
          JSON.stringify(
            context.messages.filter(
              (m) => (m as { role?: string }).role === "system",
            ),
          ),
        );
        return fauxAssistantMessage([
          fauxToolCall(SKILL_TOOL_NAME, { name: "write-prd" }),
        ]);
      },
      // 第二轮：工具结果已经在上下文里了。
      (context) => {
        systems.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(fauxText("好，按立项四问来。"));
      },
    ]);

    const opened = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header: newSessionHeader(paths),
      entries: [],
      systemPrompt: "你是测试助手。",
    });
    await opened.session.prompt("帮我写个 PRD");

    expect(systems[0]).toContain("你是测试助手。");
    expect(systems[0]).toContain("write-prd");
    // 工具把正文交给了模型。
    expect(systems[1]).toContain("第一步：先确认立项四问。");
    opened.dispose();
  });

  it("读技能目录里的附属文件；目录外的路径一律拒", async () => {
    await putSkill("write-prd", "写 PRD 时用。", "见 references/checklist.md");
    await mkdir(join(paths.skillsDir, "write-prd", "references"), {
      recursive: true,
    });
    await writeFile(
      join(paths.skillsDir, "write-prd", "references", "checklist.md"),
      "# 清单\n- 立项四问\n",
    );
    await writeFile(join(dir, "secret.txt"), "不该被读到");

    const setup = await createFauxSetup(paths);
    const results: string[] = [];
    setup.faux.setResponses([
      () =>
        fauxAssistantMessage([
          fauxToolCall(SKILL_TOOL_NAME, {
            name: "write-prd",
            file: "references/checklist.md",
          }),
        ]),
      (context) => {
        results.push(JSON.stringify(context.messages));
        return fauxAssistantMessage([
          fauxToolCall(SKILL_TOOL_NAME, {
            name: "write-prd",
            file: "../../secret.txt",
          }),
        ]);
      },
      (context) => {
        results.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(fauxText("行吧"));
      },
    ]);

    const opened = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header: newSessionHeader(paths),
      entries: [],
    });
    await opened.session.prompt("看下清单");

    expect(results[0]).toContain("- 立项四问");
    expect(results[1]).not.toContain("不该被读到");
    expect(results[1]).toContain("越界");
    opened.dispose();
  });

  it("名字拼错时把可用的名字回给模型，让它自己纠正", async () => {
    await putSkill("write-prd", "写 PRD 时用。", "正文");
    const setup = await createFauxSetup(paths);
    const seen: string[] = [];
    setup.faux.setResponses([
      () =>
        fauxAssistantMessage([
          fauxToolCall(SKILL_TOOL_NAME, { name: "writeprd" }),
        ]),
      (context) => {
        seen.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(fauxText("换个名字再试"));
      },
    ]);
    const opened = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header: newSessionHeader(paths),
      entries: [],
    });
    await opened.session.prompt("写 PRD");
    expect(seen[0]).toContain("可用：write-prd");
    opened.dispose();
  });

  it("技能是每轮现场扫的：会话开着的时候新建，下一轮就能用上", async () => {
    const setup = await createFauxSetup(paths);
    const systems: string[] = [];
    const record = (context: { messages: unknown[] }) => {
      systems.push(
        JSON.stringify(
          context.messages.filter(
            (m) => (m as { role?: string }).role === "system",
          ),
        ),
      );
      return fauxAssistantMessage(fauxText("收到"));
    };
    setup.faux.setResponses([record, record]);

    const opened = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header: newSessionHeader(paths),
      entries: [],
    });
    await opened.session.prompt("第一句");
    // 会话正开着，这时候在技能页新建一个。
    await putSkill("late-skill", "后加的技能。", "正文");
    await opened.session.prompt("第二句");

    expect(systems[0]).not.toContain("late-skill");
    expect(systems[1]).toContain("late-skill");
    opened.dispose();
  });

  it("只开了 skill 这一个工具，read / bash / write 一个都没有", async () => {
    const setup = await createFauxSetup(paths);
    setup.faux.setResponses([fauxAssistantMessage(fauxText("ok"))]);
    const opened = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header: newSessionHeader(paths),
      entries: [],
    });
    expect(opened.session.getActiveToolNames()).toEqual([SKILL_TOOL_NAME]);
    opened.dispose();
  });
});
