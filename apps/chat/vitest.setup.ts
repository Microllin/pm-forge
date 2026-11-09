import "@testing-library/jest-dom/vitest";

/**
 * jsdom 不做布局，缺几个布局相关 API。组件按规范调用是对的，缺口由测试环境补。
 * 走 Record 视图：类型层认为这些方法必然存在，这里检测的是运行时。
 */
const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
for (const name of ["scrollTo", "scrollIntoView"]) {
  if (typeof proto[name] !== "function") proto[name] = () => undefined;
}
const g = globalThis as unknown as Record<string, unknown>;
if (typeof g.ResizeObserver !== "function") {
  g.ResizeObserver = class {
    observe(): void {
      // 无布局，不会有尺寸变化。
    }
    unobserve(): void {
      // 同上。
    }
    disconnect(): void {
      // 同上。
    }
  };
}

/*
 * CodeMirror 量布局要用 Range 的几何方法，jsdom 没有实现（不做布局）。补空实现：
 * 编辑器能建起来、能编辑，只是没有真实坐标——组件测试不关心坐标。
 */
const rangeProto = Range.prototype as unknown as Record<string, unknown>;
if (typeof rangeProto.getClientRects !== "function") {
  rangeProto.getClientRects = () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {
      // 没有矩形
    },
  });
}
if (typeof rangeProto.getBoundingClientRect !== "function") {
  rangeProto.getBoundingClientRect = () => new DOMRect();
}
