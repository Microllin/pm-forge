import { describe, expect, it } from "vitest";

import { modelsEndpoint, parseModelIds, probeModels } from "./probe-models.js";

/** 记录请求并按脚本应答的假 fetch。 */
function fakeFetch(respond: () => Response | Promise<Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return Promise.resolve(respond());
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("modelsEndpoint", () => {
  it("没有 /v1 就补上；已有就直接接 /models；尾斜杠去掉", () => {
    expect(modelsEndpoint("https://relay.example")).toBe(
      "https://relay.example/v1/models",
    );
    expect(modelsEndpoint("https://relay.example/")).toBe(
      "https://relay.example/v1/models",
    );
    expect(modelsEndpoint("https://relay.example/v1")).toBe(
      "https://relay.example/v1/models",
    );
    expect(modelsEndpoint("https://relay.example/v1/")).toBe(
      "https://relay.example/v1/models",
    );
  });
});

describe("parseModelIds", () => {
  it("兼容 {data} / {models} / 纯数组，元素可为字符串或对象；去重排序", () => {
    expect(
      parseModelIds({ data: [{ id: "b" }, { id: "a" }, { id: "a" }] }),
    ).toEqual(["a", "b"]);
    expect(parseModelIds({ models: [{ name: "m1" }, "m2"] })).toEqual([
      "m1",
      "m2",
    ]);
    expect(parseModelIds(["x", { id: "y" }, null, 3])).toEqual(["x", "y"]);
    expect(parseModelIds({ nothing: true })).toEqual([]);
  });
});

describe("probeModels", () => {
  it("OpenAI 兼容：Bearer 头，打到 /v1/models", async () => {
    const f = fakeFetch(() =>
      json({ data: [{ id: "模型 A" }, { id: "模型 B" }] }),
    );
    const ids = await probeModels(
      {
        baseUrl: "https://relay.example",
        api: "openai-completions",
        key: "sk-1",
      },
      f.impl,
    );
    expect(ids).toEqual(["模型 A", "模型 B"]);
    expect(f.calls[0]?.url).toBe("https://relay.example/v1/models");
    expect(f.calls[0]?.headers.authorization).toBe("Bearer sk-1");
  });

  it("Anthropic 协议：x-api-key + anthropic-version 头", async () => {
    const f = fakeFetch(() => json({ data: [{ id: "m" }] }));
    await probeModels(
      {
        baseUrl: "https://relay.example",
        api: "anthropic-messages",
        key: "sk-2",
      },
      f.impl,
    );
    expect(f.calls[0]?.headers["x-api-key"]).toBe("sk-2");
    expect(f.calls[0]?.headers["anthropic-version"]).toBeDefined();
    expect(f.calls[0]?.headers.authorization).toBeUndefined();
  });

  it("401：明确说是 key 的问题", async () => {
    const f = fakeFetch(() => json({}, 401));
    await expect(
      probeModels(
        { baseUrl: "https://r.example", api: "openai-completions", key: "bad" },
        f.impl,
      ),
    ).rejects.toThrow("API key 被拒绝");
  });

  it("非 JSON / 解析不出模型 / 404：给出可操作的原因", async () => {
    const html = fakeFetch(() => new Response("<html>", { status: 200 }));
    await expect(
      probeModels(
        { baseUrl: "https://r.example", api: "openai-completions", key: "k" },
        html.impl,
      ),
    ).rejects.toThrow("没有返回 JSON");
    const empty = fakeFetch(() => json({ data: [] }));
    await expect(
      probeModels(
        { baseUrl: "https://r.example", api: "openai-completions", key: "k" },
        empty.impl,
      ),
    ).rejects.toThrow("没解析出任何模型");
    const missing = fakeFetch(() => json({}, 404));
    await expect(
      probeModels(
        { baseUrl: "https://r.example", api: "openai-completions", key: "k" },
        missing.impl,
      ),
    ).rejects.toThrow("返回 404");
  });

  it("连不上：报地址问题", async () => {
    const down = (() =>
      Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
    await expect(
      probeModels(
        { baseUrl: "https://r.example", api: "openai-completions", key: "k" },
        down,
      ),
    ).rejects.toThrow("连不上");
  });
});
