import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { PiSettings } from "./PiSettings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (d: unknown) =>
  new Response(JSON.stringify(d), {
    headers: { "content-type": "application/json" },
  });
const enc = new TextEncoder();
const sse = (events: unknown[]) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const e of events)
          c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
        c.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

function setup(upgradeEvents: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith("/api/pi")) {
        return Promise.resolve(
          json({
            installed: "1.2.0",
            installedAt: "2026-10-12T00:00:00Z",
            latest: "1.3.0",
            latestAt: "2026-10-20T00:00:00Z",
            updateAvailable: true,
            repository: null,
            upgrading: false,
            registryError: null,
          }),
        );
      }
      if (url.endsWith("/api/pi/upgrade"))
        return Promise.resolve(sse(upgradeEvents));
      return Promise.resolve(json({ status: "ok" }));
    }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <PiSettings />
    </QueryClientProvider>,
  );
}

describe("PiSettings", () => {
  it("显示已装与最新版本，有更新时给升级按钮", async () => {
    setup([]);
    expect(await screen.findByText("1.2.0")).toBeInTheDocument();
    expect(screen.getByText("1.3.0")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /升级到 1.3.0/ }),
    ).toBeInTheDocument();
  });

  it("自检失败：显示失败原因与日志，不进入重启等待", async () => {
    setup([
      { type: "step", name: "安装" },
      { type: "log", line: "+ @earendil-works/pi-coding-agent 1.3.0" },
      { type: "step", name: "自检" },
      {
        type: "done",
        ok: false,
        error: "新版本自检未通过，已装回原版本",
        rolledBack: true,
      },
    ]);
    await userEvent.click(
      await screen.findByRole("button", { name: /升级到/ }),
    );
    expect(
      await screen.findByText(/自检未通过，已装回原版本/),
    ).toBeInTheDocument();
    expect(screen.getByText(/▸ 自检/)).toBeInTheDocument();
    expect(screen.queryByText(/服务重启中/)).not.toBeInTheDocument();
  });

  it("不在看护进程下：提示手动重启", async () => {
    setup([{ type: "done", ok: true, version: "1.3.0", restarting: false }]);
    await userEvent.click(
      await screen.findByRole("button", { name: /升级到/ }),
    );
    expect(await screen.findByText(/请手动重启/)).toBeInTheDocument();
  });
});
