import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { Db } from "./db.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { CODE_ROOT, assertValidName, childOf } from "./files/paths.js";
import { registerAutoSync } from "./code-repos-sync.js";
import type { FileStore } from "./files/store.js";

/**
 * 代码库（事实底座 → 代码库）：按「仓库」管理 /代码库 下的一级文件夹。
 *
 * 存储不另起一套——仓库就是 /代码库/<名字> 这个文件夹，里面的文件仍归 FileStore 管，
 * 所以上传、浏览、预览全部复用文件模块。这里只补文件模块不知道的两件事：
 *   1. 每个仓库的体量（文件数 / 字节 / 最近更新），给仓库清单用；
 *   2. 仓库与产品的绑定（products.code_path）。改名要跟着改绑定，删除要先解绑——
 *      否则产品页上挂着一个指向空处的代码目录，AI 分析读代码时才发现读不到。
 */

export interface CodeRepo {
  name: string;
  path: string;
  files: number;
  bytes: number;
  /** 仓库里最近一个文件的修改时间；空仓库为 null。 */
  modifiedAt: number | null;
  createdAt: number;
  /** 代码目录绑在这个仓库（或它下面某个子目录）上的产品。 */
  products: { id: string; name: string }[];
  /** 从 git 读到的信息；不是 git 仓库时三者都是 null（界面上显示为「上传的文件夹」）。 */
  git: {
    remote: string | null;
    branch: string | null;
    commit: string | null;
  } | null;
}

const nameBody = z.object({ name: z.string().trim().min(1, "名字不能为空") });

interface NameParams {
  Params: { name: string };
}

export function registerCodeRepoRoutes(
  app: FastifyInstance,
  db: Db,
  files: FileStore,
  now: () => number = Date.now,
  git: GitDeps = defaultGitDeps(() => files.reindexUnder(CODE_ROOT)),
): void {
  /** 同一个仓库同时只允许一个 git 任务。 */
  const busy = new Set<string>();
  const pathOf = (name: string): string => {
    assertValidName(name);
    return childOf(CODE_ROOT, name);
  };

  const boundTo = (path: string): { id: string; name: string }[] =>
    db
      .prepare<[string, number, string], { id: string; name: string }>(
        "SELECT id, name FROM products WHERE code_path = ? OR substr(code_path, 1, ?) = ? ORDER BY name",
      )
      .all(path, path.length + 1, `${path}/`);

  const describe = (entry: {
    name: string;
    path: string;
    modifiedAt: number;
  }): CodeRepo => {
    const stats = files.summarize(entry.path);
    return {
      name: entry.name,
      path: entry.path,
      files: stats.files,
      bytes: stats.bytes,
      modifiedAt: stats.modifiedAt,
      createdAt: entry.modifiedAt,
      products: boundTo(entry.path),
      git: gitInfo(join(files.root, entry.path)),
    };
  };

  /** 确认仓库存在且是文件夹，返回它的条目（files.item 只认文件，所以从清单里找）。 */
  const requireRepo = async (name: string) => {
    const path = pathOf(name);
    const { entries } = await files.list(CODE_ROOT);
    const entry = entries.find((e) => e.isDir && e.path === path);
    if (entry === undefined) throw notFound(`代码库里没有仓库「${name}」`);
    return entry;
  };

  app.get("/api/code-repos", async () => {
    const { entries } = await files.list(CODE_ROOT);
    return { repos: entries.filter((e) => e.isDir).map(describe) };
  });

  app.post("/api/code-repos", async (request, reply) => {
    const { name } = nameBody.parse(request.body);
    const entry = await files.createFolder(pathOf(name));
    return reply.code(201).send(describe(entry));
  });

  app.patch<NameParams>("/api/code-repos/:name", async (request) => {
    const { name: next } = nameBody.parse(request.body);
    const current = await requireRepo(request.params.name);
    const from = current.path;
    const to = pathOf(next);
    if (from === to) return describe(current);
    const entry = await files.move(from, to);
    // 绑定跟着搬：/代码库/旧名 与 /代码库/旧名/子目录 都换成新名开头。
    db.prepare(
      "UPDATE products SET code_path = ? || substr(code_path, ?), updated_at = ? WHERE code_path = ? OR substr(code_path, 1, ?) = ?",
    ).run(to, from.length + 1, now(), from, from.length + 1, `${from}/`);
    return describe(entry);
  });

  /** 清空仓库内容、保留仓库本身与绑定：「重新上传」覆盖前调用。 */
  app.post<NameParams>("/api/code-repos/:name/reset", async (request) => {
    await requireRepo(request.params.name);
    const path = pathOf(request.params.name);
    await files.remove(path, { recursive: true });
    return describe(await files.createFolder(path));
  });

  /** 开一条 SSE：先确认可跑（抛错就是普通 HTTP 错误），再跑任务。 */
  const stream = (
    reply: FastifyReply,
    task: (emit: (event: Record<string, unknown>) => void) => Promise<void>,
  ): void => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    /*
     * 客户端断开后不再往这条流里写。
     *
     * 实测：Node 下客户端断开后 `raw.writableEnded` 仍是 false（`write()` 只是返回
     * false，不抛错），所以只判它一个是不够的——日志会继续往一个没人看的连接里灌。
     * 监听 close 置一个标志，写之前判它。
     *
     * **任务本身继续跑完**：克隆、拉取是用户明确发起的，跑一半掐掉只会留下一个
     * 需要人手动清理的半成品。断线只影响“还看不看得到进度”。
     */
    let gone = false;
    raw.on("close", () => {
      gone = true;
    });
    const emit = (event: Record<string, unknown>): void => {
      if (gone || raw.writableEnded) return;
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    void task(emit).finally(() => {
      if (!gone && !raw.writableEnded) raw.end();
    });
  };

  /**
   * 克隆仓库，git 的输出边走边推给界面。先 clone 到临时目录，成功再改名——
   * 失败不会留下半个仓库，也不会顶掉已有的同名仓库（重名在 createFolder 处 409）。
   */
  app.post("/api/code-repos/clone", (request, reply) => {
    const body = z
      .object({
        url: z.string().trim().min(1, "仓库地址不能为空"),
        name: z.string().trim().optional(),
        branch: z.string().trim().optional(),
      })
      .parse(request.body ?? {});
    checkGitUrl(body.url);
    const name = repoNameFrom(body.url, body.name);
    if (busy.has(name)) throw conflict(`「${name}」正在克隆或拉取`);
    const dest = pathOf(name);
    const staging = `${dest}.cloning`;
    // 重名要在开流之前就拒：否则客户端先看到 200，再在流里读到失败，
    // 界面得为「其实没开始」多写一套状态。克隆本身可能跑几分钟，早失败也省事。
    if (files.exists(dest)) throw conflict(`代码库里已经有「${name}」了`);
    busy.add(name);

    stream(reply, async (emit) => {
      try {
        // --progress：非 TTY 下 git 默认不报进度，界面上会一直空着。
        const cloneArgs = (url: string): string[] => [
          "clone",
          "--progress",
          ...(body.branch !== undefined && body.branch !== ""
            ? ["--branch", body.branch]
            : []),
          "--",
          url,
          join(files.root, staging),
        ];
        const onLine = (line: string): void => {
          emit({ type: "line", line });
        };
        emit({ type: "phase", phase: "clone", name });
        let result = await git.run(cloneArgs(body.url), files.root, onLine);
        /*
         * HTTPS 地址要账号而这台机器没存（服务端没法弹窗要密码），就换成同一个仓库的
         * SSH 地址再试一次：部署机器通常配了 SSH 密钥，而且有的网络 HTTPS 访问 GitHub
         * 本身就不通、SSH 通（开发机实测）。用户照样贴网页上默认的 HTTPS 地址即可。
         */
        const ssh = sshUrlOf(body.url);
        if (result.code !== 0 && ssh !== null && isAuthFailure(result.output)) {
          emit({
            type: "line",
            line: `HTTPS 地址需要账号，改用 SSH 地址重试：${ssh}`,
          });
          await files
            .remove(staging, { recursive: true })
            .catch(() => undefined);
          const viaSsh = await git.run(cloneArgs(ssh), files.root, onLine);
          if (viaSsh.code !== 0) {
            emit({
              type: "done",
              ok: false,
              error: `这个仓库需要权限，HTTPS 和 SSH 两种地址都没进去。请确认运行 PMForge 的这台机器的 SSH 公钥已加到有该仓库权限的账号上（git 原话：${gitMessage(viaSsh.output, "SSH 克隆失败")}）`,
            });
            return;
          }
          result = viaSsh;
        }
        if (result.code !== 0) {
          emit({
            type: "done",
            ok: false,
            error: gitMessage(result.output, "克隆失败"),
          });
          return;
        }
        await files.move(staging, dest);
        await git.reindex(dest);
        emit({
          type: "done",
          ok: true,
          repo: describe(await requireRepo(name)),
        });
      } catch (cause) {
        emit({
          type: "done",
          ok: false,
          error: cause instanceof Error ? cause.message : "克隆失败",
        });
      } finally {
        // 失败时的半成品：临时目录整段删掉（已经改名成功的话这段就是空操作）。
        await files.remove(staging, { recursive: true }).catch(() => undefined);
        busy.delete(name);
      }
    });
  });

  /**
   * 拉取一个仓库（调用方已加锁、已确认是 git 仓库）。手动拉取与定时同步共用这一段。
   * 工作区有本地改动且没同意丢弃时拒绝（事件 type: "dirty"）。只做快进合并：
   * 分叉了就让用户自己处理，不替人做决定。返回值与最后一条 done 事件一致。
   */
  const pullTask = async (
    name: string,
    discardsChanges: boolean,
    emit: (event: Record<string, unknown>) => void,
  ): Promise<{ ok: boolean; error?: string; changed?: boolean }> => {
    const path = pathOf(name);
    const dir = join(files.root, path);
    const fail = (error: string) => {
      emit({ type: "done", ok: false, error });
      return { ok: false, error };
    };
    try {
      emit({ type: "phase", phase: "pull", name });
      // status 不需要逐行回调（结果要整段解析）。
      const quiet = (): void => undefined;
      const status = await git.run(["status", "--porcelain"], dir, quiet);
      const dirtyLines = status.output.split("\n").filter((l) => l.trim());
      if (dirtyLines.length > 0 && !discardsChanges) {
        emit({ type: "dirty", files: dirtyLines.length });
        return fail(
          `仓库里有 ${String(dirtyLines.length)} 处本地改动，拉取会覆盖它们`,
        );
      }
      const before = gitInfo(dir)?.commit ?? null;
      const fetched = await git.run(
        ["fetch", "--progress", "--all", "--prune"],
        dir,
        (line) => {
          emit({ type: "line", line });
        },
      );
      if (fetched.code !== 0)
        return fail(gitMessage(fetched.output, "拉取失败"));
      if (dirtyLines.length > 0) {
        await git.run(["reset", "--hard", "HEAD"], dir, quiet);
        await git.run(["clean", "-fd"], dir, quiet);
      }
      const merged = await git.run(
        ["merge", "--ff-only", "@{u}"],
        dir,
        (line) => {
          emit({ type: "line", line });
        },
      );
      if (merged.code !== 0)
        return fail(
          gitMessage(
            merged.output,
            "本地与远端分叉了，自动拉取只做快进；请手动处理",
          ),
        );
      const changed = (gitInfo(dir)?.commit ?? null) !== before;
      // 没拉到新提交就不重建索引：定时同步大多数时候是这种情况，省掉一次全量扫描。
      if (changed || dirtyLines.length > 0) await git.reindex(path);
      emit({
        type: "done",
        ok: true,
        repo: describe(await requireRepo(name)),
      });
      return { ok: true, changed };
    } catch (cause) {
      return fail(cause instanceof Error ? cause.message : "拉取失败");
    }
  };

  /** 拉取更新（手动）。界面问过一次「丢弃本地改动」后带 discardsChanges 再来。 */
  app.post<NameParams>("/api/code-repos/:name/pull", (request, reply) => {
    const name = request.params.name;
    const body = z
      .object({ discardsChanges: z.boolean().optional() })
      .parse(request.body ?? {});
    const dir = join(files.root, pathOf(name));
    if (!existsSync(join(dir, ".git")))
      throw badRequest(`「${name}」不是 git 仓库，不能拉取更新`);
    if (busy.has(name)) throw conflict(`「${name}」正在克隆或拉取`);
    busy.add(name);

    stream(reply, async (emit) => {
      try {
        await pullTask(name, body.discardsChanges === true, emit);
      } finally {
        busy.delete(name);
      }
    });
  });

  registerAutoSync(app, db, now, {
    async repos() {
      const { entries } = await files.list(CODE_ROOT);
      return entries
        .filter((e) => e.isDir && existsSync(join(files.root, e.path, ".git")))
        .map((e) => e.name);
    },
    async pull(name) {
      if (busy.has(name))
        return { ok: false, error: "正在克隆或拉取，本轮跳过" };
      busy.add(name);
      try {
        // 定时同步绝不丢弃本地改动：有改动就记一条失败，留给人决定。
        return await pullTask(name, false, () => undefined);
      } finally {
        busy.delete(name);
      }
    },
  });

  app.delete<NameParams>("/api/code-repos/:name", async (request) => {
    await requireRepo(request.params.name);
    const path = pathOf(request.params.name);
    const unbound = boundTo(path);
    db.prepare(
      "UPDATE products SET code_path = NULL, updated_at = ? WHERE code_path = ? OR substr(code_path, 1, ?) = ?",
    ).run(now(), path, path.length + 1, `${path}/`);
    await files.remove(path, { recursive: true });
    return { unbound };
  });
}

/* ── Git ──────────────────────────────────────────────────────────────
   代码库的主路径是「从仓库克隆」，不是逐个文件上传。这里只用本机 git（不引库），
   并把「会改动磁盘」的三件事守住：
   1. URL 只认 https / ssh / git@host:path / 绝对路径——挡 `ext::` 这类能执行命令的传输协议，
      参数一律排在 `--` 之后，URL 不可能被当成选项；
   2. 克隆先落到临时目录，成功后改名；失败就把临时目录删掉，不留下半个仓库；
   3. 拉取更新先看工作区干不干净，脏就拒绝并让界面问一次「丢弃本地改动」，
      不悄悄覆盖用户手改过的代码。
   克隆 / 拉取期间按仓库名加锁，同一个仓库不会同时跑两遍。
   -------------------------------------------------------------------- */

const URL_PATTERN = /^(https?:\/\/|ssh:\/\/|git@[^/\s:]+:|git:\/\/|\/)/i;

export function checkGitUrl(url: string): void {
  if (!URL_PATTERN.test(url) || url.startsWith("-")) {
    throw badRequest(
      "只支持 https:// 或 ssh:// 的仓库地址（也可以填本机绝对路径）",
    );
  }
}

/**
 * HTTPS 仓库地址换成同一个仓库的 SSH 地址（GitHub / GitLab / Gitee 通用写法）；认不出返回 null。
 * `https://github.com/org/repo(.git)` → `git@github.com:org/repo.git`；带子组的路径原样保留。
 */
export function sshUrlOf(url: string): string | null {
  const m =
    /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  if (m === null) return null;
  const [, host, path] = m;
  if (host === undefined || !path?.includes("/")) return null;
  return `git@${host}:${path}.git`;
}

/** git 输出里「要账号 / 没权限」的说法。GitHub 对没权限的私有仓库回「Repository not found」。 */
const AUTH_FAILURE =
  /Authentication failed|could not read Username|terminal prompts disabled|Repository not found|returned error: 40[13]/i;
export const isAuthFailure = (output: string): boolean =>
  AUTH_FAILURE.test(output);

export interface GitStream {
  emit: (event: Record<string, unknown>) => void;
  signal: AbortSignal;
}

export interface GitDeps {
  /** 跑 git。测试里换成假的。 */
  run: (
    args: string[],
    cwd: string,
    onLine: (line: string) => void,
    signal?: AbortSignal,
  ) => Promise<{ code: number; output: string }>;
  /** 仓库有改动后重建这一支的索引。 */
  reindex: (path: string) => Promise<number>;
}

export function defaultGitDeps(
  reindex: (path: string) => Promise<number>,
): GitDeps {
  return {
    reindex,
    async run(args, cwd, onLine, signal) {
      return new Promise((resolve) => {
        const child = spawn(
          process.env.PMForge_GIT ?? "git",
          ["-c", "core.askPass=true", ...args],
          {
            cwd,
            env: {
              ...process.env,
              // 别让 git 卡在交互式提示上：没有凭据就直接失败，把话交回界面。
              GIT_TERMINAL_PROMPT: "0",
              // SSH 同理：不问密码短语；第一次连某个站点自动记下它的指纹，而不是卡在 yes/no 上。
              GIT_SSH_COMMAND:
                process.env.GIT_SSH_COMMAND ??
                "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new",
            },
            ...(signal === undefined ? {} : { signal }),
          },
        );
        let output = "";
        let buffer = "";
        const onData = (data: Buffer): void => {
          const text = data.toString("utf8");
          output += text;
          buffer += text;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) if (line.trim() !== "") onLine(line);
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("error", (error) => {
          output += String(error);
          resolve({ code: 1, output });
        });
        child.on("close", (code) => {
          if (buffer.trim() !== "") onLine(buffer);
          resolve({ code: code ?? 1, output });
        });
      });
    },
  };
}

/** 从仓库地址推出仓库名：最后一段去 .git、去掉非安全字符；可用 name 覆盖。 */
export function repoNameFrom(url: string, override?: string): string {
  const raw =
    override !== undefined && override !== ""
      ? override
      : (
          url
            .replace(/[/\\]+$/, "")
            .split(/[/:]/)
            .pop() ?? "repo"
        ).replace(/\.git$/i, "");
  // assertValidName 的要求：非空、不含 / \ 控制字符、不以 . 开头、≤255 字节。
  // 控制字符用字符码过滤，不写进正则（与 files/paths.ts 的 hasControl 同一口径）。
  // 逐字符过滤：控制字符、/、\ 一律换成 -；再剥掉开头的点。
  let cleaned = "";
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw.charAt(i);
    const code = raw.charCodeAt(i);
    cleaned +=
      code < 0x20 || code === 0x7f || ch === "/" || ch === "\\" ? "-" : ch;
  }
  cleaned = cleaned.replace(/^\.+/, "");
  assertValidName(cleaned);
  return cleaned;
}

/** git 失败时给人看的一句话：优先取 stderr 里最后一条有内容的行。 */
export function gitMessage(output: string, fallback: string): string {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(
      (l) =>
        l !== "" &&
        !l.startsWith("remote: Counting") &&
        !l.startsWith("Receiving"),
    );
  const last = lines.at(-1);
  return last === undefined ? fallback : last.slice(0, 400);
}

/** 从仓库目录读一行 git 信息（远端地址、分支、HEAD），读不到就给空。 */
function gitInfo(dir: string): {
  remote: string | null;
  branch: string | null;
  commit: string | null;
} | null {
  const read = (file: string): string | null => {
    try {
      return readFileSync(join(dir, file), "utf8").trim();
    } catch {
      return null;
    }
  };
  // 没有 .git 就是上传来的文件夹，不是 git 仓库——三者都空会让界面显示「detached」，
  // 还给出一个点了必然失败的「拉取」按钮。
  if (!existsSync(join(dir, ".git"))) return null;
  const head = read(".git/HEAD");
  const branch = head?.startsWith("ref: refs/heads/")
    ? head.slice("ref: refs/heads/".length)
    : null;
  const config = read(".git/config") ?? "";
  const remote =
    /\[remote "origin"\][\s\S]*?url\s*=\s*(.+)/.exec(config)?.[1]?.trim() ??
    null;
  const commit = branch === null ? null : read(`.git/refs/heads/${branch}`);
  return { remote, branch, commit };
}
