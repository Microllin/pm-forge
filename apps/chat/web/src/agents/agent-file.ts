/** 执行体页里不是组件的那部分（react-refresh 要求组件文件只导出组件）。 */

/**
 * 新建时预填的骨架。
 *
 * 刻意把 tools 与纪律写进模板：执行体最容易出的两种事故是「工具开太宽」与
 * 「没写清不许干什么」，空白输入框不会提醒任何一条。
 */
export const NEW_AGENT_TEMPLATE = `---
name: my-agent
description: 一句话说清「它干什么 + 什么时候派它」。调用方只靠这句话决定要不要派它。
tools: product_overview, evidence_locate, file_search, file_read
model: inherit
skills:
---

# 我的执行体

## 职责

它负责什么，一句话。

## 纪律

- 只读，不改任何文件。
- 结论必须带证据指针（file:line），拿不到证据就写「未核实」，不要推断补位。
- 超出职责的事直接说做不了，不要顺手做了。
`;

/** 定义文件里点名了哪些 skill（给「预加载 skill」那一行用）。 */
export function draftSkills(content: string): string[] {
  const body = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  if (body === undefined) return [];
  return (/^skills:[ \t]*(.*)$/m.exec(body)?.[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 写权限的工具。带其中任一项，派它之前就得先确认纪律里写了边界。 */
/** 平台的写草稿 + 终端 pi 的写类工具（大小写都认：分发出去的定义可能沿用别家的写法）。 */
const WRITE_TOOLS = /^(draft_write|write|edit|bash|notebookedit|multiedit)$/i;

/**
 * 这个执行体能不能改东西。
 *
 * `Bash` 也算：它能 `rm`、能 `git push`，比 Write 还宽。把它漏掉的话
 * 「可写」这个标就成了假的安全感——那比不标更糟。
 */
export function canWrite(tools: readonly string[]): boolean {
  // 空 tools = 继承全部工具，自然也包含写。
  return tools.length === 0 || tools.some((t) => WRITE_TOOLS.test(t));
}
