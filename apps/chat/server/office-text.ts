import { unzipSync } from "fflate";

/**
 * Office 文档取文本（只读预览）。
 *
 * ## 为什么在服务端做
 *
 * docx / xlsx / pptx 都是 zip 包 + XML。想在浏览器里解析，要么引一个几百 KB 的
 * 解析库进前端包，要么每次都现拉整个文件到浏览器再解开——而这类文件经常几十 MB。
 * 服务端已经能读文件了，用同一个 fflate（技能上传已在用，不多一个依赖）解开、
 * 抽出文字，前端只收几十 KB 的纯文本。
 *
 * ## 只做「读」，不做「原样还原」
 *
 * 这不是 Office 渲染器：表格边框、图片、页眉页脚都会丢。目标是**能核对内容**——
 * 「这一版白皮书里到底写了什么、报价单里是哪些数字」，不是拿它当正式阅读器。
 * 所以输出是带结构提示的纯文本，前端按文本渲染。
 */

export type OfficeKind = "docx" | "xlsx" | "pptx";

/** 解压后的 XML 总量上限。防 zip 炸弹：几 MB 的 docx 可以解出几个 GB。 */
const MAX_UNZIPPED = 80 * 1024 * 1024;
/** 单个 XML 解压后的上限。 */
const MAX_PART = 24 * 1024 * 1024;
/** 最后交给前端的正文字符上限。 */
const MAX_CHARS = 400_000;

const kindOf = (name: string): OfficeKind | null => {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "docx") return "docx";
  if (ext === "xlsx") return "xlsx";
  if (ext === "pptx") return "pptx";
  return null;
};

export const isOfficeFile = (name: string): boolean => kindOf(name) !== null;

/** XML 实体解码。只处理文档里真会出现的几个，别的不猜。 */
function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) =>
      String.fromCodePoint(parseInt(n, 16)),
    )
    .replace(/&amp;/g, "&");
}

/**
 * 从一段 XML 里按顺序取「段落 / 单元格 / 幻灯片」级文本。
 *
 * 用正则而不是真 XML 解析器：Office 的 XML 里文本节点就是 `<w:t>…</w:t>` 这类，
 * 结构再复杂也不影响「只要文字」这个目标。引一个 DOM 解析器换不来什么，
 * 反而在 Node 侧多一层依赖。
 */
function textOfXml(
  xml: string,
  patterns: { text: RegExp; para: RegExp; brk?: RegExp },
): string {
  // 先把段落与换行标记换成哨兵，再按顺序扫「文本节点 | 哨兵」——
  // 谁先出现就拼谁。这样段落边界落在两个文本节点之间也不会丢。
  let s = xml.replace(patterns.para, "\u0000");
  if (patterns.brk !== undefined) s = s.replace(patterns.brk, "\u0000");
  const flags = patterns.text.flags.includes("g")
    ? patterns.text.flags
    : `${patterns.text.flags}g`;
  const re = new RegExp(`${patterns.text.source}|\\u0000`, flags);
  const out: string[] = [];
  for (const m of s.matchAll(re)) {
    if (m[0] === "\u0000") out.push("\n");
    else out.push(decodeEntities(m[1] ?? ""));
  }
  return out.join("");
}

const tidy = (s: string): string =>
  s
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** 共享的表单定义。xlsx 的列宽是单元格数，这里只用来把表格拼成可读的行。 */
interface Sheet {
  name: string;
  xml: string;
}

function docxText(files: Record<string, Uint8Array>): string {
  const main = files["word/document.xml"];
  if (main === undefined) return "";
  const xml = Buffer.from(main).toString("utf8");
  return tidy(
    textOfXml(xml, {
      text: /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g,
      para: /<\/w:p>/g,
      brk: /<w:br\s*\/>/g,
    }),
  );
}

function pptxText(files: Record<string, Uint8Array>): string {
  // 幻灯片按文件名序号排，不能按对象键顺序——zip 里的顺序是生成工具决定的。
  const slides = Object.keys(files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((a, b) => {
      const n = (s: string): number =>
        Number(/slide(\d+)\.xml$/.exec(s)?.[1] ?? 0);
      return n(a) - n(b);
    });
  const blocks: string[] = [];
  slides.forEach((path, i) => {
    const xml = Buffer.from(files[path] ?? new Uint8Array()).toString("utf8");
    const text = tidy(
      textOfXml(xml, {
        text: /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>/g,
        para: /<\/a:p>/g,
      }),
    );
    if (text !== "") blocks.push(`【第 ${String(i + 1)} 页】\n${text}`);
  });
  return blocks.join("\n\n");
}

function xlsxText(files: Record<string, Uint8Array>): string {
  // 共享字符串表：单元格里的文字大多只存索引，指向这里。
  const sharedXml =
    files["xl/sharedStrings.xml"] === undefined
      ? ""
      : Buffer.from(files["xl/sharedStrings.xml"] ?? new Uint8Array()).toString(
          "utf8",
        );
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    [...(m[1] ?? "").matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)]
      .map((t) => decodeEntities(t[1] ?? ""))
      .join(""),
  );

  // 工作表名在 workbook.xml 与 rels 里对不齐，这里用文件名兜底：Sheet1、Sheet2。
  const sheets: Sheet[] = Object.keys(files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort((a, b) => {
      const n = (s: string): number =>
        Number(/sheet(\d+)\.xml$/.exec(s)?.[1] ?? 0);
      return n(a) - n(b);
    })
    .map((path, i) => ({
      name: `Sheet${String(i + 1)}`,
      xml: Buffer.from(files[path] ?? new Uint8Array()).toString("utf8"),
    }));

  const blocks: string[] = [];
  for (const sheet of sheets) {
    const rows: string[] = [];
    for (const row of sheet.xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? "").matchAll(
        /<c([^>]*)>([\s\S]*?)<\/c>/g,
      )) {
        const attrs = cell[1] ?? "";
        const body = cell[2] ?? "";
        // t="s" 表示值是共享字符串索引；否则取 <v> 里的原值，或用 <is> 内联串。
        if (/\bt="s"/.test(attrs)) {
          const idx = Number(/<v>([^<]*)<\/v>/.exec(body)?.[1] ?? "-1");
          cells.push(shared[idx] ?? "");
        } else if (/\bt="inlineStr"/.test(attrs)) {
          const inline = [...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)]
            .map((t) => decodeEntities(t[1] ?? ""))
            .join("");
          cells.push(inline);
        } else {
          cells.push(decodeEntities(/<v>([^<]*)<\/v>/.exec(body)?.[1] ?? ""));
        }
      }
      if (cells.some((c) => c !== "")) rows.push(cells.join("\t"));
    }
    if (rows.length > 0) blocks.push(`【${sheet.name}】\n${rows.join("\n")}`);
  }
  return blocks.join("\n\n");
}

export interface OfficeText {
  kind: OfficeKind;
  /** 抽出来的正文。可能为空（比如纯图片的 PPT）。 */
  text: string;
  /** 截断说明；null = 完整。 */
  truncated: boolean;
}

/**
 * 解出 Office 文件的正文。
 *
 * 解不开（文件损坏、或者根本不是 zip）时返回 `null` —— 调用方据此说
 * 「这份文件读不出内容，请下载查看」，而不是抛错让整次预览失败。
 */
export function extractOfficeText(
  fileName: string,
  bytes: Buffer,
): OfficeText | null {
  const kind = kindOf(fileName);
  if (kind === null) return null;

  let files: Record<string, Uint8Array>;
  try {
    let total = 0;
    files = unzipSync(new Uint8Array(bytes), {
      filter: (f) => {
        total += f.originalSize;
        if (total > MAX_UNZIPPED || f.originalSize > MAX_PART) return false;
        // 只要 XML：图片、媒体那些解出来只会白占内存。
        return f.name.endsWith(".xml") || f.name.endsWith(".rels");
      },
    });
  } catch {
    return null;
  }

  const text =
    kind === "docx"
      ? docxText(files)
      : kind === "pptx"
        ? pptxText(files)
        : xlsxText(files);

  if (text.length <= MAX_CHARS) return { kind, text, truncated: false };
  return {
    kind,
    text: text.slice(0, MAX_CHARS),
    truncated: true,
  };
}
