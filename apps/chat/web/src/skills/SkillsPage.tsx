import { useMemo, useRef, useState } from "react";
import { EyeOff, FolderUp, Loader2, Plus, Search, Upload } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  SKILL_TARGETS,
  createSkill,
  importSkillZip,
  listSkills,
  type SkillSummary,
  type SkillTarget,
} from "../api";
import { ART } from "../assets/art";
import { fromInput } from "../files/upload";
import { NEW_SKILL_TEMPLATE, bytesToBase64 } from "./skill-file";
import { describeImport, importSkillFolders } from "./skill-import";
import { SkillDetail } from "./SkillDetail";
import { ForgeEntry } from "../forge/ForgeEntry";
import { ForgeStudio, type ForgeStart } from "../forge/ForgeStudio";
import { NewDefinitionPanel } from "../ui/NewDefinitionPanel";

/**
 * 技能页：左边一列技能，右边看它（「展览」）。
 *
 * 一个技能 = 一个目录 + 一份 SKILL.md。详情默认看渲染后的正文，要改再切源码。
 *
 * 不做「启用/停用」开关：对话每轮都会现场扫技能库，库里有就对模型可见，
 * 多一个开关就会出现「界面说启用了但模型没拿到」这类说不清的状态。
 * 不想让模型自动选它时，在 frontmatter 里写 `disable-model-invocation: true`
 * （pi 的既有约定），比我们自造一套开关更可移植。
 */

type SkillSort = "name" | "files" | "updated";

const SORT_OPTIONS: { id: SkillSort; label: string }[] = [
  { id: "name", label: "名称" },
  { id: "files", label: "文件数" },
  { id: "updated", label: "最近改动" },
];

const SORTERS: Record<SkillSort, (a: SkillSummary, b: SkillSummary) => number> =
  {
    name: (a, b) => a.name.localeCompare(b.name),
    files: (a, b) => b.fileCount - a.fileCount || a.name.localeCompare(b.name),
    updated: (a, b) =>
      b.updatedAt - a.updatedAt || a.name.localeCompare(b.name),
  };

const TARGET_LABEL: Record<SkillTarget, string> = {
  pi: "pi（~/.pi/agent/skills）",
};

export function SkillsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const skills = useQuery({ queryKey: ["skills"], queryFn: listSkills });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** AI 工坊（新建 / 修改 / 沉淀）。null = 没开。 */
  const [forge, setForge] = useState<ForgeStart | null>(null);
  const [query, setQuery] = useState("");
  /** 默认按名称。27 个技能按字母排时，用得最多的那些会被压在后面，所以给排序。 */
  const [sort, setSort] = useState<SkillSort>("name");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["skills"] });
  };

  /** 单个文件：.md 直接当 SKILL.md，.zip 走解包。 */
  const importFile = async (file: File): Promise<void> => {
    setNotice(null);
    try {
      const skill = file.name.endsWith(".zip")
        ? await importSkillZip(
            bytesToBase64(new Uint8Array(await file.arrayBuffer())),
          )
        : await createSkill(await file.text());
      await refresh();
      setSelected(skill.name);
      setNotice({ ok: true, text: `已导入技能「${skill.name}」` });
    } catch (cause) {
      setNotice({
        ok: false,
        text: cause instanceof Error ? cause.message : "导入失败",
      });
    }
  };

  /** 文件夹：自己带 SKILL.md 就是一个技能，否则按子目录批量导入。 */
  const importFolder = async (files: FileList): Promise<void> => {
    setNotice(null);
    setProgress({ done: 0, total: 0 });
    try {
      const outcome = await importSkillFolders(
        fromInput(files),
        (done, total) => setProgress({ done, total }),
      );
      await refresh();
      const first = outcome.imported[0];
      if (first) setSelected(first.name);
      setNotice(describeImport(outcome));
    } finally {
      setProgress(null);
    }
  };

  // 依赖直接挂 skills.data：`?? []` 每次渲染都是新数组，会让 useMemo 形同虚设。
  const all = skills.data?.skills;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (all ?? []).filter(
      (s) =>
        q === "" ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
    return [...list].sort(SORTERS[sort]);
  }, [all, query, sort]);

  return (
    <div className="skills">
      <header className="skills-head">
        {/* 页面标题在顶栏，正文不再重复一遍。 */}
        <div>
          <p className="muted small">
            技能是给模型的专项说明。对话时模型只看到名字和描述，任务对得上才去加载正文——
            所以 description 要写清「做什么 +
            什么时候用」。改完下一轮对话即生效。
          </p>
          <PromptCost
            bytes={skills.data?.promptBytes ?? 0}
            visible={(all ?? []).filter((s) => !s.hidden).length}
            hidden={(all ?? []).filter((s) => s.hidden).length}
          />
        </div>
        <span className="row gap">
          <ForgeEntry
            kind="skill"
            onStart={(mode) => setForge({ mode })}
            onResume={(sessionId) => setForge({ sessionId })}
          />
          <button
            type="button"
            className="btn"
            onClick={() => {
              setNotice(null);
              setCreating(true);
              setSelected(null);
            }}
          >
            <Plus size={13} /> 新建
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={13} /> 导入文件
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => folderInput.current?.click()}
            title="选技能自己的目录（含 SKILL.md），或装着若干技能目录的那一层"
          >
            <FolderUp size={13} /> 导入文件夹
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".md,.zip"
            aria-label="导入技能文件"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importFile(file);
            }}
          />
          <input
            ref={(el) => {
              folderInput.current = el;
              // React 的类型里没有 webkitdirectory，用属性设置（各浏览器都支持）。
              el?.setAttribute("webkitdirectory", "");
            }}
            type="file"
            multiple
            aria-label="导入技能文件夹"
            hidden
            onChange={(e) => {
              const files = e.target.files;
              e.target.value = "";
              if (files && files.length > 0) void importFolder(files);
            }}
          />
        </span>
      </header>

      {progress !== null && (
        <p className="muted small">
          <Loader2 size={13} className="spin" /> 正在导入 {progress.done} /{" "}
          {progress.total} 个技能…
        </p>
      )}
      {notice !== null && (
        <p className={notice.ok ? "ok-text" : "err-text"}>{notice.text}</p>
      )}

      <div className="skills-browser">
        <aside className="skill-list">
          <div className="skill-search">
            <Search size={13} />
            <input
              type="search"
              aria-label="搜索技能"
              placeholder="搜索名称或描述"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="skill-sort">
            <span className="muted small">排序</span>
            {SORT_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`link-btn${sort === o.id ? " on" : ""}`}
                aria-pressed={sort === o.id}
                onClick={() => setSort(o.id)}
              >
                {o.label}
              </button>
            ))}
          </div>
          {skills.isPending && (
            <p className="muted small pad">
              <Loader2 size={13} className="spin" /> 读取中…
            </p>
          )}
          {skills.isError && (
            <p className="err-text small pad" role="alert">
              读不到技能：{skills.error.message}
            </p>
          )}
          {all?.length === 0 && !skills.isPending && !skills.isError && (
            <p className="muted small pad">
              还没有技能。新建一个，或导入带 SKILL.md 的文件 /
              文件夹；建好之后对话里就能用上它。
            </p>
          )}
          {(all?.length ?? 0) > 0 && filtered.length === 0 && (
            <p className="muted small pad">没有匹配「{query}」的技能。</p>
          )}
          {filtered.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
              active={skill.name === selected}
              onOpen={() => {
                setCreating(false);
                setSelected(skill.name);
              }}
            />
          ))}
        </aside>

        <section className="skill-pane">
          {creating ? (
            <NewSkill
              onDone={async (name) => {
                setCreating(false);
                await refresh();
                setSelected(name);
              }}
              onCancel={() => setCreating(false)}
            />
          ) : selected !== null ? (
            <SkillDetail
              key={selected}
              name={selected}
              onDeleted={() => {
                setSelected(null);
                void refresh();
              }}
              onRenamed={(next) => setSelected(next)}
              onAiEdit={() => setForge({ mode: "edit", name: selected })}
            />
          ) : (
            <div className="center">
              <div className="empty">
                <img
                  className="skill-empty-art"
                  src={ART.skills.src}
                  srcSet={ART.skills.srcSet}
                  alt=""
                  aria-hidden="true"
                  width={180}
                  height={180}
                />
                <h3>挑一个技能看看</h3>
                <p className="muted small">
                  左边点一个看它的说明与附属文件；要加新的就用上面的「新建 /
                  导入」。
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
      {forge !== null && (
        <ForgeStudio
          key={JSON.stringify(forge)}
          kind="skill"
          start={forge}
          onClose={() => setForge(null)}
          onSaved={(name) => {
            setForge(null);
            setCreating(false);
            setSelected(name);
            setNotice({ ok: true, text: `已保存技能「${name}」` });
            void refresh();
            void queryClient.invalidateQueries({
              queryKey: ["forge-drafts", "skill"],
            });
          }}
        />
      )}
    </div>
  );
}

/**
 * 这份清单每轮都会发给模型，成本看不见就只能靠猜（实测 27 个技能 21.6 KB，
 * 隐藏 12 个内容工具后 14.9 KB——事先猜的是 8 KB）。所以把它摆在页面上。
 */
function PromptCost({
  bytes,
  visible,
  hidden,
}: {
  bytes: number;
  visible: number;
  hidden: number;
}): React.JSX.Element | null {
  if (visible === 0 && hidden === 0) return null;
  return (
    <p className="muted small">
      <span title="模型每轮对话都会收到这份清单（名字 + 描述 + 位置）。用不到的技能点「对模型隐藏」就不再占用，仍可在对话里点名调用。">
        对模型可见 {visible} 个，每轮占提示词 {(bytes / 1024).toFixed(1)} KB
        {hidden > 0 && `；已隐藏 ${String(hidden)} 个`}
      </span>
    </p>
  );
}

function SkillRow({
  skill,
  active,
  onOpen,
}: {
  skill: SkillSummary;
  active: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const linked = SKILL_TARGETS.filter(
    (t) => skill.distribution[t] === "linked",
  );
  return (
    <button
      type="button"
      className={`skill-item${active ? " active" : ""}`}
      onClick={onOpen}
    >
      {/* 两行就够：名字与元信息同一行（右对齐），描述单独一行并截断。
          三行的话 27 个技能首屏只剩 10 行，翻页才看得完。 */}
      <span className="skill-item-top">
        <span className="skill-item-name">
          {skill.name}
          {skill.hidden && (
            <EyeOff
              size={11}
              className="skill-hidden-mark"
              aria-label="对模型隐藏"
            />
          )}
        </span>
        <span className="skill-item-meta">
          {skill.fileCount > 1 && (
            <span className="tag" title={`${String(skill.fileCount)} 个文件`}>
              {skill.fileCount}
            </span>
          )}
          {linked.map((t) => (
            <span
              key={t}
              className="skill-dot"
              title={`已分发到 ${TARGET_LABEL[t]}`}
            />
          ))}
        </span>
      </span>
      <span className="muted small ellipsis">
        {skill.description === ""
          ? "（没写 description，模型不会自动选它）"
          : skill.description}
      </span>
    </button>
  );
}

/** 新建：预填骨架，省得对着空白输入框猜格式。 */
function NewSkill({
  onDone,
  onCancel,
}: {
  onDone: (name: string) => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <NewDefinitionPanel
      title="新建技能"
      hint={(name) =>
        `保存后会叫「${name ?? "？（frontmatter 里还没写 name）"}」，并在技能库里建一个同名目录。`
      }
      template={NEW_SKILL_TEMPLATE}
      ariaLabel="SKILL.md 内容"
      onSave={(content) => createSkill(content)}
      onDone={onDone}
      onCancel={onCancel}
      footnote="带附属文件（references/ 等）的技能用「导入文件夹」更省事。"
    />
  );
}
