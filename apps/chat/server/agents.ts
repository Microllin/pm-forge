import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { badRequest, conflict, notFound } from "./errors.js";
import { parseFrontmatter } from "./skills.js";

/**
 * 执行体（agent）库：**文件系统就是真相源**，与 skills.ts 同一条原则。
 *
 * skill 是操作手册，执行体是「照手册干活、且配好工具权限的人」。两者是组合关系
 * 不是升级关系——所以并列成两个一级菜单，而不是塞进技能页当一个标签。
 *
 * 形状照 skills.ts，但有三处实质差别，别照着 skill 的直觉改这个文件：
 *   1. **一个执行体 = 一个 `<name>.md`**，不是目录。分发是软链文件而不是软链目录，
 *      也就没有附属文件、zip 导入、文件夹导入这些分支。
 *   2. **只有一个分发目标**（~/.pi/agent/agents，见 defaultAgentTargets）。
 *   3. **没有「对模型隐藏」开关**：派不派、派谁由协调者按花名册决定（agent-team/team.ts）。
 *
 * ## 两个用途
 *
 * - 平台内：智能体团队按名字从这里现场读定义来派活，
 *   不经过分发；`tools` 里写的是平台工具注册表的名字（agent-team/tools.ts）。
 * - 平台外：软链分发给本机终端里的 pi（需装子智能体扩展才会读）。
 */

/** 文件名与 frontmatter name 的白名单：kebab，顺带拒掉路径穿越。 */
const AGENT_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME_LEN = 64;
const MAX_CONTENT_BYTES = 512 * 1024;

export const AGENT_TARGETS = ["pi"] as const;
export type AgentTarget = (typeof AGENT_TARGETS)[number];

/** 分发状态。blocked = 目标目录已有同名的别人的东西，我们不动它。 */
export type AgentLinkState = "linked" | "absent" | "blocked";
export type AgentDistribution = Record<AgentTarget, AgentLinkState>;

export interface AgentSummary {
  name: string;
  description: string;
  /**
   * 允许用的工具（原样）。平台内只认工具注册表里的名字，一个都没有的定义
   * 不进团队花名册（agent-team/team.ts 的 toMember）。
   */
  tools: string[];
  /** 指定模型；没写就跟随调用方。 */
  model?: string;
  /** 启动时预加载的 skill 名字。 */
  skills: string[];
  updatedAt: number;
  distribution: AgentDistribution;
}

export interface AgentDetail extends AgentSummary {
  /** 定义全文（含 frontmatter）。编辑器里改的就是它。 */
  content: string;
  /**
   * `skills:` 里点名了、但技能库里并不存在的那些。
   *
   * 这是执行体最容易出的一种哑故障：名字拼错或技能被删，它照样能启动，
   * 只是「带着的操作手册」悄悄没了，行为退化成自由发挥而没人看得出来。
   */
  missingSkills: string[];
}

export interface AgentStoreOptions {
  dir: string;
  /** 各 CLI 的 agent 目录。测试里指向临时目录——**绝不能在测试里写真的 home**。 */
  targetDirs: Record<AgentTarget, string>;
  /**
   * 技能库里现有的名字，用来算 missingSkills。由调用方注入：
   * store 只管自己这一摊文件，不该反过来认识技能库的目录结构。
   */
  knownSkills?: () => string[];
}

/**
 * 本机 pi 的执行体目录。pi 本身没有执行体概念，这是它的子智能体扩展
 * （官方 examples/extensions/subagent、pi-toolkit）共同约定的位置；
 * 终端里的 pi 要装了这类扩展才会读。2026-10-28 起只分发给 pi。
 */
export function defaultAgentTargets(): Record<AgentTarget, string> {
  return { pi: join(homedir(), ".pi", "agent", "agents") };
}

export interface AgentStore {
  dir: string;
  list(): Promise<AgentSummary[]>;
  get(name: string): Promise<AgentDetail>;
  /** 新建。名字取自 frontmatter 的 name，不额外要求调用方传。 */
  create(content: string): Promise<AgentDetail>;
  /**
   * 改。frontmatter 改了 name 就连文件一起改名（分发过的链随之重建），
   * 否则会留下文件名与 name 不一致的执行体——花名册和 pi 子智能体扩展都按
   * frontmatter 的 name 认它，文件名对不上时排障要绕一大圈。
   */
  update(name: string, content: string): Promise<AgentDetail>;
  remove(name: string): Promise<void>;
  distribute(
    name: string,
    targets: readonly AgentTarget[],
  ): Promise<AgentDetail>;
  undistribute(
    name: string,
    targets: readonly AgentTarget[],
  ): Promise<AgentDetail>;
}

/**
 * frontmatter 里的逗号分隔表（`tools: Read, Grep, Bash`）。
 *
 * 原样拆开不做校验：同一份定义也分发给终端里的 pi，那边的工具名不归我们校验——擅自校验
 * 只会在对方新增工具时误报一个其实能用的定义。
 */
export function csvField(md: string, key: string): string[] {
  return (singleField(md, key) ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** frontmatter 的单行字段（去掉包裹的引号）。块标量交给 parseFrontmatter。 */
export function singleField(md: string, key: string): string | undefined {
  const body = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1];
  if (body === undefined) return undefined;
  const raw = new RegExp(`^${key}:[ \\t]*(.+)$`, "m").exec(body)?.[1]?.trim();
  if (raw === undefined || raw === "") return undefined;
  const first = raw[0];
  return first !== undefined && /["']/.test(first) && raw.endsWith(first)
    ? raw.slice(1, -1).trim()
    : raw;
}

/** 定义里能被解析出来的全部字段。name / description 复用技能那边的解析器。 */
export function parseAgentDefinition(md: string): {
  name?: string;
  description?: string;
  tools: string[];
  model?: string;
  skills: string[];
} {
  const meta = parseFrontmatter(md);
  const model = singleField(md, "model");
  return {
    ...(meta.name === undefined ? {} : { name: meta.name }),
    ...(meta.description === undefined
      ? {}
      : { description: meta.description }),
    tools: csvField(md, "tools"),
    ...(model === undefined ? {} : { model }),
    skills: csvField(md, "skills"),
  };
}

export function assertValidAgentName(name: string): void {
  if (name.length > MAX_NAME_LEN || !AGENT_NAME_RE.test(name)) {
    throw badRequest(
      `执行体名不合法：「${name}」。只允许小写字母、数字和中间的连字符，最长 64 字符。`,
    );
  }
}

/**
 * 校验并取出 name。缺 name / description 时花名册与 pi 子智能体扩展都无法识别它，所以直接拒。
 * 导出给 AI 工坊（forge.ts）用同一把尺子量草稿。
 */
export function requireAgentMeta(content: string): string {
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    throw badRequest("执行体定义超过 512 KiB");
  }
  const meta = parseAgentDefinition(content);
  if (!meta.name) {
    throw badRequest(
      "定义的 frontmatter 缺 name。缺了它这个执行体无法被派活，也无法分发。",
    );
  }
  if (!meta.description) {
    throw badRequest(
      "定义的 frontmatter 缺 description。调用方是靠它判断什么时候该派这个执行体的，缺了等于永远不会被选中。",
    );
  }
  assertValidAgentName(meta.name);
  if (meta.description.length > 1024) {
    throw badRequest("description 超过 1024 字");
  }
  return meta.name;
}

export function createAgentStore(options: AgentStoreOptions): AgentStore {
  const root = resolve(options.dir);
  const agentPath = (name: string): string => join(root, `${name}.md`);

  const linkState = async (
    name: string,
    targetDir: string,
  ): Promise<AgentLinkState> => {
    const linkPath = join(targetDir, `${name}.md`);
    const stats = await lstat(linkPath).catch(() => null);
    if (!stats) return "absent";
    if (!stats.isSymbolicLink()) return "blocked"; // 真文件占了名字
    const [dest, ours] = await Promise.all([
      realpath(linkPath).catch(() => null),
      realpath(agentPath(name)).catch(() => null),
    ]);
    return dest !== null && dest === ours ? "linked" : "blocked";
  };

  const distribution = async (name: string): Promise<AgentDistribution> => ({
    pi: await linkState(name, options.targetDirs.pi),
  });

  const ensureExists = async (name: string): Promise<void> => {
    assertValidAgentName(name);
    const stats = await lstat(agentPath(name)).catch(() => null);
    if (!stats?.isFile()) throw notFound(`执行体不存在：${name}`);
  };

  const ensureFree = async (name: string): Promise<void> => {
    if (await lstat(agentPath(name)).catch(() => null)) {
      throw conflict(`已有同名执行体：${name}`);
    }
  };

  const detail = async (name: string): Promise<AgentDetail> => {
    const content = await readFile(agentPath(name), "utf8").catch(() => {
      throw notFound(`执行体不存在：${name}`);
    });
    const meta = parseAgentDefinition(content);
    const stats = await stat(agentPath(name)).catch(() => null);
    const known = new Set(options.knownSkills?.() ?? []);
    return {
      name,
      description: meta.description ?? "",
      tools: meta.tools,
      ...(meta.model === undefined ? {} : { model: meta.model }),
      skills: meta.skills,
      updatedAt: stats?.mtimeMs ?? 0,
      distribution: await distribution(name),
      content,
      // 没注入技能库时不报缺失：那只说明调用方没给，而不是真的缺。
      missingSkills:
        options.knownSkills === undefined
          ? []
          : meta.skills.filter((s) => !known.has(s)),
    };
  };

  const summary = (full: AgentDetail): AgentSummary => ({
    name: full.name,
    description: full.description,
    tools: full.tools,
    ...(full.model === undefined ? {} : { model: full.model }),
    skills: full.skills,
    updatedAt: full.updatedAt,
    distribution: full.distribution,
  });

  const distribute: AgentStore["distribute"] = async (name, targets) => {
    await ensureExists(name);
    for (const target of targets) {
      const targetDir = options.targetDirs[target];
      await mkdir(targetDir, { recursive: true });
      const linkPath = join(targetDir, `${name}.md`);
      // 已存在就一律不动：是我们的链则本来就对，不是我们的则是别人的东西。
      if (await lstat(linkPath).catch(() => null)) continue;
      await symlink(agentPath(name), linkPath, "file");
    }
    return detail(name);
  };

  /** 只摘我们自己建的链，摘不掉别人的同名文件。 */
  const unlinkOurs = async (
    name: string,
    targets: readonly AgentTarget[],
  ): Promise<void> => {
    const ours = await realpath(agentPath(name)).catch(() => null);
    for (const target of targets) {
      const linkPath = join(options.targetDirs[target], `${name}.md`);
      const stats = await lstat(linkPath).catch(() => null);
      if (!stats?.isSymbolicLink()) continue;
      const dest = await realpath(linkPath).catch(() => null);
      if (ours !== null && dest === ours) await unlink(linkPath);
    }
  };

  const update = async (
    name: string,
    content: string,
  ): Promise<AgentDetail> => {
    await ensureExists(name);
    const next = requireAgentMeta(content);
    if (next === name) {
      await writeFile(agentPath(name), content, "utf8");
      return detail(name);
    }
    // 改名：先把旧链摘掉，再把文件搬过去，最后按原分发状态重建链。
    await ensureFree(next);
    const was = await distribution(name);
    await unlinkOurs(name, AGENT_TARGETS);
    await rename(agentPath(name), agentPath(next));
    await writeFile(agentPath(next), content, "utf8");
    const relink = AGENT_TARGETS.filter((t) => was[t] === "linked");
    if (relink.length > 0) await distribute(next, relink);
    return detail(next);
  };

  return {
    dir: root,

    async list() {
      const entries = await readdir(root, { withFileTypes: true }).catch(
        () => [],
      );
      const names = entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => e.name.slice(0, -3))
        .filter((n) => AGENT_NAME_RE.test(n) && n.length <= MAX_NAME_LEN)
        .sort((a, b) => a.localeCompare(b));
      const out: AgentSummary[] = [];
      for (const name of names) out.push(summary(await detail(name)));
      return out;
    },

    async get(name) {
      await ensureExists(name);
      return detail(name);
    },

    async create(content) {
      const name = requireAgentMeta(content);
      await mkdir(root, { recursive: true });
      await ensureFree(name);
      await writeFile(agentPath(name), content, "utf8");
      return detail(name);
    },

    update,

    async remove(name) {
      await ensureExists(name);
      await unlinkOurs(name, AGENT_TARGETS); // 先摘链，免得留下悬空软链
      await rm(agentPath(name), { force: true });
    },

    distribute,

    async undistribute(name, targets) {
      await ensureExists(name);
      await unlinkOurs(name, targets);
      return detail(name);
    },
  };
}
