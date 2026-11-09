import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "../../app.js";
import { IN_MEMORY, openDb, type Db } from "../../db.js";
import {
  createFileStore,
  openFilesIndex,
  type FileStore,
} from "../../files/store.js";
import { createKeyStore } from "../../model-config.js";
import { piPaths } from "../../pi/runtime.js";
import { createCatalog } from "../../products.js";
import { createSkillStore } from "../../skills.js";
import { createEvidenceService, type BriefState } from "../index.js";
import { extractKeywords } from "../keywords.js";
import { createUiIndex, rankPages } from "./index.js";
import {
  filePathToRoute,
  flattenMessages,
  inheritTitles,
  mergeLocale,
  pageHeading,
  parseFileRoutes,
  parseReactRouter,
  parseVueRouter,
  resolveTitles,
} from "./parse.js";

/**
 * 页面清单（前端视角）依据。
 *
 * 守的口径：
 *   ① 四种路由写法都认对路径（父子拼接、动态段）、组件文件、访问要求、跳转；
 *   ② 标题优先中文：文案键查中文 > 页面大标题 > 路由里的英文；子页借父页；查不到就留空，不编；
 *   ③ 只读入口文件真正引用的那份路由（二开影子副本场景）；
 *   ④ 交给 AI 的只是命中的页面，续聊按页去重。
 *
 * 样本都是 RouteHub 真实仓库里出现过的写法，裁成最小片段。
 */

describe("Vue Router", () => {
  const file = {
    path: "/r/src/router/index.ts",
    text: `
import { createRouter } from 'vue-router'
import HomeView from '@/views/HomeView.vue'
// 注释里的 { path: '/fake' } 不算
const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'Login', component: () => import('@/views/auth/LoginView.vue'), meta: { requiresAuth: false, title: 'Login' } },
  { path: '/', component: HomeView, meta: { nav: { section: '概览', label: '安全概览' }, requiresAuth: true } },
  {
    path: '/admin/settings',
    component: () => import('@/views/admin/Settings.vue'),
    meta: { requiresAuth: true, requiresAdmin: true, titleKey: 'admin.settings.title' },
    children: [
      { path: 'feishu', name: 'Feishu', component: () => import('@/views/admin/Feishu.vue'), meta: { titleKey: 'x.feishu' } },
      { path: 'sms', component: () => import('@/views/admin/Sms.vue') },
    ],
  },
  { path: '/projects', redirect: { path: '/governance', query: { tab: 'p' } } },
  { path: '/auth/callback', alias: '/auth/oauth/callback', component: () => import('./Cb.vue') },
  { path: '/analytics', component: () => import('@/views/A.vue'), meta: { requiredRoles: ['admin', 'tenant_admin'] } },
]
export default createRouter({ routes })
`,
  };
  const r = parseVueRouter(file, "/r/src");
  const page = (path: string) => {
    const p = r.pages.find((x) => x.path === path);
    if (p === undefined) throw new Error(`没有页面 ${path}`);
    return p;
  };

  it("路径父子拼好；组件按 @ 别名、相对路径、顶部 import 解析", () => {
    expect(r.pages.map((p) => p.path)).toEqual([
      "/login",
      "/",
      "/admin/settings",
      "/admin/settings/feishu",
      "/admin/settings/sms",
      "/projects",
      "/auth/callback",
      "/analytics",
    ]);
    expect(page("/login").component).toBe("/r/src/views/auth/LoginView.vue");
    expect(page("/").component).toBe("/r/src/views/HomeView.vue");
    expect(page("/auth/callback").component).toBe("/r/src/router/Cb.vue");
    expect(r.unparsed.count).toBe(0);
  });

  it("访问要求：登录 / 管理员 / 角色，子路由继承父路由", () => {
    expect(page("/login").access).toEqual(["不用登录"]);
    expect(page("/admin/settings/sms").access).toEqual(["需登录", "仅管理员"]);
    expect(page("/analytics").access).toEqual(["角色 admin、tenant_admin"]);
  });

  it("菜单分组与菜单名、跳转、别名", () => {
    expect(page("/")).toMatchObject({ section: "概览", title: "安全概览" });
    expect(page("/projects").redirect).toBe("/governance");
    expect(page("/auth/callback").aliases).toEqual(["/auth/oauth/callback"]);
  });

  it("标题：文案键查中文 > 路由里的英文；子页没标题借父页", () => {
    resolveTitles(
      r.pages,
      new Map([
        ["admin.settings.title", "系统设置"],
        ["x.feishu", "飞书登录"],
      ]),
    );
    inheritTitles(r.pages);
    expect(page("/admin/settings")).toMatchObject({
      title: "系统设置",
      titleFrom: "i18n",
    });
    expect(page("/admin/settings/feishu").title).toBe("飞书登录");
    expect(page("/admin/settings/sms")).toMatchObject({
      title: "系统设置 · sms",
      titleFrom: "parent",
    });
    // 查不到就留空，不编。
    expect(page("/analytics").title).toBeNull();
  });

  it("英文 title 被页面里的中文大标题替换", () => {
    const one = parseVueRouter(
      {
        path: "/r/src/router/index.ts",
        text: `const routes = [{ path: '/keys', component: () => import('@/views/Keys.vue'), meta: { title: 'API Keys', titleKey: 'nope' } }]`,
      },
      "/r/src",
    );
    resolveTitles(one.pages, new Map(), () => "<h1>{{ t('keys.title') }}</h1>");
    expect(one.pages[0]?.title).toBe("API Keys");
    resolveTitles(
      one.pages,
      new Map([["keys.title", "API 密钥"]]),
      () => "<h1>{{ t('keys.title') }}</h1>",
    );
    expect(one.pages[0]).toMatchObject({
      title: "API 密钥",
      titleFrom: "heading",
    });
  });
});

describe("React Router", () => {
  const r = parseReactRouter(
    {
      path: "/m/src/index.tsx",
      text: `
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import RequestDetailPage from './pages/RequestDetailPage';
import Layout from './components/Layout';
<Routes>
  <Route path="/login" element={<LoginPage />} />
  <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
    <Route index element={<Navigate to="/dashboard" replace />} />
    <Route path="dashboard" element={<DashboardPage />} />
    <Route path="requests/:id" element={<RequestDetailPage />} />
  </Route>
  <Route path="*" element={<Navigate to="/" replace />} />
</Routes>`,
    },
    "/m/src",
  );

  it("嵌套拼路径、index 路由、组件取最内层、跳转", () => {
    expect(r.pages.map((p) => [p.path, p.redirect])).toEqual(
      [
        ["/login", null],
        ["/", null],
        ["/", "/dashboard"],
        ["/dashboard", null],
        ["/requests/:id", null],
        ["/*", "/"],
      ].filter((x, i, all) => all.findIndex((y) => y[0] === x[0]) === i),
    );
    expect(r.pages.find((p) => p.path === "/dashboard")?.component).toBe(
      "/m/src/pages/DashboardPage",
    );
  });

  it("登录守卫按祖先链继承：守卫里面的要登录，外面的不要", () => {
    const access = (p: string) => r.pages.find((x) => x.path === p)?.access;
    expect(access("/dashboard")).toEqual(["需登录"]);
    expect(access("/login")).toEqual([]);
    expect(access("/*")).toEqual([]);
  });
});

describe("文件路由（Nuxt / Next）", () => {
  it("文件名转路由：index、动态段、可选段、通配、分组目录", () => {
    expect(filePathToRoute("index.vue")).toBe("/");
    expect(filePathToRoute("link/fidelity/[id].vue")).toBe(
      "/link/fidelity/:id",
    );
    expect(filePathToRoute("docs/[...slug].vue")).toBe("/docs/:slug*");
    expect(filePathToRoute("[[lang]]/about.vue")).toBe("/:lang?/about");
    expect(filePathToRoute("(marketing)/pricing/page.tsx")).toBe("/pricing");
    expect(filePathToRoute("_components/x.vue")).toBeNull();
  });

  it("Nuxt：definePageMeta 的 nav 与 redirect；组件子目录里的 .ts 不算页面", () => {
    const dir = "/o/app/pages";
    const r = parseFileRoutes(
      dir,
      [
        {
          path: `${dir}/system/users.vue`,
          text: `<script setup>definePageMeta({ nav: { section: '系统管理', label: '用户管理', permission: 'system:manage' } })</script>`,
        },
        {
          path: `${dir}/governance/model-pricing.vue`,
          text: `<script setup>definePageMeta({ redirect: () => ({ path: '/cost/pricing', query: {} }) })</script>`,
        },
        {
          path: `${dir}/login.vue`,
          text: `<script setup>definePageMeta({ layout: 'auth' })</script><template><h1>OpsHub</h1></template>`,
        },
        { path: `${dir}/form/specModel.ts`, text: "export const x = 1" },
      ],
      "nuxt",
    );
    expect(r.pages.map((p) => p.path)).toEqual([
      "/governance/model-pricing",
      "/login",
      "/system/users",
    ]);
    expect(r.pages[2]).toMatchObject({
      title: "用户管理",
      section: "系统管理",
      access: ["权限 system:manage"],
    });
    expect(r.pages[0]?.redirect).toBe("/cost/pricing");
    expect(r.pages[1]).toMatchObject({
      title: "OpsHub",
      titleFrom: "heading",
      access: ["不用登录"],
    });
  });

  it("页面大标题：useHead 去掉运行时插值；PageHeader 的 title；h1 里的 t() 查文案", () => {
    expect(pageHeading("useHead({ title: `${brand.name} - 企业方案` })")).toBe(
      "企业方案",
    );
    expect(pageHeading('<PageHeader title="API 密钥" subtitle="x" />')).toBe(
      "API 密钥",
    );
    expect(
      pageHeading("<h1>{{ t('plaza.title') }}</h1>", (k) =>
        k === "plaza.title" ? "模型广场" : undefined,
      ),
    ).toBe("模型广场");
    expect(pageHeading("<h2>审计 #{{ id }}</h2>")).toBe("审计");
  });
});

describe("中文文案", () => {
  it("双语包只取 zh 一支；类型注解里的大括号不当数据", () => {
    const m = flattenMessages(`
export const msgs: Record<'zh' | 'en', Record<string, unknown>> = {
  zh: { acme: { mediaTasks: { title: '媒体任务' } } },
  en: { acme: { mediaTasks: { title: 'Media Tasks' } } },
}`);
    expect(m.get("acme.mediaTasks.title")).toBe("媒体任务");
    expect([...m.values()]).not.toContain("Media Tasks");
  });

  it("模块化目录：子目录名补成键前缀（admin/accounts.ts → admin.accounts.*）", () => {
    const m = mergeLocale("/r/locales/zh", [
      {
        path: "/r/locales/zh/admin/accounts.ts",
        text: "export default { accounts: { title: '账号管理' } }",
      },
    ]);
    expect(m.get("admin.accounts.title")).toBe("账号管理");
  });

  it("要求双语时，单语英文包不收", () => {
    expect(
      flattenMessages("export default { a: { b: 'English' } }", {
        requireZh: true,
      }).size,
    ).toBe(0);
  });
});

describe("按任务挑页", () => {
  const r = parseVueRouter(
    {
      path: "/r/src/router/index.ts",
      text: `const routes = [
  { path: '/subscriptions', meta: { title: '我的订阅' } },
  { path: '/admin/subscriptions', meta: { title: '订阅管理', requiresAdmin: true } },
  { path: '/admin/promo-codes', meta: { title: '优惠码管理' } },
  { path: '/old-subs', redirect: '/subscriptions' },
  { path: '/settings', meta: { title: '系统配置' } },
]`,
    },
    "/r/src",
  );
  it("中文业务词翻成路径里的英文；只做跳转的不挑；二元组碎片不乱撞", () => {
    expect(
      rankPages(r.pages, extractKeywords("写一份订阅续费的 PRD"))
        .map((h) => h.page.path)
        .sort(),
    ).toEqual(["/admin/subscriptions", "/subscriptions"]);
    expect(rankPages(r.pages, extractKeywords("帮我看看怎么配的"))).toEqual([]);
  });
});

/* ── 接进定位器与接口 ─────────────────────────────────────────────── */

let dir: string;
let files: FileStore;
let index: Db;
let db: Db;

function write(path: string, body: string): void {
  const abs = join(files.root, ...path.split("/").filter(Boolean));
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-ui-")));
  db = openDb(IN_MEMORY);
  index = openFilesIndex();
  files = createFileStore(join(dir, "files"), index);
});

afterEach(() => {
  db.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

const FE = "/代码库/R/apps/console/frontend";

async function seed(): Promise<string> {
  write(`${FE}/package.json`, '{"name":"fe"}');
  write(
    `${FE}/src/main.ts`,
    "import router from './router/acme'\ncreateApp(App).use(router)",
  );
  // 上游原件：入口没引它，不该被读。
  write(
    `${FE}/src/router/index.ts`,
    "const routes = [{ path: '/upstream-only', component: () => import('@/views/U.vue') }]",
  );
  write(
    `${FE}/src/router/acme/index.ts`,
    `const routes = [
  { path: '/redeem', component: () => import('@/views/RedeemView.vue'), meta: { requiresAuth: true, titleKey: 'redeem.title' } },
]`,
  );
  write(
    `${FE}/src/i18n/locales/zh.ts`,
    "export default { redeem: { title: '兑换码' } }",
  );
  write(
    `${FE}/src/views/RedeemView.vue`,
    '<template><h1>兑换码</h1><input placeholder="输入兑换码" /></template>',
  );
  await files.reindex();
  const catalog = createCatalog(db);
  const line = catalog.createLine({ name: "线" });
  return catalog.createProduct(line.id, { name: "P", codePath: "/代码库/R" })
    .id;
}

describe("接进事实依据", () => {
  it("只读入口真正引用的那份路由；标题按文案键查到中文", async () => {
    await seed();
    const fes = await createUiIndex(files).frontends("/代码库/R");
    expect(fes).toHaveLength(1);
    expect(fes[0]?.label).toBe("apps/console/frontend");
    expect(fes[0]?.pages.map((p) => [p.path, p.title])).toEqual([
      ["/redeem", "兑换码"],
    ]);
    expect(fes[0]?.pages[0]?.component).toBe(`${FE}/src/views/RedeemView.vue`);
  });

  it("对话依据段带上命中的页面与组件正文；续聊同一页不重复给", async () => {
    const productId = await seed();
    const svc = createEvidenceService({ files, catalog: createCatalog(db) });
    const state: BriefState = { first: true, given: new Set() };
    const text = await svc.brief({ productId }, "梳理兑换码页面的现状", state);
    expect(text).toContain(`${FE}#页面清单`);
    expect(text).toContain("- /redeem：兑换码 · 需登录");
    expect(text).toContain('placeholder="输入兑换码"');

    const again = await svc.brief(
      { productId },
      "兑换码页面还要再补一个说明",
      state,
    );
    expect(again ?? "").not.toContain("- /redeem：");
  });
});

describe("接口：产品 → 页面", () => {
  it("先列前端，再按前端取页面；只认该产品代码目录下的前端", async () => {
    const productId = await seed();
    const { app } = createApp({
      auth: false,
      db,
      paths: piPaths(dir),
      keys: createKeyStore(dir, {}),
      skills: createSkillStore({
        dir: join(dir, "skills"),
        targetDirs: {
          pi: join(dir, "t", "pi"),
        },
      }),
      files,
      security: false,
    });
    try {
      const list = await app.inject({
        method: "GET",
        url: `/api/products/${productId}/ui`,
      });
      expect(list.statusCode).toBe(200);
      expect(
        list.json<{ frontends: { root: string; pages: number }[] }>().frontends,
      ).toEqual([expect.objectContaining({ root: FE, pages: 1 })]);

      const detail = await app.inject({
        method: "GET",
        url: `/api/products/${productId}/ui/pages?root=${encodeURIComponent(FE)}`,
      });
      expect(
        detail.json<{ pageList: { path: string }[] }>().pageList[0]?.path,
      ).toBe("/redeem");

      const outside = await app.inject({
        method: "GET",
        url: `/api/products/${productId}/ui/pages?root=${encodeURIComponent("/别处")}`,
      });
      expect(outside.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
