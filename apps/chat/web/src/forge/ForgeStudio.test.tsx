import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ForgeStudio } from "./ForgeStudio";

/**
 * AI 工坊界面。断言落在「人看到什么」和「发给服务端的请求」上：
 * 修改模式默认看改动前后；原件被别处改过时保存要人再确认一次；草稿有错时不让保存。
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), {
    status,
    headers: { "content-type": "application/json" },
  });

const BASE =
  "---\nname: prd\ndescription: 写 PRD。\n---\n\n## 步骤\n1. 先问目标\n";
const DRAFT = {
  sessionId: "s1",
  kind: "skill",
  mode: "edit",
  target: "prd",
  base: { "SKILL.md": BASE },
  files: { "SKILL.md": BASE.replace("先问目标", "先问目标与目标用户") },
  locked: [],
  savedName: null,
  dirty: true,
  problems: { errors: [], warnings: [] },
  name: "prd",
  stale: true,
  createdAt: 0,
  updatedAt: 0,
};

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function setup(draft: object = DRAFT) {
  const calls: Call[] = [];
  let saves = 0;
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
      if (url.endsWith("/api/forge") && method === "POST")
        return Promise.resolve(
          json({ sessionId: "s1", reused: false, kickoff: null }, 201),
        );
      if (url.endsWith("/api/forge/s1/save")) {
        saves += 1;
        return Promise.resolve(
          saves === 1
            ? json(
                {
                  error: {
                    code: "CONFLICT",
                    message:
                      "「prd」在你编辑期间被别处改过，保存会覆盖那次修改。确认覆盖吗？",
                  },
                },
                409,
              )
            : json({ name: "prd", draft: { ...draft, dirty: false } }),
        );
      }
      if (url.endsWith("/api/forge/s1")) return Promise.resolve(json(draft));
      if (url.endsWith("/api/sessions"))
        return Promise.resolve(json({ sessions: [] }));
      if (url.endsWith("/api/sessions/s1/messages"))
        return Promise.resolve(json({ messages: [], streaming: false }));
      return Promise.resolve(json({}, 404));
    }),
  );
  const onSaved = vi.fn();
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ForgeStudio
        kind="skill"
        start={{ mode: "edit", name: "prd" }}
        onClose={() => undefined}
        onSaved={onSaved}
      />
    </QueryClientProvider>,
  );
  return { calls, onSaved };
}

describe("AI 工坊", () => {
  it("修改模式：带着名字开工，默认看改动前后", async () => {
    const { calls } = setup();
    expect(
      await screen.findByRole("dialog", { name: "AI 修改技能 · prd" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.find((c) => c.url.endsWith("/api/forge") && c.method === "POST")
          ?.body,
      ).toEqual({ kind: "skill", mode: "edit", name: "prd" }),
    );
    const diff = await screen.findByLabelText("改动前后");
    expect(diff.querySelector(".forge-diff-line.del")?.textContent).toContain(
      "1. 先问目标",
    );
    expect(diff.querySelector(".forge-diff-line.add")?.textContent).toContain(
      "先问目标与目标用户",
    );
    expect(screen.getByText(/原件在你编辑期间被别处改过/)).toBeInTheDocument();
  });

  it("原件被改过：保存先问一句，确认后带 force 重存", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { calls, onSaved } = setup();
    await screen.findByLabelText("改动前后");
    await userEvent.click(screen.getByRole("button", { name: /保存到技能库/ }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith("prd"));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("被别处改过"));
    expect(
      calls.filter((c) => c.url.endsWith("/save")).map((c) => c.body),
    ).toEqual([{ force: false }, { force: true }]);
  });

  it("草稿有错时不让保存，并把错误摆出来", async () => {
    setup({
      ...DRAFT,
      stale: false,
      problems: { errors: ["SKILL.md 的 frontmatter 缺 name。"], warnings: [] },
    });
    expect(await screen.findByText(/缺 name/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /保存到技能库/ })).toBeDisabled();
  });
});
