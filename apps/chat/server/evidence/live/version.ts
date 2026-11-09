import { execFile } from "node:child_process";
import { promisify } from "node:util";

/**
 * 版本标记：这一轮截图，截的是「哪个版本的产品」。
 *
 * 快照要能和产品版本对上，否则「历史上长什么样」没法回答。版本从**代码仓库的 git** 里读：
 * - 提交号（完整 / 短）、分支、最近的标签（如 v2.7.2）；
 * - 如果是合并提交，从标题里摘出 PR 号（`Merge pull request #3827 from ...`）；
 * - 工作区有未提交改动时记 `dirty`——那种快照对应的是「某次提交 + 本地改动」，不能当成干净的版本。
 *
 * 读不到 git（仓库是上传的文件夹、或没有 git 命令）时如实返回空，不编版本号。
 */

const run = promisify(execFile);

export interface CodeVersion {
  /** 完整提交号 */
  commit: string | null;
  short: string | null;
  branch: string | null;
  /** 最近可达的标签（`git describe --tags --always`），没有就是 null */
  tag: string | null;
  /** 合并提交标题里的 PR 号 */
  pr: number | null;
  /** 工作区有未提交改动 */
  dirty: boolean;
  /** 提交标题，给人看 */
  subject: string | null;
  /** 提交时间（毫秒） */
  committedAt: number | null;
  /** 读不到 git 时的原因 */
  unavailable: string | null;
}

const EMPTY: CodeVersion = {
  commit: null,
  short: null,
  branch: null,
  tag: null,
  pr: null,
  dirty: false,
  subject: null,
  committedAt: null,
  unavailable: null,
};

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], {
      timeout: 10_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * 读一个目录的版本。`dir` 可以是仓库根，也可以是子目录（git 会往上找）。
 * 用 `--porcelain` 只看是否有改动，不关心改了哪些——快照只需要知道「干不干净」。
 */
export async function readVersion(dir: string): Promise<CodeVersion> {
  const commit = await git(dir, ["rev-parse", "HEAD"]);
  if (commit === null)
    return {
      ...EMPTY,
      unavailable:
        "这个目录不是 git 仓库（或者是上传的源码文件夹），读不到版本信息",
    };
  const [short, branch, tag, subject, at, status] = await Promise.all([
    git(dir, ["rev-parse", "--short", "HEAD"]),
    git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]),
    git(dir, ["describe", "--tags", "--always"]),
    git(dir, ["log", "-1", "--format=%s"]),
    git(dir, ["log", "-1", "--format=%ct"]),
    git(dir, ["status", "--porcelain"]),
  ]);
  const pr =
    subject === null ? null : /Merge pull request #(\d+)/.exec(subject)?.[1];
  const seconds = at === null ? null : Number(at);
  return {
    commit,
    short,
    branch: branch === "HEAD" ? null : branch,
    tag: tag !== null && /^v?\d/.test(tag) ? tag : null,
    pr: pr === undefined ? null : Number(pr),
    dirty: status !== null && status !== "",
    subject,
    committedAt:
      seconds !== null && Number.isFinite(seconds) ? seconds * 1000 : null,
    unavailable: null,
  };
}

/** 版本的一句话标签，如「v2.7.2 · 882917bc2 · PR #3827（main，有本地改动）」。 */
export function versionLabel(v: CodeVersion): string {
  if (v.commit === null) return "未知版本";
  const parts = [
    v.tag ?? v.short ?? v.commit.slice(0, 8),
    ...(v.pr === null ? [] : [`PR #${String(v.pr)}`]),
  ];
  const ctx = [
    ...(v.branch === null ? [] : [v.branch]),
    ...(v.dirty ? ["有本地改动"] : []),
  ];
  return `${parts.join(" · ")}${ctx.length === 0 ? "" : `（${ctx.join("，")}）`}`;
}

/** 版本目录名：能排序、能一眼看出是哪个版本。 */
export function versionSlug(v: CodeVersion, at: number): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+/, "")
    .replace("T", "-");
  const id = v.short ?? "unknown";
  return `${stamp}-${id}${v.dirty ? "-dirty" : ""}`;
}
