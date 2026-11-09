import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";

import type { FileStore } from "../../files/store.js";
import type { UiIndex } from "../ui/index.js";
import type { Catalog } from "../../products.js";
import type { SessionRow } from "../../sessions.js";
import {
  openReadOnly,
  type BrowserDeps,
  type PageSnapshot,
  type ReadOnlyBrowser,
} from "./browser.js";
import type { EnvStore, TestEnv } from "./envs.js";

/**
 * 给「产品对话」里的 AI 一组只读浏览工具。
 *
 * 只在会话带了 productId、且这个产品登记了带账号的测试环境时出现。
 * 浏览器按会话懒启动：第一次调用时登录，10 分钟没人用就关；每轮最多 MAX_PER_TURN 次页面动作。
 * 每次看到的页面（截图 + 文字结构）都落到文件库，可复查「PRD 照着哪几页写的」。
 */

const IDLE_MS = 10 * 60 * 1000;
export const MAX_ACTIONS = 20;
export const SHOT_ROOT = "/界面截图";

export const BROWSE_PROMPT = (envs: readonly TestEnv[]): string =>
  [
    "",
    "## 你可以看这个产品的真实页面（只读）",
    "这个产品登记了测试环境，你有一组只读浏览工具：",
    "- `page_list`：先看有哪些页面（来自代码里的路由）；",
    "- `page_open`：打开某页，拿到截图和页面上的文字结构（标题、菜单、表格列和前几行、表单字段、按钮、提示文案）；",
    "- `page_click`：点菜单、链接、标签页或「查看 / 详情」进到下一层；",
    "- `page_scroll`：往下翻一屏。",
    "要点：",
    "1. 写 PRD、描述现状前，先用这些工具看真实页面；结论里写清「依据：<环境> <页面路径>，身份 <xxx>」。",
    "2. 这是只读模式：会改数据的按钮平台会拦下，不用尝试；也不能输入文字。",
    "3. 页面上看到的是测试环境某个账号的视角，和代码说法不一致时两边都写出来、标 `[待核实]`。",
    `4. 一轮最多看 ${String(MAX_ACTIONS)} 次页面，挑相关的看。`,
    `已登记的环境（不指定 frontend 时默认用第一个：${envs[0]?.baseUrl ?? ""}）：`,
    ...envs.map(
      (e) =>
        `- ${e.baseUrl}${e.frontendRoot === null ? "" : `（前端 ${e.frontendRoot}）`}${e.role === "" ? "" : `，身份：${e.role}`}`,
    ),
    "要看另一个环境，把它的地址（或这段地址的一部分）作为 frontend 参数传进来。",
  ].join("\n");

interface Live {
  envId: string;
  browser: ReadOnlyBrowser;
  timer: ReturnType<typeof setTimeout>;
  actions: number;
}

export interface BrowseService {
  /** 这个会话该不该有浏览工具；有就返回工具与提示词追加段。 */
  profile(
    session: SessionRow,
  ): { tools: ToolDefinition[]; prompt: string } | undefined;
  /** 新一轮对话开始：动作计数清零。 */
  newTurn(sessionId: string): void;
  closeAll(): Promise<void>;
}

const slug = (s: string): string =>
  s.replace(/[^\w一-龥-]+/g, "_").replace(/^_+|_+$/g, "") || "page";

const day = (t: number): string => new Date(t).toISOString().slice(0, 10);

export function createBrowseService(deps: {
  envs: EnvStore;
  catalog: Catalog;
  files: FileStore;
  ui: UiIndex;
  browser?: BrowserDeps;
  now?: () => number;
}): BrowseService {
  const now = deps.now ?? Date.now;
  const live = new Map<string, Live>();
  const opening = new Map<string, Promise<Live>>();

  const usable = (productId: string): TestEnv[] =>
    deps.envs.list(productId).filter((e) => e.hasCredential);

  const close = async (sessionId: string): Promise<void> => {
    const l = live.get(sessionId);
    live.delete(sessionId);
    if (l === undefined) return;
    clearTimeout(l.timer);
    await l.browser.close();
  };

  const browserFor = async (sessionId: string, env: TestEnv): Promise<Live> => {
    const cur = live.get(sessionId);
    if (cur?.envId === env.id) {
      clearTimeout(cur.timer);
      cur.timer = setTimeout(() => void close(sessionId), IDLE_MS);
      return cur;
    }
    if (cur !== undefined) await close(sessionId);
    const pending = opening.get(sessionId);
    if (pending !== undefined) return pending;
    const p = (async () => {
      const cred = await deps.envs.credential(env.id);
      if (cred === null) throw new Error("这个测试环境还没存账号密码");
      const browser = await openReadOnly(
        {
          baseUrl: env.baseUrl,
          loginPath: env.loginPath,
          username: cred.username,
          password: cred.password,
          selectors: env.selectors,
        },
        deps.browser,
      );
      const l: Live = {
        envId: env.id,
        browser,
        actions: 0,
        timer: setTimeout(() => void close(sessionId), IDLE_MS),
      };
      live.set(sessionId, l);
      return l;
    })();
    opening.set(sessionId, p);
    try {
      return await p;
    } finally {
      opening.delete(sessionId);
    }
  };

  /** 把一次看到的页面落盘，并写成交给 AI 的结果（文字 + 截图）。 */
  const report = async (env: TestEnv, s: PageSnapshot, seeImages: boolean) => {
    const folder = `${SHOT_ROOT}/${slug(new URL(env.baseUrl).host)}/AI浏览/${day(now())}`;
    const name = `${String(now())}-${slug(s.path)}`;
    await deps.files
      .write(`${folder}/${name}.jpg`, s.screenshot, {
        mode: "overwrite",
        parents: true,
      })
      .catch(() => undefined);
    await deps.files
      .write(`${folder}/${name}.txt`, Buffer.from(`${s.url}\n\n${s.text}`), {
        mode: "overwrite",
        parents: true,
      })
      .catch(() => undefined);
    const head = [
      `页面：${s.path}（${env.baseUrl}${env.role === "" ? "" : `，身份 ${env.role}`}）`,
      s.title === "" ? "" : `网页标题：${s.title}`,
      s.blocked.length === 0
        ? ""
        : `只读拦截：这次页面想发出的写请求已被拦下（${s.blocked.slice(0, 5).join("；")}）`,
      `留档：${folder}/${name}.jpg`,
      seeImages
        ? ""
        : "（当前模型看不了图，只附文字结构；要看布局请换支持看图的模型）",
      "",
      s.text,
    ].filter((x) => x !== "");
    return {
      content: [
        { type: "text" as const, text: head.join("\n") },
        ...(seeImages
          ? [
              {
                type: "image" as const,
                data: s.screenshot.toString("base64"),
                mimeType: "image/jpeg",
              },
            ]
          : []),
      ],
      details: { path: s.path, image: `${folder}/${name}.jpg` },
    };
  };

  const toolsFor = (session: SessionRow, envs: TestEnv[]): ToolDefinition[] => {
    const productId = session.productId ?? "";
    /**
     * 挑环境：允许多个测试环境共存（比如 18900 的假环境 + 8091 的本机真后台）。
     * 认不出指定的是哪个时**报错并列出可选值**，不能悄悄退回第一个——
     * 那会让 AI 以为看的是 A，其实看的是 B（真实撞过）。
     */
    const pickEnv = (frontend?: string): TestEnv => {
      const key = (frontend ?? "").trim();
      if (key !== "") {
        const hit =
          envs.find((e) => e.id === key) ??
          envs.find((e) => e.baseUrl.includes(key)) ??
          envs.find((e) => e.frontendRoot?.endsWith(key) === true);
        if (hit === undefined)
          throw new Error(
            `没有叫「${key}」的测试环境。可用的有：${envs.map((e) => `${e.baseUrl}${e.role === "" ? "" : `（${e.role}）`}`).join("、")}`,
          );
        return hit;
      }
      const first = envs[0];
      if (first === undefined) throw new Error("这个产品没有可用的测试环境");
      return first;
    };
    const act = async (
      frontend: string | undefined,
      fn: (b: ReadOnlyBrowser) => Promise<PageSnapshot>,
      ctx: { model?: { input: readonly string[] } | undefined },
    ) => {
      const env = pickEnv(frontend);
      const l = await browserFor(session.id, env);
      if (l.actions >= MAX_ACTIONS)
        throw new Error(
          `这一轮已经看了 ${String(MAX_ACTIONS)} 次页面，先根据已看到的内容回答`,
        );
      l.actions += 1;
      return report(
        env,
        await fn(l.browser),
        ctx.model?.input.includes("image") ?? false,
      );
    };
    const frontendParam = Type.Optional(
      Type.String({
        description:
          "Which registered environment/frontend to use (part of its frontend path or URL). Omit when there is only one.",
      }),
    );

    const list = defineTool({
      name: "page_list",
      label: "页面清单",
      description:
        "List the pages of this product's frontend (from code routes): path, title, access requirement. Use it to decide which pages to open.",
      parameters: Type.Object({ frontend: frontendParam }),
      async execute(_id, params) {
        const product = deps.catalog
          .list()
          .flatMap((l) => l.products)
          .find((p) => p.id === productId);
        if (product?.codePath == null)
          return {
            content: [
              {
                type: "text" as const,
                text: "这个产品没绑代码目录，没有页面清单；可以直接 page_open 首页再顺着菜单点。",
              },
            ],
            details: {},
          };
        const env = pickEnv(params.frontend);
        const fes = await deps.ui.frontends(product.codePath);
        const fe =
          fes.find((f) => f.root === env.frontendRoot) ??
          (fes.length === 1 ? fes[0] : undefined);
        if (fe === undefined)
          return {
            content: [
              {
                type: "text" as const,
                text: `代码里有 ${String(fes.length)} 个前端（${fes.map((f) => f.label).join("、")}），这个环境没指定对应哪个；可以直接 page_open 首页再顺着菜单点。`,
              },
            ],
            details: {},
          };
        const lines = fe.pages
          .filter((p) => p.redirect === null)
          .slice(0, 300)
          .map(
            (p) =>
              `${p.path}  ${p.title ?? "（无标题）"}${p.access.length === 0 ? "" : `  [${p.access.join("，")}]`}`,
          );
        return {
          content: [
            {
              type: "text" as const,
              text: `${fe.label} 的页面（${String(lines.length)}）：\n${lines.join("\n")}`,
            },
          ],
          details: {},
        };
      },
    });

    const open = defineTool({
      name: "page_open",
      label: "打开页面",
      description:
        "Open a page of the registered TEST environment (read-only) and return a screenshot plus its text structure: title, menu, table columns and first rows, form fields, buttons, notices. Path like /admin/orders.",
      parameters: Type.Object({
        path: Type.String({
          description: "Page path, e.g. /admin/subscriptions",
        }),
        frontend: frontendParam,
      }),
      async execute(_id, params, _signal, _update, ctx) {
        return act(params.frontend, (b) => b.open(params.path), ctx);
      },
    });

    const click = defineTool({
      name: "page_click",
      label: "点击",
      description:
        "Click a NAVIGATION element on the current page by its visible text: a menu item, link, tab, or a view/detail button. Data-changing buttons are refused by the platform.",
      parameters: Type.Object({
        text: Type.String({
          description: "Visible text of the menu item / link / tab",
        }),
        frontend: frontendParam,
      }),
      async execute(_id, params, _signal, _update, ctx) {
        return act(params.frontend, (b) => b.click(params.text), ctx);
      },
    });

    const scroll = defineTool({
      name: "page_scroll",
      label: "往下翻",
      description:
        "Scroll the current page down one screen and return the new view.",
      parameters: Type.Object({ frontend: frontendParam }),
      async execute(_id, params, _signal, _update, ctx) {
        return act(params.frontend, (b) => b.scroll(), ctx);
      },
    });

    return [list, open, click, scroll].map(
      (t) => t as unknown as ToolDefinition,
    );
  };

  return {
    profile(session) {
      if (session.productId === null) return undefined;
      const envs = usable(session.productId);
      if (envs.length === 0) return undefined;
      return { tools: toolsFor(session, envs), prompt: BROWSE_PROMPT(envs) };
    },
    newTurn(sessionId) {
      const l = live.get(sessionId);
      if (l !== undefined) l.actions = 0;
    },
    async closeAll() {
      await Promise.all([...live.keys()].map((id) => close(id)));
    },
  };
}
