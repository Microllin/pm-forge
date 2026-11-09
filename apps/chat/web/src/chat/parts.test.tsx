import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { UserText } from "./parts";

/**
 * 用户气泡的长消息折叠。
 *
 * 这不是装饰：「AI 分析」那两个入口发出去的是服务端拼好的一大段目录事实
 * （实测 1.5 万字符量级）。不折叠的话，点一次「AI 识别」整屏都是目录树，
 * 真正要看的回答被推到视口外；但也不能直接截断——那段事实是分析的依据，
 * 要能原样展开复查。
 */
const part = (text: string) =>
  ({ text, type: "text" as const }) as unknown as Parameters<
    typeof UserText
  >[0];

describe("用户消息", () => {
  it("短消息原样显示，没有「展开全文」", () => {
    render(<UserText {...part("帮我看看这个需求")} />);
    expect(screen.getByText("帮我看看这个需求")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /展开全文/ }),
    ).not.toBeInTheDocument();
  });

  it("超过 14 行先折叠，点开能看到全文，还能再收起", async () => {
    const lines = Array.from(
      { length: 40 },
      (_, i) => `第 ${String(i + 1)} 行`,
    );
    render(<UserText {...part(lines.join("\n"))} />);

    const open = screen.getByRole("button", { name: "展开全文（共 40 行）" });
    // 折叠时只到第 14 行
    expect(screen.getByText(/第 14 行/)).toBeInTheDocument();
    expect(screen.queryByText(/第 40 行/)).not.toBeInTheDocument();

    await userEvent.click(open);
    expect(screen.getByText(/第 40 行/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "收起" }));
    expect(screen.queryByText(/第 40 行/)).not.toBeInTheDocument();
  });
});
