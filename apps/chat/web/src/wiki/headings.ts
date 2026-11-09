/**
 * 从 Markdown 源里抽小节标题，供右栏目录与标题锚点共用。
 *
 * 单独一个文件而不是和 WikiArticle 放一起：那个文件只能导出组件
 * （否则 Vite 的 fast refresh 会整页刷新，编辑正文时很烦）。
 */

export interface Heading {
  /** 锚点 id。 */
  id: string;
  text: string;
  /** 2 = `##`，3 = `###`。只收这两级。 */
  level: 2 | 3;
}

/**
 * 从 Markdown 源里抽标题。
 *
 * **正则扫行首，不重新解析一遍 AST**：渲染时 react-markdown 已经解析过一次，
 * 为了目录再解析一次是白费——而正文可以有几千字，这一次不便宜。
 *
 * 要跳过代码块里的 `#`：```sh 里的注释行 `# 装依赖` 不是标题。
 */
export function extractHeadings(markdown: string): Heading[] {
  const out: Heading[] = [];
  const used = new Map<string, number>();
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const level = m[1]?.length === 2 ? 2 : 3;
    const text = (m[2] ?? "").replace(/`/g, "").trim();
    if (text === "") continue;
    out.push({ id: slugOf(text, used), text, level });
  }
  return out;
}

/**
 * 标题 → 锚点 id。
 *
 * 中文标题没法走「转拼音/去非 ASCII」那套（去完就剩空字符串，全部撞成同一个 id），
 * 所以保留原字符只替换空白与井号，重复的加序号后缀。
 * 这个函数在抽目录与渲染标题两处都要用，**必须给出一致的结果**——
 * 不一致的表现是「目录点了不跳」，而且查起来很烦。
 */
function slugOf(text: string, used: Map<string, number>): string {
  const base = `h-${text.replace(/[\s#]+/g, "-").slice(0, 60)}`;
  const seen = used.get(base) ?? 0;
  used.set(base, seen + 1);
  return seen === 0 ? base : `${base}-${String(seen + 1)}`;
}
