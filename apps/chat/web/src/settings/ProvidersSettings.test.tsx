import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ProvidersSettings } from "./ProvidersSettings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { "content-type": "application/json" },
  });

function setup() {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = init?.method ?? "GET";
      calls.push({
        url,
        method,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.endsWith("/api/providers")) {
        return Promise.resolve(
          json({
            configured: [],
            catalog: [
              { id: "anthropic", name: "Anthropic", modelCount: 20 },
              { id: "openai", name: "OpenAI", modelCount: 30 },
            ],
            defaultModel: null,
            defaultThinking: "medium",
          }),
        );
      }
      if (url.endsWith("/api/model/probe"))
        return Promise.resolve(
          json({ models: ["模型 A", "模型 B", "模型 C"] }),
        );
      if (method === "PUT")
        return Promise.resolve(
          url.endsWith("/key") ? new Response(null, { status: 204 }) : json({}),
        );
      return Promise.resolve(
        json({
          models: [],
          defaultModel: null,
          defaultThinking: "medium",
          problem: null,
        }),
      );
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ProvidersSettings />
    </QueryClientProvider>,
  );
  return calls;
}

describe("ProvidersSettings", () => {
  it("添加中转：拉取模型后默认全选，可取消勾选，保存只带勾选的模型与 key", async () => {
    const calls = setup();
    await userEvent.click(
      await screen.findByRole("button", { name: /自定义中转/ }),
    );
    await userEvent.type(
      screen.getByPlaceholderText("https://example.com"),
      "https://relay.example",
    );
    await userEvent.type(screen.getByPlaceholderText("粘贴 key"), "sk-x");
    await userEvent.click(screen.getByRole("button", { name: /拉取模型/ }));
    expect(await screen.findByText(/拉取到 3 个模型/)).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox", { checked: true })).toHaveLength(3);

    await userEvent.click(screen.getByRole("checkbox", { name: "模型 B" }));
    await userEvent.click(
      screen.getByRole("button", { name: /保存（2 个模型）/ }),
    );
    await waitFor(() => {
      expect(
        calls.some((c) => c.url.endsWith("/api/providers/custom/relay")),
      ).toBe(true);
    });
    const saved = calls.find((c) =>
      c.url.endsWith("/api/providers/custom/relay"),
    );
    expect(saved?.body).toEqual({
      baseUrl: "https://relay.example",
      api: "anthropic-messages",
      models: ["模型 A", "模型 C"],
      key: "sk-x",
    });
  });

  it("添加内置 provider：选一个、填 key", async () => {
    const calls = setup();
    await userEvent.click(
      await screen.findByRole("button", { name: /内置 provider/ }),
    );
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.click(screen.getByRole("option", { name: /OpenAI/ }));
    await userEvent.type(screen.getByPlaceholderText("粘贴 key"), "sk-openai");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => {
      expect(
        calls.find((c) => c.url.endsWith("/api/providers/openai/key"))?.body,
      ).toEqual({ key: "sk-openai" });
    });
  });
});
