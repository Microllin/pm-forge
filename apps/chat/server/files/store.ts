import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { existsSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";

import { zipSync, type Zippable } from "fflate";

import { IN_MEMORY, openSqlite, type Db } from "../db.js";
import { HttpError, conflict, notFound } from "../errors.js";
import { SNIFF_BYTES, detectKind, isTextKind, type FileKind } from "./kinds.js";
import {
  assertValidName,
  childOf,
  isHiddenName,
  isRoot,
  isWithin,
  nameOf,
  normalizePath,
  parentOf,
  resolveSafe,
} from "./paths.js";

/**
 * 文件模块的存储：**磁盘是真相源，files.db 只是索引**。
 *
 * - 文件原样放在根目录（默认 {数据目录}/files）下。Finder、命令行、以后对话里的
 *   模型都能直接用这些文件，不需要从库里「导出」。
 * - files.db 两张表：entries（路径、大小、修改时间、类型）用于按名称搜索与类型缓存；
 *   file_text（FTS5 全文索引，trigram 分词）用于按内容搜索。都可以随时删掉重建（reindex）。
 * - 每次列目录都读磁盘，并把这一层的索引对齐——在 Finder 里改过的东西，打开那个
 *   文件夹就会出现。
 *
 * 写入一律原子：先写到同目录的临时文件 / 临时目录，再改名替换；「不覆盖」的新建用
 * 硬链接（文件）或先占位的空目录（文件夹）实现，不存在「先检查再写」的竞态。
 */

export type EntryKind = FileKind | "folder";

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  /** 字节数；文件夹为 0。 */
  size: number;
  /** 修改时间（毫秒时间戳）。 */
  modifiedAt: number;
  kind: EntryKind;
  /**
   * 版本标识（修改时间 + 大小）。保存文本时带上它，磁盘上的文件在此期间被改过
   * 就拒绝保存（412），不会悄悄覆盖别人的修改。
   */
  version: string;
}

export interface FileItem extends FileEntry {
  /**
   * 文本内容。只有文本类且不超过 EDIT_LIMIT 时才有；否则为 null——
   * 前端据此决定用编辑器还是预览，不自己猜类型。空文件是 ""，不是 null。
   */
  content: string | null;
  /** content 为 null 的原因（便于前端提示）。 */
  contentOmitted?: "not-text" | "too-large";
}

/** 搜索结果：按名称命中，或按内容命中（带一段上下文）。 */
export interface SearchHit extends FileEntry {
  match: "name" | "content";
  snippet?: string;
}

export type WriteMode = "create" | "overwrite" | "autorename";
export type BatchAction = "move" | "copy" | "delete";

export interface BatchResult {
  succeeded: { path: string; entry?: FileEntry }[];
  failed: { path: string; message: string }[];
}

/** 文本超过这个大小不在线编辑（编辑器处理几 MB 以上的文本会明显卡顿）。 */
export const EDIT_LIMIT = 5 * 1024 * 1024;
/**
 * 单个文件上传上限的默认值（可用 PMFORGE_CHAT_FILE_LIMIT_MB 改）。
 * 上传是边收边写盘的，不在内存里攒整个文件，所以上限只受磁盘约束。
 */
export const DEFAULT_UPLOAD_LIMIT = 2 * 1024 * 1024 * 1024;

export interface FileStoreOptions {
  /** 单个文件上传上限（字节）。 */
  uploadLimit?: number;
}

/** 「2 GB」「500 MB」 */
export function formatLimit(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 && Number.isInteger(gb)
    ? `${String(gb)} GB`
    : `${String(Math.round(bytes / 1024 ** 2))} MB`;
}
/** 只给不超过这个大小的文本建全文索引（更大的多半是日志 / 数据导出，按内容搜意义不大）。 */
export const TEXT_INDEX_LIMIT = 1024 * 1024;
/** 打包下载的总大小上限（在内存里打包）。 */
export const ZIP_LIMIT = 200 * 1024 * 1024;

const TMP_PREFIX = ".pmforge-tmp-";

const INDEX_MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE entries (
    path        TEXT PRIMARY KEY,
    parent      TEXT NOT NULL,
    name        TEXT NOT NULL,
    is_dir      INTEGER NOT NULL,
    size        INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    kind        TEXT NOT NULL
  );
  CREATE INDEX entries_parent ON entries(parent);
  `,
  /*
   * 全文索引。rowid 与 entries 的 rowid 一一对应（不另存路径）：删一个条目就按 rowid
   * 删它的文本，不必扫全表。trigram 分词：中文不需要分词器也能按子串搜（≥ 3 个字符）；
   * 1–2 个字符的查询 trigram 搜不了，回退为在已索引文本里找子串。
   */
  `
  CREATE VIRTUAL TABLE file_text USING fts5(content, tokenize = 'trigram');
  `,
];

export function openFilesIndex(path: string = IN_MEMORY): Db {
  return openSqlite(path, INDEX_MIGRATIONS);
}

interface Row {
  path: string;
  parent: string;
  name: string;
  is_dir: number;
  size: number;
  modified_at: number;
  kind: string;
}

const versionOf = (modifiedAt: number, size: number): string =>
  `${String(modifiedAt)}-${String(size)}`;

const toEntry = (r: Row): FileEntry => ({
  name: r.name,
  path: r.path,
  isDir: r.is_dir === 1,
  size: r.size,
  modifiedAt: r.modified_at,
  kind: r.kind as EntryKind,
  version: versionOf(r.modified_at, r.size),
});

const errno = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : "操作失败";

/**
 * 排序：文件夹在前；同类里以 ASCII 字符开头的名字在前（与 Finder 一致），
 * 其余按中文拼音；数字按大小比（「第 2 章」在「第 10 章」前）。
 */
const collator = new Intl.Collator("zh-Hans-CN", { numeric: true });
const asciiFirst = (name: string): number =>
  name.charCodeAt(0) < 0x80 ? 0 : 1;
const byFolderThenName = (a: FileEntry, b: FileEntry): number => {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return (
    asciiFirst(a.name) - asciiFirst(b.name) || collator.compare(a.name, b.name)
  );
};

/** 「名称 (1).md」「名称 (2).md」……（文件夹没有扩展名：「名称 (1)」）。 */
function numbered(name: string, n: number, isDir = false): string {
  const dot = isDir ? -1 : name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)} (${String(n)})${name.slice(dot)}`
    : `${name} (${String(n)})`;
}
const candidateName = (base: string, n: number, isDir = false): string =>
  n === 0 ? base : numbered(base, n, isDir);
const MAX_RENAME_TRIES = 1000;

/** 搜索结果的上下文片段：命中处前后各约 40 个字符，换行压成空格。 */
function snippetOf(content: string, query: string): string {
  const at = content.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return content.slice(0, 80).replace(/\s+/g, " ").trim();
  const start = Math.max(0, at - 40);
  const end = Math.min(content.length, at + query.length + 40);
  const text = content.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${end < content.length ? "…" : ""}`;
}

/** 选中项里如果同时有某个文件夹和它里面的东西，只保留外层（否则处理完外层，里面的就「不存在」了）。 */
function topLevelOnly(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter(
    (p) => !unique.some((other) => other !== p && isWithin(p, other)),
  );
}

export interface FileStore {
  readonly root: string;
  readonly uploadLimit: number;
  list(path: string): Promise<{ path: string; entries: FileEntry[] }>;
  /**
   * 递归列出一个范围（含子孙）里的**文件**，不碰磁盘、只查索引。
   *
   * 给「AI 识别售前材料」用：用户选一个大文件夹，里面可能有几百个零散文件，
   * 要先一次性拿到清单才能判断哪份是白皮书、哪份是最新一版。逐个目录 list
   * 会把一次点击变成几百次往返，而且深目录还会漏。
   *
   * 按修改时间倒序、带总数上限——清单过长时先给最近改过的那些，
   * 因为「最新一版」永远是我们要挑的东西。
   */
  listFilesDeep(
    path: string,
    options?: { limit?: number },
  ): { files: FileEntry[]; total: number; truncated: boolean };
  /** 某个路径此刻在不在（同步、只看磁盘）。 */
  exists(path: string): boolean;
  item(path: string, options?: { content?: boolean }): Promise<FileItem>;
  openRead(path: string): Promise<{ entry: FileEntry; stream: ReadStream }>;
  createFolder(
    path: string,
    options?: { autorename?: boolean },
  ): Promise<FileEntry>;
  /** data 可以是 Buffer（保存文本）或流（上传，边收边写盘）。 */
  write(
    path: string,
    data: Buffer | Readable,
    options?: { mode?: WriteMode; expectedVersion?: string; parents?: boolean },
  ): Promise<{ entry: FileEntry; created: boolean }>;
  move(from: string, to: string): Promise<FileEntry>;
  /** 复制到 `to`；目标已存在时自动改名为「名称 (1)」。 */
  copy(from: string, to: string): Promise<FileEntry>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  /** 批量移动 / 复制（到 target 文件夹）/ 删除，逐项报告结果。 */
  batch(
    action: BatchAction,
    paths: string[],
    target?: string,
  ): Promise<BatchResult>;
  /** 把若干文件 / 文件夹打成一个 zip（内存中），返回 zip 字节与建议的文件名。 */
  zip(paths: string[]): Promise<{ data: Buffer; name: string }>;
  search(query: string, limit?: number): SearchHit[];
  /**
   * 某个文件夹下（含子孙）的文件数、总字节、最近修改时间。只查索引，不碰磁盘——
   * 代码库首页要一次列出每个仓库的这三样，逐个 stat 上万个文件不现实。
   */
  summarize(path: string): {
    files: number;
    bytes: number;
    modifiedAt: number | null;
  };
  reindex(): Promise<number>;
  /**
   * 只重建 `path` 这一支的索引（克隆 / 拉取之后用）。
   * 整库 reindex 要走上万个文件；一次 pull 只动了一个仓库，没必要把整个库重扫一遍。
   */
  reindexUnder(path: string): Promise<number>;
}

/**
 * @param root 文件根目录的**真实路径**（调用方先 realpath；见 paths.ts 的说明）。
 */
export function createFileStore(
  root: string,
  index: Db,
  options: FileStoreOptions = {},
): FileStore {
  const uploadLimit = options.uploadLimit ?? DEFAULT_UPLOAD_LIMIT;
  const tooLarge = () =>
    new HttpError(
      413,
      "TOO_LARGE",
      `文件超过 ${formatLimit(uploadLimit)} 上限`,
    );

  /**
   * 把内容写进临时文件。流式写入时一边写一边计数，超过上限立刻中断
   * （请求头里的 Content-Length 由路由先拦一道；这里兜底没有或谎报长度的情况）。
   */
  async function spill(data: Buffer | Readable, tmp: string): Promise<void> {
    if (Buffer.isBuffer(data)) {
      if (data.length > uploadLimit) throw tooLarge();
      await writeFile(tmp, data, { flag: "wx" });
      return;
    }
    // 不用 pipeline：它出错时会销毁请求流，连接直接断掉，浏览器只看到「网络错误」，
    // 收不到 413 与原因。这里超限后停止写盘、把请求体剩下的部分读完丢掉，连接保持正常。
    const source = data;
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(tmp, { flags: "wx" });
      let seen = 0;
      let failed = false;
      const fail = (error: unknown) => {
        if (failed) return;
        failed = true;
        out.destroy();
        source.resume(); // 剩下的照收不写，让响应能正常发回去
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      source.on("data", (chunk: Buffer) => {
        if (failed) return;
        seen += chunk.length;
        if (seen > uploadLimit) {
          fail(tooLarge());
          return;
        }
        if (!out.write(chunk)) {
          source.pause();
          out.once("drain", () => source.resume());
        }
      });
      source.on("end", () => {
        if (!failed) out.end();
      });
      source.on("error", fail); // 客户端中途断开
      out.on("error", fail);
      out.on("finish", () => {
        if (!failed) resolve();
      });
    });
  }

  const upsert = index.prepare(
    `INSERT INTO entries (path, parent, name, is_dir, size, modified_at, kind)
     VALUES (@path, @parent, @name, @is_dir, @size, @modified_at, @kind)
     ON CONFLICT(path) DO UPDATE SET parent = excluded.parent, name = excluded.name,
       is_dir = excluded.is_dir, size = excluded.size,
       modified_at = excluded.modified_at, kind = excluded.kind`,
  );
  const cached = index.prepare<[string], Row>(
    "SELECT * FROM entries WHERE path = ?",
  );
  const childrenOf = index.prepare<[string], Row>(
    "SELECT * FROM entries WHERE parent = ?",
  );
  // 删子树不用 LIKE：路径里的 % 和 _ 会被当成通配符。
  const subtree = "path = ? OR substr(path, 1, ?) = ?";
  const deleteTreeText = index.prepare<[string, number, string]>(
    `DELETE FROM file_text WHERE rowid IN (SELECT rowid FROM entries WHERE ${subtree})`,
  );
  const deleteTree = index.prepare<[string, number, string]>(
    `DELETE FROM entries WHERE ${subtree}`,
  );
  const rowidOf = index.prepare<[string], { rowid: number }>(
    "SELECT rowid FROM entries WHERE path = ?",
  );
  const deleteText = index.prepare<[number]>(
    "DELETE FROM file_text WHERE rowid = ?",
  );
  const insertText = index.prepare<[number, string]>(
    "INSERT INTO file_text (rowid, content) VALUES (?, ?)",
  );

  const toRow = (entry: FileEntry): Row => ({
    path: entry.path,
    parent: parentOf(entry.path),
    name: entry.name,
    is_dir: entry.isDir ? 1 : 0,
    size: entry.size,
    modified_at: entry.modifiedAt,
    kind: entry.kind,
  });
  const remember = (entry: FileEntry): void => {
    if (!isRoot(entry.path)) upsert.run(toRow(entry));
  };
  const forgetTree = (path: string): void => {
    const prefix = `${path}/`;
    deleteTreeText.run(path, prefix.length, prefix);
    deleteTree.run(path, prefix.length, prefix);
  };
  /** 写入 / 清掉一个条目的全文索引（条目须已在 entries 里）。 */
  const setText = (path: string, content: string | null): void => {
    const row = rowidOf.get(path);
    if (!row) return;
    deleteText.run(row.rowid);
    if (content !== null) insertText.run(row.rowid, content);
  };

  /** 读文件开头最多 SNIFF_BYTES 个字节（不读整个文件）。 */
  async function sniff(abs: string): Promise<Buffer> {
    const handle = await open(abs, "r");
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const { bytesRead } = await handle.read(buf, 0, SNIFF_BYTES, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /**
   * 由 stat 结果构造条目；文件类型优先用索引里的缓存（大小与修改时间都没变时）。
   * `fresh` = 新出现或变过，调用方据此决定要不要重建它的全文索引。
   */
  async function describe(
    path: string,
    abs: string,
    st: Stats,
  ): Promise<{ entry: FileEntry; fresh: boolean }> {
    const modifiedAt = Math.trunc(st.mtimeMs);
    const name = isRoot(path) ? "" : nameOf(path);
    const hit = cached.get(path);
    if (st.isDirectory()) {
      return {
        entry: {
          name,
          path,
          isDir: true,
          size: 0,
          modifiedAt,
          kind: "folder",
          version: versionOf(modifiedAt, 0),
        },
        fresh: hit?.is_dir !== 1,
      };
    }
    const same =
      hit?.is_dir === 0 &&
      hit.size === st.size &&
      hit.modified_at === modifiedAt;
    const kind = same
      ? (hit.kind as FileKind)
      : detectKind(name, await sniff(abs), st.size > SNIFF_BYTES);
    return {
      entry: {
        name,
        path,
        isDir: false,
        size: st.size,
        modifiedAt,
        kind,
        version: versionOf(modifiedAt, st.size),
      },
      fresh: !same,
    };
  }

  /** 读出要进全文索引的文本；不该索引（非文本 / 太大 / 文件夹）时为 null。 */
  async function textFor(
    entry: FileEntry,
    abs: string,
  ): Promise<string | null> {
    if (entry.kind === "folder" || !isTextKind(entry.kind)) return null;
    if (entry.size > TEXT_INDEX_LIMIT) return null;
    try {
      return await readFile(abs, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * 记下一批条目；`fresh` 的（或 force 时全部）文件重建全文索引。
   * 先把要索引的文本读出来，再在一个事务里写库——事务里不能 await。
   */
  async function rememberAll(
    items: { entry: FileEntry; abs: string; fresh: boolean }[],
    force = false,
  ): Promise<void> {
    const texts = new Map<string, string | null>();
    for (const item of items) {
      if (!item.entry.isDir && (force || item.fresh)) {
        texts.set(item.entry.path, await textFor(item.entry, item.abs));
      }
    }
    index.transaction(() => {
      for (const item of items) {
        remember(item.entry);
        if (texts.has(item.entry.path)) {
          setText(item.entry.path, texts.get(item.entry.path) ?? null);
        }
      }
    })();
  }

  /** lstat 一个相对路径；不存在时抛 404（message 用 what 区分文件 / 文件夹）。 */
  async function statOf(
    path: string,
    what = "文件或文件夹",
  ): Promise<{ abs: string; st: Stats }> {
    const abs = await resolveSafe(root, path);
    try {
      return { abs, st: await lstat(abs) };
    } catch (error) {
      if (errno(error) === "ENOENT") throw notFound(`${what}不存在`);
      throw error;
    }
  }

  async function folderAbs(path: string): Promise<string> {
    const { abs, st } = await statOf(path, "文件夹");
    if (!st.isDirectory())
      throw new HttpError(400, "NOT_A_FOLDER", "这不是文件夹");
    return abs;
  }

  /** 确保文件夹存在（逐级新建缺失的；上传整个文件夹时用）。每一级名称都校验。 */
  async function ensureFolder(path: string): Promise<string> {
    let current = "/";
    let abs = root;
    for (const part of path.split("/").filter((p) => p !== "")) {
      assertValidName(part);
      current = childOf(current, part);
      abs = await resolveSafe(root, current);
      try {
        await mkdir(abs);
        await rememberAll([
          { ...(await describe(current, abs, await lstat(abs))), abs },
        ]);
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
        if (!(await lstat(abs)).isDirectory()) {
          throw conflict(`「${part}」已存在且不是文件夹`);
        }
      }
    }
    return abs;
  }

  async function fileEntry(
    path: string,
  ): Promise<{ abs: string; entry: FileEntry; fresh: boolean }> {
    if (isRoot(path)) throw new HttpError(400, "NOT_A_FILE", "这不是文件");
    const { abs, st } = await statOf(path, "文件");
    if (!st.isFile()) throw new HttpError(400, "NOT_A_FILE", "这不是文件");
    return { abs, ...(await describe(path, abs, st)) };
  }

  /** 父目录的修改时间会随子项变化，顺手刷新它在索引里的那一行。 */
  async function refreshFolder(path: string): Promise<void> {
    if (isRoot(path)) return;
    try {
      const abs = await resolveSafe(root, path);
      remember((await describe(path, abs, await lstat(abs))).entry);
    } catch {
      // 父目录在此期间被删了：下次列目录时自然对齐。
    }
  }

  /** 遍历一个目录（不跟随软链、跳过隐藏项与临时文件）。 */
  async function visibleChildren(abs: string): Promise<string[]> {
    const dirents = await readdir(abs, { withFileTypes: true });
    return dirents
      .filter((d) => !isHiddenName(d.name) && (d.isFile() || d.isDirectory()))
      .map((d) => d.name);
  }

  interface Found {
    entry: FileEntry;
    abs: string;
    fresh: boolean;
  }

  async function walk(path: string, abs: string, out: Found[]): Promise<void> {
    for (const name of await visibleChildren(abs)) {
      const childPath = childOf(path, name);
      const childAbs = join(abs, name);
      const found = await describe(childPath, childAbs, await lstat(childAbs));
      out.push({ ...found, abs: childAbs });
      if (found.entry.isDir) await walk(childPath, childAbs, out);
    }
  }

  /** 索引一个条目（文件夹则连同子树）。force：不管变没变都重建全文索引。 */
  async function indexTree(
    path: string,
    abs: string,
    force = false,
  ): Promise<FileEntry> {
    const found: Found[] = [];
    const top = { ...(await describe(path, abs, await lstat(abs))), abs };
    found.push(top);
    if (top.entry.isDir) await walk(path, abs, found);
    await rememberAll(found, force);
    return top.entry;
  }

  /**
   * 把同目录下准备好的临时文件 / 临时目录「认领」为 `name`。
   * - 不覆盖：文件用硬链接（目标已存在时直接失败）；文件夹先 mkdir 一个空目录占位
   *   （同样原子），再把临时目录改名替换这个空目录（POSIX 允许替换空目录）。
   * - autorename：被占用就试「名称 (1)」「名称 (2)」……
   * 返回最终用上的名称。临时文件 / 目录由调用方清理。
   */
  async function claim(
    parentAbs: string,
    base: string,
    tmp: string,
    options: { isDir: boolean; autorename: boolean },
  ): Promise<string> {
    for (let n = 0; n < MAX_RENAME_TRIES; n += 1) {
      const name = candidateName(base, n, options.isDir);
      const target = join(parentAbs, name);
      try {
        if (options.isDir) {
          await mkdir(target);
          try {
            await rename(tmp, target);
          } catch (error) {
            await rmdir(target).catch(() => undefined);
            throw error;
          }
        } else {
          await link(tmp, target);
        }
        return name;
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
        if (!options.autorename)
          throw conflict(`已有同名的文件或文件夹「${base}」`);
      }
    }
    throw conflict("同名文件太多，请换个名字");
  }

  const tmpName = (): string =>
    `${TMP_PREFIX}${randomBytes(8).toString("hex")}`;

  /** 复制一棵目录树到 dst（dst 须不存在）。软链与隐藏项不复制。 */
  async function copyTree(src: string, dst: string): Promise<void> {
    await mkdir(dst);
    for (const name of await visibleChildren(src)) {
      const from = join(src, name);
      const to = join(dst, name);
      const st = await lstat(from);
      if (st.isDirectory()) await copyTree(from, to);
      else if (st.isFile()) await copyFile(from, to);
    }
  }

  const store: FileStore = {
    root,
    uploadLimit,

    async list(rawPath) {
      const path = normalizePath(rawPath);
      const abs = await folderAbs(path);
      const found: Found[] = [];
      for (const name of await visibleChildren(abs)) {
        const childPath = childOf(path, name);
        const childAbs = join(abs, name);
        try {
          found.push({
            ...(await describe(childPath, childAbs, await lstat(childAbs))),
            abs: childAbs,
          });
        } catch (error) {
          if (errno(error) !== "ENOENT") throw error; // 读目录与 stat 之间被删了：跳过
        }
      }
      // 对齐这一层的索引：磁盘上没了的删掉（连同它的子树），有的补上 / 更新。
      const present = new Set(found.map((f) => f.entry.path));
      index.transaction(() => {
        for (const row of childrenOf.all(path))
          if (!present.has(row.path)) forgetTree(row.path);
      })();
      await rememberAll(found);
      return {
        path,
        entries: found.map((f) => f.entry).sort(byFolderThenName),
      };
    },

    async item(rawPath, options = {}) {
      const path = normalizePath(rawPath);
      const { abs, entry, fresh } = await fileEntry(path);
      await rememberAll([{ entry, abs, fresh }]);
      if (options.content !== true) return { ...entry, content: null };
      if (entry.kind === "folder" || !isTextKind(entry.kind)) {
        return { ...entry, content: null, contentOmitted: "not-text" };
      }
      if (entry.size > EDIT_LIMIT)
        return { ...entry, content: null, contentOmitted: "too-large" };
      return { ...entry, content: await readFile(abs, "utf8") };
    },

    async openRead(rawPath) {
      const path = normalizePath(rawPath);
      const { abs, entry } = await fileEntry(path);
      return { entry, stream: createReadStream(abs) };
    },

    async createFolder(rawPath, options = {}) {
      const path = normalizePath(rawPath);
      if (isRoot(path)) throw conflict("根目录已存在");
      const base = nameOf(path);
      assertValidName(base);
      const parent = parentOf(path);
      const parentAbs = await folderAbs(parent);
      // 占一个名字：mkdir 本身是原子的，已存在就换下一个编号（autorename 时）。
      const name = await (async () => {
        for (let n = 0; n < MAX_RENAME_TRIES; n += 1) {
          const candidate = candidateName(base, n, true);
          try {
            await mkdir(join(parentAbs, candidate));
            return candidate;
          } catch (error) {
            if (errno(error) !== "EEXIST") throw error;
            if (options.autorename !== true)
              throw conflict(`已有同名的文件或文件夹「${base}」`);
          }
        }
        throw conflict("同名文件夹太多，请换个名字");
      })();
      const finalPath = childOf(parent, name);
      const abs = join(parentAbs, name);
      const entry = await indexTree(finalPath, abs);
      await refreshFolder(parent);
      return entry;
    },

    async write(rawPath, data, options = {}) {
      const mode = options.mode ?? "create";
      let path = normalizePath(rawPath);
      if (isRoot(path)) throw new HttpError(400, "NOT_A_FILE", "缺少文件名");
      assertValidName(nameOf(path));
      const parent = parentOf(path);
      const parentAbs =
        options.parents === true
          ? await ensureFolder(parent)
          : await folderAbs(parent);
      // 先完整写到同目录的临时文件：之后的改名 / 链接是原子的，写到一半不会留下半个文件。
      // 写临时文件本身也放在 try 里：中途失败（超过上限、客户端断开）时临时文件一并清掉。
      const tmp = join(parentAbs, tmpName());
      let created = true;
      try {
        await spill(data, tmp);
        if (mode === "overwrite") {
          let existing: Stats | undefined;
          try {
            existing = await lstat(join(parentAbs, nameOf(path)));
          } catch (error) {
            if (errno(error) !== "ENOENT") throw error;
          }
          if (existing?.isDirectory())
            throw conflict(`已有同名文件夹「${nameOf(path)}」`);
          if (existing && !existing.isFile())
            throw conflict(`「${nameOf(path)}」不是普通文件`);
          if (existing && options.expectedVersion !== undefined) {
            const current = versionOf(
              Math.trunc(existing.mtimeMs),
              existing.size,
            );
            if (current !== options.expectedVersion) {
              throw new HttpError(
                412,
                "VERSION_MISMATCH",
                "文件在你打开之后被修改过，请重新打开后再保存",
              );
            }
          }
          created = existing === undefined;
          await rename(tmp, join(parentAbs, nameOf(path)));
        } else {
          const name = await claim(parentAbs, nameOf(path), tmp, {
            isDir: false,
            autorename: mode === "autorename",
          });
          path = childOf(parent, name);
        }
      } finally {
        await unlink(tmp).catch(() => undefined); // overwrite 时已被改名走，ENOENT 忽略
      }
      // 写入一定改了内容：强制重建全文索引（同一毫秒内写入同样大小时，「变没变」判断会看走眼）。
      const entry = await indexTree(path, join(parentAbs, nameOf(path)), true);
      await refreshFolder(parent);
      return { entry, created };
    },

    async move(rawFrom, rawTo) {
      const from = normalizePath(rawFrom);
      const to = normalizePath(rawTo);
      if (isRoot(from) || isRoot(to))
        throw new HttpError(400, "BAD_REQUEST", "不能移动根目录");
      assertValidName(nameOf(to));
      const { abs: srcAbs, st: srcSt } = await statOf(from);
      if (srcSt.isDirectory() && isWithin(to, from) && to !== from) {
        throw new HttpError(
          400,
          "MOVE_INTO_SELF",
          "不能把文件夹移动到它自己里面",
        );
      }
      const dstParentAbs = await folderAbs(parentOf(to));
      const dstAbs = join(dstParentAbs, nameOf(to));
      if (to === from) return (await describe(from, srcAbs, srcSt)).entry;
      try {
        const dstSt = await lstat(dstAbs);
        // 大小写不敏感的文件系统（macOS 默认）上，「a.md → A.md」的目标就是它自己：放行。
        if (dstSt.ino !== srcSt.ino || dstSt.dev !== srcSt.dev) {
          throw conflict(`目标位置已有「${nameOf(to)}」`);
        }
      } catch (error) {
        if (errno(error) !== "ENOENT") throw error;
      }
      await rename(srcAbs, dstAbs);
      index.transaction(() => {
        forgetTree(from);
      })();
      const entry = await indexTree(to, dstAbs);
      await refreshFolder(parentOf(from));
      await refreshFolder(parentOf(to));
      return entry;
    },

    async copy(rawFrom, rawTo) {
      const from = normalizePath(rawFrom);
      const to = normalizePath(rawTo);
      if (isRoot(from))
        throw new HttpError(400, "BAD_REQUEST", "不能复制根目录");
      if (isRoot(to)) throw new HttpError(400, "BAD_REQUEST", "缺少目标名称");
      assertValidName(nameOf(to));
      const { abs: srcAbs, st: srcSt } = await statOf(from);
      // 「复制到自己所在的文件夹」是合法的（会自动改名为「A (1)」）；不合法的是
      // 目标的上级落在源文件夹里面——那样会一边复制一边产生新的要复制的内容。
      if (srcSt.isDirectory() && isWithin(parentOf(to), from)) {
        throw new HttpError(
          400,
          "COPY_INTO_SELF",
          "不能把文件夹复制到它自己里面",
        );
      }
      const dstParent = parentOf(to);
      const dstParentAbs = await folderAbs(dstParent);
      const tmp = join(dstParentAbs, tmpName());
      let name: string;
      try {
        if (srcSt.isDirectory()) await copyTree(srcAbs, tmp);
        else await copyFile(srcAbs, tmp);
        name = await claim(dstParentAbs, nameOf(to), tmp, {
          isDir: srcSt.isDirectory(),
          autorename: true,
        });
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
      const entry = await indexTree(
        childOf(dstParent, name),
        join(dstParentAbs, name),
      );
      await refreshFolder(dstParent);
      return entry;
    },

    async remove(rawPath, options = {}) {
      const path = normalizePath(rawPath);
      if (isRoot(path))
        throw new HttpError(400, "BAD_REQUEST", "不能删除根目录");
      const { abs, st } = await statOf(path);
      if (st.isDirectory() && options.recursive !== true) {
        const inside: Found[] = [];
        await walk(path, abs, inside);
        if (inside.length > 0) {
          const folders = inside.filter((f) => f.entry.isDir).length;
          const files = inside.length - folders;
          throw new HttpError(
            409,
            "FOLDER_NOT_EMPTY",
            `文件夹「${nameOf(path)}」里还有 ${String(folders)} 个文件夹、${String(files)} 个文件`,
          );
        }
      }
      await rm(abs, { recursive: true, force: false });
      index.transaction(() => {
        forgetTree(path);
      })();
      await refreshFolder(parentOf(path));
    },

    async batch(action, rawPaths, rawTarget) {
      const paths = topLevelOnly(rawPaths.map(normalizePath));
      const target =
        rawTarget === undefined ? undefined : normalizePath(rawTarget);
      if (action !== "delete" && target === undefined) {
        throw new HttpError(400, "BAD_REQUEST", "缺少目标文件夹");
      }
      const result: BatchResult = { succeeded: [], failed: [] };
      for (const path of paths) {
        try {
          if (action === "delete") {
            // 批量删除前端已经确认过「文件夹连同内容一起删除」。
            await store.remove(path, { recursive: true });
            result.succeeded.push({ path });
          } else {
            const to = childOf(target ?? "/", nameOf(path));
            const entry =
              action === "move"
                ? await store.move(path, to)
                : await store.copy(path, to);
            result.succeeded.push({ path, entry });
          }
        } catch (error) {
          result.failed.push({ path, message: messageOf(error) });
        }
      }
      return result;
    },

    async zip(rawPaths) {
      const paths = topLevelOnly(rawPaths.map(normalizePath));
      if (paths.length === 0)
        throw new HttpError(400, "BAD_REQUEST", "没有选中任何文件");
      const files: { name: string; abs: string; size: number }[] = [];
      const tops = new Set<string>();
      for (const path of paths) {
        if (isRoot(path))
          throw new HttpError(400, "BAD_REQUEST", "不能打包根目录");
        const { abs, st } = await statOf(path);
        // 选中项可能来自不同文件夹（重名）：顶层名重复时加编号。
        let top = nameOf(path);
        for (let n = 1; tops.has(top); n += 1)
          top = numbered(nameOf(path), n, st.isDirectory());
        tops.add(top);
        if (st.isDirectory()) {
          const inside: Found[] = [];
          await walk(path, abs, inside);
          for (const f of inside) {
            if (!f.entry.isDir) {
              files.push({
                name: `${top}${f.entry.path.slice(path.length)}`,
                abs: f.abs,
                size: f.entry.size,
              });
            }
          }
        } else {
          files.push({ name: top, abs, size: st.size });
        }
      }
      const total = files.reduce((sum, f) => sum + f.size, 0);
      if (total > ZIP_LIMIT) {
        throw new HttpError(
          413,
          "TOO_LARGE",
          "选中的内容超过 200 MB，请分批下载",
        );
      }
      const tree: Zippable = {};
      for (const f of files)
        tree[f.name] = new Uint8Array(await readFile(f.abs));
      const first = paths[0] ?? "/";
      const name =
        paths.length === 1
          ? `${nameOf(first)}.zip`
          : `文件（${String(paths.length)} 项）.zip`;
      return { data: Buffer.from(zipSync(tree, { level: 6 })), name };
    },

    listFilesDeep(path, options) {
      const limit = options?.limit ?? 2000;
      const prefix = `${normalizePath(path)}/`;
      // substr 而不是 LIKE：路径里的 % 与 _ 不是通配符（与 summarize 同一口径）。
      const total =
        index
          .prepare<[number, string], { n: number }>(
            "SELECT COUNT(*) AS n FROM entries WHERE is_dir = 0 AND substr(path, 1, ?) = ?",
          )
          .get(prefix.length, prefix)?.n ?? 0;
      const files = index
        .prepare<[number, string, number], Row>(
          `SELECT * FROM entries
            WHERE is_dir = 0 AND substr(path, 1, ?) = ?
            ORDER BY modified_at DESC, path
            LIMIT ?`,
        )
        .all(prefix.length, prefix, limit)
        .map(toEntry);
      return { files, total, truncated: total > files.length };
    },

    summarize(path) {
      const prefix = `${normalizePath(path)}/`;
      // substr 而不是 LIKE：路径里的 % 和 _ 不能被当成通配符（与删子树同一口径）。
      const row = index
        .prepare<
          [number, string],
          { files: number; bytes: number; modifiedAt: number | null }
        >(
          "SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS bytes, MAX(modified_at) AS modifiedAt FROM entries WHERE is_dir = 0 AND substr(path, 1, ?) = ?",
        )
        .get(prefix.length, prefix);
      return row ?? { files: 0, bytes: 0, modifiedAt: null };
    },

    search(query, limit = 100) {
      const q = query.trim();
      if (q === "") return [];
      // instr 而不是 LIKE：用户输入的 % 和 _ 不该被当成通配符。
      const byName = index
        .prepare<[string, number], Row>(
          "SELECT * FROM entries WHERE instr(lower(name), ?) > 0 ORDER BY is_dir DESC, name LIMIT ?",
        )
        .all(q.toLowerCase(), limit)
        .map((r): SearchHit => ({ ...toEntry(r), match: "name" }));
      const seen = new Set(byName.map((h) => h.path));

      // 按内容：≥ 3 个字符走 trigram 全文索引；更短的 trigram 搜不了，回退为子串查找。
      const contentRows =
        Array.from(q).length >= 3
          ? index
              .prepare<[string, number], Row & { content: string }>(
                `SELECT e.*, t.content FROM file_text t JOIN entries e ON e.rowid = t.rowid
                 WHERE file_text MATCH ? ORDER BY rank LIMIT ?`,
              )
              .all(`"${q.replace(/"/g, '""')}"`, limit)
          : index
              .prepare<[string, number], Row & { content: string }>(
                `SELECT e.*, t.content FROM file_text t JOIN entries e ON e.rowid = t.rowid
                 WHERE instr(lower(t.content), ?) > 0 LIMIT ?`,
              )
              .all(q.toLowerCase(), limit);
      const byContent = contentRows
        .filter((r) => !seen.has(r.path))
        .map((r): SearchHit => ({
          ...toEntry(r),
          match: "content",
          snippet: snippetOf(r.content, q),
        }));
      return [...byName, ...byContent];
    },

    exists(path) {
      return existsSync(
        join(root, ...normalizePath(path).split("/").filter(Boolean)),
      );
    },

    async reindexUnder(path) {
      const start = normalizePath(path);
      const abs = await resolveSafe(root, start);
      const found: Found[] = [];
      if (!existsSync(abs)) {
        // 仓库被删了：把它在索引里的那一支清掉。
        const prefix = `${start}/`;
        index.transaction(() => {
          index
            .prepare<[number, string]>(
              "DELETE FROM file_text WHERE rowid IN (SELECT rowid FROM entries WHERE substr(path, 1, ?) = ?)",
            )
            .run(prefix.length, prefix);
          index
            .prepare<[number, string]>(
              "DELETE FROM entries WHERE substr(path, 1, ?) = ?",
            )
            .run(prefix.length, prefix);
        })();
        return 0;
      }
      await walk(start, abs, found);
      await rememberAll(found, true);
      return found.length;
    },

    async reindex() {
      const found: Found[] = [];
      await walk("/", root, found);
      index.transaction(() => {
        index.prepare("DELETE FROM file_text").run();
        index.prepare("DELETE FROM entries").run();
      })();
      // 重建时所有文本都重新进全文索引（升级上来的老库里还没有 file_text）。
      await rememberAll(found, true);
      return found.length;
    },
  };
  return store;
}
