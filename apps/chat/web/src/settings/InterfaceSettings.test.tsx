import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { InterfaceSettings } from "./InterfaceSettings";
import { setReasoningDisplay } from "./ui-prefs";

/** 设置项没有「保存」按钮：点一下即生效、即落盘。 */

/** 同 ui-prefs.test.ts：jsdom 下没有可用的 localStorage，得自己注入。 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  cleanup();
  setReasoningDisplay("collapsed");
  vi.unstubAllGlobals();
});

describe("界面设置", () => {
  it("三档都在，当前档位可辨识", () => {
    render(<InterfaceSettings />);
    expect(
      screen.getByRole("button", { name: "折叠", pressed: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "边想边看" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "始终展开" }),
    ).toBeInTheDocument();
  });

  it("点一下即生效：落盘 + 选中态跟着走 + 说明文案跟着换", async () => {
    render(<InterfaceSettings />);
    await userEvent.click(screen.getByRole("button", { name: "边想边看" }));
    expect(localStorage.getItem("pmforge-chat.reasoning-display")).toBe(
      "streaming",
    );
    expect(
      screen.getByRole("button", { name: "边想边看", pressed: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/思考时自动展开，答完自动收起/),
    ).toBeInTheDocument();
  });

  it("说清「自适应思考的模型可能根本不思考」，免得以为设置没生效", () => {
    render(<InterfaceSettings />);
    expect(screen.getByText(/自适应思考/)).toBeInTheDocument();
  });
});
