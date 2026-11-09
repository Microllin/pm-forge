import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { createRequest, json } from "../http";
import { Select } from "../ui/Select";

/**
 * 售前模板。
 *
 * 回答一个问题：**一个产品对外销售，应该有哪些材料、每类材料必须答到哪几点。**
 * 每一条材料带「检查要点」，后面 AI 核对时逐条对，结论能落到「有，但没写交付形态」，
 * 而不是笼统的「有 / 没有」。
 *
 * 与「生命周期规范」同一套做法：出厂模板只是种子，之后阶段、材料、要点全可改；
 * 改坏了一键恢复出厂。建库时选模板，库里的材料清单就从它铺出来。
 */
const api = createRequest("/api");

interface Item {
  id: string;
  stageId: string;
  name: string;
  required: boolean;
  audience: "external" | "internal";
  guide: string;
  checkpoints: string[];
  fileHints: string[];
}

interface Stage {
  id: string;
  code: string;
  label: string;
  question: string;
  items: Item[];
}

interface Template {
  id: string;
  name: string;
  description: string;
  builtinKey: "product" | "company" | null;
  stages: Stage[];
  libCount: number;
}

const KEY = ["presales-templates"] as const;

export function PresalesTemplatesPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: KEY,
    queryFn: () =>
      api<{ templates: Template[] }>("/presales-templates").then(
        (r) => r.templates,
      ),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const templates = list.data ?? [];
  const active =
    templates.find((t) => t.id === selected) ?? templates[0] ?? null;

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: KEY });
  };

  const act = (fn: () => Promise<unknown>): void => {
    setError(null);
    fn()
      .then(refresh)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : "操作失败");
      });
  };

  if (list.isPending) return <p className="muted small pad">加载中…</p>;

  return (
    <div className="presales-templates">
      <aside className="presales-rail">
        <div className="presales-rail-head">
          <h2>售前模板</h2>
          <button
            className="btn primary"
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus size={13} /> 新建
          </button>
        </div>
        <p className="muted presales-rail-note">
          建库时按模板铺材料清单。出厂模板可改，也能复制一份再改。
        </p>
        {creating && (
          <NewTemplateForm
            onDone={(t) => {
              setCreating(false);
              setSelected(t.id);
              refresh();
            }}
            onCancel={() => {
              setCreating(false);
            }}
            onError={setError}
          />
        )}
        <ul className="presales-lib-list">
          {templates.map((t) => {
            const items = t.stages.flatMap((s) => s.items);
            return (
              <li key={t.id}>
                <button
                  className={`presales-lib${t.id === active?.id ? " active" : ""}`}
                  onClick={() => {
                    setSelected(t.id);
                  }}
                >
                  <span className="presales-lib-name">
                    {t.name}
                    {t.builtinKey !== null && <em className="tag">出厂</em>}
                  </span>
                  <span className="presales-lib-meta">
                    {t.stages.length} 个阶段 · {items.length} 类材料 ·{" "}
                    {items.filter((i) => i.required).length} 必备
                    {t.libCount > 0 && ` · ${String(t.libCount)} 本库在用`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <main className="presales-main">
        {active === null ? (
          <p className="muted small pad">
            还没有模板，点「新建」或重启服务恢复出厂模板。
          </p>
        ) : (
          <TemplateDetail
            key={active.id}
            template={active}
            error={error}
            onAct={act}
          />
        )}
      </main>
    </div>
  );
}

function TemplateDetail({
  template,
  error,
  onAct,
}: {
  template: Template;
  error: string | null;
  onAct: (fn: () => Promise<unknown>) => void;
}): React.JSX.Element {
  const [addingStage, setAddingStage] = useState(false);

  return (
    <div className="presales-detail">
      <header className="presales-head">
        <div>
          <h2>
            {template.name}
            {template.builtinKey !== null && <em className="tag">出厂</em>}
          </h2>
          <p className="muted">{template.description}</p>
          <p className="muted small">
            {template.libCount > 0
              ? `${String(template.libCount)} 本售前库在用这个模板`
              : "还没有库在用这个模板"}
          </p>
        </div>
        <div className="presales-head-actions">
          <button
            className="btn"
            onClick={() => {
              onAct(() =>
                api(`/presales-templates/${template.id}/duplicate`, {
                  method: "POST",
                }),
              );
            }}
          >
            <Copy size={13} /> 复制
          </button>
          {template.builtinKey !== null && (
            <button
              className="btn"
              title="把阶段与材料换回出厂内容；库里的材料不受影响"
              onClick={() => {
                if (
                  !window.confirm(
                    "把这份模板恢复成出厂内容？你改过的阶段与材料会丢失。",
                  )
                ) {
                  return;
                }
                onAct(() =>
                  api(`/presales-templates/${template.id}/reset`, {
                    method: "POST",
                  }),
                );
              }}
            >
              <RotateCcw size={13} /> 恢复出厂
            </button>
          )}
          <button
            className="btn danger"
            onClick={() => {
              if (
                !window.confirm(
                  template.libCount > 0
                    ? `删除「${template.name}」？${String(template.libCount)} 本库会解绑（库里的材料不受影响）。`
                    : `删除「${template.name}」？`,
                )
              ) {
                return;
              }
              onAct(() =>
                api(`/presales-templates/${template.id}`, { method: "DELETE" }),
              );
            }}
          >
            <Trash2 size={13} /> 删除
          </button>
        </div>
      </header>

      {error !== null && (
        <p className="presales-error">
          <TriangleAlert size={13} /> {error}
        </p>
      )}

      <div className="presales-template-stages">
        {template.stages.map((stage, index) => (
          <StageBlock
            key={stage.id}
            stage={stage}
            first={index === 0}
            last={index === template.stages.length - 1}
            onAct={onAct}
          />
        ))}
      </div>

      <div className="presales-foot">
        {addingStage ? (
          <NewStageForm
            templateId={template.id}
            nextCode={`S${String(template.stages.length + 1)}`}
            onDone={() => {
              setAddingStage(false);
            }}
            onCancel={() => {
              setAddingStage(false);
            }}
          />
        ) : (
          <button
            className="btn"
            onClick={() => {
              setAddingStage(true);
            }}
          >
            <Plus size={13} /> 加一个阶段
          </button>
        )}
      </div>
    </div>
  );
}

function StageBlock({
  stage,
  first,
  last,
  onAct,
}: {
  stage: Stage;
  first: boolean;
  last: boolean;
  onAct: (fn: () => Promise<unknown>) => void;
}): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);

  return (
    <section className="presales-template-stage">
      <div className="presales-template-stage-head">
        <b>{stage.code}</b>
        <span>{stage.label}</span>
        <small className="muted">{stage.question}</small>
        <span className="presales-toolbar-spacer" />
        <button
          className="presales-icon-btn"
          aria-label="上移"
          disabled={first}
          onClick={() => {
            onAct(() =>
              api(`/presales-stages/${stage.id}/move`, {
                method: "POST",
                ...json({ delta: -1 }),
              }),
            );
          }}
        >
          <ArrowUp size={13} />
        </button>
        <button
          className="presales-icon-btn"
          aria-label="下移"
          disabled={last}
          onClick={() => {
            onAct(() =>
              api(`/presales-stages/${stage.id}/move`, {
                method: "POST",
                ...json({ delta: 1 }),
              }),
            );
          }}
        >
          <ArrowDown size={13} />
        </button>
        <button
          className="btn ghost"
          onClick={() => {
            setEditing((v) => !v);
          }}
        >
          改阶段
        </button>
        <button
          className="presales-icon-btn"
          aria-label="删除阶段"
          onClick={() => {
            if (
              !window.confirm(
                `删除阶段「${stage.label}」？它下面的 ${String(stage.items.length)} 类材料会一起删掉。`,
              )
            ) {
              return;
            }
            onAct(() =>
              api(`/presales-stages/${stage.id}`, { method: "DELETE" }),
            );
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {editing && (
        <StageForm
          initial={stage}
          onSubmit={(body) =>
            onAct(() =>
              api(`/presales-stages/${stage.id}`, {
                method: "PATCH",
                ...json(body),
              }),
            )
          }
          onDone={() => {
            setEditing(false);
          }}
        />
      )}

      <ul className="presales-template-items">
        {stage.items.map((item) => (
          <ItemRow key={item.id} item={item} onAct={onAct} />
        ))}
        {stage.items.length === 0 && (
          <li className="muted presales-empty">这个阶段还没有材料。</li>
        )}
      </ul>

      {adding ? (
        <ItemForm
          title="新增材料"
          onSubmit={(body) =>
            onAct(() =>
              api(`/presales-stages/${stage.id}/items`, {
                method: "POST",
                ...json(body),
              }),
            )
          }
          onDone={() => {
            setAdding(false);
          }}
          onCancel={() => {
            setAdding(false);
          }}
        />
      ) : (
        <button
          className="btn ghost"
          onClick={() => {
            setAdding(true);
          }}
        >
          <Plus size={12} /> 加材料
        </button>
      )}
    </section>
  );
}

function ItemRow({
  item,
  onAct,
}: {
  item: Item;
  onAct: (fn: () => Promise<unknown>) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  return (
    <li className="presales-template-item">
      <div className="presales-template-item-head">
        <button
          className="presales-file-link"
          onClick={() => {
            setOpen((v) => !v);
          }}
          aria-expanded={open}
        >
          <span>{item.name}</span>
        </button>
        {item.required ? (
          <span className="pill warn">必备</span>
        ) : (
          <span className="pill">可选</span>
        )}
        <em className={`tag${item.audience === "internal" ? " warn" : ""}`}>
          {item.audience === "internal" ? "对内" : "对外"}
        </em>
        <span className="presales-toolbar-spacer" />
        <button
          className="btn ghost"
          onClick={() => {
            setEditing((v) => !v);
          }}
        >
          改
        </button>
        <button
          className="presales-icon-btn"
          aria-label={`删除 ${item.name}`}
          onClick={() => {
            if (!window.confirm(`删除材料「${item.name}」？`)) return;
            onAct(() =>
              api(`/presales-items/${item.id}`, { method: "DELETE" }),
            );
          }}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {open && !editing && (
        <div className="presales-template-item-body">
          {item.guide !== "" && <p className="muted">{item.guide}</p>}
          {item.checkpoints.length > 0 && (
            <>
              <strong className="small">必须答到</strong>
              <ol className="presales-checkpoints">
                {item.checkpoints.map((c) => (
                  <li key={c}>
                    <Check size={11} /> {c}
                  </li>
                ))}
              </ol>
            </>
          )}
          {item.fileHints.length > 0 && (
            <p className="muted small">
              文件名线索：{item.fileHints.join("、")}
            </p>
          )}
        </div>
      )}

      {editing && (
        <ItemForm
          title="修改材料"
          initial={item}
          onSubmit={(body) =>
            onAct(() =>
              api(`/presales-items/${item.id}`, {
                method: "PATCH",
                ...json(body),
              }),
            )
          }
          onDone={() => {
            setEditing(false);
          }}
          onCancel={() => {
            setEditing(false);
          }}
          onError={() => undefined}
        />
      )}
    </li>
  );
}

const AUDIENCE_OPTIONS = [
  ["external", "对外"],
  ["internal", "对内"],
] as const;

function ItemForm({
  title,
  initial,
  onSubmit,
  onDone,
  onCancel,
  onError,
}: {
  title: string;
  initial?: Item | undefined;
  onSubmit: (body: unknown) => void;
  onDone: () => void;
  onCancel: () => void;
  onError?: (message: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState(initial?.name ?? "");
  const [required, setRequired] = useState(initial?.required ?? true);
  const [audience, setAudience] = useState<"external" | "internal">(
    initial?.audience ?? "external",
  );
  const [guide, setGuide] = useState(initial?.guide ?? "");
  const [checkpoints, setCheckpoints] = useState(
    (initial?.checkpoints ?? []).join("\n"),
  );
  const [hints, setHints] = useState((initial?.fileHints ?? []).join(" "));

  return (
    <div className="presales-form">
      <p className="muted small">{title}</p>
      <div className="field-row">
        <label className="field">
          材料名称
          <input
            value={name}
            placeholder="如：产品白皮书"
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </label>
        <label className="field">
          给谁看
          <Select
            value={audience}
            onChange={(v) => {
              setAudience(v === "internal" ? "internal" : "external");
            }}
            options={AUDIENCE_OPTIONS.map(([value, label]) => ({
              value: value,
              label: label,
            }))}
          />
        </label>
      </div>
      <label className="field">
        说明（这份材料干什么用的）
        <input
          value={guide}
          onChange={(e) => {
            setGuide(e.target.value);
          }}
        />
      </label>
      <label className="field">
        必须答到（一行一条，AI 核对时逐条对）
        <textarea
          rows={4}
          value={checkpoints}
          onChange={(e) => {
            setCheckpoints(e.target.value);
          }}
        />
      </label>
      <label className="field">
        文件名线索（空格分隔，AI 识别时用来缩小范围）
        <input
          value={hints}
          onChange={(e) => {
            setHints(e.target.value);
          }}
        />
      </label>
      <label className="presales-check">
        <input
          type="checkbox"
          checked={required}
          onChange={(e) => {
            setRequired(e.target.checked);
          }}
        />
        必备（缺了它这一单会卡在这个阶段）
      </label>
      <div className="presales-actions">
        <button
          className="btn primary"
          disabled={name.trim() === ""}
          onClick={() => {
            if (name.trim() === "") {
              onError?.("材料名称不能为空");
              return;
            }
            onSubmit({
              name: name.trim(),
              required,
              audience,
              guide: guide.trim(),
              checkpoints,
              fileHints: hints,
            });
            onDone();
          }}
        >
          保存
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

function StageForm({
  initial,
  onSubmit,
  onDone,
}: {
  initial: Stage;
  onSubmit: (body: unknown) => void;
  onDone: () => void;
}): React.JSX.Element {
  const [code, setCode] = useState(initial.code);
  const [label, setLabel] = useState(initial.label);
  const [question, setQuestion] = useState(initial.question);
  return (
    <div className="presales-form">
      <div className="field-row">
        <label className="field">
          代号
          <input
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
            }}
          />
        </label>
        <label className="field">
          阶段名称
          <input
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
            }}
          />
        </label>
      </div>
      <label className="field">
        这一阶段客户在问什么
        <input
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
          }}
        />
      </label>
      <div className="presales-actions">
        <button
          className="btn primary"
          disabled={code.trim() === "" || label.trim() === ""}
          onClick={() => {
            onSubmit({
              code: code.trim(),
              label: label.trim(),
              question: question.trim(),
            });
            onDone();
          }}
        >
          保存
        </button>
        <button className="btn" onClick={onDone}>
          取消
        </button>
      </div>
    </div>
  );
}

function NewStageForm({
  templateId,
  nextCode,
  onDone,
  onCancel,
}: {
  templateId: string;
  nextCode: string;
  onDone: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [code, setCode] = useState(nextCode);
  const [label, setLabel] = useState("");
  const [question, setQuestion] = useState("");
  return (
    <div className="presales-form">
      <div className="field-row">
        <label className="field">
          代号
          <input
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
            }}
          />
        </label>
        <label className="field">
          阶段名称
          <input
            value={label}
            placeholder="如：商务谈判"
            onChange={(e) => {
              setLabel(e.target.value);
            }}
          />
        </label>
      </div>
      <label className="field">
        这一阶段客户在问什么
        <input
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
          }}
        />
      </label>
      <div className="presales-actions">
        <button
          className="btn primary"
          disabled={code.trim() === "" || label.trim() === ""}
          onClick={() => {
            // 先发请求再关表单：失败了表单还在，人能看见报错并改。
            void api(`/presales-templates/${templateId}/stages`, {
              method: "POST",
              ...json({
                code: code.trim(),
                label: label.trim(),
                question: question.trim(),
              }),
            }).then(onDone);
          }}
        >
          添加
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

function NewTemplateForm({
  onDone,
  onCancel,
  onError,
}: {
  onDone: (t: Template) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  return (
    <div className="presales-form">
      <label className="field">
        模板名称
        <input
          value={name}
          placeholder="如：政企招投标专用"
          onChange={(e) => {
            setName(e.target.value);
          }}
        />
      </label>
      <label className="field">
        说明
        <input
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
          }}
        />
      </label>
      <div className="presales-actions">
        <button
          className="btn primary"
          disabled={name.trim() === ""}
          onClick={() => {
            void api<Template>("/presales-templates", {
              method: "POST",
              ...json({ name: name.trim(), description: description.trim() }),
            })
              .then(onDone)
              .catch((e: unknown) => {
                onError(e instanceof Error ? e.message : "新建失败");
              });
          }}
        >
          新建
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}
