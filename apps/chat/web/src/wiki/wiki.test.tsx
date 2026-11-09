import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { extractHeadings } from "./headings";
import { WikiArticle } from "./WikiArticle";

describe("抽小节标题", () => {
  it("只收 ## 与 ###，忽略一级标题", () => {
    const got = extractHeadings("# 页面标题\n## 二级\n### 三级\n#### 四级");
    expect(got.map((h) => [h.level, h.text])).toEqual([
      [2, "二级"],
      [3, "三级"],
    ]);
  });

  it("跳过代码块里的 #——`# 装依赖` 不是标题", () => {
    const md = ["## 真标题", "", "```sh", "# 装依赖", "pnpm i", "```", ""].join(
      "\n",
    );
    expect(extractHeadings(md).map((h) => h.text)).toEqual(["真标题"]);
  });

  it("中文标题也能生成锚点——不能因为去掉非 ASCII 就变成空串", () => {
    const got = extractHeadings("## 架构分层");
    expect(got[0]?.id).toBeTruthy();
    expect(got[0]?.id).not.toBe("h-");
  });

  it("同名标题的锚点不撞——否则目录里两条都跳到第一个", () => {
    const got = extractHeadings("## 概述\n### 细节\n## 概述");
    const ids = got.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("标题里的反引号不进锚点文本", () => {
    expect(extractHeadings("## `server/app.ts` 的职责")[0]?.text).toBe(
      "server/app.ts 的职责",
    );
  });
});

describe("正文渲染", () => {
  it("渲染出的标题 id 与 extractHeadings 算的一致——不一致就是「目录点了不跳」", () => {
    const md =
      "## 架构分层\n\n正文\n\n### 服务端\n\n正文\n\n## 架构分层\n\n正文";
    const { container } = render(<WikiArticle markdown={md} />);
    const rendered = [...container.querySelectorAll("h2, h3")].map((el) =>
      el.getAttribute("id"),
    );
    expect(rendered).toEqual(extractHeadings(md).map((h) => h.id));
    // 重名那两个确实拿到了不同的 id
    expect(new Set(rendered).size).toBe(3);
  });

  it("证据等级标记渲染成带样式的徽标", () => {
    render(
      <WikiArticle markdown="服务端分三层 [已核实]，缓存策略不明 [待核实]。" />,
    );
    expect(screen.getByText("已核实")).toHaveClass("wiki-badge", "ok");
    expect(screen.getByText("待核实")).toHaveClass("wiki-badge", "warn");
  });

  it("代码块里的同名字样不被当成徽标——正文完全可能拿它举例", () => {
    const md = ["正文 [已核实]", "", "```md", "写法是 [待核实]", "```"].join(
      "\n",
    );
    const { container } = render(<WikiArticle markdown={md} />);
    expect(container.querySelectorAll(".wiki-badge")).toHaveLength(1);
    expect(container.querySelector("code")?.textContent).toContain("[待核实]");
  });

  it("不渲染原始 HTML——正文多半来自模型，开了等于给提示词注入一条直达 DOM 的路", () => {
    const { container } = render(
      <WikiArticle markdown={'<img src=x onerror="alert(1)">\n\n正文'} />,
    );
    expect(container.querySelector("img")).toBeNull();
  });

  it("只放行 http(s) 链接", () => {
    const { container } = render(
      <WikiArticle markdown="[外链](https://example.com) 与 [坏的](javascript:alert(1))" />,
    );
    const links = [...container.querySelectorAll("a")];
    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe("https://example.com");
  });

  it("表格照常渲染（产品 wiki 里字段清单、权限矩阵都靠它）", () => {
    const md = ["| 字段 | 含义 |", "| --- | --- |", "| id | 主键 |"].join("\n");
    const { container } = render(<WikiArticle markdown={md} />);
    expect(container.querySelector(".md-table table")).not.toBeNull();
    expect(screen.getByText("主键")).toBeInTheDocument();
  });
});
