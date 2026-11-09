import { unzipSync, zipSync, type Zippable } from "fflate";

/**
 * 在原文件里替换文字，**保留样式**——售前材料 AI 修订的落地方式。
 *
 * ## 为什么不是「重写整份文档」
 *
 * 售前材料是排好版的 Word / PPT / Excel。整份重写（哪怕写回 docx）会把版式、
 * 图片、表格样式一起毁掉，产出物没法直接发给客户。所以只做**文字级替换**：
 * 在 XML 里找到原文所在的文本节点，把字换掉，其它字节原样保留。
 *
 * ## 原文跨了几处格式怎么办
 *
 * Word 会把一句话拆进好几个 `<w:t>`（中间换过字体、加过粗、或者只是编辑历史）。
 * 这里先把**同一段落**里的文本节点拼起来再找原文——拆在几处格式里的也能命中。
 * 替换后的新文字整段落进**第一处**的格式里，后面几处被覆盖到的字清空。代价是
 * 「半句加粗」这种格式会被抹平成第一处的样子；比起找不到原文只能让人手改，这个
 * 代价可接受。
 *
 * 跨段落（中间有回车）、跨单元格、跨幻灯片文本框的原文**不替换**：返回 0 处命中，
 * 由调用方标成「需手改」。数字单元格（Excel 里的价格多半是数值不是文字）同理。
 *
 * ## 与预览的口径一致
 *
 * 命中判断与 office-text.ts 抽出来给 AI 看的正文同一套切分（段落 / 换行 / 单元格），
 * 所以 AI 从预览正文里逐字摘的原文，在这里能按同一个边界找到。
 */

export type EditableKind = "docx" | "pptx" | "xlsx" | "text";

export const editableKindOf = (name: string): EditableKind | null => {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "docx" || ext === "pptx" || ext === "xlsx") return ext;
  if (["md", "markdown", "txt", "csv"].includes(ext)) return "text";
  return null;
};

export interface Replacement {
  original: string;
  replacement: string;
}

export interface ReplaceResult {
  bytes: Buffer;
  /** 与输入同序：每一条实际替换了几处。0 = 没找到（或原文跨段落）。 */
  counts: number[];
}

/** 解压上限：防 zip 炸弹。与 office-text.ts 同一量级，但这里要整包解（含图片）。 */
const MAX_UNZIPPED = 400 * 1024 * 1024;

/* ── XML 文本节点 ──────────────────────────────────────────────────── */

interface Grammar {
  /** 文本节点的标签名，如 w:t。 */
  tag: string;
  /** 段落边界：开 / 关段落、换行。命中不跨越它们。 */
  boundary: RegExp;
  /** 需要 xml:space="preserve" 才保得住首尾空格。 */
  preserveSpace: boolean;
}

const DOCX: Grammar = {
  tag: "w:t",
  boundary: /<\/w:p>|<w:p[\s>/]|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>/,
  preserveSpace: true,
};
const PPTX: Grammar = {
  tag: "a:t",
  boundary: /<\/a:p>|<a:p[\s>/]|<a:br\b[^>]*\/>/,
  preserveSpace: false,
};
/** sharedStrings 的 <si> 与工作表里的内联串 <is>：一格一段。 */
const XLSX: Grammar = {
  tag: "t",
  boundary: /<\/?si[\s>/]|<\/si>|<\/?is[\s>/]|<\/is>/,
  preserveSpace: true,
};

export function decodeXml(s: string): string {
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

const encodeXml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface TextNode {
  /** 整个元素在 XML 里的起止（含标签）。 */
  start: number;
  end: number;
  attrs: string;
  text: string;
}

/** 按段落边界把文本节点分组。顺序即文档顺序。 */
function segmentsOf(xml: string, g: Grammar): TextNode[][] {
  const tag = g.tag.replace(":", "\\:");
  const re = new RegExp(
    `<${tag}(\\s[^>]*)?>([^<]*)</${tag}>|${g.boundary.source}`,
    "g",
  );
  const segments: TextNode[][] = [];
  let current: TextNode[] = [];
  for (const m of xml.matchAll(re)) {
    if (m[0].startsWith(`<${g.tag}`) && m[0].endsWith(`</${g.tag}>`)) {
      // 注意 `<t` 也是 `<tbl` 之类的前缀：上面的正则要求紧跟空白或 >，不会误中。
      current.push({
        start: m.index,
        end: m.index + m[0].length,
        attrs: m[1] ?? "",
        text: decodeXml(m[2] ?? ""),
      });
    } else {
      if (current.length > 0) segments.push(current);
      current = [];
    }
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** 一段文字里不重叠地找原文，返回起点列表。 */
function findAll(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (needle === "") return out;
  for (let i = haystack.indexOf(needle); i !== -1;) {
    out.push(i);
    i = haystack.indexOf(needle, i + needle.length);
  }
  return out;
}

/**
 * 在一段 XML 里做一条替换。返回新 XML 与命中次数。
 *
 * 做法：段落内拼出整段文字，逐字记下它属于哪个节点；遇到命中就把替换文字记到
 * 命中起点所在的节点上、跳过原文，其余字原样归还给各自的节点。这样「原文在一个
 * 节点里」「原文跨三个节点」「一段里命中两次」都是同一条路。
 */
function replaceInXml(
  xml: string,
  g: Grammar,
  original: string,
  replacement: string,
): { xml: string; count: number } {
  let count = 0;
  const edits: { start: number; end: number; text: string }[] = [];
  for (const nodes of segmentsOf(xml, g)) {
    // 逐个 UTF-16 码元记下它属于哪个节点（与 indexOf 的下标同一口径）。
    const owner: number[] = [];
    let joined = "";
    nodes.forEach((n, i) => {
      joined += n.text;
      owner.push(...Array.from({ length: n.text.length }, () => i));
    });
    const hits = findAll(joined, original);
    if (hits.length === 0) continue;
    count += hits.length;
    const next = nodes.map(() => "");
    const give = (pos: number, text: string): void => {
      const i = owner[pos] ?? 0;
      next[i] = `${next[i] ?? ""}${text}`;
    };
    let pos = 0;
    for (const hit of hits) {
      for (; pos < hit; pos++) give(pos, joined.charAt(pos));
      give(hit, replacement);
      pos = hit + original.length;
    }
    for (; pos < joined.length; pos++) give(pos, joined.charAt(pos));
    nodes.forEach((n, i) => {
      const text = next[i] ?? "";
      if (text === n.text) return;
      let attrs = n.attrs;
      if (
        g.preserveSpace &&
        /^\s|\s$/.test(text) &&
        !attrs.includes("xml:space=")
      )
        attrs = `${attrs} xml:space="preserve"`;
      edits.push({
        start: n.start,
        end: n.end,
        text: `<${g.tag}${attrs}>${encodeXml(text)}</${g.tag}>`,
      });
    });
  }
  if (edits.length === 0) return { xml, count };
  edits.sort((a, b) => a.start - b.start);
  let out = "";
  let last = 0;
  for (const e of edits) {
    out += xml.slice(last, e.start) + e.text;
    last = e.end;
  }
  return { xml: out + xml.slice(last), count };
}

/** 每种格式里要改哪些部件（按 zip 内路径）。 */
function partsOf(kind: Exclude<EditableKind, "text">, names: string[]) {
  const pick = (re: RegExp, g: Grammar) =>
    names.filter((n) => re.test(n)).map((name) => ({ name, g }));
  if (kind === "docx")
    return pick(
      /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/,
      DOCX,
    );
  if (kind === "pptx") return pick(/^ppt\/slides\/slide\d+\.xml$/, PPTX);
  return [
    ...pick(/^xl\/sharedStrings\.xml$/, XLSX),
    ...pick(/^xl\/worksheets\/sheet\d+\.xml$/, XLSX),
  ];
}

function unzip(bytes: Buffer): Record<string, Uint8Array> {
  let total = 0;
  return unzipSync(new Uint8Array(bytes), {
    filter: (f) => {
      total += f.originalSize;
      if (total > MAX_UNZIPPED) throw new Error("文件解压后过大");
      return true;
    },
  });
}

/** 已经是压缩格式的部件（图片、视频）不再压一遍，省时间也不变大。 */
const STORED = /\.(png|jpe?g|gif|mp4|mov|m4a|mp3|wav|emf|wmf|zip|gz)$/i;

/**
 * 依次应用一组替换。后一条看到的是前一条改过的结果——两条改同一句时，
 * 后一条的原文可能已经不存在，命中 0，如实报给调用方。
 *
 * 解不开的文件抛错（调用方应先用 {@link countMatches} 预检）。
 */
export function applyReplacements(
  fileName: string,
  bytes: Buffer,
  list: readonly Replacement[],
): ReplaceResult {
  const kind = editableKindOf(fileName);
  if (kind === null) throw new Error("这种格式不支持在原文件里修改");

  if (kind === "text") {
    let text = bytes.toString("utf8");
    const counts = list.map((r) => {
      const n = findAll(text, r.original).length;
      if (n > 0) text = text.split(r.original).join(r.replacement);
      return n;
    });
    return { bytes: Buffer.from(text, "utf8"), counts };
  }

  const files = unzip(bytes);
  const parts = partsOf(kind, Object.keys(files));
  const xml = new Map(
    parts.map((p) => [
      p.name,
      Buffer.from(files[p.name] ?? new Uint8Array()).toString("utf8"),
    ]),
  );
  const counts = list.map((r) => {
    let n = 0;
    for (const p of parts) {
      const done = replaceInXml(
        xml.get(p.name) ?? "",
        p.g,
        r.original,
        r.replacement,
      );
      n += done.count;
      if (done.count > 0) xml.set(p.name, done.xml);
    }
    return n;
  });

  const out: Zippable = {};
  for (const [name, data] of Object.entries(files)) {
    const changed = xml.get(name);
    const content =
      changed === undefined
        ? data
        : new Uint8Array(Buffer.from(changed, "utf8"));
    out[name] = [content, { level: STORED.test(name) ? 0 : 6 }];
  }
  return { bytes: Buffer.from(zipSync(out)), counts };
}

/** 预检：每条原文在文件里能命中几处（不改文件）。解不开返回 null。 */
export function countMatches(
  fileName: string,
  bytes: Buffer,
  originals: readonly string[],
): number[] | null {
  const kind = editableKindOf(fileName);
  if (kind === null) return null;
  if (kind === "text") {
    const text = bytes.toString("utf8");
    return originals.map((o) => findAll(text, o).length);
  }
  let files: Record<string, Uint8Array>;
  try {
    files = unzip(bytes);
  } catch {
    return null;
  }
  const parts = partsOf(kind, Object.keys(files)).map((p) => ({
    g: p.g,
    joined: segmentsOf(
      Buffer.from(files[p.name] ?? new Uint8Array()).toString("utf8"),
      p.g,
    ).map((nodes) => nodes.map((n) => n.text).join("")),
  }));
  return originals.map((o) =>
    parts.reduce(
      (sum, p) =>
        sum + p.joined.reduce((s, seg) => s + findAll(seg, o).length, 0),
      0,
    ),
  );
}
