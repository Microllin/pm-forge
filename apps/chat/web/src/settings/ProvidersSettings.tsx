import { useState } from "react";
import {
  KeyRound,
  ListRestart,
  Loader2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  CUSTOM_APIS,
  THINKING_LEVELS,
  getModels,
  getProviders,
  probeModels,
  removeProvider,
  saveCustomProvider,
  saveDefaults,
  setProviderKey,
  type ConfiguredProvider,
  type CustomApi,
  type ThinkingLevel,
} from "../api";
import { Select } from "../ui/Select";

/**
 * 模型接入（照 pi CLI）：可以接入多个 provider，对话里能切换的模型就是它们的并集。
 *
 * - 自定义中转：名称 + 接口地址 + 协议 + key，用 key 从 {地址}/v1/models 拉取模型后勾选。
 * - pi 内置 provider：选一个、填 key 即可，模型清单与元数据 pi 都有。
 *
 * key 只写不读：界面只显示来源（已保存 / 环境变量），不回显内容。
 */
export function ProvidersSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const providers = useQuery({
    queryKey: ["providers"],
    queryFn: getProviders,
  });
  const [editing, setEditing] = useState<
    ConfiguredProvider | "new-custom" | "new-builtin" | null
  >(null);

  const refresh = async (): Promise<void> => {
    setEditing(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["providers"] }),
      queryClient.invalidateQueries({ queryKey: ["models"] }),
      queryClient.invalidateQueries({ queryKey: ["session-model"] }),
    ]);
  };

  const data = providers.data;
  return (
    <section className="card">
      <header className="card-head">
        <h3>模型接入</h3>
        <span className="row gap">
          <button
            type="button"
            className="btn"
            onClick={() => setEditing("new-custom")}
          >
            <Plus size={13} /> 自定义中转
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setEditing("new-builtin")}
          >
            <Plus size={13} /> 内置 provider
          </button>
        </span>
      </header>

      {!data && (
        <p className="muted small">
          <Loader2 size={13} className="spin" /> 读取中…
        </p>
      )}
      {data?.configured.length === 0 && editing === null && (
        <p className="muted small">
          还没有接入任何 provider。加一个，对话里就能选它的模型。
        </p>
      )}

      {data && data.configured.length > 0 && (
        <ul className="provider-list">
          {data.configured.map((p) => (
            <ProviderRow
              key={p.id}
              provider={p}
              onEdit={() => setEditing(p)}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}

      {editing === "new-custom" && (
        <CustomForm onDone={refresh} onCancel={() => setEditing(null)} />
      )}
      {editing !== null &&
        typeof editing === "object" &&
        editing.kind === "custom" && (
          <CustomForm
            initial={editing}
            onDone={refresh}
            onCancel={() => setEditing(null)}
          />
        )}
      {editing === "new-builtin" && data && (
        <BuiltinForm
          catalog={data.catalog.filter(
            (c) => !data.configured.some((p) => p.id === c.id),
          )}
          onDone={refresh}
          onCancel={() => setEditing(null)}
        />
      )}
    </section>
  );
}

function ProviderRow({
  provider,
  onEdit,
  onChanged,
}: {
  provider: ConfiguredProvider;
  onEdit: () => void;
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const [key, setKey] = useState("");
  const [changingKey, setChangingKey] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await action();
      setKey("");
      setChangingKey(false);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
    }
  };

  return (
    <li className="provider">
      <div className="provider-main">
        <strong>{provider.name}</strong>
        <span className="tag">
          {provider.kind === "custom" ? "中转" : "内置"}
        </span>
        <span className="muted small">
          {provider.models.length} 个模型 ·{" "}
          {provider.keySource === "env"
            ? "key 来自环境变量"
            : provider.keySource === "file"
              ? "key 已保存"
              : "缺少 key"}
        </span>
        {provider.kind === "custom" && (
          <span className="muted small ellipsis">{provider.baseUrl}</span>
        )}
      </div>
      <div className="row gap">
        {changingKey ? (
          <>
            <input
              className="input sm"
              type="password"
              autoComplete="off"
              aria-label={`${provider.name} 的新 key`}
              placeholder="新 key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              type="button"
              className="btn primary"
              disabled={key.trim() === ""}
              onClick={() =>
                void run(() => setProviderKey(provider.id, key.trim()))
              }
            >
              保存
            </button>
            <button
              type="button"
              className="btn ghost"
              onClick={() => setChangingKey(false)}
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="icon-btn ghost"
              aria-label="更换 key"
              title="更换 key"
              onClick={() => setChangingKey(true)}
            >
              <KeyRound size={13} />
            </button>
            {provider.kind === "custom" && (
              <button
                type="button"
                className="icon-btn ghost"
                aria-label="编辑"
                title="编辑"
                onClick={onEdit}
              >
                <Pencil size={13} />
              </button>
            )}
            <button
              type="button"
              className="icon-btn ghost"
              aria-label="移除"
              title="移除"
              onClick={() => {
                if (
                  window.confirm(
                    `移除「${provider.name}」？它的 key 也会删除。`,
                  )
                )
                  void run(() => removeProvider(provider.id));
              }}
            >
              <Trash2 size={13} />
            </button>
          </>
        )}
      </div>
      {error && <p className="err-text small">{error}</p>}
    </li>
  );
}

/** 新增 / 编辑自定义中转。模型清单用 key 从 {地址}/v1/models 拉取后勾选，也可手动添加。 */
function CustomForm({
  initial,
  onDone,
  onCancel,
}: {
  initial?: Extract<ConfiguredProvider, { kind: "custom" }>;
  onDone: () => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const [id, setId] = useState(initial?.id ?? "relay");
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [api, setApi] = useState<CustomApi>(
    initial?.api ?? "anthropic-messages",
  );
  const [key, setKey] = useState("");
  /** 候选模型（拉取到的 + 已有的 + 手动加的）与勾选状态。 */
  const [candidates, setCandidates] = useState<string[]>(initial?.models ?? []);
  const [selected, setSelected] = useState<Set<string>>(
    new Set(initial?.models ?? []),
  );
  const [manual, setManual] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const probe = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const ids = await probeModels({
        baseUrl,
        api,
        providerId: id,
        ...(key.trim() === "" ? {} : { key: key.trim() }),
      });
      setCandidates((prev) => [...new Set([...prev, ...ids])]);
      // 第一次拉取（还没勾任何模型）默认全选：中转的模型通常都要用。
      setSelected((prev) => (prev.size === 0 ? new Set(ids) : prev));
      setMessage({ ok: true, text: `拉取到 ${String(ids.length)} 个模型` });
    } catch (cause) {
      setMessage({
        ok: false,
        text: cause instanceof Error ? cause.message : "拉取失败",
      });
    } finally {
      setBusy(false);
    }
  };

  const toggle = (model: string): void =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(model)) next.delete(model);
      else next.add(model);
      return next;
    });

  const save = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      await saveCustomProvider(id.trim(), {
        baseUrl: baseUrl.trim(),
        api,
        models: candidates.filter((m) => selected.has(m)),
        ...(key.trim() === "" ? {} : { key: key.trim() }),
      });
      await onDone();
    } catch (cause) {
      setMessage({
        ok: false,
        text: cause instanceof Error ? cause.message : "保存失败",
      });
      setBusy(false);
    }
  };

  return (
    <div className="subform">
      <h4>{initial ? `编辑「${initial.id}」` : "添加自定义中转"}</h4>
      <div className="grid">
        <label>
          名称
          <input
            value={id}
            disabled={initial !== undefined}
            onChange={(e) => setId(e.target.value.toLowerCase())}
          />
        </label>
        <label>
          协议
          <Select
            value={api}
            onChange={(v) => setApi(v)}
            options={CUSTOM_APIS.map((a) => ({ value: a, label: a }))}
          />
        </label>
        <label>
          接口地址
          <input
            placeholder="https://example.com"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </label>
        <label>
          API key
          <input
            type="password"
            autoComplete="off"
            placeholder={
              initial && initial.keySource !== "none"
                ? "留空则不修改"
                : "粘贴 key"
            }
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
      </div>

      <div className="row gap">
        <button
          type="button"
          className="btn"
          disabled={busy || baseUrl.trim() === ""}
          onClick={() => void probe()}
        >
          {busy ? (
            <Loader2 size={13} className="spin" />
          ) : (
            <ListRestart size={13} />
          )}{" "}
          拉取模型
        </button>
        <span className="muted small">用 key 请求 {"{地址}"}/v1/models</span>
      </div>

      {candidates.length > 0 && (
        <div className="model-checks" role="group" aria-label="模型清单">
          {candidates.map((m) => (
            <label key={m} className="check">
              <input
                type="checkbox"
                checked={selected.has(m)}
                onChange={() => toggle(m)}
              />
              <span>{m}</span>
            </label>
          ))}
        </div>
      )}
      <div className="row gap">
        <input
          className="input sm"
          aria-label="手动添加模型"
          placeholder="手动添加模型 id"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && manual.trim() !== "") {
              e.preventDefault();
              const m = manual.trim();
              setCandidates((prev) => (prev.includes(m) ? prev : [...prev, m]));
              setSelected((prev) => new Set(prev).add(m));
              setManual("");
            }
          }}
        />
        <span className="muted small">回车添加</span>
      </div>

      <footer className="card-foot">
        {message && (
          <span className={message.ok ? "ok-text" : "err-text"}>
            {message.text}
          </span>
        )}
        <button type="button" className="btn ghost" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={
            busy ||
            id.trim() === "" ||
            baseUrl.trim() === "" ||
            selected.size === 0
          }
          onClick={() => void save()}
        >
          保存（{selected.size} 个模型）
        </button>
      </footer>
    </div>
  );
}

function BuiltinForm({
  catalog,
  onDone,
  onCancel,
}: {
  catalog: { id: string; name: string; modelCount: number }[];
  onDone: () => Promise<void>;
  onCancel: () => void;
}): React.JSX.Element {
  const [id, setId] = useState(catalog[0]?.id ?? "");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="subform">
      <h4>添加 pi 内置 provider</h4>
      <div className="grid">
        <label>
          Provider
          <Select
            value={id}
            onChange={(v) => setId(v)}
            options={catalog.map((p) => ({
              value: p.id,
              label: `${p.name}（${String(p.modelCount)} 个模型）`,
            }))}
          />
        </label>
        <label>
          API key
          <input
            type="password"
            autoComplete="off"
            placeholder="粘贴 key"
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
        </label>
      </div>
      <footer className="card-foot">
        {error && <span className="err-text">{error}</span>}
        <button type="button" className="btn ghost" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={busy || id === "" || key.trim() === ""}
          onClick={() => {
            setBusy(true);
            setProviderKey(id, key.trim())
              .then(onDone)
              .catch((cause: unknown) => {
                setError(cause instanceof Error ? cause.message : "保存失败");
                setBusy(false);
              });
          }}
        >
          保存
        </button>
      </footer>
    </div>
  );
}

/** 新会话的默认模型与思考强度。已有会话按各自切换过的模型，不受影响。 */
export function DefaultsSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const models = useQuery({ queryKey: ["models"], queryFn: getModels });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const data = models.data;
  if (!data) return <section className="card muted">读取中…</section>;

  const current = data.defaultModel
    ? `${data.defaultModel.provider}/${data.defaultModel.modelId}`
    : "";
  const save = async (
    model: string,
    thinking: ThinkingLevel,
  ): Promise<void> => {
    setMessage(null);
    const slash = model.indexOf("/");
    try {
      await saveDefaults({
        defaultModel:
          slash > 0
            ? {
                provider: model.slice(0, slash),
                modelId: model.slice(slash + 1),
              }
            : null,
        defaultThinking: thinking,
      });
      await queryClient.invalidateQueries({ queryKey: ["models"] });
      setMessage({ ok: true, text: "已保存" });
    } catch (cause) {
      setMessage({
        ok: false,
        text: cause instanceof Error ? cause.message : "保存失败",
      });
    }
  };

  return (
    <section className="card">
      <header className="card-head">
        <h3>新会话默认</h3>
        {message && (
          <span className={message.ok ? "ok-text" : "err-text"}>
            {message.text}
          </span>
        )}
      </header>
      {data.models.length === 0 ? (
        <p className="muted small">{data.problem ?? "先接入一个 provider"}</p>
      ) : (
        <div className="grid">
          <label>
            模型
            <Select
              aria-label="默认模型"
              value={current}
              onChange={(v) => void save(v, data.defaultThinking)}
              options={data.models.map((m) => ({
                value: `${m.provider}/${m.id}`,
                label: `${m.provider} / ${m.id}`,
              }))}
            />
          </label>
          <label>
            思考强度
            <Select
              aria-label="默认思考强度"
              value={data.defaultThinking}
              onChange={(v) => void save(current, v)}
              options={THINKING_LEVELS.map((t) => ({ value: t, label: t }))}
            />
          </label>
        </div>
      )}
      <p className="muted small">
        对话里可以随时切换：点输入框左下角的模型名、输入 /model，或按 Shift+Tab
        切思考强度。
      </p>
    </section>
  );
}
