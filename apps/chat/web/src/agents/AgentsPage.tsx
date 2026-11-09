import { useMemo, useRef, useState } from "react";
import { Bot, Loader2, Plus, Search, Upload } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { createAgent, listAgents, type AgentSummary } from "../api";
import { AgentDetail } from "./AgentDetail";
import { ForgeEntry } from "../forge/ForgeEntry";
import { ForgeStudio, type ForgeStart } from "../forge/ForgeStudio";
import { NEW_AGENT_TEMPLATE, canWrite } from "./agent-file";
import { NewDefinitionPanel } from "../ui/NewDefinitionPanel";

/**
 * 执行体页：左边一列执行体，右边看它（「展览」）——与技能页同构，
 * 因为这两样东西在用户脑子里就是并排的：手册与照手册干活的人。
 *
 * 一个执行体 = 一个 `<name>.md`（不是目录），所以这里没有「导入文件夹 / zip」。
 *
 * 卡面上直接摆 tools / model / skills 三样，不藏进详情页：它们决定「派它出去
 * 会发生什么」——有没有写权限、用哪个模型、带着哪份操作手册。藏起来的话列表
 * 就只剩一堆名字，没法横向比较。
 */

export function AgentsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const agents = useQuery({ queryKey: ["agents"], queryFn: listAgents });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  /** AI 工坊（新建 / 修改 / 沉淀）。null = 没开。 */
  const [forge, setForge] = useState<ForgeStart | null>(null);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const fileInput = useRef<HTMLInputElement>(null);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ["agents"] });
  };

  const importFile = async (file: File): Promise<void> => {
    setNotice(null);
    try {
      const agent = await createAgent(await file.text());
      await refresh();
      setCreating(false);
      setSelected(agent.name);
      setNotice({ ok: true, text: `已导入执行体「${agent.name}」` });
    } catch (cause) {
      setNotice({
        ok: false,
        text: cause instanceof Error ? cause.message : "导入失败",
      });
    }
  };

  // 依赖直接挂 agents.data：`?? []` 每次渲染都是新数组，会让 useMemo 形同虚设。
  const all = agents.data;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (all ?? [])
      .filter(
        (a) =>
          q === "" ||
          a.name.toLowerCase().includes(q) ||
          a.description.toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [all, query]);

  return (
    <div className="skills">
      <header className="skills-head">
        <div>
          {/* 页面标题在顶栏，正文不再重复一遍。 */}
          <p className="muted small">
            技能是操作手册，执行体是照手册干活、且配好工具权限的人——两者是组合关系，
            不是升级关系。对话里的 AI 会按需把活派给这里的执行体（tools
            里至少要有一个平台工具才会进团队）；也可以软链分发到{" "}
            <code>~/.pi/agent/agents</code> 给终端里的 pi 用。
          </p>
        </div>
        <span className="row gap">
          <ForgeEntry
            kind="agent"
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
            <Upload size={13} /> 导入定义
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".md"
            aria-label="导入执行体定义"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void importFile(file);
            }}
          />
        </span>
      </header>

      {notice !== null && (
        <p className={notice.ok ? "ok-text" : "err-text"}>{notice.text}</p>
      )}

      <div className="skills-browser">
        <aside className="skill-list">
          <div className="skill-search">
            <Search size={13} />
            <input
              type="search"
              aria-label="搜索执行体"
              placeholder="搜索名称或描述"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          {agents.isPending && (
            <p className="muted small pad">
              <Loader2 size={13} className="spin" /> 读取中…
            </p>
          )}
          {agents.isError && (
            <p className="err-text small pad">{agents.error.message}</p>
          )}
          {all?.length === 0 && !agents.isPending && (
            <p className="muted small pad">
              还没有执行体。新建一个，或导入一份带 frontmatter（name /
              description / tools / model / skills）的 .md。
            </p>
          )}
          {(all?.length ?? 0) > 0 && filtered.length === 0 && (
            <p className="muted small pad">没有匹配「{query}」的执行体。</p>
          )}
          {filtered.map((agent) => (
            <AgentRow
              key={agent.name}
              agent={agent}
              active={agent.name === selected}
              onOpen={() => {
                setCreating(false);
                setSelected(agent.name);
              }}
            />
          ))}
        </aside>

        <section className="skill-pane">
          {creating ? (
            <NewAgent
              onDone={async (name) => {
                setCreating(false);
                await refresh();
                setSelected(name);
              }}
              onCancel={() => setCreating(false)}
            />
          ) : selected !== null ? (
            <AgentDetail
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
                <Bot size={22} className="faint-icon" />
                <h3>挑一个执行体看看</h3>
                <p className="muted small">
                  左边点一个看它的职责、工具权限与纪律；要加新的就用上面的「新建
                  / 导入」。
                </p>
              </div>
            </div>
          )}
        </section>
      </div>
      {forge !== null && (
        <ForgeStudio
          key={JSON.stringify(forge)}
          kind="agent"
          start={forge}
          onClose={() => setForge(null)}
          onSaved={(name) => {
            setForge(null);
            setCreating(false);
            setSelected(name);
            setNotice({ ok: true, text: `已保存执行体「${name}」` });
            void refresh();
            void queryClient.invalidateQueries({
              queryKey: ["forge-drafts", "agent"],
            });
          }}
        />
      )}
    </div>
  );
}

function AgentRow({
  agent,
  active,
  onOpen,
}: {
  agent: AgentSummary;
  active: boolean;
  onOpen: () => void;
}): React.JSX.Element {
  const writes = canWrite(agent.tools);
  return (
    <button
      type="button"
      className={`skill-item${active ? " active" : ""}`}
      onClick={onOpen}
    >
      <span className="skill-item-top">
        <span className="skill-item-name">{agent.name}</span>
        <span className="skill-item-meta">
          {writes && (
            <span
              className="tag warn"
              title={
                agent.tools.length === 0
                  ? "没写 tools = 继承全部工具，包括写与 Bash"
                  : "有写权限（写草稿，或终端里的写文件 / 执行命令）：派它之前先看清它的纪律"
              }
            >
              可写
            </span>
          )}
          {agent.model !== undefined && (
            <span className="tag">{agent.model}</span>
          )}
          {agent.distribution.pi === "linked" && (
            <span className="skill-dot" title="已分发到 ~/.pi/agent/agents" />
          )}
        </span>
      </span>
      <span className="muted small ellipsis">
        {agent.tools.length > 0 ? agent.tools.join(" · ") : "继承全部工具"}
        {agent.description === "" ? "" : ` — ${agent.description}`}
      </span>
    </button>
  );
}

/** 新建：预填骨架，省得对着空白输入框猜格式。 */
function NewAgent({
  onDone,
  onCancel,
}: {
  onDone: (name: string) => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <NewDefinitionPanel
      title="新建执行体"
      hint={(name) =>
        `保存后会叫「${name ?? "？（frontmatter 里还没写 name）"}」，在执行体库里建一个同名 .md。`
      }
      template={NEW_AGENT_TEMPLATE}
      ariaLabel="执行体定义内容"
      onSave={(content) => createAgent(content)}
      onDone={onDone}
      onCancel={onCancel}
      footnote="tools 留空等于继承全部工具（含写与 Bash）；要收紧就逐个列出来。"
    />
  );
}
