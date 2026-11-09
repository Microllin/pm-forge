import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";

/**
 * 命令面板（⌘K / Ctrl+K）。只做「找到并跳过去」：前往某个菜单、打开某条会话、换主题。
 *
 * 条目由外壳传进来——面板自己不知道有哪些菜单和会话，这样它不依赖任何业务模块。
 */
export interface Command {
  id: string;
  group: string;
  label: string;
  icon: React.ReactNode;
  hint?: string;
  run: () => void;
}

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: readonly Command[];
  onClose: () => void;
}): React.JSX.Element {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);

  // 只在打开时挂载（见 App），所以每次打开都是全新状态，不用在 effect 里重置。
  useEffect(() => {
    input.current?.focus();
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return commands;
    return commands.filter((c) =>
      `${c.group} ${c.label}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => {
    list.current
      ?.querySelector(`[data-index="${String(index)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (i: number): void => {
    const command = shown[i];
    if (command === undefined) return;
    onClose();
    command.run();
  };

  return (
    <div
      className="palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="命令面板">
        <div className="palette-input">
          <Search size={16} />
          <input
            ref={input}
            aria-label="搜索命令"
            placeholder="前往页面、打开会话、切换主题…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, shown.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                run(index);
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={list} role="listbox">
          {shown.length === 0 && (
            <p className="palette-empty">没有匹配的结果，换个关键词试试。</p>
          )}
          {shown.map((c, i) => {
            const header = shown[i - 1]?.group !== c.group ? c.group : null;
            return (
              <div key={c.id}>
                {header !== null && (
                  <div className="palette-group">{header}</div>
                )}
                <button
                  type="button"
                  role="option"
                  aria-selected={i === index}
                  data-index={i}
                  className={`palette-item${i === index ? " on" : ""}`}
                  onMouseMove={() => setIndex(i)}
                  onClick={() => run(i)}
                >
                  {c.icon}
                  <span>{c.label}</span>
                  {c.hint !== undefined && (
                    <span className="palette-hint">{c.hint}</span>
                  )}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
