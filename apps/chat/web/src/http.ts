/**
 * 前端访问服务端的那一层壳。
 *
 * 为什么单独一个文件：`ApiError` 与 `request` 原来在五个 api.ts 里各写了一遍
 * （根 / files / products / lifecycle / analysis），字面几乎相同但**不完全相同**
 * ——files 那份多一条 413 的文案、少一个默认 content-type。
 * 五份类定义还意味着 `catch (e) { e instanceof ApiError }` 在跨模块时会失效：
 * products 抛出的 ApiError 不是 files 那个类的实例。
 */

/**
 * 任何接口回 401 时广播的事件。登录闸（auth/AuthGate.tsx）听它，重查登录状态后
 * 回到登录页——不用每个调用点自己处理「登录过期」。
 */
export const UNAUTHORIZED_EVENT = "pmforge:unauthorized";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * 造一个绑定了前缀的 request。
 *
 * @param prefix 路径前缀，如 `/api` 或 `/api/files`。
 * @param statusText 某些状态码的**兜底**文案（如 files 的 413）。
 *   服务端的消息更准时以它为准——413 的服务端消息带着实际配置的上限
 *   （「文件超过 1 MB 上限」），而这里只能写死一个数字。
 *   只有服务端没给 JSON 错误体时（Fastify 内置的 payload 限制就不给）才用它。
 */
export function createRequest(
  prefix: string,
  statusText?: (status: number) => string | undefined,
) {
  return async function request<T>(
    url: string,
    init: RequestInit = {},
  ): Promise<T> {
    const headers = new Headers(init.headers);
    // 只在确实有 JSON 体时才加：文件上传用 application/octet-stream，
    // 覆盖掉它会让服务端的 body parser 不认（415）。
    if (init.body !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    const res = await fetch(`${prefix}${url}`, { ...init, headers });
    if (!res.ok) {
      // 查登录状态的接口本身不会 401；其余的 401 都意味着该回登录页了。
      if (res.status === 401 && typeof window !== "undefined")
        window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
      let code = "HTTP_ERROR";
      let message =
        statusText?.(res.status) ?? `请求失败（${String(res.status)}）`;
      try {
        const body = (await res.json()) as {
          error?: { code?: string; message?: string };
        };
        code = body.error?.code ?? code;
        message = body.error?.message ?? message;
      } catch {
        // 没有 JSON 错误体，用上面的默认文案。
      }
      throw new ApiError(res.status, code, message);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  };
}

/** JSON 请求体。配合 `createRequest` 用：`request(url, { method: "POST", ...json(x) })`。 */
export const json = (body: unknown): RequestInit => ({
  body: JSON.stringify(body),
});
