import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ClipboardCheck,
  Eye,
  Link2,
  ListPlus,
  Sparkles,
  Upload,
  Wand2,
} from "lucide-react";

import type { Todo, TodoAction } from "./agent-api";

/**
 * 巡检待办：不花模型额度的规则检查，打开页面就算（服务端 computeTodos）。
 *
 * 一条待办 = 一个具体问题 + 能直接点的下一步。高优先级默认展开，中低折叠成计数，
 * 免得一本新库一打开就是几十条红字把清单压到看不见。
 */

const ACTION_LABEL: Record<TodoAction, [string, React.ReactNode]> = {
  add: ["加入清单", <ListPlus size={12} key="i" />],
  upload: ["上传", <Upload size={12} key="i" />],
  promote: ["预览草稿", <Eye size={12} key="i" />],
  review: ["发起审阅", <Sparkles size={12} key="i" />],
  "open-review": ["看修订清单", <ClipboardCheck size={12} key="i" />],
  link: ["去对号", <Link2 size={12} key="i" />],
  draft: ["让助手起草", <Wand2 size={12} key="i" />],
};

const LEVEL_LABEL = { high: "高", mid: "中", low: "低" } as const;

export function TodoPanel({
  todos,
  autoReview,
  onAutoReview,
  onAction,
}: {
  todos: Todo[];
  autoReview: boolean;
  onAutoReview: (on: boolean) => void;
  onAction: (todo: Todo, action: TodoAction) => void;
}): React.JSX.Element {
  const [showAll, setShowAll] = useState(false);
  const high = todos.filter((t) => t.level === "high");
  const rest = todos.filter((t) => t.level !== "high");
  const visible = showAll ? todos : high;

  return (
    <section className="presales-todo" aria-label="巡检待办">
      <div className="presales-todo-head">
        <strong>巡检待办</strong>
        <span className="muted small">
          {todos.length === 0 ? (
            "都齐了，没有发现问题。"
          ) : (
            <>
              高 <b className="presales-gap">{high.length}</b> · 中{" "}
              {todos.filter((t) => t.level === "mid").length} · 低{" "}
              {todos.filter((t) => t.level === "low").length}
            </>
          )}
        </span>
        <span className="presales-toolbar-spacer" />
        <label
          className="presales-check small"
          title="上传或替换 Word / PPT / Excel / Markdown 后自动发起一次 AI 审阅（会消耗模型额度）"
        >
          <input
            type="checkbox"
            checked={autoReview}
            onChange={(e) => onAutoReview(e.target.checked)}
          />
          上传后自动审阅
        </label>
      </div>
      {visible.length > 0 && (
        <ul className="presales-todo-list">
          {visible.map((t) => (
            <li key={t.id} className={`presales-todo-item lv-${t.level}`}>
              <em className={`presales-todo-lv lv-${t.level}`}>
                {LEVEL_LABEL[t.level]}
              </em>
              <div className="presales-todo-text">
                <span>{t.title}</span>
                {t.detail !== "" && (
                  <span className="muted small">{t.detail}</span>
                )}
              </div>
              <span className="presales-todo-ops">
                {t.actions.map((a) => (
                  <button
                    key={a}
                    type="button"
                    className={`btn ghost${a === "draft" ? " ai" : ""}`}
                    onClick={() => onAction(t, a)}
                  >
                    {ACTION_LABEL[a][1]} {ACTION_LABEL[a][0]}
                  </button>
                ))}
              </span>
            </li>
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <button
          type="button"
          className="btn ghost presales-todo-more"
          onClick={() => setShowAll((v) => !v)}
        >
          {showAll ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          {showAll
            ? "只看高优先级"
            : `另有 ${String(rest.length)} 条中低优先级`}
        </button>
      )}
    </section>
  );
}
