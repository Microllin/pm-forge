import { homedir } from "node:os";
import { join } from "node:path";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";

import { findBrowser } from "./chromium.js";

/**
 * 只读浏览器：给对话里的 AI 看测试环境的真实页面。
 *
 * 这是平台「对话会话没有工具」那条安全边界的**唯一放开处**，所以「只读」由这里硬性保证，
 * 不靠 AI 自觉：
 * 1. 网络层：除登录那一次外，所有非 GET 请求一律拦掉——点到「删除」请求也发不出去；
 * 2. 点击层：拒绝文字像写操作的元素、提交按钮、表单里的按钮；不提供「输入文字」；
 * 3. 范围层：只放行登记的那个环境域名（和它的静态资源）；
 * 4. 凭据：账号密码只在 login() 里用一次，不进任何返回值；登录那一帧不截图。
 */

export interface EnvLogin {
  /** 测试环境首页地址，如 https://test.example.com */
  baseUrl: string;
  /** 登录页路径，默认 /login */
  loginPath?: string;
  username: string;
  password: string;
  /** 自动找不准时手填的选择器 */
  selectors?: { username?: string; password?: string; submit?: string };
}

export interface PageSnapshot {
  url: string;
  /** 相对环境地址的路径 */
  path: string;
  title: string;
  /** 给 AI 读的文字结构 */
  text: string;
  /** PNG */
  screenshot: Buffer;
  /** 这次被拦下的写请求（如实告诉 AI 与人） */
  blocked: string[];
}

/** 像写操作的按钮文字：点之前就拒绝。宁可多拒，不可误点。 */
export const WRITE_WORDS =
  /删除|移除|新建|新增|添加|创建|保存|提交|确认|确定|发送|充值|支付|购买|下单|退款|退出|登出|注销|重置|清空|禁用|启用|停用|撤销|审批|通过|驳回|导入|上传|生成|发布|同步|复制|分配|授权|解绑|绑定|修改密码|delete|remove|create|add|save|submit|confirm|send|pay|logout|sign out|reset|disable|enable|approve|reject|import|upload|publish|sync/i;

/** 允许点的元素：导航性的。 */
const NAV_ROLES = ["link", "tab", "menuitem", "treeitem"] as const;

const LOGIN_USER = [
  'input[autocomplete="username"]',
  'input[name*="user" i]',
  'input[name*="email" i]',
  'input[name*="account" i]',
  'input[type="email"]',
  'input[type="text"]',
];
const LOGIN_PASS = ['input[type="password"]'];
const LOGIN_SUBMIT = [
  'button[type="submit"]',
  'button:has-text("登录")',
  'button:has-text("登 录")',
  'button:has-text("Login")',
  'button:has-text("Sign in")',
  'input[type="submit"]',
];

/** 页面里像密钥的东西打码（与 analysis/scan.ts 的凭据口径一致）。 */
const SECRET_LIKE =
  /\b(sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;

export function maskSecrets(text: string): string {
  return text.replace(SECRET_LIKE, (m) => `${m.slice(0, 6)}…（已打码）`);
}

/**
 * 在页面里抽文字结构。纯 DOM 读取，不改页面。
 * 结构：标题、高亮菜单、面包屑、表格（列 + 前 5 行）、表单字段、按钮、空状态 / 提示文案、正文摘要。
 */
const EXTRACT = `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const t = (el) => (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
  const out = [];
  const h = [...document.querySelectorAll("h1,h2,[class*=page-title i],[class*=pageTitle]")].filter(vis).map(t).filter(Boolean);
  if (h.length) out.push("标题：" + [...new Set(h)].slice(0, 3).join(" / "));
  const active = [...document.querySelectorAll("nav [aria-current=page], aside [aria-current=page], .active, .is-active, .router-link-active, [class*=selected]")].filter((e) => vis(e) && e.closest("nav,aside,[class*=sidebar i],[class*=menu i]")).map(t).filter((x) => x && x.length < 30);
  if (active.length) out.push("当前菜单：" + [...new Set(active)].slice(0, 3).join(" > "));
  const crumbs = [...document.querySelectorAll("[aria-label*=breadcrumb i] li, [class*=breadcrumb i] a, [class*=breadcrumb i] span")].filter(vis).map(t).filter(Boolean);
  if (crumbs.length) out.push("面包屑：" + [...new Set(crumbs)].join(" / "));
  const menu = [...document.querySelectorAll("nav a, aside a, [role=menuitem]")].filter(vis).map(t).filter((x) => x && x.length < 20);
  if (menu.length) out.push("菜单：" + [...new Set(menu)].slice(0, 40).join("、"));
  const tabs = [...document.querySelectorAll("[role=tab]")].filter(vis).map(t).filter(Boolean);
  if (tabs.length) out.push("标签页：" + tabs.join("、"));
  [...document.querySelectorAll("table")].filter(vis).slice(0, 3).forEach((tb, i) => {
    const head = [...tb.querySelectorAll("thead th, thead td")].map(t).filter(Boolean);
    const rows = [...tb.querySelectorAll("tbody tr")].filter(vis);
    out.push("表格" + (i + 1) + "：列 = " + (head.join(" | ") || "（无表头）") + "；共 " + rows.length + " 行可见");
    rows.slice(0, 5).forEach((r) => out.push("  - " + cut([...r.querySelectorAll("td")].map(t).join(" | "), 200)));
  });
  const fields = [...document.querySelectorAll("label, [class*=form-item i] [class*=label i]")].filter(vis).map((l) => {
    const name = t(l); if (!name || name.length > 30) return null;
    const box = l.closest("[class*=form-item i], .field, label") || l.parentElement;
    const input = box && box.querySelector("input, select, textarea, [role=combobox], [role=switch]");
    const kind = !input ? "" : input.getAttribute("role") === "switch" || input.type === "checkbox" ? "开关" : input.tagName === "SELECT" || input.getAttribute("role") === "combobox" ? "下拉" : input.tagName === "TEXTAREA" ? "多行文本" : "输入框";
    const req = box && /\\*/.test(t(l)) || (input && input.required) ? "（必填）" : "";
    return name + (kind ? "[" + kind + "]" : "") + req;
  }).filter(Boolean);
  if (fields.length) out.push("表单字段：" + [...new Set(fields)].slice(0, 30).join("、"));
  const buttons = [...document.querySelectorAll("button, [role=button], a.btn, a[class*=button i]")].filter(vis).map(t).filter((x) => x && x.length < 20);
  if (buttons.length) out.push("按钮：" + [...new Set(buttons)].slice(0, 40).join("、"));
  const notes = [...document.querySelectorAll("[class*=empty i], [class*=alert i], [role=alert], [class*=tip i], [class*=hint i]")].filter(vis).map(t).filter((x) => x && x.length < 120);
  if (notes.length) out.push("提示 / 空状态：" + [...new Set(notes)].slice(0, 8).join(" ｜ "));
  const main = document.querySelector("main, [role=main], #app, #root, body");
  out.push("正文摘要：" + cut(t(main), 1500));
  return out.join("\\n");
})()`;

/**
 * 隐藏挡住页面主体的浮层：对话式引导、全屏遮罩、右上角通知。
 * 只改 display，不改数据、不点按钮。
 */
const DISMISS_OVERLAYS = `(() => {
  const hide = (el) => el.style.setProperty("display", "none", "important");
  // 只按类名 / 角色认，不按「大面积浮层」认：引导弹窗常只是一个居中的卡片，
  // 遮罩是它的兄弟节点，按面积一刀切会漏掉卡片、却把应用本身的容器藏掉。
  const sel = '[role="dialog"],[role="alertdialog"],[aria-modal="true"]';
  const cls = /onboarding|guide|tour|driver-|welcome|intro|resume|toast/i;
  for (const el of document.querySelectorAll("body *")) {
    const c = typeof el.className === "string" ? el.className : "";
    if (/(^|\\s)(fixed|absolute)(\\s|$)/.test(c) && (cls.test(c) || el.getAttribute("role") === "dialog")) hide(el);
  }
  for (const el of document.querySelectorAll(sel)) hide(el);
  // 剩下的全屏遮罩（半透明黑底、不含任何内容）单独按「铺满且几乎透明」认。
  for (const el of document.querySelectorAll("body > *, body > * > *")) {
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const bg = s.backgroundColor || "";
    const m = /rgba?\\(([^)]+)\\)/.exec(bg);
    const alpha = m ? Number((m[1] || "").split(",")[3] ?? 1) : 1;
    if (s.position === "fixed" && r.width * r.height >= innerWidth * innerHeight * 0.9 && alpha < 0.95 && !el.textContent.trim()) hide(el);
  }
})()`;

export interface ReadOnlyBrowser {
  open(path: string): Promise<PageSnapshot>;
  click(text: string): Promise<PageSnapshot>;
  scroll(): Promise<PageSnapshot>;
  close(): Promise<void>;
}

export interface BrowserDeps {
  launch?: () => Promise<Browser>;
  /** 每次动作后等页面稳定多久（毫秒） */
  settleMs?: number;
  /** 数据目录：里面 browsers/ 存着本服务自己装的内核。 */
  dataDir?: string;
}

/**
 * 启动浏览器。内核从 `chromium.ts` 的查找顺序里取：手工指定 → 服务自带 → 机器缓存。
 * 一个都找不到时抛错，讲清怎么装——不静默退化成「看不了页面」。
 */
export function defaultLaunch(dataDir?: string): () => Promise<Browser> {
  return () => {
    const info = findBrowser(dataDir ?? defaultDataDir());
    if (info.path === null)
      throw new Error(
        "没找到可用的浏览器内核：在「产品 → 测试环境」里点「安装浏览器」，或设置 PMFORGE_CHROMIUM",
      );
    return chromium.launch({
      executablePath: info.path,
      args: [
        "--no-sandbox",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
      ],
    });
  };
}

/** 兜底的数据目录：与 config.ts 的默认值一致（环境变量优先）。 */
function defaultDataDir(): string {
  return process.env.PMFORGE_CHAT_DATA_DIR ?? join(homedir(), ".pmforge-chat");
}

/** 打开一个已登录的只读浏览器。登录失败直接抛错（错误信息里不带账号密码）。 */
export async function openReadOnly(
  env: EnvLogin,
  deps: BrowserDeps = {},
): Promise<ReadOnlyBrowser> {
  const base = new URL(env.baseUrl);
  const settle = deps.settleMs ?? 800;
  const browser = await (deps.launch ?? defaultLaunch(deps.dataDir))();
  let ctx: BrowserContext | undefined;
  try {
    ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      locale: "zh-CN",
      ignoreHTTPSErrors: true,
    });
    let loggingIn = true;
    const blocked: string[] = [];
    await ctx.route("**/*", async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const sameSite =
        url.hostname === base.hostname ||
        url.hostname.endsWith(
          `.${base.hostname.split(".").slice(-2).join(".")}`,
        );
      // 范围层：页面导航只许留在这个环境里；静态资源（字体、CDN 脚本）照放。
      if (
        req.isNavigationRequest() &&
        req.frame() === req.frame().page().mainFrame() &&
        !sameSite
      ) {
        blocked.push(`跳出测试环境：${url.origin}`);
        return route.abort();
      }
      // 网络层：只读。登录期间放行（登录本身就是一次 POST）。
      if (
        req.method() !== "GET" &&
        req.method() !== "HEAD" &&
        req.method() !== "OPTIONS" &&
        !loggingIn
      ) {
        blocked.push(`${req.method()} ${url.pathname}`);
        return route.abort();
      }
      return route.continue();
    });
    const page = await ctx.newPage();

    // ── 登录 ──
    await page.goto(new URL(env.loginPath ?? "/login", base).toString(), {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await page.waitForTimeout(settle);
    const first = async (list: readonly string[], custom?: string) => {
      for (const sel of custom === undefined ? list : [custom]) {
        const loc = page.locator(sel).first();
        if ((await loc.count()) > 0 && (await loc.isVisible())) return loc;
      }
      return null;
    };
    const user = await first(LOGIN_USER, env.selectors?.username);
    const pass = await first(LOGIN_PASS, env.selectors?.password);
    if (user === null || pass === null)
      throw new Error(
        "登录页上没找到账号 / 密码输入框：请在登记里手填选择器，或确认登录页地址",
      );
    await user.fill(env.username);
    await pass.fill(env.password);
    const submit = await first(LOGIN_SUBMIT, env.selectors?.submit);
    if (submit === null) await pass.press("Enter");
    else await submit.click();
    await page
      .waitForURL((u) => !u.pathname.startsWith(env.loginPath ?? "/login"), {
        timeout: 15_000,
      })
      .catch(() => undefined);
    await page.waitForTimeout(settle);
    // 判断登没登上看「密码框还在不在」，不看网址：登录页地址填错时服务端会跳到真正的登录页，
    // 网址变了、人却没登进去（测试实测过）。
    const stillLogin = await page
      .locator('input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);
    if (stillLogin)
      throw new Error(
        "登录没成功（还停在登录页）：账号密码不对，或登录页有验证码 / 扫码",
      );
    loggingIn = false;
    blocked.length = 0;

    const snap = async (): Promise<PageSnapshot> => {
      await page
        .waitForLoadState("networkidle", { timeout: 8_000 })
        .catch(() => undefined);
      await page.waitForTimeout(settle);
      // 关掉挡住主体的浮层：新手引导、欢迎弹窗、通知条。只隐藏不点按钮——
      // 点「开始」「我知道了」会触发前端写接口，只读模式下发不出去，也没必要去碰。
      // 连做两遍：引导弹窗常常在接口回来后才挂上，第一遍时它还没出现（真实环境实测）。
      await page.evaluate(DISMISS_OVERLAYS).catch(() => undefined);
      await page.waitForTimeout(400);
      await page.evaluate(DISMISS_OVERLAYS).catch(() => undefined);
      const text = maskSecrets(String(await page.evaluate(EXTRACT)));
      const shot = await page.screenshot({ type: "jpeg", quality: 70 });
      const url = new URL(page.url());
      const out: PageSnapshot = {
        url: url.toString(),
        path: `${url.pathname}${url.search}${url.hash}`,
        title: await page.title(),
        text,
        screenshot: shot,
        blocked: [...blocked],
      };
      blocked.length = 0;
      return out;
    };

    const browserRef = browser;
    return {
      async open(path) {
        const target = new URL(path, base);
        if (target.hostname !== base.hostname)
          throw new Error("只能打开登记的测试环境里的页面");
        await page.goto(target.toString(), {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        return snap();
      },
      async click(text) {
        const wanted = text.trim();
        if (wanted === "") throw new Error("要点哪个？给出元素上的文字");
        if (WRITE_WORDS.test(wanted))
          throw new Error(`「${wanted}」像是会改数据的操作，只读模式下不点`);
        let target = null;
        for (const role of NAV_ROLES) {
          const loc = page.getByRole(role, { name: wanted }).first();
          if ((await loc.count()) > 0 && (await loc.isVisible())) {
            target = loc;
            break;
          }
        }
        // 「查看 / 详情」这类按钮也算导航：只认这几个字。
        if (
          target === null &&
          /^(查看|详情|查看详情|展开|更多|下一页|上一页|view|detail|details|more|next)$/i.test(
            wanted,
          )
        ) {
          const loc = page.getByRole("button", { name: wanted }).first();
          if ((await loc.count()) > 0) target = loc;
        }
        if (target === null)
          throw new Error(
            `页面上没找到可点的「${wanted}」（只认菜单、链接、标签页和查看类按钮）`,
          );
        const inForm = await target.evaluate(
          (el) =>
            el.closest("form") !== null ||
            (el as HTMLButtonElement).type === "submit",
        );
        if (inForm) throw new Error(`「${wanted}」在表单里，只读模式下不点`);
        const label = (await target.innerText().catch(() => wanted)).trim();
        if (WRITE_WORDS.test(label))
          throw new Error(`「${label}」像是会改数据的操作，只读模式下不点`);
        await target.click({ timeout: 10_000 });
        return snap();
      },
      async scroll() {
        await page.mouse.wheel(0, 800);
        return snap();
      },
      async close() {
        await ctx?.close().catch(() => undefined);
        await browserRef.close().catch(() => undefined);
      },
    };
  } catch (e) {
    await ctx?.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    throw e;
  }
}

export type { Page };
