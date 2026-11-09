import { secretByContent } from "../../analysis/scan.js";
import type { FileStore } from "../../files/store.js";
import { inNoiseDir } from "../atlas.js";
import type { Keyword } from "../keywords.js";
import { STALE_SEGMENT } from "../locate.js";
import { expandForTables } from "../schema/glossary.js";
import {
  flattenMessages,
  inheritTitles,
  mergeLocale,
  parseFileRoutes,
  parseReactRouter,
  parseVueRouter,
  resolveTitles,
  type RouterFormat,
  type SourceText,
  type UiPage,
  type UiPages,
} from "./parse.js";

/**
 * 页面清单索引：在产品绑定的代码目录里找出各个前端，读出页面清单，缓存。
 *
 * 结构与 schema/index.ts 对称：
 * 前端按位置自动划分、按代码目录指纹缓存、按任务挑页交给 AI。
 *
 * 「前端」怎么认（按可信度从高到低，同一前端只取一种）：
 * 1. 入口文件（main.ts / main.tsx / index.tsx）里 `import router from './router/xxx'`——
 *    真实仓库 console-v2 有上游原件与二开影子副本两份路由，**只有入口引的那份才生效**；
 * 2. `src/router/index.ts`、`src/router.ts`、`src/routes.ts`；
 * 3. 入口文件自己里写了 `<Route`（React Router 常见）；
 * 4. Nuxt：含 `nuxt.config.*` 的目录下的 `pages/`（或 `app/pages/`）；
 * 5. Next：含 `next.config.*` 的目录下的 `app/` 或 `pages/`。
 */

export interface Frontend {
  /** 前端根目录（package.json 所在），同时是标识。 */
  root: string;
  /** 给人看的名字：相对代码目录的路径，如 `apps/console/frontend`。 */
  label: string;
  format: RouterFormat;
  /** 路由定义在哪个文件（文件路由就是 pages 目录）。 */
  entry: string;
  pages: UiPage[];
  /** 读到了多少条中文文案（用于查 titleKey）。0 表示标题只能靠路由里写的 / 页面大标题。 */
  messages: number;
  unparsed: UiPages["unparsed"];
}

export interface UiIndex {
  frontends(codePath: string): Promise<Frontend[]>;
  invalidate(codePath?: string): void;
}

const MAX_LIST = 200_000;
/** 单个前端最多读多少份页面组件（补标题用）。 */
const MAX_COMPONENT_READS = 400;
const MAX_LOCALE_FILES = 400;

const ENTRY_NAMES = new Set([
  "main.ts",
  "main.js",
  "main.tsx",
  "main.jsx",
  "index.tsx",
  "index.jsx",
]);
const COMPONENT_EXT = [".vue", ".tsx", ".jsx", ".ts", ".js"];

const dirOf = (p: string): string => p.slice(0, p.lastIndexOf("/"));

export function createUiIndex(files: FileStore): UiIndex {
  const cache = new Map<
    string,
    { fingerprint: string; pending: Promise<Frontend[]> }
  >();
  const read = async (path: string): Promise<string | null> => {
    const item = await files.item(path, { content: true }).catch(() => null);
    return typeof item?.content === "string" ? item.content : null;
  };

  const build = async (codePath: string): Promise<Frontend[]> => {
    const { files: listed } = files.listFilesDeep(codePath, {
      limit: MAX_LIST,
    });
    const all = new Set<string>();
    for (const e of listed) {
      if (inNoiseDir(e.path) || STALE_SEGMENT.test(e.path)) continue;
      all.add(e.path);
    }
    const under = (dir: string): string[] =>
      [...all].filter((p) => p.startsWith(`${dir}/`));
    const pkgRoots = [...all]
      .filter((p) => p.endsWith("/package.json"))
      .map(dirOf)
      .sort((a, b) => b.length - a.length);
    /** 一个文件归哪个前端：最近的 package.json 目录。 */
    const rootOf = (p: string): string | null =>
      pkgRoots.find((r) => p.startsWith(`${r}/`)) ?? null;

    const out: Frontend[] = [];
    const taken = new Set<string>();
    const textCache = new Map<string, string | null>();
    const readCached = async (p: string): Promise<string | null> => {
      if (!textCache.has(p)) textCache.set(p, await read(p));
      return textCache.get(p) ?? null;
    };

    // ── 1~3：Vue Router / React Router，从入口文件起 ──
    const entries = [...all].filter((p) => {
      const name = p.slice(p.lastIndexOf("/") + 1);
      return ENTRY_NAMES.has(name) && /\/src\/[^/]+$/.test(p);
    });
    for (const entryFile of entries) {
      const root = rootOf(entryFile);
      if (root === null || taken.has(root)) continue;
      const src = dirOf(entryFile);
      const text = (await readCached(entryFile)) ?? "";
      let routerFile: string | null = null;
      const imp =
        /import\s+\w+\s+from\s+['"](\.\/router[^'"]*|@\/router[^'"]*)['"]/.exec(
          text,
        )?.[1];
      if (imp !== undefined) {
        const base = imp.startsWith("@/")
          ? `${src}/${imp.slice(2)}`
          : `${src}/${imp.slice(2)}`;
        routerFile =
          [
            base,
            `${base}/index.ts`,
            `${base}/index.js`,
            `${base}.ts`,
            `${base}.js`,
          ].find((c) => all.has(c)) ?? null;
      }
      routerFile ??=
        [
          `${src}/router/index.ts`,
          `${src}/router/index.js`,
          `${src}/router.ts`,
          `${src}/routes.ts`,
          `${src}/routes.tsx`,
        ].find((c) => all.has(c)) ?? null;
      let parsed: UiPages | null = null;
      let entry = routerFile;
      if (routerFile !== null) {
        const rt = (await readCached(routerFile)) ?? "";
        // 入口里 `import { routes } from './router'`、真正的数组在 router 文件里：照读。
        parsed = /<Route\b/.test(rt)
          ? parseReactRouter({ path: routerFile, text: rt }, src)
          : parseVueRouter({ path: routerFile, text: rt }, src);
      } else if (/<Route\b/.test(text)) {
        parsed = parseReactRouter({ path: entryFile, text }, src);
        entry = entryFile;
      }
      if (parsed === null || entry === null || parsed.pages.length === 0)
        continue;
      const messages = await localeOf(src, under(src), readCached);
      await fillTitles(parsed.pages, messages, all, readCached);
      taken.add(root);
      out.push(frontendOf(root, codePath, parsed, entry, messages.size));
    }

    // ── 4~5：Nuxt / Next 文件路由 ──
    for (const cfg of [...all].filter((p) =>
      /\/(nuxt|next)\.config\.(ts|js|mjs|cjs)$/.test(p),
    )) {
      const root = dirOf(cfg);
      if (taken.has(root)) continue;
      const nuxt = cfg.includes("/nuxt.config.");
      const candidates = nuxt
        ? [`${root}/app/pages`, `${root}/pages`]
        : [
            `${root}/app`,
            `${root}/src/app`,
            `${root}/pages`,
            `${root}/src/pages`,
          ];
      const pagesDir = candidates.find((d) => under(d).length > 0);
      if (pagesDir === undefined) continue;
      const texts: SourceText[] = [];
      for (const p of under(pagesDir).slice(0, MAX_COMPONENT_READS)) {
        const t = await readCached(p);
        if (t !== null) texts.push({ path: p, text: t });
      }
      const messages = await localeOf(root, under(root), readCached);
      const parsed = parseFileRoutes(
        pagesDir,
        texts,
        nuxt ? "nuxt" : "next",
        (k) => messages.get(k),
      );
      if (parsed.pages.length === 0) continue;
      taken.add(root);
      out.push(frontendOf(root, codePath, parsed, pagesDir, messages.size));
    }
    return out.sort((a, b) => (a.label < b.label ? -1 : 1));
  };

  return {
    async frontends(codePath) {
      if (!files.exists(codePath)) return [];
      const s = files.summarize(codePath);
      const fingerprint = `${String(s.files)}-${String(s.modifiedAt)}`;
      const hit = cache.get(codePath);
      if (hit?.fingerprint === fingerprint) return hit.pending;
      const pending = build(codePath);
      cache.set(codePath, { fingerprint, pending });
      pending.catch(() => cache.delete(codePath));
      return pending;
    },
    invalidate(codePath) {
      if (codePath === undefined) cache.clear();
      else cache.delete(codePath);
    },
  };
}

function frontendOf(
  root: string,
  codePath: string,
  parsed: UiPages,
  entry: string,
  messages: number,
): Frontend {
  const rel = root.slice(codePath.length).replace(/^\//, "");
  return {
    root,
    label: rel === "" ? codePath.slice(codePath.lastIndexOf("/") + 1) : rel,
    format: parsed.format,
    entry,
    pages: parsed.pages,
    messages,
    unparsed: parsed.unparsed,
  };
}

/**
 * 中文文案：`i18n/locales/zh/**`、`locales/zh.*`、`zh-CN.json` 这类，再加 i18n 目录里
 * 自带 zh / en 两支的双语包（只取 zh）。英文包一律不收。
 */
async function localeOf(
  base: string,
  inside: readonly string[],
  read: (p: string) => Promise<string | null>,
): Promise<Map<string, string>> {
  const zhFiles = inside.filter((p) =>
    /\/(i18n|locales?|lang)\/(?:.*\/)?zh(?:[-_]CN|-Hans)?(?:\/|\.(?:ts|js|json)$)/i.test(
      p,
    ),
  );
  const mixed = inside.filter(
    (p) =>
      /\/(i18n|locales?|lang)\//i.test(p) &&
      /\.(ts|js|json)$/.test(p) &&
      !zhFiles.includes(p) &&
      !/\/(en|ja|ko|fr|de)(?:[-_][A-Z]{2})?(?:\/|\.)/.test(p) &&
      !/\.(test|spec)\./.test(p) &&
      !p.includes("__tests__"),
  );
  const zhRoot =
    zhFiles
      .map((p) => /^(.*\/zh(?:[-_]CN|-Hans)?)\//i.exec(p)?.[1])
      .find((x) => x !== undefined) ?? base;
  const texts: SourceText[] = [];
  for (const p of zhFiles.slice(0, MAX_LOCALE_FILES)) {
    const t = await read(p);
    if (t !== null) texts.push({ path: p, text: t });
  }
  const out = mergeLocale(zhRoot, texts);
  for (const p of mixed.slice(0, MAX_LOCALE_FILES)) {
    const t = await read(p);
    if (t === null) continue;
    for (const [k, v] of flattenMessages(t, { requireZh: true })) out.set(k, v);
  }
  // 手写的翻译表（`export const translations = { zh: { … } }`，放在 stores/ 之类）：
  // 文件名带 translation / messages / i18n 的也收 zh 支。
  for (const p of inside
    .filter(
      (x) =>
        /(translations?|messages|i18n)\.(ts|js)$/i.test(x) &&
        !mixed.includes(x) &&
        !zhFiles.includes(x),
    )
    .slice(0, 20)) {
    const t = await read(p);
    if (t === null) continue;
    for (const [k, v] of flattenMessages(t, { requireZh: true })) out.set(k, v);
  }
  return out;
}

async function fillTitles(
  pages: UiPage[],
  messages: ReadonlyMap<string, string>,
  all: ReadonlySet<string>,
  read: (p: string) => Promise<string | null>,
): Promise<void> {
  // 先把组件路径落到真实文件上（`@/views/X.vue` 原样、`./pages/X` 要补扩展名）。
  const texts = new Map<string, string | null>();
  let reads = 0;
  for (const p of pages) {
    if (p.component === null) continue;
    const real =
      [
        p.component,
        ...COMPONENT_EXT.map((e) => `${p.component ?? ""}${e}`),
        ...COMPONENT_EXT.map((e) => `${p.component ?? ""}/index${e}`),
      ].find((c) => all.has(c)) ?? null;
    p.component = real;
    if (real === null || texts.has(real) || reads >= MAX_COMPONENT_READS)
      continue;
    reads += 1;
    texts.set(real, await read(real));
  }
  resolveTitles(pages, messages, (path) => texts.get(path) ?? null);
  inheritTitles(pages);
}

// ─────────────────────── 交给 AI：按任务挑页 ───────────────────────

const FORMAT_CN: Record<RouterFormat, string> = {
  "vue-router": "Vue Router 路由表",
  "react-router": "React Router 路由",
  nuxt: "Nuxt 页面目录",
  next: "Next 页面目录",
};
const MIN_PAGE_SCORE = 4;
const MAX_PAGES = 12;
/** 命中页面的组件正文最多附几份、每份多长：表单字段与按钮文案在那里面。 */
const MAX_COMPONENT_BODIES = 2;
const MAX_COMPONENT_CHARS = 3000;
const MAX_UI_CHARS = 9000;

export interface PageHit {
  page: UiPage;
  score: number;
  matched: string[];
}

/** 给页面打分：标题 > 路径 > 组件文件名 > 菜单分组。中文词先按词表翻成路径里的英文写法。 */
export function rankPages(
  pages: readonly UiPage[],
  input: readonly Keyword[],
): PageHit[] {
  const keywords = expandForTables(input);
  const out: PageHit[] = [];
  for (const p of pages) {
    if (p.redirect !== null) continue;
    const title = (p.title ?? "").toLowerCase();
    const path = p.path.toLowerCase();
    const comp = (p.component ?? "").toLowerCase();
    const compName = comp.slice(comp.lastIndexOf("/") + 1);
    const section = (p.section ?? "").toLowerCase();
    let score = 0;
    const matched: { term: string; s: number }[] = [];
    for (const k of keywords) {
      let s = 0;
      if (k.weight < 2) {
        if (title.includes(k.term)) s += 3 * k.weight;
      } else {
        if (title.includes(k.term)) s += 4 * k.weight;
        if (path.includes(k.term)) s += 3 * k.weight;
        if (compName.includes(k.term)) s += 2 * k.weight;
        if (section.includes(k.term)) s += 1 * k.weight;
      }
      if (s > 0) {
        score += s;
        matched.push({ term: k.term, s });
      }
    }
    if (score < MIN_PAGE_SCORE) continue;
    out.push({
      page: p,
      score,
      matched: matched
        .sort((a, b) => b.s - a.s)
        .slice(0, 4)
        .map((m) => m.term),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

export const pageKey = (root: string, path: string): string =>
  `${root}#页面/${path}`;
export const uiPath = (root: string): string => `${root}#页面清单`;

export interface UiBrief {
  path: string;
  title: string;
  content: string;
  truncated: boolean;
  matched: string[];
  score: number;
  covers: string[];
}

function pageLine(p: UiPage): string {
  const bits = [
    p.title ?? "（没取到标题）",
    ...(p.section === null ? [] : [`菜单「${p.section}」`]),
    ...p.access,
  ];
  return `- ${p.path}：${bits.join(" · ")}${p.component === null ? "" : `（组件 ${p.component}）`}`;
}

/**
 * 按任务从一个前端里挑页，写成交给 AI 的「页面清单」摘要：命中的页面逐条列出
 * （标题、菜单、访问要求、组件文件），分数最高的两页再附组件正文的开头一截。
 */
export async function uiBriefFor(
  fe: Frontend,
  keywords: readonly Keyword[],
  exclude: ReadonlySet<string> | undefined,
  readComponent: (path: string) => Promise<string | null>,
): Promise<UiBrief | null> {
  const hits = rankPages(fe.pages, keywords)
    .filter((h) => exclude?.has(pageKey(fe.root, h.page.path)) !== true)
    .slice(0, MAX_PAGES);
  if (hits.length === 0) return null;
  const visible = fe.pages.filter((p) => p.redirect === null).length;
  const lines = [
    `页面清单 · ${fe.label}（取自${FORMAT_CN[fe.format]}，共 ${String(visible)} 个页面；这是代码里登记的页面，不代表都在菜单里露出）`,
    "按这次任务命中的页面：",
    ...hits.map((h) => pageLine(h.page)),
  ];
  let truncated = false;
  let size = lines.join("\n").length;
  let bodies = 0;
  for (const h of hits) {
    if (bodies >= MAX_COMPONENT_BODIES) break;
    const comp = h.page.component;
    if (comp === null) continue;
    const text = await readComponent(comp);
    if (text === null || secretByContent(text)) continue;
    const body = text.slice(0, MAX_COMPONENT_CHARS);
    if (size + body.length > MAX_UI_CHARS) {
      truncated = true;
      break;
    }
    lines.push(
      "",
      `### ${h.page.path} 的页面组件（${comp}${body.length < text.length ? "，只附开头" : ""}）`,
      body,
    );
    if (body.length < text.length) truncated = true;
    size += body.length;
    bodies += 1;
  }
  const content = lines.join("\n");
  return {
    path: uiPath(fe.root),
    title: `页面清单：${fe.label}`,
    content,
    truncated,
    matched: [...new Set(hits.flatMap((h) => h.matched))].slice(0, 4),
    score: hits[0]?.score ?? 0,
    covers: hits.map((h) => pageKey(fe.root, h.page.path)),
  };
}
