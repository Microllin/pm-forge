import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  REASONING_DISPLAY,
  setReasoningDisplay,
  useReasoningDisplay,
} from "./ui-prefs";
import { renderHook, act } from "@testing-library/react";

/**
 * 界面偏好存 localStorage。这里钉的是三件容易出事的：默认值、脏值兜底、
 * 以及 useSyncExternalStore 的快照必须稳定（现读现返回会打进无限重渲染）。
 */

/**
 * 内存版 Storage。Node 24 自带的 localStorage 要 --localstorage-file 才可用，
 * jsdom 环境里拿到的是不可用的那个；ui-prefs 自己把读写包了 try/catch（生产
 * 环境优雅降级），所以这里必须注入一个能用的，否则测的只是「降级路径」。
 * 口径与 apps/web 的 persist.test.ts 一致。
 */
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
  setReasoningDisplay("collapsed");
  vi.unstubAllGlobals();
});

describe("思考过程显示偏好", () => {
  it("默认折叠（不改变既有行为）", () => {
    const { result } = renderHook(() => useReasoningDisplay());
    expect(result.current).toBe("collapsed");
  });

  it("设置后立刻生效并落盘", () => {
    const { result } = renderHook(() => useReasoningDisplay());
    act(() => {
      setReasoningDisplay("streaming");
    });
    expect(result.current).toBe("streaming");
    expect(localStorage.getItem("pmforge-chat.reasoning-display")).toBe(
      "streaming",
    );
  });

  it("三档都能设", () => {
    for (const mode of REASONING_DISPLAY) {
      act(() => {
        setReasoningDisplay(mode);
      });
      const { result } = renderHook(() => useReasoningDisplay());
      expect(result.current).toBe(mode);
    }
  });

  it("快照引用稳定：值没变时不触发重渲染", () => {
    let renders = 0;
    const { rerender, result } = renderHook(() => {
      renders += 1;
      return useReasoningDisplay();
    });
    const before = renders;
    rerender();
    expect(renders).toBe(before + 1); // 只因 rerender 自身，不会再被 store 叫醒
    expect(result.current).toBe("collapsed");
  });

  it("另一个标签页改了设置，这边跟着变", () => {
    const { result } = renderHook(() => useReasoningDisplay());
    act(() => {
      localStorage.setItem("pmforge-chat.reasoning-display", "expanded");
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "pmforge-chat.reasoning-display",
          newValue: "expanded",
        }),
      );
    });
    expect(result.current).toBe("expanded");
  });

  it("存了脏值（手改 localStorage / 旧版本遗留）回落到默认，不崩", () => {
    localStorage.setItem("pmforge-chat.reasoning-display", "banana");
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "pmforge-chat.reasoning-display",
          newValue: "banana",
        }),
      );
    });
    const { result } = renderHook(() => useReasoningDisplay());
    expect(result.current).toBe("collapsed");
  });
});
