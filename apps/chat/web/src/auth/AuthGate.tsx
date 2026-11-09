import { useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  Database,
  Hammer,
  Loader2,
  LockKeyhole,
  LogOut,
  PackageCheck,
  User,
} from "lucide-react";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { json, UNAUTHORIZED_EVENT } from "../http";
import {
  AUTH_KEY,
  authRequest,
  changePassword,
  getAuthStatus,
  logout,
  type AuthUser,
} from "./api";
import { BrandMark } from "../shell/BrandMark";
import { LOGIN_ART } from "../assets/art";
import "./auth.css";

/**
 * 登录闸的前端一半（服务端见 server/auth.ts）。
 *
 * 整个应用包在 AuthGate 里：没账户 → 首次设置；没登录 → 登录页；登录了才渲染应用。
 * 登录凭证是 HttpOnly Cookie，脚本拿不到也不用管，浏览器每次请求自己带。
 * 任何接口回 401（登录过期、在别处改了密码）都会广播 UNAUTHORIZED_EVENT，
 * 这里收到就重查状态，自然回到登录页。
 */

/** 当前登录的用户。只在 AuthGate 里面用。 */
function useAuthUser(): AuthUser | null {
  const status = useQuery({ queryKey: AUTH_KEY, queryFn: getAuthStatus });
  return status.data?.user ?? null;
}

/**
 * 换了身份（登录 / 退出）：别的数据缓存一律作废，再**主动重拉**登录状态。
 *
 * 不能用 queryClient.clear()：它连登录状态那条也删掉，而 AuthGate 正挂着的观察者
 * 不会因此重拉，页面就停在登录框上不动（实测：设置成功了却进不去）。
 */
async function switchIdentity(queryClient: QueryClient): Promise<void> {
  queryClient.removeQueries({
    predicate: (q) => q.queryKey[0] !== AUTH_KEY[0],
  });
  await queryClient.refetchQueries({ queryKey: AUTH_KEY });
}

export function AuthGate({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: AUTH_KEY,
    queryFn: getAuthStatus,
    retry: 2,
  });

  useEffect(() => {
    const onUnauthorized = (): void => {
      void queryClient.invalidateQueries({ queryKey: AUTH_KEY });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, [queryClient]);

  if (status.isPending)
    return (
      <div className="auth-page">
        <Loader2 size={18} className="spin" />
      </div>
    );
  if (status.isError)
    return (
      <div className="auth-page">
        <div className="auth-card">
          <h1>连不上服务</h1>
          <p className="err-text">{status.error.message}</p>
          <button
            type="button"
            className="btn primary"
            onClick={() => void status.refetch()}
          >
            重试
          </button>
        </div>
      </div>
    );
  if (status.data.user !== null) return <>{children}</>;
  return (
    <AuthForm
      mode={status.data.setupRequired ? "setup" : "login"}
      onDone={async () => {
        await switchIdentity(queryClient);
      }}
    />
  );
}

function AuthForm({
  mode,
  onDone,
}: {
  mode: "setup" | "login";
  onDone: () => Promise<void>;
}): React.JSX.Element {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  /** idle → busy（进度条）→ done（对勾 + 圆形转场）→ 进入应用 */
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");
  const [wipe, setWipe] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const setup = mode === "setup";

  const submit = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (setup && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setPhase("busy");
    setError(null);
    try {
      await authRequest(setup ? "/setup" : "/login", {
        method: "POST",
        ...json({ username, password }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作失败");
      setPhase("idle");
      return;
    }
    // 成功：按钮变对勾，再从按钮处铺开一个圆盖住整屏，然后才切进应用。
    // 不喜欢动画的人（系统里开了「减少动态效果」）直接进。
    if (!prefersReducedMotion()) {
      setPhase("done");
      const r = buttonRef.current?.getBoundingClientRect();
      await wait(320);
      if (r) setWipe({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
      await wait(560);
    }
    await onDone();
  };

  return (
    <div className="auth-split">
      <Showcase />
      <main className="auth-side">
        <form
          className="auth-card auth-card-flat"
          onSubmit={(e) => void submit(e)}
        >
          {/* 窄屏收起左侧展示区后，品牌只剩这一处。 */}
          <div className="auth-brand auth-brand-compact">
            <span className="auth-logo" aria-hidden="true">
              <BrandMark size={16} />
            </span>
            <span>PM-Forge</span>
          </div>
          <div className="auth-heading">
            <h1>{setup ? "设置账户" : "登录"}</h1>
            <p className="field-hint">
              {setup ? "第一次使用，设置之后这页不会再出现" : "本地工作台"}
            </p>
          </div>
          <label className="auth-input">
            <User size={16} aria-hidden="true" />
            <input
              autoFocus
              autoComplete="username"
              placeholder="用户名"
              aria-label="用户名"
              value={username}
              maxLength={40}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
          <label className="auth-input">
            <LockKeyhole size={16} aria-hidden="true" />
            <input
              type="password"
              autoComplete={setup ? "new-password" : "current-password"}
              placeholder={setup ? "密码（至少 8 位）" : "密码"}
              aria-label="密码"
              value={password}
              maxLength={128}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          {setup && (
            <label className="auth-input">
              <LockKeyhole size={16} aria-hidden="true" />
              <input
                type="password"
                autoComplete="new-password"
                placeholder="再输一次密码"
                aria-label="再输一次密码"
                value={confirm}
                maxLength={128}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
          )}
          {error !== null && (
            <p className="err-text auth-error" role="alert">
              {error}
            </p>
          )}
          <button
            ref={buttonRef}
            type="submit"
            className={`auth-submit ${phase}`}
            disabled={
              phase !== "idle" || username.trim() === "" || password === ""
            }
          >
            {phase === "done" ? (
              <Check size={20} className="auth-submit-ok" />
            ) : (
              <>
                <span>{setup ? "设置并进入" : "进入工作台"}</span>
                <ArrowRight size={16} />
              </>
            )}
            <span className="auth-submit-bar" aria-hidden="true" />
          </button>
          <p className="auth-foot">
            <LockKeyhole size={12} /> 账户与数据只存在这台机器上
          </p>
        </form>
      </main>
      {wipe !== null && (
        <div
          className="auth-wipe"
          aria-hidden="true"
          style={{ left: wipe.x, top: wipe.y }}
        />
      )}
    </div>
  );
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * 登录页左侧：一张会动的「锻造」网络——外圈是原料（文件、代码、页面、对话），
 * 光点沿连线流向中间的炉心，再从炉心送往三道工序。
 * 只讲平台真有的东西，不放演示数字（登录前拿不到真实数据，假的会被当真）。
 */
const STAGES = [
  {
    icon: <Database size={15} />,
    label: "投料",
    hint: "文件 · 代码 · 页面 · 对话",
  },
  { icon: <Hammer size={15} />, label: "锻造", hint: "技能 · 执行体" },
  { icon: <PackageCheck size={15} />, label: "出炉", hint: "你确认后入库" },
];

function Showcase(): React.JSX.Element {
  return (
    <aside className="auth-showcase" aria-label="PM-Forge 介绍">
      {/* 底图是生成的「锻造台」线稿；上面的画布动画叠在它上面，图负责质感，动画负责活。 */}
      <img className="auth-art" src={LOGIN_ART} alt="" aria-hidden="true" />
      <ForgeCanvas />
      <div className="auth-brand">
        <span className="auth-logo" aria-hidden="true">
          <BrandMark size={16} />
        </span>
        <span>PM-Forge</span>
      </div>

      <ul className="auth-stages" aria-label="工作方式">
        {STAGES.map((s, i) => (
          <li key={s.label} className={`auth-stage s${String(i + 1)}`}>
            <span className="auth-stage-icon" aria-hidden="true">
              {s.icon}
            </span>
            <span>
              <strong>{s.label}</strong>
              <small>{s.hint}</small>
            </span>
          </li>
        ))}
      </ul>

      <div className="auth-hero">
        <h2>
          把零散的需求，
          <br />
          锻造成<em>可交付的方案</em>。
        </h2>
      </div>
    </aside>
  );
}

/** 画布动画。颜色每帧从主题变量取，切主题不用重建；减少动态效果时只画一帧。 */
function ForgeCanvas(): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const still = prefersReducedMotion();
    interface P {
      x: number;
      y: number;
    }
    let nodes: P[] = [];
    let edges: [number, number][] = [];
    let parts: { e: number; t: number; v: number }[] = [];
    let w = 0;
    let h = 0;
    let raf = 0;
    const layout = (): void => {
      const r = cv.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = r.width;
      h = r.height;
      cv.width = w * dpr;
      cv.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cx = w * 0.56;
      const cy = h * 0.42;
      const base = Math.min(w, h);
      nodes = [{ x: cx, y: cy }];
      const ring = (n: number, rad: number, off: number): void => {
        for (let i = 0; i < n; i++) {
          const a = off + (i / n) * Math.PI * 2;
          nodes.push({
            x: cx + Math.cos(a) * rad * 1.3,
            y: cy + Math.sin(a) * rad * 0.82,
          });
        }
      };
      ring(7, base * 0.22, 0.3);
      ring(12, base * 0.42, 0.05);
      edges = [];
      for (let i = 1; i < nodes.length; i++) {
        if (i <= 7) {
          edges.push([i, 0]);
          continue;
        }
        let best = 1;
        let bd = Infinity;
        for (let j = 1; j <= 7; j++) {
          const a = nodes[i];
          const b = nodes[j];
          if (!a || !b) continue;
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d < bd) {
            bd = d;
            best = j;
          }
        }
        edges.push([i, best]);
      }
      parts = Array.from({ length: 28 }, () => ({
        e: Math.floor(Math.random() * edges.length),
        t: Math.random(),
        v: 0.004 + Math.random() * 0.006,
      }));
    };
    const token = (name: string): string =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const frame = (time: number): void => {
      ctx.clearRect(0, 0, w, h);
      const line = token("--line-strong");
      const accent = token("--accent");
      const dim = token("--faint");
      ctx.lineWidth = 1;
      ctx.strokeStyle = line;
      for (const [a, b] of edges) {
        const A = nodes[a];
        const B = nodes[b];
        if (!A || !B) continue;
        ctx.beginPath();
        ctx.moveTo(A.x, A.y);
        ctx.lineTo(B.x, B.y);
        ctx.stroke();
      }
      ctx.fillStyle = accent;
      for (const p of parts) {
        if (!still) p.t += p.v;
        if (p.t >= 1) {
          p.t = 0;
          p.e = Math.floor(Math.random() * edges.length);
        }
        const edge = edges[p.e];
        const A = edge ? nodes[edge[0]] : undefined;
        const B = edge ? nodes[edge[1]] : undefined;
        if (!A || !B) continue;
        ctx.globalAlpha = Math.sin(p.t * Math.PI) * 0.9;
        ctx.beginPath();
        ctx.arc(A.x + (B.x - A.x) * p.t, A.y + (B.y - A.y) * p.t, 1.8, 0, 7);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      nodes.forEach((n, i) => {
        if (i === 0) {
          const pulse = (Math.sin(time / 600) + 1) / 2;
          ctx.strokeStyle = accent;
          ctx.globalAlpha = 0.25 + pulse * 0.3;
          ctx.beginPath();
          ctx.arc(n.x, n.y, 16 + pulse * 6, 0, 7);
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.fillStyle = accent;
          ctx.beginPath();
          ctx.arc(n.x, n.y, 7, 0, 7);
          ctx.fill();
        } else {
          ctx.fillStyle = dim;
          ctx.beginPath();
          ctx.arc(n.x, n.y, 2.6, 0, 7);
          ctx.fill();
        }
      });
      if (!still) raf = requestAnimationFrame(frame);
    };
    layout();
    raf = requestAnimationFrame(frame);
    const onResize = (): void => layout();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, []);
  return <canvas ref={ref} className="auth-canvas" aria-hidden="true" />;
}

/** 设置页里的「账户」卡片：当前是谁、改密码、退出登录。 */
export function AccountSettings(): React.JSX.Element {
  const queryClient = useQueryClient();
  const user = useAuthUser();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const submit = async (e: React.SyntheticEvent): Promise<void> => {
    e.preventDefault();
    if (next !== confirm) {
      setMessage({ ok: false, text: "两次输入的新密码不一致" });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await changePassword(current, next);
      setCurrent("");
      setNext("");
      setConfirm("");
      setMessage({ ok: true, text: "密码已修改，其他设备上的登录已全部退出" });
    } catch (cause) {
      setMessage({
        ok: false,
        text: cause instanceof Error ? cause.message : "修改失败",
      });
    } finally {
      setBusy(false);
    }
  };

  const signOut = async (): Promise<void> => {
    await logout().catch(() => undefined);
    await switchIdentity(queryClient);
  };

  return (
    <section className="card">
      <header className="card-head">
        <h3>账户</h3>
        <button
          type="button"
          className="btn ghost"
          onClick={() => void signOut()}
        >
          <LogOut size={14} /> 退出登录
        </button>
      </header>
      <p className="field-hint">
        当前登录：<strong>{user?.username ?? "—"}</strong>
        。登录在这台浏览器上保持 30 天。
      </p>
      <form className="account-form" onSubmit={(e) => void submit(e)}>
        <label className="field">
          当前密码
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </label>
        <label className="field">
          新密码（至少 8 位）
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            maxLength={128}
            onChange={(e) => setNext(e.target.value)}
          />
        </label>
        <label className="field">
          再输一次新密码
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            maxLength={128}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <div>
          <button
            type="submit"
            className="btn primary"
            disabled={busy || current === "" || next === ""}
          >
            {busy && <Loader2 size={13} className="spin" />}
            修改密码
          </button>
        </div>
        {message !== null && (
          <p
            className={message.ok ? "field-hint" : "err-text"}
            role={message.ok ? "status" : "alert"}
          >
            {message.text}
          </p>
        )}
      </form>
    </section>
  );
}
