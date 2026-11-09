import { isNoiseDir } from "../analysis/scan.js";
import type { FileStore } from "../files/store.js";
import type { EvidenceSource } from "./library.js";
import { isStagingPath } from "../staging/paths.js";

/**
 * 依据地图：把依据库里的每个文件夹预先扫成「文件 → 路径 / 标题 / 章节」清单。
 *
 * 存在的理由是**快**。依据库粒度是文件夹，一个代码仓动辄几千个文件；每次任务
 * 都现场遍历再逐个读开，定位会慢到让人以为卡死。地图建一次、缓存住，之后每次
 * 定位只是内存里的打分。
 *
 * 与旧实现的区别：这是**平台托管的文件库**，目录结构与文件清单都在 files.db 索引
 * 里，列目录不碰磁盘，所以建地图比扫本地目录便宜得多。
 *
 * 只记「能看出这份文件讲什么」的最少信息：
 * - 文档（md / txt …）：标题 + 前若干个章节标题；
 * - 代码：只记路径。代码的「讲什么」主要体现在目录与文件名上（billing/refund.ts），
 *   正文命中交给定位器的全文搜索补。
 */

export interface AtlasEntry {
  /** 文件库路径（以 / 开头），既是标识也是给 AI 看的路径。 */
  path: string;
  sourceKey: string;
  isDoc: boolean;
  title: string | null;
  headings: string[];
}

export interface AtlasOptions {
  /** 单个依据目录最多收多少文件；超出截断并如实报出。 */
  maxFiles?: number;
  ttlMs?: number;
  /** 读文件正文（带 content）。测试可注入。 */
  readContent?: (path: string) => Promise<string | null>;
}

const DOC_EXT = new Set([
  "md",
  "markdown",
  "mdown",
  "mkd",
  "txt",
  "html",
  "htm",
]);
/** 地图收录的扩展名；全文搜索用同一份，保证两路信号看的是同一批文件。 */
const CODE_EXT = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "vue",
  "svelte",
  "go",
  "py",
  "java",
  "kt",
  "rs",
  "rb",
  "php",
  "cs",
  "swift",
  "sql",
  "json",
  "yaml",
  "yml",
  "toml",
  "proto",
  "graphql",
]);
const MAX_HEADINGS = 30;

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export const ATLAS_EXTENSIONS: readonly string[] = [...DOC_EXT, ...CODE_EXT];

/** 从文档正文里取标题与章节。front-matter 的 title 优先于第一个 `#`。 */
export function parseDocHead(text: string): {
  title: string | null;
  headings: string[];
} {
  let title: string | null = null;
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  const fmBody = fm?.[1];
  if (fmBody !== undefined) {
    const t = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fmBody);
    if (t?.[1] !== undefined) title = t[1];
  }
  const headings: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m?.[2] === undefined) continue;
    if (title === null && m[1] === "#") {
      title = m[2];
      continue;
    }
    headings.push(m[2]);
    if (headings.length >= MAX_HEADINGS) break;
  }
  return { title, headings };
}

/**
 * 不当本产品事实的路径：
 * - 路径上任何一段是依赖 / 构建产物目录（第三方代码）；
 * - 在临时区里：AI 写了、人还没确认的东西，
 *   当成依据就会出现「AI 下一轮引用自己没被确认的草稿」。产品一般不会绑到临时区，
 *   这条防的是把文档目录绑到根上这类情况。
 */
export function inNoiseDir(path: string): boolean {
  return (
    isStagingPath(path) ||
    path.split("/").some((seg) => seg !== "" && isNoiseDir(seg))
  );
}

export interface Atlas {
  entriesFor(
    sources: readonly EvidenceSource[],
  ): Promise<{ entries: AtlasEntry[]; truncated: string[] }>;
  /** 丢掉缓存，下次重建。不传则清空。 */
  invalidate(sourceKey?: string): void;
}

export function createAtlas(
  files: FileStore,
  options: AtlasOptions = {},
): Atlas {
  const maxFiles = options.maxFiles ?? 5000;
  const ttl = options.ttlMs ?? 10 * 60 * 1000;
  const readContent =
    options.readContent ??
    (async (path: string) => {
      const item = await files.item(path, { content: true }).catch(() => null);
      const content = item?.content;
      return typeof content === "string" ? content : null;
    });

  const cache = new Map<
    string,
    {
      builtAt: number;
      pending: Promise<{ entries: AtlasEntry[]; truncated: boolean }>;
    }
  >();

  const buildFor = async (
    source: EvidenceSource,
  ): Promise<{ entries: AtlasEntry[]; truncated: boolean }> => {
    const entries: AtlasEntry[] = [];
    let truncated = false;

    const add = async (path: string): Promise<void> => {
      if (inNoiseDir(path)) return;
      const ext = extensionOf(path);
      const isDoc = DOC_EXT.has(ext);
      if (!isDoc && !CODE_EXT.has(ext)) return;
      if (entries.length >= maxFiles) {
        truncated = true;
        return;
      }
      let title: string | null = null;
      let headings: string[] = [];
      if (isDoc) {
        const text = await readContent(path);
        if (text !== null) ({ title, headings } = parseDocHead(text));
      }
      entries.push({ path, sourceKey: source.key, isDoc, title, headings });
    };

    if (source.isFile) {
      await add(source.path);
      return { entries, truncated };
    }

    // 走索引拿整个范围的清单：一次查询，不逐个目录往返。多取一些：依赖目录会被
    // 过滤掉（真实仓库里 1.7 万文件有 4500 个在 node_modules 下）。
    const { files: listed, truncated: cut } = files.listFilesDeep(source.path, {
      limit: maxFiles * 2,
    });
    truncated = cut;
    for (const entry of listed) await add(entry.path);
    return { entries, truncated };
  };

  const get = (source: EvidenceSource) => {
    const hit = cache.get(source.key);
    if (hit !== undefined && Date.now() - hit.builtAt < ttl) return hit.pending;
    const pending = buildFor(source);
    cache.set(source.key, { builtAt: Date.now(), pending });
    pending.catch(() => cache.delete(source.key));
    return pending;
  };

  return {
    async entriesFor(sources) {
      const built = await Promise.all(sources.map((s) => get(s)));
      const entries: AtlasEntry[] = [];
      const truncated: string[] = [];
      built.forEach((b, i) => {
        entries.push(...b.entries);
        const s = sources[i];
        if (b.truncated && s !== undefined) truncated.push(s.path);
      });
      return { entries, truncated };
    },
    invalidate(sourceKey) {
      if (sourceKey === undefined) cache.clear();
      else cache.delete(sourceKey);
    },
  };
}
