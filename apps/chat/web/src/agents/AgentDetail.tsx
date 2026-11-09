import { useState } from "react";
import {
  Link2,
  Link2Off,
  Loader2,
  Lock,
  Pencil,
  Save,
  Sparkles,
  Trash2,
  TriangleAlert,
  Wrench,
  X,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteAgent,
  getAgent,
  saveAgent,
  setAgentDistribution,
  type AgentDetail as AgentDetailData,
} from "../api";
import { MarkdownText } from "../chat/markdown";
import { draftName, stripFrontmatter } from "../skills/skill-file";
import { canWrite } from "./agent-file";

/**
 * 执行体详情（「展览」）。默认看渲染后的定义正文，要改再点「编辑」切源码——
 * 与技能详情同一套节奏。
 *
 * 比技能多一块「能力与配置」：工具 / 模型 / 预加载 skill。这三样是**派它之前
 * 必须看清**的东西，放在正文下面等于没放。
 */

export function AgentDetail({
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
  const agent = useQuery({
    queryKey: ["agent", name],
    queryFn: () => getAgent(name),
  });
  const [editing, setEditing] = useState(false);

  const refresh = async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["agent", name] }),
      queryClient.invalidateQueries({ queryKey: ["agents"] }),
    ]);
  };

  if (agent.isPending) {
    return (
      <div className="skill-detail muted">
        <Loader2 size={14} className="spin" /> 读取中…
      </div>
    );
  }
  if (agent.isError) {
    return (
      <div className="skill-detail err-text">
        <TriangleAlert size={14} /> {agent.error.message}
      </div>
    );
  }
  const data = agent.data;

  return (
    <div className="skill-detail">
      <header className="skill-detail-head">
        <div className="skill-detail-title">
          <h3>{data.name}</h3>
          <p className="muted small">
            {data.description === ""
              ? "没写 description——调用方不会知道什么时候该派它。"
              : data.description}
          </p>
        </div>
        <span className="row gap">
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

      <Capabilities agent={data} />
      <Distribution agent={data} onChanged={refresh} />

      {editing ? (
        <AgentSource
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

/** 能力面：派它出去会发生什么，得先看清这三样。 */
function Capabilities({
  agent,
}: {
  agent: AgentDetailData;
}): React.JSX.Element {
  const writes = canWrite(agent.tools);
  return (
    <section className="agent-caps">
      <h4>能力与配置</h4>
      <div className="agent-cap-row">
        <span className="agent-cap-label">
          <Wrench size={12} /> 工具
        </span>
        <span className="agent-cap-value">
          {agent.tools.length > 0 ? (
            agent.tools.map((t) => (
              <span key={t} className="tag">
                {t}
              </span>
            ))
          ) : (
            <span className="muted small">
              继承全部工具——包括写文件与 Bash，等于没有权限边界
            </span>
          )}
          {writes && (
            <span
              className="tag warn"
              title="有写权限：派它之前先确认它的纪律里写了边界"
            >
              可写
            </span>
          )}
        </span>
      </div>
      <div className="agent-cap-row">
        <span className="agent-cap-label">模型</span>
        <span className="agent-cap-value">
          {agent.model !== undefined ? (
            <span className="tag">{agent.model}</span>
          ) : (
            <span className="muted small">跟随调用方</span>
          )}
        </span>
      </div>
      <div className="agent-cap-row">
        <span className="agent-cap-label">预加载技能</span>
        <span className="agent-cap-value">
          {agent.skills.length > 0 ? (
            agent.skills.map((s) => (
              <span
                key={s}
                className={`tag${agent.missingSkills.includes(s) ? " warn" : ""}`}
                title={
                  agent.missingSkills.includes(s)
                    ? "技能库里没有这个名字：它启动时加载不到，会退化成自由发挥"
                    : "启动时预加载的操作手册"
                }
              >
                {s}
                {agent.missingSkills.includes(s) && " ⚠"}
              </span>
            ))
          ) : (
            <span className="muted small">
              无——它按定义正文自由发挥，没有操作手册约束
            </span>
          )}
        </span>
      </div>
      {agent.missingSkills.length > 0 && (
        <p className="err-text small">
          <TriangleAlert size={12} /> 技能库里找不到：
          {agent.missingSkills.join("、")}。名字拼错或技能被删都会这样——
          它照样能启动，只是手册悄悄没了。
        </p>
      )}
    </section>
  );
}

/** 分发区：被占名时只报状态、不给一个必然失败的按钮。 */
function Distribution({
  agent,
  onChanged,
}: {
  agent: AgentDetailData;
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = agent.distribution.pi;

  return (
    <section className="skill-dist">
      <h4>分发到命令行</h4>
      <div className="skill-dist-row">
        <span>
          pi
          <span className="muted small">
            {" "}
            ~/.pi/agent/agents（终端 pi 装了子智能体扩展才会读）
          </span>
        </span>
        {state === "blocked" ? (
          <span
            className="tag"
            title="那个目录里已有同名的别的文件，不会去覆盖它"
          >
            <Lock size={11} /> 同名被占用
          </span>
        ) : (
          <button
            type="button"
            className={state === "linked" ? "btn" : "btn primary"}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              void setAgentDistribution(
                agent.name,
                state === "linked" ? [] : ["pi"],
              )
                .then(onChanged)
                .catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : "操作失败");
                })
                .finally(() => setBusy(false));
            }}
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
      {error !== null && <p className="err-text small">{error}</p>}
    </section>
  );
}

/** 源码编辑。校验在服务端，这里只把它的原话显示在保存旁边。 */
function AgentSource({
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
        aria-label="执行体定义内容"
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
              void saveAgent(name, draft)
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
            name 改了：保存后会改叫「{nextName}」，文件与软链一起改名。
          </span>
        ) : (
          <span className="muted small">
            frontmatter 的 name 与 description 缺一个，它就派不出去也分发不了。
          </span>
        )}
      </footer>
    </section>
  );
}

/** 删除用内联确认条，不用 window.confirm（与技能页一致，也便于测试）。 */
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
      <span className="small">删除「{name}」？定义与软链都会删掉。</span>
      <button
        type="button"
        className="btn danger"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void deleteAgent(name)
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
