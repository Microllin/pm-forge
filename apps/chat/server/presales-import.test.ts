import { describe, expect, it } from "vitest";

import {
  recognizePrompt,
  recognizeResultSchema,
  scanForRecognition,
} from "./presales-import.js";
import type { FileStore } from "./files/store.js";

/**
 * AI 识别导入。
 *
 * 这里测的是**判断依据是否传到位**：模型要能挑对，前提是清单里有路径、修改时间、
 * 大小，以及每类材料是「对内」还是「对外」——内外搞反是这类材料最严重的错。
 */

const fakeStore = (
  files: { path: string; name: string; size: number; modifiedAt: number }[],
  total = files.length,
): FileStore =>
  ({
    exists: () => true,
    listFilesDeep: () => ({
      files: files.map((f) => ({
        ...f,
        isDir: false,
        kind: "other",
        version: "v",
      })),
      total,
      truncated: total > files.length,
    }),
  }) as unknown as FileStore;

describe("扫描范围", () => {
  it("只取文件、带修改时间与大小", () => {
    const store = fakeStore([
      {
        path: "/a/白皮书-v2.2.docx",
        name: "白皮书-v2.2.docx",
        size: 1024 * 1024,
        modifiedAt: 1_700_000_000_000,
      },
      {
        path: "/a/旧/白皮书-v1.docx",
        name: "白皮书-v1.docx",
        size: 512 * 1024,
        modifiedAt: 1_600_000_000_000,
      },
    ]);
    const scan = scanForRecognition(store, "/a");
    expect(scan.files.map((f) => f.path)).toEqual([
      "/a/白皮书-v2.2.docx",
      "/a/旧/白皮书-v1.docx",
    ]);
    expect(scan.truncated).toBe(false);
    expect(scan.total).toBe(2);
  });

  it("范围不存在时报错而不是给空清单", () => {
    const store = { exists: () => false } as unknown as FileStore;
    expect(() => scanForRecognition(store, "/nope")).toThrow(/不存在/);
  });
});

describe("提示词", () => {
  const prompt = recognizePrompt({
    scopePath: "/售前材料",
    files: [
      {
        path: "/售前材料/RouteHub-白皮书-v2.2-20261010.docx",
        name: "RouteHub-白皮书-v2.2-20261010.docx",
        size: 2 * 1024 * 1024,
        modifiedAt: new Date("2026-10-10").getTime(),
      },
      {
        path: "/售前材料/RouteHub-报价单-对内-v1.0.xlsx",
        name: "RouteHub-报价单-对内-v1.0.xlsx",
        size: 100 * 1024,
        modifiedAt: new Date("2026-09-23").getTime(),
      },
    ],
    total: 2,
    truncated: false,
    slots: [
      { id: "s1", title: "产品白皮书", stage: "contact", audience: "external" },
      {
        id: "s2",
        title: "标准报价单模板",
        stage: "proposal",
        audience: "external",
      },
      {
        id: "s3",
        title: "招投标参数（保密）",
        stage: "proposal",
        audience: "internal",
      },
    ],
  });

  it("清单带路径、日期、大小", () => {
    expect(prompt).toContain("/售前材料/RouteHub-白皮书-v2.2-20261010.docx");
    expect(prompt).toContain("2026-10-10");
    expect(prompt).toContain("2.0MB");
  });

  it("每类材料都标明对内还是对外", () => {
    expect(prompt).toContain("产品白皮书（阶段：contact；对外）");
    expect(prompt).toContain("招投标参数（保密）（阶段：proposal；对内）");
  });

  it("明确禁止把对内件挑给对外槽位", () => {
    expect(prompt).toContain("绝对不能");
    expect(prompt).toContain("对内");
  });

  it("要求输出 json 块，并锁定槽位标题与路径原文", () => {
    expect(prompt).toContain("```json");
    expect(prompt).toContain("不要自创");
    expect(prompt).toContain("完整路径原文");
  });

  it("截断时告诉模型清单不全", () => {
    const cut = recognizePrompt({
      scopePath: "/x",
      files: [{ path: "/x/a.pdf", name: "a.pdf", size: 1, modifiedAt: 0 }],
      total: 900,
      truncated: true,
      slots: [],
    });
    expect(cut).toContain("未列出");
  });
});

describe("结果解析", () => {
  it("认不出的把握等级退成 low，不整条丢", () => {
    const parsed = recognizeResultSchema.parse({
      picks: [
        { slotTitle: "产品白皮书", filePath: "/a.pdf", confidence: "瞎写的" },
      ],
    });
    expect(parsed.picks[0]?.confidence).toBe("low");
    expect(parsed.picks[0]?.reason).toBe("");
    expect(parsed.picks[0]?.alternates).toEqual([]);
  });
});
