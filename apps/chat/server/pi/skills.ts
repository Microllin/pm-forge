import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/**
 * 把 skill 库接到 pi 上。两件事：告诉模型有哪些 skill，给它一条加载的路。
 *
 * ## 为什么不走 pi 的 ResourceLoader
 *
 * 可以走（`noSkills: true` 时 pi 仍会读 `additionalSkillPaths`），但那是**开会话
 * 时读一次**。运行器会把会话留在内存里（runner.ts 的 live），于是「刚在技能页
 * 新建的 skill 对已打开的会话不生效」，还得额外加一套失效/重开机制。
 * 这里改成**每轮现场扫一次目录**（pi 自己的 loadSkillsFromDir，解析规则与 CLI
 * 一致），改完下一轮即生效，不必重开会话，也没有缓存要失效。
 *
 * ## 为什么不开 read 工具
 *
 * pi 的 skills 提示词段是跟着 read / bash 工具走的（没有这两个工具它干脆不写
 * 这一段），最省事的做法就是开 read。但 read 能读整台机器上任何文件，而这个
 * 服务的模型内容来自外部——一次提示词注入就能把 ~/.ssh 读出去。
 * 所以换成下面这个只能读 skill 目录内文件的 `skill` 工具，提示词段用
 * pi 的 formatSkillsForPrompt 以 "indirect"（读取器只能经别的工具到达）生成。
 */

export const SKILL_TOOL_NAME = "skill";

/**
 * 手动点名：`/skill:名字 [参数]`（与 pi CLI 同一个写法）。
 *
 * 为什么要有它：模型靠描述自动选技能会漏（pi 文档自己也写了 "A model might fail
 * to load a relevant skill, so use /skill:name when you need to force it"）。
 * 而且隐藏的技能本来就不进清单，只能靠点名。
 */
const SKILL_COMMAND = /^\/skill:([a-z0-9][a-z0-9-]*)[ \t]*([\s\S]*)$/;

/** 包住被注入正文的标记。历史里据此折回成你打的那行命令。 */
const SKILL_BLOCK_OPEN = "<loaded-skill name=";
const SKILL_BLOCK_END = "</loaded-skill>";

export function parseSkillCommand(
  text: string,
): { name: string; args: string } | null {
  const m = SKILL_COMMAND.exec(text.trim());
  const name = m?.[1];
  if (name === undefined) return null;
  return { name, args: (m?.[2] ?? "").trim() };
}

/**
 * 把 `/skill:名字 参数` 展开成真正发给模型的消息：技能正文 + 作为用户请求的参数
 * （pi 的口径：Arguments after /skill:name are appended to the loaded instructions
 * as a user request）。
 *
 * **注入成用户消息而不是只塞这一轮的系统提示词**：技能多半是多轮流程（写 PRD 要
 * 来回问好几轮），只管一轮的话第二轮指令就没了。进了 transcript 才一直在上下文里。
 *
 * 找不到那个技能时返回 null，由调用方把原话照常发出去——不要把「命令打错了」
 * 变成一条看不懂的报错。
 */
export async function expandSkillCommand(
  skillsDir: string,
  text: string,
): Promise<string | null> {
  const parsed = parseSkillCommand(text);
  if (!parsed) return null;
  // 点名要能命中隐藏的技能（它们不进清单，但点名就该能用）。
  const skill = allSkills(skillsDir).find((s) => s.name === parsed.name);
  if (!skill) return null;
  const body = await readFile(skill.filePath, "utf8").catch(() => null);
  if (body === null) return null;
  return [
    text.trim(),
    "",
    `${SKILL_BLOCK_OPEN}"${skill.name}" path="${skill.filePath}">`,
    body.trim(),
    SKILL_BLOCK_END,
    ...(parsed.args === "" ? [] : ["", `用户请求：${parsed.args}`]),
  ].join("\n");
}

/**
 * 历史里把展开过的那条折回成命令原文。
 *
 * 不折的话会出现「实时看到的是 /skill:generate-prd，刷新后变成几千字正文」——
 * 这套代码一直守的是流式与历史同形。
 */
export function collapseSkillCommand(text: string): string {
  const at = text.indexOf(`\n\n${SKILL_BLOCK_OPEN}`);
  if (at < 0 || !text.includes(SKILL_BLOCK_END)) return text;
  const head = text.slice(0, at);
  const tail = text.slice(
    text.indexOf(SKILL_BLOCK_END) + SKILL_BLOCK_END.length,
  );
  const args = /用户请求：([\s\S]*)$/.exec(tail.trim())?.[1]?.trim();
  return args === undefined || head.includes(args) ? head : `${head} ${args}`;
}

/** 单次读取上限。skill 正文是给模型看的说明，不该出现几 MB 的东西。 */
const MAX_READ_BYTES = 256 * 1024;

/**
 * 技能清单在系统提示词里占多少字节，以及「隐藏某一个能省多少」。
 *
 * 为什么要报这个数：这份清单**每一轮对话都会发给模型**，27 个技能实测 21.6 KB
 * （约 5~6k token）。在界面上看不到它的时候，连我自己都把「隐藏 12 个内容工具
 * 能降到多少」估错了（猜 8 KB，实际 14.9 KB）——成本不可见就只能靠猜。
 *
 * 每个技能的占用用「总长 − 去掉它之后的长度」算，而不是自己拼一遍格式：
 * 格式由 pi 的 formatSkillsForPrompt 决定，自己算一份迟早对不上。
 */
export function promptCost(skillsDir: string): {
  total: number;
  perSkill: Record<string, number>;
} {
  const skills = scanSkills(skillsDir);
  if (skills.length === 0) return { total: 0, perSkill: {} };
  const bytes = (list: Skill[]): number =>
    Buffer.byteLength(formatSkillsForPrompt(list, "indirect"), "utf8");
  const total = bytes(skills);
  const perSkill: Record<string, number> = {};
  for (const skill of skills) {
    perSkill[skill.name] =
      total - bytes(skills.filter((s) => s.name !== skill.name));
  }
  return { total, perSkill };
}

/** 现场扫一遍 skill 库（含隐藏的）。解析/发现规则直接用 pi 的，避免两套实现对不上。 */
export function allSkills(skillsDir: string): Skill[] {
  return loadSkillsFromDir({ dir: skillsDir, source: "path" }).skills;
}

/**
 * 对模型**可见**的技能：隐藏的（frontmatter 写了 disable-model-invocation）不进清单。
 *
 * 注意「不进清单」≠「不能用」：pi CLI 里隐藏的技能仍能用 `/skill:name` 点名调用，
 * 所以这里的 skill 工具也按名字查 allSkills——否则界面上那句「仍可点名调用」就是
 * 假话（实测模型会回「可用技能列表里没有这个名字」）。
 */
export function scanSkills(skillsDir: string): Skill[] {
  return allSkills(skillsDir).filter((s) => !s.disableModelInvocation);
}

/**
 * 系统提示词里的 skills 段。没有 skill 时返回空串——空的
 * `<available_skills>` 只会让模型以为有工具可用却无从下手。
 */
export function skillsPromptSection(skillsDir: string): string {
  const skills = scanSkills(skillsDir);
  if (skills.length === 0) return "";
  const listing = formatSkillsForPrompt(skills, "indirect").trim();
  return [
    listing,
    `Load one with the ${SKILL_TOOL_NAME} tool: pass the skill name to get its instructions, and add file="<relative path>" to read a bundled file (for example file="references/checklist.md"). This tool is the only way to read those files.`,
  ].join("\n");
}

/** 路径必须落在 skill 库内（软链也要解析后再判），否则不读。 */
async function resolveInside(
  skillsDir: string,
  name: string,
  file: string,
): Promise<string> {
  const root = await realpath(skillsDir).catch(() => resolve(skillsDir));
  const target = resolve(root, name, file);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`路径越界：${file}`);
  }
  const real = await realpath(target).catch(() => target);
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`路径越界（软链指向库外）：${file}`);
  }
  return real;
}

/**
 * `skill` 工具：按名字加载 skill 说明，或读它目录里的附属文件。
 *
 * 失败时**把可用的名字列出来**：模型拼错名字时一次就能自己纠正，
 * 否则它只会收到「不存在」然后放弃，用户看到的是技能明明在却没被用。
 */
export function createSkillTool(skillsDir: string): ToolDefinition {
  return defineTool({
    name: SKILL_TOOL_NAME,
    label: "Skill",
    description:
      "Load a skill's instructions by name, or read a file bundled with that skill. Call it as soon as a listed skill matches the task; follow the loaded instructions afterwards. Skills the user names explicitly can be loaded even when they are not in <available_skills>.",
    parameters: Type.Object({
      name: Type.String({
        description: "Skill name exactly as listed in <available_skills>.",
      }),
      file: Type.Optional(
        Type.String({
          description:
            "Optional path of a bundled file, relative to the skill directory. Omit to load SKILL.md.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      // 按名字查**全量**：隐藏的技能不进清单，但点名就该能加载（与 pi 的
      // /skill:name 一致）。只列可见的作为纠错提示，免得把隐藏的又推回模型眼前。
      const skill = allSkills(skillsDir).find((s) => s.name === params.name);
      if (!skill) {
        const names = scanSkills(skillsDir)
          .map((s) => s.name)
          .join(", ");
        throw new Error(
          names === ""
            ? "没有任何可用技能。"
            : `没有名为「${params.name}」的技能。可用：${names}`,
        );
      }
      const file = params.file ?? "SKILL.md";
      const path = await resolveInside(skillsDir, skill.name, file);
      const stats = await stat(path).catch(() => null);
      if (!stats?.isFile())
        throw new Error(`技能 ${skill.name} 里没有文件：${file}`);
      const raw = await readFile(path, "utf8");
      const truncated = Buffer.byteLength(raw, "utf8") > MAX_READ_BYTES;
      const text = truncated
        ? `${raw.slice(0, MAX_READ_BYTES)}\n\n[truncated at 256 KiB]`
        : raw;
      return {
        content: [{ type: "text", text }],
        details: { skill: skill.name, file, truncated },
      };
    },
  }) as ToolDefinition;
}
