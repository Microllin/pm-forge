import { useEffect, useMemo, useRef, useState } from "react";
import { Brain, Check, ChevronDown, Cpu } from "lucide-react";

import type { ModelControls } from "./model-controls";

/**
 * 输入框左下角的模型与思考强度按钮（pi CLI 的 /model 与 Shift+Tab）。
 *
 * - 点模型名或输入 `/model` 打开选择器：可搜索，↑↓ 选、Enter 确认、Esc 关闭。
 * - 点思考强度或按 Shift+Tab 切到下一档（只在模型支持的档位里转）。
 * - 回答进行中不能切换：pi 会在下一次请求时用新模型，轮中途换模型的结果难以解释。
 */
export function ModelBar({
  controls,
  busy,
}: {
  controls: ModelControls;
  busy: boolean;
}): React.JSX.Element {
  const { state } = controls;
  const thinkingAdjustable = (state?.thinkingLevels.length ?? 0) > 1;
  return (
    <div className="model-bar">
      <button
        type="button"
        className="chip"
        disabled={busy || controls.models.length === 0}
        title={
          state
            ? `${state.provider}/${state.modelId}（/model 切换）`
            : "选择模型"
        }
        onClick={() => controls.openPicker()}
      >
        <Cpu size={12} />
        <span className="chip-text">{state?.modelId ?? "选择模型"}</span>
        <ChevronDown size={12} />
      </button>
      {state && (
        <button
          type="button"
          className="chip"
          disabled={busy || !thinkingAdjustable}
          title={
            thinkingAdjustable
              ? "思考强度（Shift+Tab 切换）"
              : "这个模型不支持调节思考强度"
          }
          onClick={() => void controls.cycleThinking()}
        >
          <Brain size={12} />
          <span className="chip-text">{state.thinkingLevel}</span>
        </button>
      )}
      {(controls.error ??
        (controls.models.length === 0 ? controls.problem : null)) && (
        <span className="err-text small">
          {controls.error ?? controls.problem}
        </span>
      )}
      {controls.pickerOpen && <ModelPicker controls={controls} />}
    </div>
  );
}

function ModelPicker({
  controls,
}: {
  controls: ModelControls;
}): React.JSX.Element {
  const [query, setQuery] = useState(controls.pickerQuery);
  const current = controls.state;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return controls.models.filter(
      (m) =>
        q === "" ||
        m.id.toLowerCase().includes(q) ||
        m.provider.toLowerCase().includes(q),
    );
  }, [controls.models, query]);
  const initial = Math.max(
    0,
    filtered.findIndex(
      (m) => m.provider === current?.provider && m.id === current.modelId,
    ),
  );
  const [active, setActive] = useState(initial);
  const index = Math.min(active, Math.max(filtered.length - 1, 0));
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${String(index)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  // 点选择器外面关闭。
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) controls.closePicker();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [controls]);

  const choose = (i: number): void => {
    const m = filtered[i];
    if (m) void controls.select({ provider: m.provider, modelId: m.id });
  };

  return (
    <div className="picker" ref={rootRef} role="dialog" aria-label="选择模型">
      <input
        className="picker-search"
        aria-label="搜索模型"
        placeholder="搜索模型…"
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((index + 1) % Math.max(filtered.length, 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(
              (index - 1 + filtered.length) % Math.max(filtered.length, 1),
            );
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(index);
          } else if (e.key === "Escape") {
            e.preventDefault();
            controls.closePicker();
          }
        }}
      />
      <div className="picker-list" ref={listRef} role="listbox">
        {filtered.length === 0 && (
          <p className="muted small pad">没有匹配的模型</p>
        )}
        {filtered.map((m, i) => {
          // 按 provider 分组：与上一项不同就出一个组标题（列表本就按 provider 排好）。
          const header =
            i === 0 || filtered[i - 1]?.provider !== m.provider
              ? m.provider
              : null;
          const selected =
            m.provider === current?.provider && m.id === current.modelId;
          return (
            <div key={`${m.provider}/${m.id}`}>
              {header && <div className="picker-group">{header}</div>}
              <button
                type="button"
                role="option"
                aria-selected={i === index}
                data-index={i}
                className={`picker-item${i === index ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(i);
                }}
              >
                <span className="picker-check">
                  {selected && <Check size={12} />}
                </span>
                <span className="picker-name">{m.id}</span>
                {m.inheritedFrom && (
                  <span
                    className="picker-meta"
                    title={`参数继承自 ${m.inheritedFrom}`}
                  >
                    {Math.round(m.contextWindow / 1000)}k
                  </span>
                )}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
