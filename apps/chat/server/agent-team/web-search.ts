/**
 * 联网搜索：借模型接口自带的搜索能力。
 *
 * 为什么另发一次请求，而不是把搜索开关塞进智能体自己的会话：pi-ai 1.4.0 不认识
 * `server_tool_use` / `web_search_tool_result` 这类内容块，塞进去解析结果不可预期。
 * 这里是一次独立的、一问一答的请求，返回结论文本 + 来源链接，对智能体来说就是普通工具。
 *
 * 只支持 `anthropic-messages` 协议（实测部分中转服务会原样透传 web_search_20250305）。
 */

export interface WebSearchTarget {
  baseUrl: string;
  apiKey: string;
  modelId: string;
}

export interface WebSearchResult {
  answer: string;
  sources: { title: string; url: string }[];
  searches: number;
}

/** 单次搜索请求里模型最多发起几次搜索。更多既慢又贵，调研要深入就多调几次工具。 */
const MAX_USES = 3;
const TIMEOUT_MS = 120_000;

interface Block {
  type: string;
  text?: string;
  citations?: { url?: string; title?: string }[];
  content?: unknown;
}

/** 解析 Messages 接口的返回。抽成纯函数，便于离线测试。 */
export function parseWebSearchResponse(body: unknown): WebSearchResult {
  const b = body as {
    content?: Block[];
    usage?: { server_tool_use?: { web_search_requests?: number } };
    error?: { message?: string };
  };
  if (!Array.isArray(b.content)) {
    throw new Error(`联网搜索失败：${b.error?.message ?? "接口没有返回内容"}`);
  }
  const sources = new Map<string, string>();
  const texts: string[] = [];
  for (const block of b.content) {
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
      for (const c of block.citations ?? []) {
        if (c.url) sources.set(c.url, c.title ?? c.url);
      }
    }
    // 搜索结果块里也有链接：模型没在正文里引用的，也列出来供核对。
    if (
      block.type === "web_search_tool_result" &&
      Array.isArray(block.content)
    ) {
      for (const r of block.content as { url?: string; title?: string }[]) {
        if (r.url && !sources.has(r.url)) sources.set(r.url, r.title ?? r.url);
      }
    }
  }
  return {
    answer: texts.join("").trim(),
    sources: [...sources].map(([url, title]) => ({ url, title })),
    searches: b.usage?.server_tool_use?.web_search_requests ?? 0,
  };
}

export function formatWebSearch(query: string, r: WebSearchResult): string {
  const lines = [
    `# 联网搜索：${query}`,
    "",
    r.answer || "（模型没有给出结论）",
    "",
  ];
  lines.push(`## 来源（${String(r.sources.length)}）`);
  if (r.sources.length === 0)
    lines.push("（没有可引用的来源——以上结论视为未核实）");
  for (const s of r.sources.slice(0, 20))
    lines.push(`- [${s.title}](${s.url})`);
  return lines.join("\n");
}

export async function webSearch(
  target: WebSearchTarget,
  query: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<WebSearchResult> {
  const url = `${target.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": target.apiKey,
      authorization: `Bearer ${target.apiKey}`,
    },
    body: JSON.stringify({
      model: target.modelId,
      max_tokens: 2048,
      tools: [
        { type: "web_search_20250305", name: "web_search", max_uses: MAX_USES },
      ],
      messages: [
        {
          role: "user",
          content: [
            "请联网搜索并回答下面的问题。要求：",
            "1. 只陈述搜到的事实，每条都要能对应到来源；搜不到就明说搜不到，不要凭记忆补。",
            "2. 带上事实的时间（发布/更新日期），过时的信息要标出来。",
            "3. 用中文回答，简洁。",
            "",
            `问题：${query}`,
          ].join("\n"),
        },
      ],
    }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(
      `联网搜索失败：HTTP ${String(res.status)} ${text.slice(0, 200)}`,
    );
  }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } }).error?.message;
    throw new Error(
      `联网搜索失败：HTTP ${String(res.status)} ${msg ?? ""}`.trim(),
    );
  }
  return parseWebSearchResponse(body);
}
