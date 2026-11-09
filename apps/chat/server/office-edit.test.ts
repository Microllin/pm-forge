import { unzipSync, zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";

import {
  applyReplacements,
  countMatches,
  editableKindOf,
} from "./office-edit.js";
import { extractOfficeText } from "./office-text.js";

const docx = (body: string): Buffer =>
  Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8(
        `<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`,
      ),
      "word/media/image1.png": new Uint8Array([1, 2, 3, 4]),
    }),
  );

const part = (bytes: Buffer, name: string): string =>
  Buffer.from(unzipSync(new Uint8Array(bytes))[name] ?? []).toString("utf8");

describe("office-edit：在原文件里替换文字", () => {
  it("认得出可改的格式", () => {
    expect(editableKindOf("白皮书.DOCX")).toBe("docx");
    expect(editableKindOf("a.md")).toBe("text");
    expect(editableKindOf("演示.mp4")).toBeNull();
    expect(editableKindOf("扫描件.pdf")).toBeNull();
  });

  it("一个文本节点里的原文：只改字，样式与其它部件原样保留", () => {
    const src = docx(
      "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>支持 30 家模型厂商</w:t></w:r></w:p>",
    );
    const out = applyReplacements("a.docx", src, [
      { original: "30 家", replacement: "40 余家" },
    ]);
    expect(out.counts).toEqual([1]);
    const xml = part(out.bytes, "word/document.xml");
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("<w:t>支持 40 余家模型厂商</w:t>");
    expect(
      unzipSync(new Uint8Array(out.bytes))["word/media/image1.png"],
    ).toEqual(new Uint8Array([1, 2, 3, 4]));
    // 与预览口径一致：改完再抽文本就是新的话。
    expect(extractOfficeText("a.docx", out.bytes)?.text).toBe(
      "支持 40 余家模型厂商",
    );
  });

  it("原文拆在几处格式里也能命中：新文字落进第一处，后面被覆盖的清空", () => {
    const src = docx(
      "<w:p><w:r><w:t>平台已</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>支持 SSO</w:t></w:r><w:r><w:t> 登录。</w:t></w:r></w:p>",
    );
    const out = applyReplacements("a.docx", src, [
      {
        original: "已支持 SSO 登录",
        replacement: "规划支持 SSO 登录（路线图）",
      },
    ]);
    expect(out.counts).toEqual([1]);
    expect(extractOfficeText("a.docx", out.bytes)?.text).toBe(
      "平台规划支持 SSO 登录（路线图）。",
    );
  });

  it("跨段落的原文不替换，如实报 0 处（由调用方标「需手改」）", () => {
    const src = docx(
      "<w:p><w:r><w:t>第一段结尾</w:t></w:r></w:p><w:p><w:r><w:t>第二段开头</w:t></w:r></w:p>",
    );
    expect(countMatches("a.docx", src, ["结尾第二段", "第二段"])).toEqual([
      0, 1,
    ]);
    const out = applyReplacements("a.docx", src, [
      { original: "结尾第二段", replacement: "x" },
    ]);
    expect(out.counts).toEqual([0]);
  });

  it("一段里多处命中都换；首尾空格补 xml:space；特殊字符转义", () => {
    const src = docx(
      "<w:p><w:r><w:t>A 版与 A 版</w:t></w:r></w:p><w:p><w:r><w:t>x</w:t></w:r></w:p>",
    );
    const out = applyReplacements("a.docx", src, [
      { original: "A 版", replacement: "B<&>版" },
      { original: "x", replacement: " y " },
    ]);
    expect(out.counts).toEqual([2, 1]);
    const xml = part(out.bytes, "word/document.xml");
    expect(xml).toContain("<w:t>B&lt;&amp;&gt;版与 B&lt;&amp;&gt;版</w:t>");
    expect(xml).toContain('<w:t xml:space="preserve"> y </w:t>');
  });

  it("后一条的原文被前一条改掉了：命中 0", () => {
    const src = docx("<w:p><w:r><w:t>旧名称 RouteHub</w:t></w:r></w:p>");
    const out = applyReplacements("a.docx", src, [
      { original: "旧名称 RouteHub", replacement: "云枢" },
      { original: "RouteHub", replacement: "x" },
    ]);
    expect(out.counts).toEqual([1, 0]);
  });

  it("pptx：按幻灯片里的段落替换", () => {
    const src = Buffer.from(
      zipSync({
        "ppt/slides/slide1.xml": strToU8(
          "<p:sld><a:p><a:r><a:t>首年 </a:t></a:r><a:r><a:t>8 折</a:t></a:r></a:p></p:sld>",
        ),
      }),
    );
    const out = applyReplacements("a.pptx", src, [
      { original: "首年 8 折", replacement: "按商务政策" },
    ]);
    expect(out.counts).toEqual([1]);
    expect(extractOfficeText("a.pptx", out.bytes)?.text).toContain(
      "按商务政策",
    );
  });

  it("xlsx：共享字符串一格一段；数字单元格不动", () => {
    const src = Buffer.from(
      zipSync({
        "xl/sharedStrings.xml": strToU8(
          "<sst><si><t>并发上限</t></si><si><r><t>按 token </t></r><r><t>计费</t></r></si></sst>",
        ),
        "xl/worksheets/sheet1.xml": strToU8(
          '<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c><c><v>99</v></c></row></sheetData></worksheet>',
        ),
      }),
    );
    expect(
      countMatches("a.xlsx", src, ["并发上限按", "按 token 计费", "99"]),
    ).toEqual([0, 1, 0]);
    const out = applyReplacements("a.xlsx", src, [
      { original: "按 token 计费", replacement: "按积分计费" },
    ]);
    expect(out.counts).toEqual([1]);
    expect(extractOfficeText("a.xlsx", out.bytes)?.text).toContain(
      "按积分计费",
    );
  });

  it("md：直接替换全部命中", () => {
    const out = applyReplacements("a.md", Buffer.from("A，A。"), [
      { original: "A", replacement: "B" },
    ]);
    expect(out.counts).toEqual([2]);
    expect(out.bytes.toString("utf8")).toBe("B，B。");
  });

  it("解不开的文件：预检返回 null", () => {
    expect(countMatches("坏.docx", Buffer.from("not a zip"), ["x"])).toBeNull();
  });
});
