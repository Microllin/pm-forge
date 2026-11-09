import { useEffect, useState } from "react";

/**
 * 收起的侧栏只剩图标：鼠标停在图标上时，在右边弹出它的名字。
 *
 * 为什么不用原生 title：浏览器自带的提示要等一秒多才出、样式跟不了主题。
 * 为什么不用 CSS ::after：侧栏是 overflow 滚动容器，伪元素会被裁掉。
 * 所以挂在 body 层，按图标的位置定位；用事件委托，一个组件管全部图标。
 */
export function RailTip({
  container,
  enabled,
}: {
  container: React.RefObject<HTMLElement | null>;
  enabled: boolean;
}): React.JSX.Element | null {
  const [tip, setTip] = useState<{
    label: string;
    top: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    const root = container.current;
    if (!root || !enabled) return;
    const show = (e: Event): void => {
      const target = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-rail-tip]",
      );
      if (!target) return;
      const r = target.getBoundingClientRect();
      setTip({
        label: target.dataset.railTip ?? "",
        top: r.top + r.height / 2,
        left: r.right + 10,
      });
    };
    const hide = (e: Event): void => {
      const to = (e as MouseEvent).relatedTarget as Node | null;
      if (
        to &&
        root.contains(to) &&
        (to as HTMLElement).closest("[data-rail-tip]")
      )
        return;
      setTip(null);
    };
    root.addEventListener("mouseover", show);
    root.addEventListener("focusin", show);
    root.addEventListener("mouseout", hide);
    root.addEventListener("focusout", () => setTip(null));
    root.addEventListener("scroll", () => setTip(null), true);
    return () => {
      root.removeEventListener("mouseover", show);
      root.removeEventListener("focusin", show);
      root.removeEventListener("mouseout", hide);
    };
  }, [container, enabled]);

  if (!tip || !enabled) return null;
  return (
    <div
      className="rail-tip"
      role="tooltip"
      style={{ top: tip.top, left: tip.left }}
    >
      {tip.label}
    </div>
  );
}
