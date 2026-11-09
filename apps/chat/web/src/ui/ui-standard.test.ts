import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 平台规范守卫：界面一致性。
 *
 * 只查机器能确定判断的几条：写死的字号、原生下拉、「muted pad」漏了 small。
 * 违反时列出「文件:行号」，照着改就行。
 */

const SRC = join(import.meta.dirname, "..");

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs, exts));
    else if (exts.some((e) => name.endsWith(e)) && !/\.test\.tsx?$/.test(name))
      out.push(abs);
  }
  return out;
}

const rel = (abs: string): string => relative(SRC, abs).split("\\").join("/");

/** 逐行找命中。注释行也算——规范示例不写在源码注释里，写在 design 文档里。 */
function hits(
  files: string[],
  test: (line: string) => boolean,
  skip: (file: string) => boolean = () => false,
): string[] {
  const out: string[] = [];
  for (const abs of files) {
    if (skip(rel(abs))) continue;
    readFileSync(abs, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (test(line))
          out.push(`${rel(abs)}:${String(i + 1)}  ${line.trim()}`);
      });
  }
  return out;
}

const cssFiles = walk(SRC, [".css"]);
const tsxFiles = walk(SRC, [".tsx", ".ts"]);

describe("平台规范：字号只用六档", () => {
  it("CSS 的 font-size 只写 var(--text-*)（例外：inherit / 0 / em）", () => {
    const bad = hits(cssFiles, (line) => {
      const m = /font-size:\s*([^;]+);/.exec(line);
      if (m === null) return false;
      const v = (m[1] ?? "").trim();
      return !(
        /^var\(--text-[a-z]+\)$/.test(v) ||
        v === "inherit" ||
        v === "0" ||
        /^[0-9.]+em$/.test(v)
      );
    });
    expect(bad).toEqual([]);
  });

  it("组件行内样式的 fontSize 只写 var(--text-*)", () => {
    const bad = hits(
      tsxFiles,
      (line) =>
        /fontSize:\s*/.test(line) &&
        !/fontSize:\s*"var\(--text-[a-z]+\)"/.test(line),
    );
    expect(bad).toEqual([]);
  });

  it("状态提示（muted + pad）必须带 small，别继承正文字号", () => {
    const bad = hits(tsxFiles, (line) => {
      const m = /className="([^"]*)"/.exec(line);
      if (m === null) return false;
      const cls = (m[1] ?? "").split(/\s+/);
      return (
        cls.includes("muted") && cls.includes("pad") && !cls.includes("small")
      );
    });
    expect(bad).toEqual([]);
  });

  it("守卫本身有效：确实扫到了文件", () => {
    expect(cssFiles.length).toBeGreaterThan(5);
    expect(tsxFiles.length).toBeGreaterThan(20);
  });
});

describe("平台规范：下拉只用 ui/Select", () => {
  it("没有原生 <select>", () => {
    const bad = hits(
      tsxFiles,
      (line) =>
        /<select[\s>]|<select$/.test(line) ||
        /createElement\(\s*["']select["']/.test(line),
      // 组件自己的说明注释里提到了 <select>，不算。
      (file) => file === "ui/Select.tsx",
    );
    expect(bad).toEqual([]);
  });

  it("CSS 里也不再给原生 select 写样式", () => {
    const bad = hits(cssFiles, (line) =>
      /(^|[\s,>+~])select(\s*[,{:.[]|\s*$)/.test(line),
    );
    expect(bad).toEqual([]);
  });
});
