/**
 * Wiki 正文的渲染，与 `chat/markdown.tsx` 分开。
 *
 * 为什么不直接复用那一个：对话里的 Markdown 要**流式**（每帧重解析、围栏可能没闭合、
 * 超长时退回纯文本），wiki 正文是**落定的静态文档**，要的是另一组东西——
 * 标题锚点、右栏目录、证据等级上色。硬塞进同一个组件会让两边的分支条件互相干扰。
 *
 * 安全口径沿用那边已经做对的一条：**不引 `rehype-raw`**。
 * 正文多半来自模型，开了原始 HTML 等于给提示词注入一条直达 DOM 的路。
 */
import { memo, useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { extractHeadings } from "./headings";

/** 证据等级标记。约定写法，不建模。 */
const BADGES = ["已核实", "待核实", "未覆盖"] as const;
type Badge = (typeof BADGES)[number];

const BADGE_CLASS: Record<Badge, string> = {
  已核实: "wiki-badge ok",
  待核实: "wiki-badge warn",
  未覆盖: "wiki-badge none",
};

/**
 * 把 `[已核实]` 这类标记换成带样式的 span。
 *
 * 做在**文本节点层**而不是预处理整段 Markdown：直接字符串替换会误伤代码块里的
 * 同名字样（正文里完全可能出现 `` `[待核实]` `` 作为举例），而到了文本节点这一层，
 * 代码块的内容已经走 `code` 分支了，碰不到这里。
 */
function withBadges(children: React.ReactNode): React.ReactNode {
  const walk = (node: React.ReactNode, key: number): React.ReactNode => {
    if (typeof node !== "string") return node;
    const parts = node.split(/(\[(?:已核实|待核实|未覆盖)\])/g);
    if (parts.length === 1) return node;
    return parts.map((part, i) => {
      const hit = BADGES.find((b) => part === `[${b}]`);
      return hit === undefined ? (
        part
      ) : (
        <span key={`${String(key)}-${String(i)}`} className={BADGE_CLASS[hit]}>
          {hit}
        </span>
      );
    });
  };
  if (Array.isArray(children))
    return children.map((c, i) => walk(c as React.ReactNode, i));
  return walk(children, 0);
}

function headingText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (Array.isArray(children))
    return children.map((c) => headingText(c as React.ReactNode)).join("");
  return "";
}

export const WikiArticle = memo(function WikiArticle({
  markdown,
}: {
  markdown: string;
}): React.JSX.Element {
  /*
   * 锚点 id 必须和 extractHeadings 算的一模一样，所以这里**不另算一套**，
   * 而是复用它的结果按出现顺序取。react-markdown 逐个渲染标题，
   * 用一个游标按序消费就对得上。
   *
   * 不用「渲染时现算 slug」的原因：那需要在组件间共享 used 计数，
   * 而 react-markdown 可能因为 memo 跳过重渲染，计数就乱了。
   */
  const components = useMemo<Components>(() => {
    const headings = extractHeadings(markdown);
    let cursor = 0;
    const idFor = (text: string): string | undefined => {
      // 按顺序找下一个文本相符的，容忍行内代码反引号被去掉后的差异。
      const plain = text.replace(/`/g, "").trim();
      for (let i = cursor; i < headings.length; i += 1) {
        if (headings[i]?.text === plain) {
          cursor = i + 1;
          return headings[i]?.id;
        }
      }
      return undefined;
    };
    return {
      a: ({ href, children }) =>
        href !== undefined && /^https?:\/\//i.test(href) ? (
          <a href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        ) : (
          <span>{children}</span>
        ),
      table: ({ children }) => (
        <div className="md-table">
          <table>{children}</table>
        </div>
      ),
      h2: ({ children }) => (
        <h2 id={idFor(headingText(children))}>{withBadges(children)}</h2>
      ),
      h3: ({ children }) => (
        <h3 id={idFor(headingText(children))}>{withBadges(children)}</h3>
      ),
      p: ({ children }) => <p>{withBadges(children)}</p>,
      li: ({ children }) => <li>{withBadges(children)}</li>,
      td: ({ children }) => <td>{withBadges(children)}</td>,
    };
  }, [markdown]);

  return (
    <div className="md wiki-md">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
});
