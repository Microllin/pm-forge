import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

import "./select.css";

/**
 * 平台统一的下拉框。**不要再写原生 `<select>`**，守卫测试
 * ui/ui-standard.test.ts 会拦。
 *
 * 为什么不用原生：原生下拉的弹出层由操作系统画，字体、字号、圆角、深色模式都不跟平台走，
 * Windows / macOS / Linux 各长一个样，深色主题下还常是一块白底。
 *
 * 交互对齐原生（WAI-ARIA「select-only combobox」模式）：
 * - 点击或 ↓ / Enter / 空格打开；↑↓ 移动、Home / End 到头尾、敲字母跳到对应项；
 *   Enter / 空格选中，Esc 或点外面关闭；焦点始终留在按钮上。
 * - 弹出层挂到 body 上（portal）：一是不被对话框的 overflow 裁掉；二是很多下拉包在
 *   `<label>` 里，弹层若在 label 内，点选项会冒泡成「再点一次按钮」又把它关掉。
 */

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
  disabled?: boolean;
}

export function Select<V extends string = string>({
  value,
  options,
  onChange,
  disabled = false,
  className,
  placeholder = "请选择",
  "aria-label": ariaLabel,
}: {
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  disabled?: boolean;
  /** 加在按钮上，用于沿用场景样式（如 `input sm`）。 */
  className?: string;
  /** 当前值不在选项里时显示。 */
  placeholder?: string;
  "aria-label"?: string;
}): React.JSX.Element {
  const id = useId();
  const listId = `${id}-list`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    width: number;
    maxHeight: number;
  } | null>(null);
  /** 敲字母跳转：短时间内连续敲的字符拼起来匹配。 */
  const typed = useRef({ text: "", at: 0 });

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const enabledFrom = (start: number, step: 1 | -1): number => {
    for (let i = start; i >= 0 && i < options.length; i += step)
      if (options[i]?.disabled !== true) return i;
    return -1;
  };

  const openList = (): void => {
    if (disabled || options.length === 0) return;
    setActive(selectedIndex >= 0 ? selectedIndex : enabledFrom(0, 1));
    setOpen(true);
  };
  const close = (): void => {
    setOpen(false);
    setPos(null);
  };
  const choose = (index: number): void => {
    const option = options[index];
    if (option === undefined || option.disabled === true) return;
    close();
    buttonRef.current?.focus();
    if (option.value !== value) onChange(option.value);
  };

  /** 弹层位置：贴在按钮下方；下方放不下就翻到上方。 */
  const place = (): void => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (rect === undefined) return;
    const gap = 4;
    const below = window.innerHeight - rect.bottom - gap - 8;
    const above = rect.top - gap - 8;
    const want = 280;
    const up = below < Math.min(want, 160) && above > below;
    const maxHeight = Math.max(80, Math.min(want, up ? above : below));
    setPos({
      top: up ? rect.top - gap - maxHeight : rect.bottom + gap,
      left: rect.left,
      width: rect.width,
      maxHeight,
    });
  };

  useLayoutEffect(() => {
    if (open) place();
    // place 只读 ref 与 window，不需要列进依赖。
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (
        buttonRef.current?.contains(target) === true ||
        listRef.current?.contains(target) === true
      )
        return;
      close();
    };
    // 页面滚动或窗口变化：重新贴位。弹层自己内部的滚动不管。
    const onScroll = (e: Event): void => {
      if (listRef.current?.contains(e.target as Node) === true) return;
      place();
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // 当前项滚进可视区。
  useEffect(() => {
    if (!open || active < 0) return;
    const el = listRef.current?.children.item(active);
    // jsdom（测试环境）没有 scrollIntoView。
    if (el != null && typeof el.scrollIntoView === "function")
      el.scrollIntoView({ block: "nearest" });
  }, [open, active, pos]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (disabled) return;
    const key = e.key;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(key)) {
        e.preventDefault();
        openList();
      }
      return;
    }
    const move = (next: number): void => {
      e.preventDefault();
      if (next >= 0) setActive(next);
    };
    if (key === "ArrowDown") move(enabledFrom(active + 1, 1));
    else if (key === "ArrowUp") move(enabledFrom(active - 1, -1));
    else if (key === "Home") move(enabledFrom(0, 1));
    else if (key === "End") move(enabledFrom(options.length - 1, -1));
    else if (key === "Enter" || key === " ") {
      e.preventDefault();
      choose(active);
    } else if (key === "Escape") {
      // 只关下拉，不让外层对话框跟着关。
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (key === "Tab") {
      close();
    } else if (key.length === 1) {
      const now = Date.now();
      typed.current = {
        text: (now - typed.current.at < 600 ? typed.current.text : "") + key,
        at: now,
      };
      const q = typed.current.text.toLowerCase();
      const hit = options.findIndex(
        (o) => o.disabled !== true && o.label.toLowerCase().startsWith(q),
      );
      if (hit >= 0) setActive(hit);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        className={`ui-select${className === undefined ? "" : ` ${className}`}`}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open && active >= 0 ? `${id}-opt-${String(active)}` : undefined
        }
        disabled={disabled}
        onClick={(e) => {
          // 包在 <label> 里时，label 的默认行为会再派一次 click 到按钮上。
          e.preventDefault();
          if (open) close();
          else openList();
        }}
        onKeyDown={onKeyDown}
      >
        <span className={`ui-select-value${selected ? "" : " placeholder"}`}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown size={14} className="ui-select-caret" aria-hidden="true" />
      </button>
      {open &&
        pos !== null &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            className="ui-select-list"
            style={{
              top: pos.top,
              left: pos.left,
              minWidth: pos.width,
              maxHeight: pos.maxHeight,
            }}
          >
            {options.map((o, i) => (
              <li
                key={o.value}
                id={`${id}-opt-${String(i)}`}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled === true || undefined}
                className={`ui-select-option${i === active ? " active" : ""}`}
                // 用 mousedown 而不是 click：避免按钮先失焦。
                onMouseDown={(e) => {
                  e.preventDefault();
                }}
                onClick={() => choose(i)}
                onMouseEnter={() => {
                  if (o.disabled !== true) setActive(i);
                }}
              >
                <span>{o.label}</span>
                {o.value === value && <Check size={14} aria-hidden="true" />}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
