import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Copy,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  createArtifact,
  createStage,
  createTemplate,
  deleteArtifact,
  deleteStage,
  deleteTemplate,
  duplicateTemplate,
  listTemplates,
  moveStage,
  resetTemplate,
  updateArtifact,
  updateStage,
  updateTemplate,
  type Artifact,
  type Stage,
  type Template,
} from "./api";
import { ArtifactDialog, StageDialog, TemplateDialog } from "./dialogs";
import "./lifecycle.css";

type Dialog =
  | { kind: "new-template" }
  | { kind: "edit-template"; template: Template }
  | { kind: "new-stage"; template: Template }
  | { kind: "edit-stage"; stage: Stage }
  | { kind: "new-artifact"; stage: Stage }
  | { kind: "edit-artifact"; artifact: Artifact };

/**
 * 产品 → 生命周期规范：模板库。
 *
 * 一个模板 = 一套「这类产品从 0 到 1 该走哪些阶段、每个阶段该交什么」。
 * 左边模板列表，右边选中模板的阶段与产出物。
 *
 * 与老版本（apps/core/src/lifecycle-schema.ts）的区别：那版的层级表写死在 TS 里、
 * 只有两个固定档位、唯一编辑入口是设置页改 JSON。这里层、产出物、判定要点全是数据。
 */
export function LifecyclePage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const templates = useQuery({
    queryKey: ["lifecycle-templates"],
    queryFn: listTemplates,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 展开了判定要点的产出物。默认收起：一屏要能看完整条生命线。 */
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());

  const all = templates.data ?? [];
  const selected = all.find((t) => t.id === selectedId) ?? all[0];

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ["lifecycle-templates"] });
  const close = (): void => setDialog(null);
  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "操作失败");
    }
    await refresh();
  };
  const toggle = (id: string): void =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const removeTemplate = (t: Template): void => {
    // 服务端也会拒（409），这里先拦住，免得先问「确定删除吗」再告诉你删不了。
    if (t.productCount > 0) {
      setNotice(
        `还有 ${String(t.productCount)} 个产品绑着「${t.name}」，先给它们换个模板或解绑`,
      );
      return;
    }
    if (window.confirm(`删除模板「${t.name}」？它的阶段与产出物会一并删除。`))
      void run(() => deleteTemplate(t.id));
  };
  const reset = (t: Template): void => {
    if (
      window.confirm(
        `把「${t.name}」的阶段与产出物整体换回出厂内容？你在这个模板里的改动会丢失。`,
      )
    )
      void run(() => resetTemplate(t.id));
  };

  const stageCount = (t: Template): number => t.stages.length;
  const artifactCount = (t: Template): number =>
    t.stages.reduce((n, s) => n + s.artifacts.length, 0);

  return (
    <div className="lifecycle-page">
      <aside className="lifecycle-side">
        <header className="sidebar-head">
          <h1>模板</h1>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="新建模板"
            title="新建模板"
            onClick={() => setDialog({ kind: "new-template" })}
          >
            <Plus size={16} />
          </button>
        </header>
        <nav className="template-list" aria-label="模板列表">
          {all.map((t) => (
            <button
              key={t.id}
              type="button"
              className={`template-item${t.id === selected?.id ? " active" : ""}`}
              aria-current={t.id === selected?.id ? "true" : undefined}
              onClick={() => {
                setSelectedId(t.id);
                setNotice(null);
              }}
            >
              <span className="template-name">{t.name}</span>
              {t.builtin && <span className="tag">出厂</span>}
              <span className="count">{stageCount(t)}</span>
            </button>
          ))}
        </nav>
      </aside>

      <section className="lifecycle-main" aria-label="模板详情">
        {notice && (
          <div className="notice" role="alert">
            <span>{notice}</span>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setNotice(null)}
            >
              知道了
            </button>
          </div>
        )}

        {templates.isPending && (
          <p className="muted small">
            <Loader2 size={14} className="spin" /> 读取中…
          </p>
        )}
        {templates.isError && (
          <p className="err-text">读取失败：{templates.error.message}</p>
        )}

        {templates.isSuccess && !selected && (
          <div className="products-empty">
            <ListChecks size={32} />
            <p>还没有模板</p>
            <p className="small">
              一个模板就是一套「这类产品该走哪些阶段、每阶段该交什么」。
            </p>
            <button
              type="button"
              className="btn primary"
              onClick={() => setDialog({ kind: "new-template" })}
            >
              <Plus size={14} /> 新建模板
            </button>
          </div>
        )}

        {selected && (
          <>
            <header className="line-head">
              <div>
                <h2>
                  {selected.name}
                  {selected.builtin && <span className="tag">出厂</span>}
                </h2>
                {selected.description ? (
                  <p className="desc">{selected.description}</p>
                ) : (
                  <p className="muted small">暂无适用说明</p>
                )}
                <p className="muted small">
                  {stageCount(selected)} 个阶段 · {artifactCount(selected)}{" "}
                  件产出物 ·{" "}
                  {selected.productCount > 0
                    ? `${String(selected.productCount)} 个产品在用`
                    : "暂无产品绑定"}
                </p>
              </div>
              <div className="head-actions">
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    setDialog({ kind: "edit-template", template: selected })
                  }
                >
                  <Pencil size={13} /> 编辑
                </button>
                <button
                  type="button"
                  className="btn"
                  title="连阶段带产出物复制一份，改坏了也不影响原模板"
                  onClick={() =>
                    void run(async () => {
                      const copy = await duplicateTemplate(selected.id);
                      await refresh();
                      setSelectedId(copy.id);
                    })
                  }
                >
                  <Copy size={13} /> 复制
                </button>
                {selected.builtin && (
                  <button
                    type="button"
                    className="btn"
                    title="把阶段与产出物整体换回出厂内容"
                    onClick={() => reset(selected)}
                  >
                    <RotateCcw size={13} /> 恢复出厂
                  </button>
                )}
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => removeTemplate(selected)}
                >
                  <Trash2 size={13} /> 删除
                </button>
              </div>
            </header>

            <section className="stages-section">
              <header className="section-head">
                <h3>阶段与产出物</h3>
                <button
                  type="button"
                  className="btn primary"
                  onClick={() =>
                    setDialog({ kind: "new-stage", template: selected })
                  }
                >
                  <Plus size={14} /> 新建阶段
                </button>
              </header>

              {selected.stages.length === 0 ? (
                <p className="muted empty-row">
                  还没有阶段。从第一个阶段开始，比如「L0.1 想法卡」。
                </p>
              ) : (
                <ol className="stage-list" aria-label="阶段列表">
                  {selected.stages.map((stage, i) => (
                    <li key={stage.id} className="stage">
                      <header className="stage-head">
                        <span className="stage-code">{stage.code}</span>
                        <div className="stage-title">
                          <strong>{stage.label}</strong>
                          {stage.question && (
                            <span className="muted small">
                              {stage.question}
                            </span>
                          )}
                        </div>
                        <div className="stage-actions">
                          <button
                            type="button"
                            className="icon-btn ghost"
                            aria-label={`上移阶段 ${stage.label}`}
                            title="上移"
                            disabled={i === 0}
                            onClick={() =>
                              void run(() => moveStage(stage.id, -1))
                            }
                          >
                            <ChevronUp size={14} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn ghost"
                            aria-label={`下移阶段 ${stage.label}`}
                            title="下移"
                            disabled={i === selected.stages.length - 1}
                            onClick={() =>
                              void run(() => moveStage(stage.id, 1))
                            }
                          >
                            <ChevronDown size={14} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn ghost"
                            aria-label={`编辑阶段 ${stage.label}`}
                            title="编辑阶段"
                            onClick={() =>
                              setDialog({ kind: "edit-stage", stage })
                            }
                          >
                            <Pencil size={14} />
                          </button>
                          <button
                            type="button"
                            className="icon-btn ghost"
                            aria-label={`删除阶段 ${stage.label}`}
                            title="删除阶段"
                            onClick={() => {
                              if (
                                window.confirm(
                                  `删除阶段「${stage.code} ${stage.label}」？它下面的 ${String(stage.artifacts.length)} 件产出物会一并删除。`,
                                )
                              )
                                void run(() => deleteStage(stage.id));
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </header>

                      <ul className="artifact-list">
                        {stage.artifacts.map((a) => {
                          const open = opened.has(a.id);
                          return (
                            <li
                              key={a.id}
                              className={`artifact${open ? " open" : ""}`}
                            >
                              <div className="artifact-row">
                                <button
                                  type="button"
                                  className="artifact-toggle"
                                  aria-expanded={open}
                                  onClick={() => toggle(a.id)}
                                >
                                  {open ? (
                                    <ChevronDown size={14} className="faint" />
                                  ) : (
                                    <ChevronRight size={14} className="faint" />
                                  )}
                                  <span className="artifact-name">
                                    {a.name}
                                  </span>
                                  <span
                                    className={`pill ${a.required ? "ok" : "mild"}`}
                                  >
                                    {a.required ? "必交" : "选填"}
                                  </span>
                                  <span className="muted small">
                                    {a.checkpoints.length} 条判定要点
                                  </span>
                                </button>
                                <div className="row gap">
                                  <button
                                    type="button"
                                    className="icon-btn ghost"
                                    aria-label={`编辑产出物 ${a.name}`}
                                    title="编辑产出物"
                                    onClick={() =>
                                      setDialog({
                                        kind: "edit-artifact",
                                        artifact: a,
                                      })
                                    }
                                  >
                                    <Pencil size={14} />
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-btn ghost"
                                    aria-label={`删除产出物 ${a.name}`}
                                    title="删除产出物"
                                    onClick={() => {
                                      if (
                                        window.confirm(
                                          `删除产出物「${a.name}」？`,
                                        )
                                      )
                                        void run(() => deleteArtifact(a.id));
                                    }}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                </div>
                              </div>

                              {open && (
                                <div className="artifact-detail">
                                  {a.guide && (
                                    <p className="artifact-guide">{a.guide}</p>
                                  )}
                                  {a.checkpoints.length > 0 ? (
                                    <>
                                      <h4>判定要点</h4>
                                      <ol className="checkpoints">
                                        {a.checkpoints.map((c, ci) => (
                                          <li key={`${a.id}-${String(ci)}`}>
                                            {c}
                                          </li>
                                        ))}
                                      </ol>
                                    </>
                                  ) : (
                                    <p className="muted small">
                                      还没有判定要点。没有它，AI
                                      比对时只能回答「有 / 没有」。
                                    </p>
                                  )}
                                  {a.fileHints.length > 0 && (
                                    <p className="file-hints">
                                      <span className="muted small">
                                        文件线索
                                      </span>
                                      {a.fileHints.map((h) => (
                                        <code key={`${a.id}-${h}`}>{h}</code>
                                      ))}
                                    </p>
                                  )}
                                </div>
                              )}
                            </li>
                          );
                        })}
                        <li className="artifact-add">
                          <button
                            type="button"
                            className="btn ghost"
                            onClick={() =>
                              setDialog({ kind: "new-artifact", stage })
                            }
                          >
                            <Plus size={14} /> 加产出物
                          </button>
                        </li>
                      </ul>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </section>

      {dialog?.kind === "new-template" && (
        <TemplateDialog
          title="新建模板"
          submitLabel="创建"
          onClose={close}
          onSubmit={async (fields) => {
            const created = await createTemplate(fields);
            await refresh();
            setSelectedId(created.id);
            close();
          }}
        />
      )}
      {dialog?.kind === "edit-template" && (
        <TemplateDialog
          title="编辑模板"
          submitLabel="保存"
          initial={dialog.template}
          onClose={close}
          onSubmit={async (fields) => {
            await updateTemplate(dialog.template.id, fields);
            await refresh();
            close();
          }}
        />
      )}
      {dialog?.kind === "new-stage" && (
        <StageDialog
          title={`在「${dialog.template.name}」下新建阶段`}
          submitLabel="创建"
          onClose={close}
          onSubmit={async (fields) => {
            await createStage(dialog.template.id, fields);
            await refresh();
            close();
          }}
        />
      )}
      {dialog?.kind === "edit-stage" && (
        <StageDialog
          title="编辑阶段"
          submitLabel="保存"
          initial={dialog.stage}
          onClose={close}
          onSubmit={async (fields) => {
            await updateStage(dialog.stage.id, fields);
            await refresh();
            close();
          }}
        />
      )}
      {dialog?.kind === "new-artifact" && (
        <ArtifactDialog
          title={`在「${dialog.stage.label}」下新建产出物`}
          submitLabel="创建"
          onClose={close}
          onSubmit={async (fields) => {
            await createArtifact(dialog.stage.id, fields);
            await refresh();
            close();
          }}
        />
      )}
      {dialog?.kind === "edit-artifact" && (
        <ArtifactDialog
          title="编辑产出物"
          submitLabel="保存"
          initial={{
            name: dialog.artifact.name,
            required: dialog.artifact.required,
            guide: dialog.artifact.guide,
            checkpoints: dialog.artifact.checkpoints.join("\n"),
            fileHints: dialog.artifact.fileHints.join("\n"),
          }}
          onClose={close}
          onSubmit={async (fields) => {
            await updateArtifact(dialog.artifact.id, fields);
            await refresh();
            close();
          }}
        />
      )}
    </div>
  );
}
