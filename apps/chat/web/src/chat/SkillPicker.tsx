import { useEffect, useMemo, useRef, useState } from "react";
import { EyeOff, Sparkles } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { listSkills, type SkillSummary } from "../api";

/**
 * 技能选择器（输入 `/skill` 回车打开，照 pi CLI 的 `/skill:name`）。
 *
 * 为什么要有手动点名：模型靠描述自动选会漏（pi 文档自己也这么说），而**隐藏的
 * 技能根本不进清单**，只能点名。选中后不直接发出去，而是把 `/skill:名字 ` 填回
 * 输入框——技能多半还要带一句「做什么」，直接发等于逼你再补一轮。
 */
export function SkillPicker({
  query: initialQuery,
  onPick,
  onClose,
}: {
  query: string;
  onPick: (name: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const skills = useQuery({ queryKey: ["skills"], queryFn: listSkills });
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const all = skills.data?.skills;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (all ?? []).filter(
      (s) =>
        q === "" ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
  }, [all, query]);
  const index = Math.min(active, Math.max(filtered.length - 1, 0));

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${String(index)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  // 点外面关闭（与模型选择器同一套手势）。
  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const choose = (i: number): void => {
    const skill = filtered[i];
    if (skill) onPick(skill.name);
  };

  return (
    <div className="picker" ref={rootRef} role="dialog" aria-label="选择技能">
      <input
        className="picker-search"
        aria-label="搜索技能"
        placeholder="搜索技能…"
        autoFocus
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive(Math.min(index + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(Math.max(index - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(index);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <div className="picker-list" ref={listRef}>
        {skills.isPending && <p className="muted small pad">读取中…</p>}
        {!skills.isPending && filtered.length === 0 && (
          <p className="muted small pad">
            {(all ?? []).length === 0
              ? "还没有技能。去左侧「技能」页新建或导入。"
              : `没有匹配「${query}」的技能。`}
          </p>
        )}
        {filtered.map((skill, i) => (
          <SkillRow
            key={skill.name}
            skill={skill}
            active={i === index}
            index={i}
            onPick={() => choose(i)}
            onHover={() => setActive(i)}
          />
        ))}
      </div>
    </div>
  );
}

function SkillRow({
  skill,
  active,
  index,
  onPick,
  onHover,
}: {
  skill: SkillSummary;
  active: boolean;
  index: number;
  onPick: () => void;
  onHover: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      data-index={index}
      className={`picker-item${active ? " active" : ""}`}
      onMouseEnter={onHover}
      onClick={onPick}
    >
      <Sparkles size={12} className="picker-check" />
      <span className="picker-name">{skill.name}</span>
      {skill.hidden && <EyeOff size={11} aria-label="对模型隐藏，只能点名用" />}
      <span className="picker-meta ellipsis">{skill.description}</span>
    </button>
  );
}
