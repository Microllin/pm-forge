import { describe, expect, it } from "vitest";

import { draftName, stripFrontmatter } from "./skill-file";

/** 这两个纯函数直接决定界面显示什么，单独钉住。 */

describe("draftName", () => {
  it("从 frontmatter 取 name，带引号也认", () => {
    expect(draftName("---\nname: write-prd\n---\n正文")).toBe("write-prd");
    expect(draftName('---\nname: "write-prd"\n---\n正文')).toBe("write-prd");
  });

  it("没有 frontmatter 或没写 name 时返回 null（界面据此提示「还没写 name」）", () => {
    expect(draftName("# 只有正文")).toBeNull();
    expect(draftName("---\ndescription: 有描述没名字\n---\n正文")).toBeNull();
  });
});

describe("stripFrontmatter", () => {
  it("剥掉 YAML 头，正文原样留下", () => {
    const md = "---\nname: a\ndescription: b\n---\n\n# 标题\n\n正文。\n";
    expect(stripFrontmatter(md)).toBe("# 标题\n\n正文。\n");
  });

  it("正文里的 --- 分隔线不受影响", () => {
    const md = "---\nname: a\n---\n\n正文一\n\n---\n\n正文二\n";
    const out = stripFrontmatter(md);
    expect(out.startsWith("正文一")).toBe(true);
    expect(out).toContain("---");
  });

  it("没有 frontmatter 时原样返回", () => {
    expect(stripFrontmatter("# 只有正文")).toBe("# 只有正文");
  });
});
