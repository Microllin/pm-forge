import { HttpError } from "../errors.js";

/**
 * 用 key 从中转接口拉取模型清单（`GET {base}/v1/models`）。
 *
 * 中转平台动辄几十上百个模型，手敲 id 既慢又容易错。
 *
 * 只拿得到 id：`/v1/models` 各家都不返回上下文窗口、最大输出这类元数据。
 * 这些由 pi/runtime.ts 按同名模型从 pi 内置目录继承，这里不编造。
 */

const TIMEOUT_MS = 15_000;

/**
 * 拼出 models 端点。地址可能填成 `https://x`、`https://x/`、`https://x/v1`：
 * 已经以 /v1 结尾就直接接 /models，否则补上 /v1。尾斜杠先去掉，拼出 `//models`
 * 有些网关会 404。
 */
export function modelsEndpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}

function headersFor(api: string, key: string): Record<string, string> {
  if (api === "anthropic-messages") {
    // 缺 anthropic-version 头 Anthropic 会拒，且报错不会提示缺的是它。
    return {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      accept: "application/json",
    };
  }
  return { authorization: `Bearer ${key}`, accept: "application/json" };
}

/** 宽容解析：`{ data: [...] }` / `{ models: [...] }` / 纯数组，元素是字符串或带 id/name 的对象。 */
export function parseModelIds(payload: unknown): string[] {
  const list = Array.isArray(payload)
    ? payload
    : payload !== null && typeof payload === "object"
      ? ((payload as { data?: unknown }).data ??
        (payload as { models?: unknown }).models)
      : undefined;
  if (!Array.isArray(list)) return [];
  const ids = new Set<string>();
  for (const item of list) {
    const raw =
      typeof item === "string"
        ? item
        : item !== null && typeof item === "object"
          ? ((item as { id?: unknown }).id ?? (item as { name?: unknown }).name)
          : undefined;
    if (typeof raw === "string" && raw.trim() !== "") ids.add(raw.trim());
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export async function probeModels(
  params: { baseUrl: string; api: string; key: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const url = modelsEndpoint(params.baseUrl);
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: headersFor(params.api, params.key),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause instanceof Error && cause.name === "TimeoutError";
    throw new HttpError(
      502,
      "UPSTREAM",
      timedOut ? `拉取超时：${url}` : `连不上 ${url}，检查接口地址`,
    );
  }
  // 401/403 单独说：最常见，而「上游故障」会让人去查网络而不是查 key。
  if (res.status === 401 || res.status === 403) {
    throw new HttpError(502, "UPSTREAM_AUTH", "API key 被拒绝，检查是否填对");
  }
  if (!res.ok) {
    throw new HttpError(
      502,
      "UPSTREAM",
      `${url} 返回 ${String(res.status)}，检查接口地址`,
    );
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new HttpError(502, "UPSTREAM", `${url} 没有返回 JSON，检查接口地址`);
  }
  const ids = parseModelIds(payload);
  if (ids.length === 0) {
    throw new HttpError(502, "UPSTREAM", "接口通了，但没解析出任何模型");
  }
  return ids;
}
