import { conflict } from "../errors.js";
import { childOf, nameOf, parentOf } from "../files/paths.js";
import type { FileEntry, FileStore } from "../files/store.js";

/** folder 下一个还没被占用的名字：「名称.ext」→「名称 (1).ext」…（与文件库的同名策略一致）。 */
export function freeChild(
  exists: (path: string) => boolean,
  folder: string,
  name: string,
): string {
  const first = childOf(folder, name);
  if (!exists(first)) return first;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 1; i < 1000; i += 1) {
    const next = childOf(folder, `${stem} (${String(i)})${ext}`);
    if (!exists(next)) return next;
  }
  throw conflict(`「${folder}」里同名文件太多`);
}

/** 逐级补建文件夹（已存在的跳过）。 */
async function ensureFolder(files: FileStore, folder: string): Promise<void> {
  let current = "";
  for (const part of folder.split("/").filter((p) => p !== "")) {
    current = `${current}/${part}`;
    if (!files.exists(current)) await files.createFolder(current);
  }
}

/**
 * 把临时区里的一个文件搬到正式文件夹，同名不覆盖（自动改名）。
 *
 * 用「搬」不用「复制再删」：文件可能是几十 MB 的 PPT，搬是一次改名。
 */
export async function moveInto(
  files: FileStore,
  from: string,
  folder: string,
): Promise<FileEntry> {
  await ensureFolder(files, folder);
  return files.move(
    from,
    freeChild((p) => files.exists(p), folder, nameOf(from)),
  );
}

/**
 * 把临时区里的一个文件搬到确切的路径。目标已有文件时**替换**——调用方在界面上
 * 已经让人看过「会替换已有内容」并确认（与补齐草稿「挪入」同一口径）。
 */
export async function moveTo(
  files: FileStore,
  from: string,
  to: string,
): Promise<{ entry: FileEntry; replaced: boolean }> {
  await ensureFolder(files, parentOf(to));
  const replaced = files.exists(to);
  if (!replaced) return { entry: await files.move(from, to), replaced };
  // 只替换文件：目标是文件夹时「替换」等于删掉整个文件夹，绝不做。
  const isDir = await files.list(to).then(
    () => true,
    () => false,
  );
  if (isDir) throw conflict(`「${to}」是一个文件夹，换一个文件名`);

  /*
   * 先把旧文件挪到旁边，再搬新文件，最后才删旧的。
   *
   * 原来直接 `remove(to)` 再 `move`：move 只要有一步失败（权限、磁盘满、目标目录
   * 被并发删掉），旧文件已经没了、新文件也没放进去——用户确认过的那份正式文档
   * 就这样丢了，而临时区里的草稿还在，看起来像「确认成功了但内容是空的」。
   * 挪到旁边是可回退的：任何一步失败都把旧的放回去。
   */
  const backup = `${to}.replacing-${String(Date.now())}`;
  await files.move(to, backup);
  try {
    const entry = await files.move(from, to);
    await files.remove(backup).catch(() => undefined);
    return { entry, replaced };
  } catch (error) {
    // 新文件没到位：把旧的放回去，宁可这次确认失败，也不能让正式文档消失。
    await files.move(backup, to).catch(() => undefined);
    throw error;
  }
}

/**
 * 从 folder 往上删空文件夹，到 stop（不含）为止。
 * 智能体一次运行一个文件夹、对话按天一个文件夹：处理完不留一串空壳。
 */
export async function pruneEmpty(
  files: FileStore,
  folder: string,
  stop: string,
): Promise<void> {
  let current = folder;
  while (current !== stop && current.startsWith(`${stop}/`)) {
    const listed = await files.list(current).catch(() => null);
    if (listed === null || listed.entries.length > 0) return;
    await files.remove(current, { recursive: true }).catch(() => undefined);
    current = parentOf(current);
  }
}
