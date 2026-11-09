import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Globe,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";

import type { Product } from "./api";
import {
  browserStatus,
  createEnv,
  deleteEnv,
  installBrowser,
  listEnvs,
  testEnv,
  updateEnv,
  type EnvForm,
  type TestEnv,
} from "./envs-api";

/**
 * 产品的「测试环境」：登记后，这个产品的对话里 AI 就能用只读浏览器去看真实页面
 * 。
 *
 * 账号密码只写不读：保存后界面只显示「已保存」，编辑时留空 = 沿用原来的。
 */
export function EnvsDialog({
  product,
  onClose,
}: {
  product: Product;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const envs = useQuery({
    queryKey: ["envs", product.id],
    queryFn: () => listEnvs(product.id),
  });
  const [editing, setEditing] = useState<TestEnv | "new" | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<
    Record<string, { ok: boolean; text: string }>
  >({});

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && editing === null) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, editing]);

  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: ["envs", product.id] });

  const runTest = async (env: TestEnv): Promise<void> => {
    setTesting(env.id);
    try {
      const r = await testEnv(product.id, env.id);
      setResult((m) => ({
        ...m,
        [env.id]: r.ok
          ? {
              ok: true,
              text: `登录成功，进到了 ${r.landed}${r.title === "" ? "" : `（${r.title}）`}`,
            }
          : { ok: false, text: r.reason },
      }));
    } catch (e) {
      setResult((m) => ({
        ...m,
        [env.id]: {
          ok: false,
          text: e instanceof Error ? e.message : "试登录失败",
        },
      }));
    } finally {
      setTesting(null);
    }
  };

  if (editing !== null)
    return (
      <EnvEditor
        product={product}
        env={editing === "new" ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={async () => {
          await refresh();
          setEditing(null);
        }}
      />
    );

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="dialog" role="dialog" aria-modal="true">
        <header className="dialog-head">
          <h2>测试环境：{product.name}</h2>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <p className="field-hint">
          登记后，这个产品的对话里 AI
          可以自己打开测试环境的页面看（只读：会改数据的请求一律被拦下，也不能输入文字），
          写 PRD 时对照真实界面。只登记测试 / 预发环境，建议用低权限账号。
        </p>

        {envs.isPending ? (
          <p className="muted small">
            <Loader2 size={14} className="spin" /> 读取中…
          </p>
        ) : (envs.data ?? []).length === 0 ? (
          <p className="muted small">还没登记测试环境。</p>
        ) : (
          <ul className="envs-list" aria-label="测试环境">
            {(envs.data ?? []).map((env) => (
              <li key={env.id}>
                <div className="envs-row">
                  <Globe size={14} className="faint" />
                  <code>{env.baseUrl}</code>
                  {env.role !== "" && <span className="tag">{env.role}</span>}
                  {env.hasCredential ? (
                    <span className="tag">
                      <ShieldCheck size={11} /> 账号已保存
                    </span>
                  ) : (
                    <span className="tag warn">还没存账号</span>
                  )}
                  <span className="envs-actions">
                    <button
                      type="button"
                      className="btn small"
                      disabled={testing !== null || !env.hasCredential}
                      onClick={() => void runTest(env)}
                    >
                      {testing === env.id ? (
                        <Loader2 size={13} className="spin" />
                      ) : null}
                      试登录
                    </button>
                    <button
                      type="button"
                      className="icon-btn ghost"
                      aria-label={`编辑 ${env.baseUrl}`}
                      onClick={() => setEditing(env)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn ghost"
                      aria-label={`删除 ${env.baseUrl}`}
                      onClick={() => {
                        if (
                          !window.confirm(
                            `删除测试环境 ${env.baseUrl}？保存的账号密码一并删除。`,
                          )
                        )
                          return;
                        void deleteEnv(product.id, env.id).then(refresh);
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </span>
                </div>
                {result[env.id] !== undefined && (
                  <p
                    className={`small ${result[env.id]?.ok === true ? "envs-ok" : "err-text"}`}
                  >
                    {result[env.id]?.ok === true ? (
                      <CheckCircle2 size={12} />
                    ) : (
                      <TriangleAlert size={12} />
                    )}{" "}
                    {result[env.id]?.text}
                  </p>
                )}
                {env.frontendRoot !== null && (
                  <p className="muted small">对应前端：{env.frontendRoot}</p>
                )}
              </li>
            ))}
          </ul>
        )}

        <BrowserSection />

        <footer className="dialog-foot">
          <button
            type="button"
            className="btn primary"
            onClick={() => setEditing("new")}
          >
            <Plus size={14} /> 登记测试环境
          </button>
        </footer>
      </div>
    </div>
  );
}

function EnvEditor({
  product,
  env,
  onClose,
  onSaved,
}: {
  product: Product;
  env: TestEnv | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}): React.JSX.Element {
  const [form, setForm] = useState<EnvForm>({
    baseUrl: env?.baseUrl ?? "",
    loginPath: env?.loginPath ?? "/login",
    role: env?.role ?? "",
    frontendRoot: env?.frontendRoot ?? null,
    username: "",
    password: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof EnvForm, v: string): void => {
    setForm((f) => ({ ...f, [k]: v }));
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      // 账号密码都留空 = 编辑时沿用原来的；新建时必须填。
      const payload: EnvForm = { ...form };
      if (form.username === "" && form.password === "") {
        delete payload.username;
        delete payload.password;
        if (env === null) throw new Error("新登记的环境要填账号和密码");
      }
      if (env === null) await createEnv(product.id, payload);
      else await updateEnv(product.id, env.id, payload);
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <header className="dialog-head">
          <h2>{env === null ? "登记测试环境" : "编辑测试环境"}</h2>
          <button
            type="button"
            className="icon-btn ghost"
            aria-label="关闭"
            disabled={busy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <label className="field">
          环境地址
          <input
            className="input"
            value={form.baseUrl}
            placeholder="https://test-console.example.com"
            onChange={(e) => set("baseUrl", e.target.value)}
            required
          />
        </label>
        <label className="field">
          登录页路径
          <input
            className="input"
            value={form.loginPath}
            onChange={(e) => set("loginPath", e.target.value)}
          />
          <span className="field-hint">
            平台会在这页自动找账号框、密码框和登录按钮。有验证码 / 短信 /
            扫码的登录页目前做不了。
          </span>
        </label>
        <label className="field">
          这个账号的身份
          <input
            className="input"
            value={form.role}
            placeholder="如：普通租户 / 平台管理员"
            onChange={(e) => set("role", e.target.value)}
          />
          <span className="field-hint">
            AI 会知道它看到的是哪个角色的视角。
          </span>
        </label>
        <div className="grid">
          <label className="field">
            账号
            <input
              className="input"
              autoComplete="off"
              value={form.username ?? ""}
              placeholder={
                env?.hasCredential === true ? "已保存，留空不改" : ""
              }
              onChange={(e) => set("username", e.target.value)}
            />
          </label>
          <label className="field">
            密码
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              value={form.password ?? ""}
              placeholder={
                env?.hasCredential === true ? "已保存，留空不改" : ""
              }
              onChange={(e) => set("password", e.target.value)}
            />
          </label>
        </div>
        <p className="field-hint">
          账号密码只存在这台机器上（仅本服务可读），界面和接口都不会再显示，也不会交给
          AI。 AI
          看到的截图与页面文字会存进文件库「/界面截图」，可能包含测试数据。
        </p>
        {error !== null && (
          <p className="err-text" role="alert">
            {error}
          </p>
        )}
        <footer className="dialog-foot">
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={onClose}
          >
            取消
          </button>
          <button type="submit" className="btn primary" disabled={busy}>
            {busy && <Loader2 size={14} className="spin" />} 保存
          </button>
        </footer>
      </form>
    </div>
  );
}

/**
 * AI 的眼睛：浏览器内核。服务自己带一份，不依赖这台机器碰巧装了什么。
 * 装的时候能看着进度走——官方下载站常常很慢，不给进度会被当成卡死。
 */
function BrowserSection(): React.JSX.Element {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["browser-status"],
    queryFn: browserStatus,
  });
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const s = status.data;

  const install = (): void => {
    setBusy(true);
    setLog([]);
    void installBrowser((e) => {
      if (e.type === "log") setLog((l) => [...l.slice(-5), e.line]);
      else setLog((l) => [...l.slice(-5), ...e.log]);
    })
      .catch((err: unknown) => {
        setLog((l) => [...l, err instanceof Error ? err.message : "安装失败"]);
      })
      .finally(() => {
        setBusy(false);
        void queryClient.invalidateQueries({ queryKey: ["browser-status"] });
      });
  };

  return (
    <section className="envs-browser" aria-label="浏览器内核">
      <h3>
        <Globe size={13} className="faint" /> AI 的眼睛（浏览器内核）
      </h3>
      {status.isPending ? (
        <p className="muted small">读取中…</p>
      ) : s?.ok === true ? (
        <p className="small">
          <CheckCircle2 size={12} className="envs-ok" /> 已就绪
          {s.source === "bundled"
            ? `（服务自带，${String(s.sizeMb)} MB）`
            : s.source === "system-cache"
              ? "（借用这台机器上已有的 playwright 缓存，建议装一份到服务名下）"
              : "（手工指定）"}
        </p>
      ) : (
        <p className="small err-text">
          <TriangleAlert size={12} /> 还没有可用的浏览器内核：AI
          现在看不到任何页面。
        </p>
      )}
      {s?.reason !== null && s?.ok === true && (
        <p className="muted small">{s.reason}</p>
      )}
      <div className="envs-actions">
        <button
          type="button"
          className="btn small"
          disabled={busy}
          onClick={install}
        >
          {busy ? <Loader2 size={13} className="spin" /> : null}
          {s?.ok === true ? "重装内核" : "安装内核"}
        </button>
      </div>
      {log.length > 0 && <pre className="envs-log">{log.join("\n")}</pre>}
      <p className="field-hint">
        内核装在服务的数据目录里，约 380 MB。安装优先复制这台机器上已有的
        playwright
        缓存；没有可复制的才联网下载——官方下载站常常连不上，可以从别处拷一份，或用
        PMFORGE_BROWSER_HOST / PMFORGE_CHROMIUM 指定。
      </p>
    </section>
  );
}
