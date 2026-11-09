import { describe, expect, it } from "vitest";

import { scanSkillFolders } from "./skill-folder";
import type { UploadItem } from "../files/upload";

/**
 * 分组规则是「一次一个」与「一次一批」能共用同一个按钮的全部依据，
 * 所以每条规则都单独钉一个用例。文件内容在这里无关紧要，只看路径。
 */

const items = (...paths: string[]): UploadItem[] =>
  paths.map((relPath) => ({
    file: new File(["x"], relPath.split("/").at(-1) ?? "f"),
    relPath,
  }));

describe("技能目录分组", () => {
  it("选中的目录自带 SKILL.md：就是一个技能，路径相对它自己", () => {
    const scan = scanSkillFolders(
      items("write-prd/SKILL.md", "write-prd/references/checklist.md"),
    );
    expect(scan.single).toBe(true);
    expect(scan.groups).toHaveLength(1);
    expect(scan.groups[0]?.files.map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "references/checklist.md",
    ]);
  });

  it("选中的是技能库根目录：每个含 SKILL.md 的子目录各算一个", () => {
    const scan = scanSkillFolders(
      items(
        "skills/write-prd/SKILL.md",
        "skills/write-prd/references/a.md",
        "skills/verify-feature/SKILL.md",
        "skills/README.md",
      ),
    );
    expect(scan.single).toBe(false);
    expect(scan.groups.map((g) => g.root).sort()).toEqual([
      "verify-feature",
      "write-prd",
    ]);
    // 库根目录下的 README.md 不属于任何技能，不会被塞进去。
    expect(
      scan.groups.flatMap((g) => g.files.map((f) => f.path)),
    ).not.toContain("README.md");
  });

  it("嵌套的 SKILL.md 归上层技能当附属文件，不另算一个技能（与 pi 的发现规则一致）", () => {
    const scan = scanSkillFolders(
      items("write-prd/SKILL.md", "write-prd/examples/sample-skill/SKILL.md"),
    );
    expect(scan.groups).toHaveLength(1);
    expect(scan.groups[0]?.files.map((f) => f.path).sort()).toEqual([
      "SKILL.md",
      "examples/sample-skill/SKILL.md",
    ]);
  });

  it("隐藏文件一律不带进来（.DS_Store / .git）", () => {
    const scan = scanSkillFolders(
      items(
        "write-prd/SKILL.md",
        "write-prd/.DS_Store",
        "write-prd/.git/config",
      ),
    );
    expect(scan.groups[0]?.files.map((f) => f.path)).toEqual(["SKILL.md"]);
  });

  it("一个 SKILL.md 都没有：不报「成功 0 个」，而是说清该选哪一层", () => {
    const scan = scanSkillFolders(items("docs/一些笔记.md", "docs/图.png"));
    expect(scan.groups).toEqual([]);
    expect(scan.problem).toContain("SKILL.md");
    expect(scan.problem).toContain("选");
  });

  it("拖进来多个技能目录（没有共同顶层）也能分开", () => {
    const scan = scanSkillFolders(
      items("write-prd/SKILL.md", "verify-feature/SKILL.md"),
    );
    expect(scan.groups.map((g) => g.root).sort()).toEqual([
      "verify-feature",
      "write-prd",
    ]);
  });
});
