/** 技能页里不是组件的那部分（react-refresh 要求组件文件只导出组件）。 */

/** 新建时预填的骨架：空白输入框只会让人不知道该写什么格式。 */
export const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: 一句话说清「做什么 + 什么时候用」。模型只靠这句话判断要不要加载它。
---

# 我的技能

写给模型看的步骤。需要附带文件时打包成 zip 导入，正文里用相对路径引用，例如 references/checklist.md。
`;

/** 从 SKILL.md 原文里取 frontmatter 的 name，用来提示「保存后会叫什么」。 */
export function draftName(content: string): string | null {
  const body = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  if (body === undefined) return null;
  const raw = /^name:[ \t]*(.+)$/m.exec(body)?.[1]?.trim();
  if (raw === undefined || raw === "") return null;
  const first = raw[0];
  return first !== undefined && /["']/.test(first) && raw.endsWith(first)
    ? raw.slice(1, -1).trim()
    : raw;
}

/** 二进制转 base64。分块是因为一次性 spread 大数组会爆栈。 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

/**
 * 渲染正文前剥掉 frontmatter。
 *
 * Markdown 不认识 YAML 头，直接渲染会把 `name: … description: … version: …`
 * 糊成一段正文（实测 baoyu-infographic 那段把首屏占满），而这些字段界面上方
 * 已经展示过了。编辑源码时仍然看到完整原文——那里改的就是整个文件。
 */
export function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trimStart();
}
