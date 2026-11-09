import { childOf, createFolder, putContent, type WriteMode } from "./api";

/**
 * 上传：文件与整个文件夹。
 *
 * 一个待上传项 = 文件 + 它相对上传目标的路径（"a.md"，或文件夹里的 "PRD/设计/a.md"）。
 * 来源两种：<input webkitdirectory> 选的（webkitRelativePath），或拖进来的（遍历目录项）。
 *
 * 上传是「加东西」，从不覆盖：
 * - 顶层的文件同名时自动改名「名称 (1).ext」。
 * - 顶层的文件夹同名时整个改名为「名称 (1)」再往里传——不和已有文件夹合并，
 *   否则同名文件要么覆盖要么零散改名，结果很难预期。
 * - 以点开头的（.DS_Store、.git 等）跳过：本模块不显示也不允许新建隐藏项。
 */

export interface UploadItem {
  file: File;
  relPath: string;
}

/** 一项已经算好去处的上传：目标路径与写入方式都定了，重试时原样再来一次。 */
export interface UploadTask {
  item: UploadItem;
  path: string;
  mode: WriteMode;
  parents: boolean;
}

export interface UploadSummary {
  uploaded: number;
  /** 顶层文件夹的改名（「PRD」→「PRD (1)」）。 */
  renamedFolders: string[];
  /** 顶层文件的改名。 */
  renamedFiles: string[];
  skippedHidden: number;
  failed: { relPath: string; message: string }[];
  /** 失败的那些，可以原样重试（去处不变，顶层文件夹不会再改一次名）。 */
  retry: UploadTask[];
}

const emptySummary = (): UploadSummary => ({
  uploaded: 0,
  renamedFolders: [],
  renamedFiles: [],
  skippedHidden: 0,
  failed: [],
  retry: [],
});
const messageOf = (cause: unknown) =>
  cause instanceof Error ? cause.message : "失败";

/** 从 <input type=file>（含 webkitdirectory）取待上传项。 */
export function fromInput(files: FileList | File[]): UploadItem[] {
  return [...files].map((file) => {
    // 只有从文件夹选择器来的文件才有 webkitRelativePath；普通文件上它是空串，
    // 部分环境（老浏览器、测试用的 jsdom）里干脆没有这个属性。
    const rel = (file as { webkitRelativePath?: unknown }).webkitRelativePath;
    return {
      file,
      relPath: typeof rel === "string" && rel !== "" ? rel : file.name,
    };
  });
}

/**
 * 从拖放事件取待上传项（文件与文件夹都行）。
 * 必须在 drop 事件里同步拿到目录项——事件结束后 DataTransferItem 就失效了，所以分两步：
 * 先同步收集 entry，再异步遍历。
 */
export function collectDropEntries(data: DataTransfer): FileSystemEntry[] {
  const entries: FileSystemEntry[] = [];
  for (const item of data.items) {
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  return entries;
}

export async function fromEntries(
  entries: FileSystemEntry[],
): Promise<UploadItem[]> {
  const out: UploadItem[] = [];
  const visit = async (
    entry: FileSystemEntry,
    prefix: string,
  ): Promise<void> => {
    const relPath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      out.push({ file, relPath });
      return;
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      // readEntries 一次最多给 100 个左右，读到空为止。
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>(
          (resolve, reject) => {
            reader.readEntries(resolve, reject);
          },
        );
        if (batch.length === 0) break;
        for (const child of batch) await visit(child, relPath);
      }
    }
  };
  for (const entry of entries) await visit(entry, "");
  return out;
}

const isHiddenPath = (relPath: string) =>
  relPath.split("/").some((part) => part.startsWith("."));

/** 把待上传项传到 `folder` 下。onProgress(已处理, 总数)。 */
export async function uploadAll(
  folder: string,
  items: UploadItem[],
  onProgress: (done: number, total: number) => void,
): Promise<UploadSummary> {
  const summary = emptySummary();
  const visible = items.filter((item) => {
    if (isHiddenPath(item.relPath)) {
      summary.skippedHidden += 1;
      return false;
    }
    return true;
  });

  // 顶层文件夹先各建一个（同名自动改名），记下实际名称；它决定里面每个文件的去处。
  const tops = new Map<string, string | null>();
  for (const item of visible) {
    const slash = item.relPath.indexOf("/");
    if (slash < 0) continue;
    const top = item.relPath.slice(0, slash);
    if (tops.has(top)) continue;
    try {
      const created = await createFolder(childOf(folder, top), true);
      tops.set(top, created.name);
      if (created.name !== top)
        summary.renamedFolders.push(`${top} → ${created.name}`);
    } catch (cause) {
      tops.set(top, null);
      summary.failed.push({ relPath: `${top}/`, message: messageOf(cause) });
    }
  }

  const tasks: UploadTask[] = [];
  for (const item of visible) {
    const slash = item.relPath.indexOf("/");
    if (slash < 0) {
      // 顶层文件：同名自动改名。
      tasks.push({
        item,
        path: childOf(folder, item.relPath),
        mode: "autorename",
        parents: false,
      });
      continue;
    }
    const top = tops.get(item.relPath.slice(0, slash));
    // 顶层文件夹没建成：里面的文件都无处可去，已经整体记为失败。
    if (top === null || top === undefined) continue;
    tasks.push({
      item,
      path: childOf(folder, `${top}${item.relPath.slice(slash)}`),
      mode: "create",
      parents: true,
    });
  }
  const result = await runUploads(tasks, onProgress);
  return {
    ...result,
    renamedFolders: summary.renamedFolders,
    skippedHidden: summary.skippedHidden,
    failed: [...summary.failed, ...result.failed],
  };
}

/** 执行（或重试）一批已经算好去处的上传。 */
export async function runUploads(
  tasks: UploadTask[],
  onProgress: (done: number, total: number) => void,
): Promise<UploadSummary> {
  const summary = emptySummary();
  let done = 0;
  onProgress(done, tasks.length);
  for (const task of tasks) {
    try {
      const { entry } = await putContent(task.path, task.item.file, task.mode, {
        parents: task.parents,
      });
      if (task.mode === "autorename" && entry.name !== task.item.relPath) {
        summary.renamedFiles.push(`${task.item.relPath} → ${entry.name}`);
      }
      summary.uploaded += 1;
    } catch (cause) {
      summary.failed.push({
        relPath: task.item.relPath,
        message: messageOf(cause),
      });
      summary.retry.push(task);
    }
    done += 1;
    onProgress(done, tasks.length);
  }
  return summary;
}

/** 失败清单太长时只列前几个，其余说「等 N 个」。 */
const SHOW_FAILED = 5;

/** 上传结果的一句话提示。 */
export function describeSummary(s: UploadSummary): {
  ok: boolean;
  text: string;
} {
  const parts = [`已上传 ${String(s.uploaded)} 个文件`];
  if (s.renamedFolders.length > 0)
    parts.push(`同名文件夹已改名：${s.renamedFolders.join("、")}`);
  if (s.renamedFiles.length > 0)
    parts.push(`同名已自动改名：${s.renamedFiles.join("、")}`);
  if (s.skippedHidden > 0)
    parts.push(`跳过 ${String(s.skippedHidden)} 个隐藏文件`);
  if (s.failed.length > 0) {
    const shown = s.failed
      .slice(0, SHOW_FAILED)
      .map((f) => `${f.relPath}（${f.message}）`);
    const more =
      s.failed.length > SHOW_FAILED ? ` 等 ${String(s.failed.length)} 个` : "";
    parts.push(
      `失败 ${String(s.failed.length)} 个：${shown.join("、")}${more}`,
    );
  }
  return { ok: s.failed.length === 0, text: parts.join("；") };
}
