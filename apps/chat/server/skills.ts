import {
  lstat,
  mkdir,
  readdir,
  readFile as readFileRaw,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { unzipSync } from "fflate";

import { badRequest, conflict, notFound } from "./errors.js";

/**
 * skill 库：**文件系统就是真相源**。
 *
 * 刻意不进 SQLite：pi 自己是按目录读 SKILL.md 的（见 server/pi/skills.ts），
 * 库里再存一份就会出现「界面显示的」与「模型实际加载的」两份事实。
 * 一个 skill = 一个目录 + 必有的 SKILL.md（Agent Skills 规范的可移植形态），
 * 附属文件（references/ 等）原样躺在目录里。
 *
 * 分发（软链到 ~/.pi/agent/skills）只是顺带：本服务的对话直接读 skillsDir，
 * 不依赖分发。分发是为了同一份 skill 也能给本机终端里的 pi 用。
 * 2026-10-28 起只分发给 pi（用户拍板去掉 Claude Code）。铁律：**绝不覆盖目标目录里已有的同名项**——那是别人的地盘。
 */

/** 目录名与 frontmatter name 的白名单：kebab，顺带拒掉路径穿越。 */
const SKILL_NAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_NAME_LEN = 64;
const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 500;
/** 单个技能的体量上限。技能是给模型看的说明，不是素材库。 */
const MAX_TREE_BYTES = 20 * 1024 * 1024;
const MAX_TREE_FILES = 500;
/** 展览页能直接渲染的文本上限；再大就只报大小，避免把浏览器拖垮。 */
const MAX_VIEW_BYTES = 1024 * 1024;

export const SKILL_TARGETS = ["pi"] as const;
export type SkillTarget = (typeof SKILL_TARGETS)[number];

/** 分发状态。blocked = 目标目录已有同名的别人的东西，我们不动它。 */
export type SkillLinkState = "linked" | "absent" | "blocked";
export type SkillDistribution = Record<SkillTarget, SkillLinkState>;

export interface SkillSummary {
  name: string;
  description: string;
  /** frontmatter 写了 disable-model-invocation：模型不会自动选它，但仍可点名用。 */
  hidden: boolean;
  /** 它在每轮系统提示词里占多少字节（隐藏的为 0）。 */
  promptBytes: number;
  /** 目录里的文件数（含 SKILL.md）。>1 说明带附属文件。 */
  fileCount: number;
  updatedAt: number;
  distribution: SkillDistribution;
}

export interface SkillDetail extends SkillSummary {
  /** SKILL.md 全文（含 frontmatter）。编辑器里改的就是它。 */
  content: string;
  /** 目录内全部文件的相对路径。 */
  files: string[];
}

/** 一个待写入的文件：相对技能根的路径 + base64 内容。 */
export interface SkillTreeFile {
  path: string;
  base64: string;
}

export interface SkillFileContent {
  path: string;
  /** 文本内容；二进制文件不给内容，只报类型与大小。 */
  text: string | null;
  bytes: number;
}

export interface SkillStoreOptions {
  dir: string;
  /**
   * 每个技能在系统提示词里占多少字节。由调用方注入（server/pi/skills.ts 的
   * promptCost）——store 只管文件，不该认识 pi 的提示词格式；测试里不注入即为 0。
   */
  promptBytes?: () => Record<string, number>;
  /** 各 CLI 的 skill 目录。测试里指向临时目录——**绝不能在测试里写真的 home**。 */
  targetDirs: Record<SkillTarget, string>;
}

/**
 * 本机 pi 的用户级技能目录。
 *
 * 不用 pi 也认的 ~/.agents/skills：那是多家 CLI 共用的「Agent Skills 标准位置」，
 * 放那里等于同时发给了别的工具，与「只发给 pi」不符。
 */
export function defaultSkillTargets(): Record<SkillTarget, string> {
  return { pi: join(homedir(), ".pi", "agent", "skills") };
}

export interface SkillStore {
  dir: string;
  list(): Promise<SkillSummary[]>;
  get(name: string): Promise<SkillDetail>;
  /** 新建。名字取自 frontmatter 的 name，不额外要求调用方传。 */
  create(content: string): Promise<SkillDetail>;
  /**
   * 改。frontmatter 改了 name 就连目录一起改名（分发过的链随之重建），
   * 否则「网页里改个名字」会留下目录名与 name 不一致的 skill——
   * 别的 Agent Skills 实现会因此加载不到。
   */
  update(name: string, content: string): Promise<SkillDetail>;
  remove(name: string): Promise<void>;
  /** 导入 .zip（目录形态，带附属文件）。 */
  importZip(base64: string): Promise<SkillDetail>;
  /**
   * 导入一个技能目录的全部文件（浏览器的文件夹选择器/ 拖放给的就是这个形状）。
   * 必须恰好带一个**顶层** SKILL.md——「一次一个技能」由这条规则兜底，
   * 「一次一批」由前端按同一规则拆成多次调用（见 web/src/skills/skill-folder.ts）。
   */
  importTree(files: readonly SkillTreeFile[]): Promise<SkillDetail>;
  /** 读技能目录里的某个文件（展览页点开附属文件用）。 */
  readFile(name: string, relPath: string): Promise<SkillFileContent>;
  /**
   * 写 / 删附属文件（SKILL.md 以外）。AI 工坊保存草稿时用：SKILL.md 走 update
   * （要校验、可能改名），其余文件走这里。路径越界一律拒。
   */
  putFiles(
    name: string,
    files: readonly { path: string; text: string }[],
    removed: readonly string[],
  ): Promise<SkillDetail>;
  /** 开关「对模型隐藏」。改的是 SKILL.md 的 frontmatter，不另存一份状态。 */
  setHidden(name: string, hidden: boolean): Promise<SkillDetail>;
  distribute(
    name: string,
    targets: readonly SkillTarget[],
  ): Promise<SkillDetail>;
  undistribute(
    name: string,
    targets: readonly SkillTarget[],
  ): Promise<SkillDetail>;
}

/**
 * 从 frontmatter 取 name / description。
 *
 * 支持 YAML 的折叠/字面块标量（`>`、`>-`、`|`、`|-`）：实测 baoyu-translate 就是
 * `description: >-` 加几行缩进续行，只取单行会把描述显示成「>-」——界面上看着
 * 像个 bug，而且搜索也搜不到内容。pi 那边用的是真 YAML 解析器，所以不处理的话
 * 还会出现「界面显示 >-、模型看到的却是全文」这种两份事实。
 */
export function parseFrontmatter(md: string): {
  name?: string;
  description?: string;
} {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const body = block?.[1];
  if (body === undefined) return {};
  const lines = body.split(/\r?\n/);
  const pick = (key: string): string | undefined => {
    const at = lines.findIndex((l) => l.startsWith(`${key}:`));
    if (at < 0) return undefined;
    const head = (lines[at] ?? "").slice(key.length + 1).trim();
    // 块标量：值在后面的缩进行里。`>` 折叠成空格，`|` 保留换行。
    const scalar = /^([>|])([+-]?)$/.exec(head);
    if (scalar) {
      const kept: string[] = [];
      for (const line of lines.slice(at + 1)) {
        if (line.trim() !== "" && !/^\s/.test(line)) break; // 缩进结束 = 这个键结束
        kept.push(line.trim());
      }
      const joined =
        scalar[1] === ">"
          ? kept.join(" ").replace(/\s+/g, " ")
          : kept.join("\n");
      return joined.trim();
    }
    const value = head;
    const first = value[0];
    if (
      value.length >= 2 &&
      first !== undefined &&
      /["']/.test(first) &&
      value.endsWith(first)
    ) {
      return value.slice(1, -1).trim();
    }
    return value === "" ? undefined : value;
  };
  const name = pick("name");
  const description = pick("description");
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  };
}

/** pi 的「不让模型自动选」开关（Agent Skills 规范字段）。 */
export const HIDE_FLAG = "disable-model-invocation";

/** frontmatter 里这个开关是不是打开的。只认 true / yes / on，其余一律当未开。 */
export function readHideFlag(md: string): boolean {
  const body = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1];
  if (body === undefined) return false;
  const raw = new RegExp(`^${HIDE_FLAG}:[ \\t]*(.+)$`, "m")
    .exec(body)?.[1]
    ?.trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
  return raw === "true" || raw === "yes" || raw === "on";
}

/**
 * 改写 frontmatter 里的开关：`hidden=true` 写上，`false` 去掉整行。
 *
 * 只动这一行、别的原样保留——SKILL.md 是用户的文件，不是我们的数据结构。
 * 不引 YAML 库：引了就得把整个 frontmatter 解析再序列化，注释、键序、缩进
 * 都会被重排，用户下次打开会发现文件「自己变了样」。
 */
export function setHideFlag(md: string, hidden: boolean): string {
  const block = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(md);
  if (!block) {
    throw badRequest("SKILL.md 没有 frontmatter，无法设置可见性");
  }
  const [whole, open, body, close] = block;
  if (open === undefined || body === undefined || close === undefined) {
    throw badRequest("SKILL.md 的 frontmatter 解析失败");
  }
  const line = new RegExp(`^${HIDE_FLAG}:.*$`, "m");
  let nextBody: string;
  if (hidden) {
    nextBody = line.test(body)
      ? body.replace(line, `${HIDE_FLAG}: true`)
      : `${body}\n${HIDE_FLAG}: true`;
  } else {
    // 去掉整行，顺带收掉它留下的空行。
    nextBody = body
      .replace(line, "")
      .replace(/\n{2,}/g, "\n")
      .replace(/^\n|\n$/g, "");
  }
  return md.replace(whole, `${open}${nextBody}${close}`);
}

/**
 * 校验并取出 name / description。缺一个 pi 就静默不加载，所以这里直接拒。
 * 导出给 AI 工坊（forge.ts）：草稿每写一次就用同一把尺子量，免得「草稿看着对、保存才报错」。
 */
export function requireMeta(content: string): {
  name: string;
  description: string;
} {
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    throw badRequest("SKILL.md 超过 512 KiB");
  }
  const meta = parseFrontmatter(content);
  if (!meta.name) {
    throw badRequest(
      "SKILL.md 的 frontmatter 缺 name。缺了它 pi 会静默不加载这个技能。",
    );
  }
  if (!meta.description) {
    throw badRequest(
      "SKILL.md 的 frontmatter 缺 description。模型是靠它判断什么时候该用这个技能的，缺了等于永远不会被选中。",
    );
  }
  assertValidName(meta.name);
  if (meta.description.length > 1024) {
    throw badRequest("description 超过 1024 字（Agent Skills 规范上限）");
  }
  return { name: meta.name, description: meta.description };
}

export function assertValidName(name: string): void {
  if (name.length > MAX_NAME_LEN || !SKILL_NAME_RE.test(name)) {
    throw badRequest(
      `技能名不合法：「${name}」。只允许小写字母、数字和中间的连字符，最长 64 字符。`,
    );
  }
}

async function walkFiles(dir: string, base: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkFiles(abs, base)));
    else if (entry.isFile()) out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
}

export function createSkillStore(options: SkillStoreOptions): SkillStore {
  const root = resolve(options.dir);
  const skillPath = (name: string): string => join(root, name);

  const linkState = async (
    name: string,
    targetDir: string,
  ): Promise<SkillLinkState> => {
    const linkPath = join(targetDir, name);
    const stats = await lstat(linkPath).catch(() => null);
    if (!stats) return "absent";
    if (!stats.isSymbolicLink()) return "blocked"; // 真目录/文件占了名字
    const [dest, ours] = await Promise.all([
      realpath(linkPath).catch(() => null),
      realpath(skillPath(name)).catch(() => null),
    ]);
    return dest !== null && dest === ours ? "linked" : "blocked";
  };

  const distribution = async (name: string): Promise<SkillDistribution> => ({
    pi: await linkState(name, options.targetDirs.pi),
  });

  const mdPath = (name: string): string => join(skillPath(name), "SKILL.md");

  const ensureExists = async (name: string): Promise<void> => {
    assertValidName(name);
    const stats = await lstat(skillPath(name)).catch(() => null);
    if (!stats?.isDirectory()) throw notFound(`技能不存在：${name}`);
  };

  const ensureFree = async (name: string): Promise<void> => {
    if (await lstat(skillPath(name)).catch(() => null)) {
      throw conflict(`已有同名技能：${name}`);
    }
  };

  const detail = async (name: string): Promise<SkillDetail> => {
    const content = await readFileRaw(mdPath(name), "utf8").catch(() => {
      throw notFound(`技能缺少 SKILL.md：${name}`);
    });
    const meta = parseFrontmatter(content);
    const files = (await walkFiles(skillPath(name), skillPath(name))).sort(
      (a, b) => a.localeCompare(b),
    );
    const hidden = readHideFlag(content);
    const cost = options.promptBytes?.()[name] ?? 0;
    const stats = await stat(mdPath(name)).catch(() => null);
    return {
      name,
      description: meta.description ?? "",
      hidden,
      promptBytes: cost,
      fileCount: files.length,
      updatedAt: stats?.mtimeMs ?? 0,
      distribution: await distribution(name),
      content,
      files,
    };
  };

  const distribute: SkillStore["distribute"] = async (name, targets) => {
    await ensureExists(name);
    for (const target of targets) {
      const targetDir = options.targetDirs[target];
      await mkdir(targetDir, { recursive: true });
      const linkPath = join(targetDir, name);
      // 已存在就一律不动：是我们的链则本来就对，不是我们的则是别人的东西。
      if (await lstat(linkPath).catch(() => null)) continue;
      await symlink(skillPath(name), linkPath, "dir");
    }
    return detail(name);
  };

  /** 只摘我们自己建的链，摘不掉别人的同名目录。 */
  const unlinkOurs = async (
    name: string,
    targets: readonly SkillTarget[],
  ): Promise<void> => {
    const ours = await realpath(skillPath(name)).catch(() => null);
    for (const target of targets) {
      const linkPath = join(options.targetDirs[target], name);
      const stats = await lstat(linkPath).catch(() => null);
      if (!stats?.isSymbolicLink()) continue;
      const dest = await realpath(linkPath).catch(() => null);
      if (ours !== null && dest === ours) await unlink(linkPath);
    }
  };

  /**
   * 把一棵文件树写进技能目录。越界（zip-slip / ../）整份丢弃并报错——
   * 留半个技能在盘上比直接失败更糟，用户看不出它是坏的。
   */
  const writeTree = async (
    name: string,
    entries: readonly { path: string; data: Buffer }[],
  ): Promise<void> => {
    const dest = skillPath(name);
    await mkdir(dest, { recursive: true });
    for (const entry of entries) {
      const target = resolve(dest, entry.path);
      if (target !== dest && !target.startsWith(dest + sep)) {
        await rm(dest, { recursive: true, force: true });
        throw badRequest(`有越界路径：${entry.path}`);
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, entry.data);
    }
  };

  /**
   * 保存 SKILL.md。frontmatter 改了 name 就连目录一起改名（分发过的链随之重建），
   * 否则「网页里改个名字」会留下目录名与 name 不一致的技能——别的 Agent Skills
   * 实现会因此加载不到。
   */
  const update = async (
    name: string,
    content: string,
  ): Promise<SkillDetail> => {
    await ensureExists(name);
    const meta = requireMeta(content);
    if (meta.name === name) {
      await writeFile(mdPath(name), content, "utf8");
      return detail(name);
    }
    // 改名：先把旧链摘掉，再整目录搬过去，最后按原分发状态重建链。
    await ensureFree(meta.name);
    const was = await distribution(name);
    await unlinkOurs(name, SKILL_TARGETS);
    await rename(skillPath(name), skillPath(meta.name));
    await writeFile(mdPath(meta.name), content, "utf8");
    const relink = SKILL_TARGETS.filter((t) => was[t] === "linked");
    if (relink.length > 0) await distribute(meta.name, relink);
    return detail(meta.name);
  };

  const write = async (name: string, content: string): Promise<void> => {
    await mkdir(skillPath(name), { recursive: true });
    await writeFile(mdPath(name), content, "utf8");
  };

  return {
    dir: root,

    async list() {
      const entries = await readdir(root, { withFileTypes: true }).catch(
        () => [],
      );
      const names = entries
        .filter((e) => e.isDirectory() && SKILL_NAME_RE.test(e.name))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
      const out: SkillSummary[] = [];
      for (const name of names) {
        const has = await lstat(mdPath(name))
          .then((s) => s.isFile())
          .catch(() => false);
        if (!has) continue; // 没有 SKILL.md 的目录不是 skill，pi 也不会加载
        const full = await detail(name);
        out.push({
          name: full.name,
          description: full.description,
          hidden: full.hidden,
          promptBytes: full.promptBytes,
          fileCount: full.fileCount,
          updatedAt: full.updatedAt,
          distribution: full.distribution,
        });
      }
      return out;
    },

    async get(name) {
      await ensureExists(name);
      return detail(name);
    },

    async create(content) {
      const { name } = requireMeta(content);
      await ensureFree(name);
      await write(name, content);
      return detail(name);
    },

    update,

    async remove(name) {
      await ensureExists(name);
      await unlinkOurs(name, SKILL_TARGETS); // 先摘链，免得留下悬空软链
      await rm(skillPath(name), { recursive: true, force: true });
    },

    async importZip(base64) {
      const bytes = Buffer.from(base64, "base64");
      if (bytes.byteLength === 0)
        throw badRequest("zip 是空的，或不是合法 base64");
      if (bytes.byteLength > MAX_ZIP_BYTES) throw badRequest("zip 超过 20 MiB");
      let entries: Record<string, Uint8Array>;
      try {
        entries = unzipSync(new Uint8Array(bytes));
      } catch {
        throw badRequest("解不开这个 zip");
      }
      const paths = Object.keys(entries).filter((p) => !p.endsWith("/"));
      if (paths.length > MAX_ZIP_ENTRIES) throw badRequest("zip 里文件太多");
      // 取路径最浅的 SKILL.md 当 skill 根，其上层目录名无所谓（名字取 frontmatter）。
      const mdEntry = paths
        .filter((p) => basename(p) === "SKILL.md")
        .sort((a, b) => a.split("/").length - b.split("/").length)[0];
      if (mdEntry === undefined) throw badRequest("zip 里找不到 SKILL.md");
      const mdBytes = entries[mdEntry];
      if (!mdBytes) throw badRequest("zip 里的 SKILL.md 读不出来");
      const { name } = requireMeta(Buffer.from(mdBytes).toString("utf8"));
      await ensureFree(name);

      const prefix = mdEntry.includes("/") ? `${dirname(mdEntry)}/` : "";
      const tree: { path: string; data: Buffer }[] = [];
      for (const p of paths) {
        if (prefix && !p.startsWith(prefix)) continue; // 只取 skill 子树
        const rel = prefix ? p.slice(prefix.length) : p;
        const data = entries[p];
        if (!rel || !data) continue;
        tree.push({ path: rel, data: Buffer.from(data) });
      }
      await writeTree(name, tree);
      return detail(name);
    },

    /**
     * 文件夹导入。与 zip 导入共用同一套落盘与越界防护，区别只在「文件从哪来」。
     *
     * 隐藏文件（.DS_Store、.git/…）一律跳过：macOS 选个文件夹必带 .DS_Store，
     * 带进来既没用又会让「文件数」这个指标失真。
     */
    async importTree(files) {
      // 先判越界再滤隐藏：顺序反了的话 `../x` 会被当成「点开头的隐藏项」静默丢掉
      // （`"..".startsWith(".")` 是 true）——盘上虽然没出事，但把一个越界企图
      // 当垃圾文件吞了，出事时没人知道。
      for (const f of files) {
        const parts = f.path.split(/[\\/]/);
        if (
          f.path.startsWith("/") ||
          /^[a-zA-Z]:/.test(f.path) ||
          parts.includes("..")
        ) {
          throw badRequest(`有越界路径：${f.path}`);
        }
      }
      const visible = files.filter(
        (f) => !f.path.split("/").some((part) => part.startsWith(".")),
      );
      if (visible.length === 0)
        throw badRequest("这个文件夹里没有可导入的文件");
      if (visible.length > MAX_TREE_FILES) {
        throw badRequest(`一个技能最多 ${String(MAX_TREE_FILES)} 个文件`);
      }
      const entries = visible.map((f) => ({
        path: f.path,
        data: Buffer.from(f.base64, "base64"),
      }));
      const total = entries.reduce((sum, e) => sum + e.data.byteLength, 0);
      if (total > MAX_TREE_BYTES) {
        throw badRequest(
          "这个技能超过 20 MiB——技能是给模型看的说明，不是素材库",
        );
      }
      const md = entries.find((e) => e.path === "SKILL.md");
      if (!md) {
        throw badRequest(
          "这个文件夹里没有顶层 SKILL.md。请选技能自己的目录（里面直接放着 SKILL.md）。",
        );
      }
      const { name } = requireMeta(md.data.toString("utf8"));
      await ensureFree(name);
      await writeTree(name, entries);
      return detail(name);
    },

    async readFile(name, relPath) {
      await ensureExists(name);
      const target = resolve(skillPath(name), relPath);
      const root = resolve(skillPath(name));
      if (target !== root && !target.startsWith(root + sep)) {
        throw badRequest(`路径越界：${relPath}`);
      }
      const stats = await stat(target).catch(() => null);
      if (!stats?.isFile())
        throw notFound(`技能 ${name} 里没有这个文件：${relPath}`);
      if (stats.size > MAX_VIEW_BYTES) {
        return { path: relPath, text: null, bytes: stats.size };
      }
      const buf = await readFileRaw(target);
      // 含 NUL 一律当二进制：拿去渲染只会得到一屏乱码。
      const binary = buf.includes(0);
      return {
        path: relPath,
        text: binary ? null : buf.toString("utf8"),
        bytes: stats.size,
      };
    },

    async putFiles(name, files, removed) {
      await ensureExists(name);
      const root = resolve(skillPath(name));
      const inside = (rel: string): string => {
        const parts = rel.split(/[\\/]/);
        const target = resolve(root, rel);
        if (
          rel === "" ||
          rel.startsWith("/") ||
          parts.includes("..") ||
          parts.some((p) => p.startsWith(".")) ||
          !target.startsWith(root + sep)
        )
          throw badRequest(`有越界路径：${rel}`);
        if (rel === "SKILL.md") throw badRequest("SKILL.md 要走保存接口");
        return target;
      };
      // 先全部校验再落盘：半截写入的技能比直接失败更糟。
      const writes = files.map((f) => ({
        target: inside(f.path),
        text: f.text,
      }));
      const deletes = removed.map(inside);
      for (const w of writes) {
        await mkdir(dirname(w.target), { recursive: true });
        await writeFile(w.target, w.text, "utf8");
      }
      for (const d of deletes) await rm(d, { force: true });
      return detail(name);
    },

    async setHidden(name, hidden) {
      await ensureExists(name);
      const current = await detail(name);
      if (current.hidden === hidden) return current; // 已经是这个状态，不白写一次盘
      return update(name, setHideFlag(current.content, hidden));
    },

    distribute,

    async undistribute(name, targets) {
      await ensureExists(name);
      await unlinkOurs(name, targets);
      return detail(name);
    },
  };
}
