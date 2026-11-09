import { memo, useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * 回答正文的 Markdown 渲染。
 *
 * - 不开原始 HTML（不引 rehype-raw）：模型输出不可信，开了等于给提示词注入一条
 *   直达 DOM 的路。
 * - 链接只放行 http(s)。
 * - 流式中途若代码围栏没闭合，临时补上——否则后文全被吞进代码块。
 * - 超长文本流式期间退回纯文本：Markdown 每帧都要全文重解析，长到几万字时
 *   会卡住主线程，连「停止」都点不动。落定后再一次性排版。
 */

const LIVE_LIMIT = 12_000;

const components: Components = {
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
};

function closeOpenFence(text: string): string {
  const fences = text
    .split("\n")
    .filter((l) => /^\s{0,3}(```|~~~)/.test(l)).length;
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text;
}

export const MarkdownText = memo(function MarkdownText({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}): React.JSX.Element {
  const raw = streaming && text.length > LIVE_LIMIT;
  const source = useMemo(
    () => (raw ? "" : streaming ? closeOpenFence(text) : text),
    [text, streaming, raw],
  );
  if (raw) return <div className="md md-raw">{text}</div>;
  return (
    <div className="md">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </Markdown>
    </div>
  );
});
