import { useState } from "react";
import {
  Eye,
  EyeOff,
  FileText,
  Link2,
  Link2Off,
  Loader2,
  Lock,
  Pencil,
  Save,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteSkill,
  getSkill,
  getSkillFile,
  saveSkill,
  setSkillDistribution,
  setSkillHidden,
  type SkillDetail as SkillDetailData,
  type SkillTarget,
} from "../api";
import { MarkdownText } from "../chat/markdown";
import { draftName, stripFrontmatter } from "./skill-file";

/**
 * 技能详情（「展览」）。默认看**渲染后的** SKILL.md，而不是源码框：
 * 技能正文本来就是写给人和模型读的说明，源码形态只有在改它的时候才有意义。
 * 改的时候点「编辑」切到源码，保存后切回。
 */

const TARGETS: { id: SkillTarget; label: string; hint: string }[] = [
  { id: "pi", label: "pi", hint: "~/.pi/agent/skills" },
];

export function SkillDetail({
  name,
  onDeleted,
  onRenamed,
  onAiEdit,
}: {
  name: string;
  onDeleted: () => void;
  onRenamed: (next: string) => void;
  /** 打开 AI 工坊修改它（用大白话说要改什么，AI 改草稿、人确认后保存）。 */
  onAiEdit?: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const skill = useQuery({
    queryKey: ["skill", name],
    queryFn: () => getSkill(name),
  });
  const [editing, setEditing] = useState(false);

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["skill", name] }),
      queryClient.invalidateQueries({ queryKey: ["skills"] }),
    ]);
  };

  if (skill.isPending) {
    return (
      <div className="skill-detail muted">
        <Loader2 size={14} className="spin" /> 读取中…
      </div>
    );
  }
  if (skill.isError) {
    return (
      <div className="skill-detail err-text">
        <TriangleAlert size={14} /> {skill.error.message}
      </div>
    );
  }
  const data = skill.data;

  return (
    <div className="skill-detail">
      <header className="skill-detail-head">
        <div className="skill-detail-title">
          <h3>
            {data.name}
            {data.hidden && (
              <span
                className="tag"
                title="模型不会自动选它；仍可在对话里点名用"
              >
                <EyeOff size={11} /> 对模型隐藏
              </span>
            )}
          </h3>
          <Description text={data.description} />
          <p className="muted small">
            {data.hidden
              ? "已对模型隐藏：不占每轮提示词，仍可在对话里点名调用。"
              : `在每轮系统提示词里占 ${(data.promptBytes / 1024).toFixed(1)} KB`}
          </p>
        </div>
        <span className="row gap">
          <Visibility skill={data} onChanged={refresh} />
          {onAiEdit !== undefined && (
            <button
              type="button"
              className="btn"
              title="用大白话告诉 AI 要改什么，它改草稿、你看过改动前后再保存"
              onClick={onAiEdit}
            >
              <Sparkles size={13} /> AI 修改
            </button>
          )}
          <button
            type="button"
            className={`btn${editing ? " active" : ""}`}
            onClick={() => setEditing((v) => !v)}
          >
            <Pencil size={13} /> {editing ? "看渲染" : "编辑"}
          </button>
          <DeleteButton
            name={data.name}
            onDeleted={async () => {
              await refresh();
              onDeleted();
            }}
          />
        </span>
      </header>

      <Distribution skill={data} onChanged={refresh} />

      {data.files.length > 1 && (
        <FileList
          name={data.name}
          files={data.files.filter((f) => f !== "SKILL.md")}
        />
      )}

      {editing ? (
        <SkillSource
          name={data.name}
          content={data.content}
          onSaved={async (saved) => {
            setEditing(false);
            await refresh();
            if (saved !== data.name) onRenamed(saved);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <section className="skill-md">
          <MarkdownText
            text={stripFrontmatter(data.content)}
            streaming={false}
          />
        </section>
      )}
    </div>
  );
}

/** 分发区：两个 CLI 目录各一行，被占名时只报状态、不给必然失败的按钮。 */
function Distribution({
  skill,
  onChanged,
}: {
  skill: SkillDetailData;
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState<SkillTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (target: SkillTarget): void => {
    // 只有 pi 一个目标（2026-10-28 去掉 Claude）：切换即「全有 / 全无」。
    const next: SkillTarget[] =
      skill.distribution[target] === "linked" ? [] : [target];
    setBusy(target);
    setError(null);
    void setSkillDistribution(skill.name, [...next])
      .then(onChanged)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "操作失败");
      })
      .finally(() => setBusy(null));
  };

  return (
    <section className="skill-dist">
      <h4>分发到命令行</h4>
      {TARGETS.map((target) => {
        const state = skill.distribution[target.id];
        return (
          <div key={target.id} className="skill-dist-row">
            <span>
              {target.label}
              <span className="muted small"> {target.hint}</span>
            </span>
            {state === "blocked" ? (
              <span
                className="tag"
                title="那个目录里已有同名的别的东西，不会去覆盖它"
              >
                <Lock size={11} /> 同名被占用
              </span>
            ) : (
              <button
                type="button"
                className={state === "linked" ? "btn" : "btn primary"}
                disabled={busy === target.id}
                onClick={() => toggle(target.id)}
              >
                {state === "linked" ? (
                  <>
                    <Link2Off size={13} /> 撤销分发
                  </>
                ) : (
                  <>
                    <Link2 size={13} /> 分发
                  </>
                )}
              </button>
            )}
          </div>
        );
      })}
      {error !== null && <p className="err-text small">{error}</p>}
    </section>
  );
}

/** 附属文件：点开就地看内容（二进制只报大小）。 */
function FileList({
  name,
  files,
}: {
  name: string;
  files: string[];
}): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  /**
   * 默认收起。实测 baoyu-infographic 带 49 个附属文件，平铺会把 SKILL.md 正文
   * 整个挤出屏幕——而正文才是这一页的主角。
   */
  const [expanded, setExpanded] = useState(false);
  const file = useQuery({
    queryKey: ["skill-file", name, open],
    queryFn: () => getSkillFile(name, open ?? ""),
    enabled: open !== null,
  });

  return (
    <section className="skill-files">
      <h4>
        附属文件（{files.length}）
        <button
          type="button"
          className="link-btn"
          aria-expanded={expanded}
          aria-label={expanded ? "收起附属文件清单" : "展开附属文件清单"}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "收起" : "展开"}
        </button>
      </h4>
      <ul hidden={!expanded} className="skill-file-list">
        {files.map((f) => (
          <li key={f}>
            <button
              type="button"
              className={`skill-file${open === f ? " active" : ""}`}
              onClick={() => setOpen((cur) => (cur === f ? null : f))}
            >
              <FileText size={12} /> {f}
            </button>
          </li>
        ))}
      </ul>
      {open !== null && (
        <div className="skill-file-body">
          {file.isPending && (
            <p className="muted small">
              <Loader2 size={12} className="spin" /> 读取中…
            </p>
          )}
          {file.isError && (
            <p className="err-text small">{file.error.message}</p>
          )}
          {file.data &&
            (file.data.text === null ? (
              <p className="muted small">
                二进制文件或过大，不在这里展示（{file.data.bytes} 字节）
              </p>
            ) : (
              <pre className="pre">{file.data.text}</pre>
            ))}
        </div>
      )}
    </section>
  );
}

/** 源码编辑。校验在服务端，这里只把它的原话显示在保存旁边。 */
function SkillSource({
  name,
  content,
  onSaved,
  onCancel,
}: {
  name: string;
  content: string;
  onSaved: (savedName: string) => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState(content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nextName = draftName(draft);
  const renaming = nextName !== null && nextName !== name;

  return (
    <section className="skill-source">
      <textarea
        className="skill-editor"
        aria-label="SKILL.md 内容"
        spellCheck={false}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <footer className="skill-foot">
        <span className="row gap">
          <button
            type="button"
            className="btn primary"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              setError(null);
              void saveSkill(name, draft)
                .then((saved) => onSaved(saved.name))
                .catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : "保存失败");
                })
                .finally(() => setSaving(false));
            }}
          >
            {saving ? (
              <Loader2 size={13} className="spin" />
            ) : (
              <Save size={13} />
            )}{" "}
            保存
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            <X size={13} /> 取消
          </button>
        </span>
        {error !== null ? (
          <span className="err-text small">{error}</span>
        ) : renaming ? (
          <span className="muted small">
            name 改了：保存后技能会改叫「{nextName}」，目录与软链一起改名。
          </span>
        ) : (
          <span className="muted small">
            frontmatter 的 name 与 description
            缺一个，命令行与对话都会静默不加载。
          </span>
        )}
      </footer>
    </section>
  );
}

/**
 * 描述默认折两行。它是写给模型做路由判断的，动辄几百字（实测 baoyu 那批上千字），
 * 原样摊开会把首屏占满，而人要看的其实是下面的正文。
 */
function Description({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  if (text === "") {
    return (
      <p className="muted small">
        没写 description——模型不会自动选它。点「编辑」补一句「做什么 +
        什么时候用」。
      </p>
    );
  }
  return (
    <p className={`muted small skill-desc${open ? " open" : ""}`}>
      {text}{" "}
      <button
        type="button"
        className="link-btn"
        aria-label={open ? "收起描述" : "展开完整描述"}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "收起" : "展开"}
      </button>
    </p>
  );
}

/** 「对模型隐藏」：写 frontmatter 的 disable-model-invocation，不另存状态。 */
function Visibility({
  skill,
  onChanged,
}: {
  skill: SkillDetailData;
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      disabled={busy}
      title={
        skill.hidden
          ? "现在模型不会自动选它。点一下恢复：会去掉 frontmatter 的 disable-model-invocation"
          : "不让模型自动选它（仍可点名用）。会在 frontmatter 写 disable-model-invocation: true，提示词里也不再占位置"
      }
      onClick={() => {
        setBusy(true);
        void setSkillHidden(skill.name, !skill.hidden)
          .then(onChanged)
          .finally(() => setBusy(false));
      }}
    >
      {busy ? (
        <Loader2 size={13} className="spin" />
      ) : skill.hidden ? (
        <Eye size={13} />
      ) : (
        <EyeOff size={13} />
      )}{" "}
      {skill.hidden ? "恢复可见" : "对模型隐藏"}
    </button>
  );
}

/** 删除用内联确认条，不用 window.confirm（与文件模块一致，也便于测试）。 */
function DeleteButton({
  name,
  onDeleted,
}: {
  name: string;
  onDeleted: () => Promise<void>;
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!confirming) {
    return (
      <button type="button" className="btn" onClick={() => setConfirming(true)}>
        <Trash2 size={13} /> 删除
      </button>
    );
  }
  return (
    <span className="row gap skill-confirm">
      <span className="small">删除「{name}」？目录与软链都会删掉。</span>
      <button
        type="button"
        className="btn danger"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void deleteSkill(name)
            .then(onDeleted)
            .finally(() => setBusy(false));
        }}
      >
        删除
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => setConfirming(false)}
      >
        取消
      </button>
    </span>
  );
}
