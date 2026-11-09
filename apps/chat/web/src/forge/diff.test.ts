import { describe, expect, it } from "vitest";

import { diffLines, diffStat, foldUnchanged } from "./diff";

describe("diffLines", () => {
  it("只标出改动的行", () => {
    const d = diffLines("a\nb\nc", "a\nB\nc");
    expect(d).toEqual([
      { type: "same", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "B" },
      { type: "same", text: "c" },
    ]);
    expect(diffStat(d)).toEqual({ added: 1, removed: 1 });
  });

  it("新建（原文为空）= 全是新增", () => {
    expect(diffStat(diffLines("", "x\ny"))).toEqual({ added: 2, removed: 0 });
  });

  it("中间插入不误判后面的行", () => {
    const d = diffLines("1\n2\n3\n4", "1\n2\nnew\n3\n4");
    expect(d.filter((l) => l.type !== "same")).toEqual([
      { type: "add", text: "new" },
    ]);
  });

  it("没改的大段折起来，改动前后留上下文", () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${String(i)}`).join(
      "\n",
    );
    const after = before.replace("l10", "L10");
    const blocks = foldUnchanged(diffLines(before, after), 2);
    expect(blocks.map((b) => b.type)).toEqual(["fold", "lines", "fold"]);
    expect(blocks[0]).toMatchObject({ type: "fold", count: 8 });
  });
});
