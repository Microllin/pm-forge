/**
 * 文件模块的接口。形状与 server/files/routes.ts 一一对应。
 */
import { createRequest } from "../http";

import { ApiError } from "../http";

export { ApiError };

/** 413 的兜底文案：Fastify 内置的 payload 限制不给 JSON 错误体，只回一个裸 413。 */
const request = createRequest("/api/files", (s) =>
  s === 413 ? "文件太大，超过了上限" : undefined,
);

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const qs = (params: Record<string, string>) =>
  new URLSearchParams(params).toString();

export type EntryKind =
  "folder" | "markdown" | "html" | "text" | "image" | "pdf" | "other";

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modifiedAt: number;
  kind: EntryKind;
  version: string;
}

export interface FileItem extends FileEntry {
  /** 文本类且不太大时才有；空文件是 ""。 */
  content: string | null;
  contentOmitted?: "not-text" | "too-large";
}

export type WriteMode = "create" | "overwrite" | "autorename";

export interface SearchHit extends FileEntry {
  match: "name" | "content";
  /** 按内容命中时，命中处前后的一段文字。 */
  snippet?: string;
}

export interface BatchResult {
  succeeded: { path: string; entry?: FileEntry }[];
  failed: { path: string; message: string }[];
}

export const listFolder = (path: string) =>
  request<{ path: string; entries: FileEntry[] }>(`/list?${qs({ path })}`);
export const getItem = (path: string) =>
  request<FileItem>(`/item?${qs({ path, content: "1" })}`);

/**
 * 原始内容地址。
 * - 末尾带文件名：浏览器内置 PDF 阅读器用它当标题与「另存为」的默认名（否则显示 raw）。
 * - 带上 version：文件变了地址就变，图片 / PDF 不会显示旧的缓存。
 */
export const rawUrl = (
  entry: Pick<FileEntry, "path" | "name" | "version">,
  download = false,
) =>
  `/api/files/raw/${encodeURIComponent(entry.name)}?${qs({ path: entry.path, v: entry.version, ...(download ? { download: "1" } : {}) })}`;

export const putContent = (
  path: string,
  data: Blob | string,
  mode: WriteMode,
  options: {
    /** 保存文本时带上打开时的版本：期间被别处改过就 412，不悄悄覆盖。 */
    ifMatch?: string;
    /** 缺失的上级文件夹自动新建（上传整个文件夹时用）。 */
    parents?: boolean;
  } = {},
) =>
  request<{ entry: FileEntry; created: boolean }>(
    `/content?${qs({ path, mode, ...(options.parents === true ? { parents: "1" } : {}) })}`,
    {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        ...(options.ifMatch === undefined
          ? {}
          : { "if-match": `"${options.ifMatch}"` }),
      },
      body: data,
    },
  );

export const createFolder = (path: string, autorename = false) =>
  request<FileEntry>(
    "/folders",
    json({ path, ...(autorename ? { autorename: true } : {}) }),
  );
export const moveEntry = (from: string, to: string) =>
  request<FileEntry>("/move", json({ from, to }));
export const removeEntry = (path: string, recursive = false) =>
  request<undefined>(
    `/entry?${qs({ path, ...(recursive ? { recursive: "1" } : {}) })}`,
    {
      method: "DELETE",
    },
  );
export const searchFiles = (q: string) =>
  request<{ hits: SearchHit[] }>(`/search?${qs({ q })}`).then((r) => r.hits);

export const copyEntry = (from: string, to: string) =>
  request<FileEntry>("/copy", json({ from, to }));

export const batch = (
  action: "move" | "copy" | "delete",
  paths: string[],
  target?: string,
) =>
  request<BatchResult>(
    "/batch",
    json({ action, paths, ...(target === undefined ? {} : { target }) }),
  );

/** 打包下载：取回 zip 后用一个临时链接触发浏览器保存。 */
export async function downloadZip(paths: string[]): Promise<void> {
  const res = await fetch("/api/files/zip", json({ paths }));
  if (!res.ok) {
    let message =
      res.status === 413
        ? "选中的内容太大，请分批下载"
        : `打包失败（${String(res.status)}）`;
    try {
      message =
        ((await res.json()) as { error?: { message?: string } }).error
          ?.message ?? message;
    } catch {
      // 用默认文案
    }
    throw new ApiError(res.status, "ZIP_FAILED", message);
  }
  const header = res.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(header)?.[1];
  const name = encoded === undefined ? "文件.zip" : decodeURIComponent(encoded);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/* ── 路径小工具（与服务端同一套规则） ── */

export const parentOf = (path: string) => {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
};
export const childOf = (parent: string, name: string) =>
  parent === "/" ? `/${name}` : `${parent}/${name}`;
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
/** "/a/b" → [{ name: "文件", path: "/" }, { name: "a", path: "/a" }, { name: "b", path: "/a/b" }] */
export const crumbsOf = (path: string) => {
  const parts = path.split("/").filter(Boolean);
  return [
    { name: "文件", path: "/" },
    ...parts.map((name, i) => ({
      name,
      path: `/${parts.slice(0, i + 1).join("/")}`,
    })),
  ];
};

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
