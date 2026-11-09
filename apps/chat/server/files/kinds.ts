import { isUtf8 } from "node:buffer";

/**
 * 文件类型判定。决定前端用哪个查看器，以及下发内容时用什么 Content-Type。
 *
 * 思路：扩展名先分大类，「像文本的」再看内容确认——是否文本由服务端判定，
 * 前端只认结论（带不带 content），不自己猜。
 */

export type FileKind = "markdown" | "html" | "text" | "image" | "pdf" | "other";

const MARKDOWN = new Set(["md", "markdown", "mdown", "mkd"]);
const HTML = new Set(["html", "htm", "xhtml"]);

/** 浏览器 <img> 能直接显示的格式。SVG 也在这里：用 <img> 显示时其中的脚本不会执行。 */
const IMAGE: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
};

/**
 * 明确是二进制的格式：不做文本嗅探，直接归为「其他」（可存可下载，暂不预览）。
 * 列出来是为了不被误判：docx / xlsx 是 zip，前 8 KB 里可能恰好没有 NUL。
 */
const BINARY = new Set([
  "doc", "docx", "ppt", "pptx", "xls", "xlsx", "key", "pages", "numbers",
  "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "tar",
  "mp3", "wav", "flac", "aac", "ogg", "m4a", "mp4", "mov", "avi", "mkv", "webm",
  "exe", "dmg", "pkg", "msi", "app", "bin", "so", "dylib", "dll",
  "ttf", "otf", "woff", "woff2", "psd", "sketch", "fig", "heic", "tiff", "tif",
  "sqlite", "db",
]); // prettier-ignore

/** 只看这么多字节判定是否文本。不读整个文件：大文件判定也是常数开销。 */
export const SNIFF_BYTES = 8192;
/** 空字节占比超过这个值就当二进制。UTF-16 文本也会因此被归为二进制——MVP 只认 UTF-8。 */
const MAX_NUL_RATIO = 0.05;

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  // 「.env」这类以点开头且只有一个点的名字没有扩展名。
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * 这段样本是不是 UTF-8 文本。
 *
 * - PDF 先排除：文件头之后常有大段 ASCII，单看前 8 KB 会被当成文本。
 * - 样本是从大文件里截出来的（`truncated`）时，末尾可能截在一个多字节字符中间：
 *   先去掉不完整的尾巴再校验，否则合法的中文文件会因截断位置不巧被判成二进制。
 *   **没截断时不去**——那时末尾的残缺字节就是真的非法编码（比如 latin1 的 é）。
 */
export function looksLikeText(sample: Buffer, truncated = false): boolean {
  if (sample.length === 0) return true;
  if (sample.subarray(0, 5).toString("latin1") === "%PDF-") return false;
  let nul = 0;
  for (const byte of sample) if (byte === 0) nul += 1;
  if (nul / sample.length > MAX_NUL_RATIO) return false;
  return isUtf8(truncated ? trimPartialUtf8(sample) : sample);
}

/** 去掉末尾不完整的 UTF-8 序列（最多 3 个字节）。 */
function trimPartialUtf8(buf: Buffer): Buffer {
  // 从末尾往前找最后一个「首字节」（非 10xxxxxx），看它声明的长度是否够。
  for (let back = 1; back <= Math.min(4, buf.length); back += 1) {
    const byte = buf[buf.length - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue; // 续字节，继续往前
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need > back ? buf.subarray(0, buf.length - back) : buf;
  }
  return buf;
}

/**
 * 判定类型。`sample` 是文件开头最多 SNIFF_BYTES 个字节（目录不调用），
 * `truncated` 表示文件比样本长。不认识的扩展名（含无扩展名，如 Makefile）
 * 只要内容是文本就按文本处理。
 */
export function detectKind(
  name: string,
  sample: Buffer,
  truncated = false,
): FileKind {
  const ext = extensionOf(name);
  if (ext in IMAGE) return "image";
  if (ext === "pdf")
    return sample.subarray(0, 5).toString("latin1") === "%PDF-"
      ? "pdf"
      : "other";
  if (BINARY.has(ext)) return "other";
  if (!looksLikeText(sample, truncated)) return "other";
  if (MARKDOWN.has(ext)) return "markdown";
  if (HTML.has(ext)) return "html";
  return "text";
}

/** 是否文本类（可以带内容返回、可以在线编辑）。 */
export const isTextKind = (kind: FileKind): boolean =>
  kind === "markdown" || kind === "html" || kind === "text";

/**
 * 在线查看时下发的 Content-Type。文本类（含 HTML、Markdown）一律 text/plain：
 * 直接打开 raw 地址时浏览器只会把它当纯文本显示，不会渲染 HTML、不会跑脚本。
 * HTML 的渲染预览由前端放进无同源权限的 sandbox iframe 里做。
 */
export function contentTypeOf(name: string, kind: FileKind): string {
  if (kind === "image")
    return IMAGE[extensionOf(name)] ?? "application/octet-stream";
  if (kind === "pdf") return "application/pdf";
  if (isTextKind(kind)) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
