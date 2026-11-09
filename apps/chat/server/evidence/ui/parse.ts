/**
 * 前端视角依据：从代码里读出「有哪些页面、每页叫什么、谁能进、对应哪份组件」。
 *
 * 与 schema/parse.ts 同一个原则：
 * **纯文本解析，不跑任何构建工具**——代码库是用户传上来的，不在本机执行它的任何东西。
 *
 * 认四种写法：
 * - Vue Router：`routes: RouteRecordRaw[] = [ … ]` 数组字面量（含 children、meta、redirect）；
 * - React Router：JSX `<Route path=… element={<XxxPage />}>`（含嵌套、index）；
 * - Nuxt：`pages/` 目录即路由（`[id].vue` → `:id`），`definePageMeta` 里的 nav / layout；
 * - Next：`app/**\/page.tsx` 或 `pages/**`。
 *
 * 页面标题：路由里直接写的（meta.title、nav.label）优先；写的是 i18n 键（titleKey）时
 * 到同目录的中文文案里查（见 resolveTitles）。查不到就留空、如实标「没取到标题」，不编。
 */

export type RouterFormat = "vue-router" | "react-router" | "nuxt" | "next";

export interface UiPage {
  /** 完整路径（父子已拼好），如 `/admin/accounts`、`/requests/:id`。 */
  path: string;
  /** 路由名（Vue Router 的 name）；文件路由没有就为 null。 */
  name: string | null;
  /** 给人看的标题：优先中文文案，其次路由里写的英文 title。 */
  title: string | null;
  /** 标题来自哪：路由里直接写的 / 按 i18n 键查到的 / 页面自己的大标题 / 没取到。 */
  titleFrom: "literal" | "i18n" | "heading" | "parent" | null;
  /** 菜单分组（opshub / sechub 的 nav.section 这类）。 */
  section: string | null;
  /** 访问要求，人读的短标签：「需登录」「仅管理员」「角色 admin、tenant_admin」「权限 system:manage」。 */
  access: string[];
  /** 页面组件文件（文件库路径）；解析不出就为 null。 */
  component: string | null;
  /** 只做跳转的路由：跳到哪。 */
  redirect: string | null;
  /** 路由别名。 */
  aliases: string[];
  /** 定义在哪个文件。 */
  source: string;
  /** 未解析的 i18n 键（标题没取到时给人追查）。 */
  titleKey: string | null;
  /** 父路由的路径（Vue Router children）。子页没标题时借父页的标题，写成「父 · 子路径段」。 */
  parent?: string;
}

export interface UiPages {
  format: RouterFormat;
  pages: UiPage[];
  unparsed: { count: number; samples: string[] };
}

export interface SourceText {
  path: string;
  text: string;
}

const MAX_SAMPLES = 5;

function bag(): { add: (s: string) => void; done: () => UiPages["unparsed"] } {
  let count = 0;
  const samples: string[] = [];
  return {
    add(s) {
      count += 1;
      if (samples.length < MAX_SAMPLES) samples.push(s);
    },
    done: () => ({ count, samples }),
  };
}

/** 去掉 JS 的行注释与块注释，保留字符串与模板字符串里的内容。 */
export function stripJsComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i] ?? "";
    const next = src[i + 1];
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j + 1;
    } else if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      i = end === -1 ? src.length : end;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** 从开括号位置找配对的闭括号（跳过字符串）。 */
function matching(src: string, open: number): number {
  const pairs: Record<string, string> = { "[": "]", "{": "}", "(": ")" };
  const want = pairs[src[open] ?? ""];
  if (want === undefined) return -1;
  const stack: string[] = [want];
  for (let i = open + 1; i < src.length; i += 1) {
    const c = src[i] ?? "";
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      i = j;
      continue;
    }
    const close = pairs[c];
    if (close !== undefined) stack.push(close);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** 按顶层逗号切。 */
function splitTop(src: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let buf = "";
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i] ?? "";
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      buf += src.slice(i, j + 1);
      i = j;
      continue;
    }
    if (c === "[" || c === "{" || c === "(") depth += 1;
    else if (c === "]" || c === "}" || c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      if (buf.trim() !== "") out.push(buf.trim());
      buf = "";
    } else buf += c;
  }
  if (buf.trim() !== "") out.push(buf.trim());
  return out;
}

/** 一个对象字面量 `{ a: 1, b: {...} }` 的顶层键 → 原文值。 */
function objectProps(obj: string): Map<string, string> {
  const out = new Map<string, string>();
  const inner = obj.trim().replace(/^\{/, "").replace(/\}$/, "");
  for (const part of splitTop(inner)) {
    const m = /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*)$/.exec(
      part,
    );
    const key = m?.[2] ?? m?.[3];
    if (key !== undefined && m?.[4] !== undefined) out.set(key, m[4].trim());
    else if (/^[A-Za-z_$][\w$]*$/.test(part)) out.set(part, part);
  }
  return out;
}

/** 字符串字面量的值；不是字面量返回 null。 */
function literal(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const s = raw.trim();
  const m = /^(['"`])([\s\S]*)\1$/.exec(s);
  if (m?.[2] === undefined) return null;
  if (m[1] === "`" && m[2].includes("${")) return null;
  return m[2];
}

function joinPath(parent: string, child: string): string {
  if (child.startsWith("/")) return child;
  if (child === "") return parent === "" ? "/" : parent;
  const base = parent.endsWith("/") ? parent.slice(0, -1) : parent;
  return `${base}/${child}`;
}

/**
 * 把 `@/views/x.vue`、`~/x`、相对路径解析成文件库路径。
 *
 * `@` / `~` 按惯例指向 `src/`（Vite / Vue CLI）或应用根（Nuxt），由调用方传 aliasRoot。
 */
export function resolveImport(
  spec: string,
  from: string,
  aliasRoot: string,
): string {
  if (spec.startsWith("@/") || spec.startsWith("~/"))
    return `${aliasRoot}/${spec.slice(2)}`;
  if (!spec.startsWith(".")) return spec;
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}

// ─────────────────────────── Vue Router ───────────────────────────

interface VueCtx {
  file: string;
  aliasRoot: string;
  imports: Map<string, string>;
  bad: ReturnType<typeof bag>;
}

function accessOf(meta: Map<string, string>, inherited: string[]): string[] {
  const out = [...inherited];
  const push = (s: string): void => {
    if (!out.includes(s)) out.push(s);
  };
  const auth = meta.get("requiresAuth");
  if (auth === "true") push("需登录");
  if (auth === "false") {
    const i = out.indexOf("需登录");
    if (i !== -1) out.splice(i, 1);
    push("不用登录");
  }
  if (meta.get("requiresAdmin") === "true") push("仅管理员");
  const roles = meta.get("requiredRoles") ?? meta.get("roles");
  if (roles !== undefined) {
    const list = [...roles.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (list.length > 0) push(`角色 ${list.join("、")}`);
  }
  const nav = meta.get("nav");
  const perm =
    meta.get("permission") ??
    (nav === undefined ? undefined : objectProps(nav).get("permission"));
  const p = literal(perm);
  if (p !== null) push(`权限 ${p}`);
  return out;
}

function vueRoute(
  obj: string,
  parentPath: string,
  inherited: string[],
  ctx: VueCtx,
  out: UiPage[],
): void {
  const props = objectProps(obj);
  const rawPath = literal(props.get("path"));
  if (rawPath === null) {
    ctx.bad.add(`${ctx.file}：${obj.replace(/\s+/g, " ").slice(0, 60)}`);
    return;
  }
  const path = joinPath(parentPath, rawPath);
  const meta = objectProps(props.get("meta") ?? "{}");
  const nav = objectProps(meta.get("nav") ?? "{}");
  const access = accessOf(meta, inherited);

  let component: string | null = null;
  const comp = props.get("component") ?? props.get("components");
  if (comp !== undefined) {
    const lazy = /import\(\s*['"]([^'"]+)['"]\s*\)/.exec(comp);
    if (lazy?.[1] !== undefined)
      component = resolveImport(lazy[1], ctx.file, ctx.aliasRoot);
    else {
      const spec = ctx.imports.get(comp.trim());
      if (spec !== undefined)
        component = resolveImport(spec, ctx.file, ctx.aliasRoot);
    }
  }

  const redirectRaw = props.get("redirect");
  let redirect: string | null = null;
  if (redirectRaw !== undefined) {
    redirect =
      literal(redirectRaw) ??
      literal(objectProps(redirectRaw).get("path")) ??
      (() => {
        const name = literal(objectProps(redirectRaw).get("name"));
        return name === null ? "（运行时决定）" : `路由 ${name}`;
      })();
  }
  const aliasRaw = props.get("alias");
  const aliases =
    aliasRaw === undefined
      ? []
      : [...aliasRaw.matchAll(/['"]([^'"]+)['"]/g)].flatMap((m) =>
          m[1] === undefined ? [] : [joinPath(parentPath, m[1])],
        );

  const titleKey = literal(meta.get("titleKey"));
  const label = literal(nav.get("label"));
  const title = label ?? literal(meta.get("title"));
  out.push({
    path,
    name: literal(props.get("name")),
    title,
    titleFrom: title === null ? null : "literal",
    section: literal(nav.get("section")),
    access,
    component,
    redirect,
    aliases,
    source: ctx.file,
    titleKey,
    ...(parentPath === "" ? {} : { parent: parentPath }),
  });

  const children = props.get("children");
  if (children !== undefined) vueRouteArray(children, path, access, ctx, out);
}

function vueRouteArray(
  arr: string,
  parentPath: string,
  inherited: string[],
  ctx: VueCtx,
  out: UiPage[],
): void {
  const inner = arr.trim().replace(/^\[/, "").replace(/\]$/, "");
  for (const item of splitTop(inner)) {
    if (item.startsWith("{")) vueRoute(item, parentPath, inherited, ctx, out);
    else if (item.startsWith("...")) {
      // `...adminRoutes`：展开的是别处定义的数组。真实仓库里只出现在菜单拼接处，
      // 路由表本身没用到；遇到就如实计数。
      ctx.bad.add(`${ctx.file}：展开 ${item.slice(0, 40)}（没跟进去读）`);
    } else ctx.bad.add(`${ctx.file}：${item.slice(0, 60)}`);
  }
}

function importsOf(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(
    /import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/g,
  ))
    if (m[1] !== undefined && m[2] !== undefined) out.set(m[1], m[2]);
  return out;
}

/**
 * 解析一个 Vue Router 路由文件。认 `const routes = [ … ]`、`export const routes … = [ … ]`
 * 以及 `createRouter({ routes: [ … ] })` 里直接写的数组。
 */
export function parseVueRouter(file: SourceText, aliasRoot: string): UiPages {
  const bad = bag();
  const src = stripJsComments(file.text);
  const ctx: VueCtx = {
    file: file.path,
    aliasRoot,
    imports: importsOf(src),
    bad,
  };
  const pages: UiPage[] = [];
  const re =
    /(?:\b(?:const|let|var)\s+\w*[Rr]outes\w*\s*(?::[^=]+)?=\s*|\broutes\s*:\s*)\[/g;
  for (const m of src.matchAll(re)) {
    const open = m.index + m[0].length - 1;
    const close = matching(src, open);
    if (close === -1) {
      bad.add(`${file.path}：路由数组没闭合`);
      continue;
    }
    vueRouteArray(src.slice(open, close + 1), "", [], ctx, pages);
  }
  return { format: "vue-router", pages: dedupe(pages), unparsed: bad.done() };
}

// ─────────────────────────── React Router ───────────────────────────

/** 一个 JSX 开标签的属性原文（到配对的 `>` 为止，跳过 `{…}` 里的 `>`）。 */
function jsxTagEnd(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i += 1) {
    const c = src[i];
    if (c === "{") depth += 1;
    else if (c === "}") depth -= 1;
    else if (c === ">" && depth === 0) return i;
    else if ((c === '"' || c === "'") && depth === 0) {
      const end = src.indexOf(c, i + 1);
      if (end === -1) return -1;
      i = end;
    }
  }
  return -1;
}

function jsxAttr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{)`).exec(
    attrs,
  );
  if (m === null) return null;
  if (m[1] !== undefined) return m[1];
  if (m[2] !== undefined) return m[2];
  const open = m.index + m[0].length - 1;
  const close = matching(attrs, open);
  return close === -1 ? null : attrs.slice(open + 1, close).trim();
}

/** 解析 `<Routes>` 里的 `<Route>` 树。 */
export function parseReactRouter(file: SourceText, aliasRoot: string): UiPages {
  const bad = bag();
  const src = stripJsComments(file.text);
  const imports = importsOf(src);
  const pages: UiPage[] = [];
  /** 祖先链：路径 + 是否套了登录守卫。子路由按祖先链继承，不按路径前缀猜。 */
  const stack: { path: string; guarded: boolean }[] = [];
  const re = /<(\/?)Route\b/g;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    if (m[1] === "/") {
      stack.pop();
      continue;
    }
    const end = jsxTagEnd(src, m.index + m[0].length);
    if (end === -1) {
      bad.add(`${file.path}：<Route 没闭合`);
      break;
    }
    const attrs = src.slice(m.index + m[0].length, end);
    const selfClosing = attrs.trimEnd().endsWith("/");
    const parent = stack[stack.length - 1];
    const raw = jsxAttr(attrs, "path");
    const isIndex = /\bindex\b(?!\s*=)/.test(attrs);
    const path = joinPath(parent?.path ?? "", isIndex ? "" : (raw ?? ""));
    const element = jsxAttr(attrs, "element") ?? jsxAttr(attrs, "Component");
    // element 里最内层的组件名（`<RequireAuth><Layout /></RequireAuth>` 取 Layout）。
    const names = [...(element ?? "").matchAll(/<([A-Z][\w.]*)/g)].map(
      (x) => x[1] ?? "",
    );
    const guarded =
      (parent?.guarded ?? false) ||
      names.some((n) => /Require|Auth|Guard|Protected/.test(n));
    const nav = /<Navigate\b[^>]*\bto\s*=\s*["']([^"']+)["']/.exec(
      element ?? "",
    );
    const comp = names.filter((n) => n !== "Navigate").pop();
    const spec = comp === undefined ? undefined : imports.get(comp);
    // 只包一层布局、不带 path 的 <Route> 不算页面，但要继续往下拼子路由。
    if (raw !== null || isIndex)
      pages.push({
        path,
        name: null,
        title: null,
        titleFrom: null,
        section: null,
        access: guarded ? ["需登录"] : [],
        component:
          spec === undefined ? null : resolveImport(spec, file.path, aliasRoot),
        redirect: nav?.[1] ?? null,
        aliases: [],
        source: file.path,
        titleKey: null,
      });
    if (!selfClosing) stack.push({ path, guarded });
  }
  return {
    format: "react-router",
    pages: dedupe(pages),
    unparsed: bad.done(),
  };
}

// ─────────────────────────── 文件路由（Nuxt / Next） ───────────────────────────

const PAGE_EXT = /\.(vue|tsx|jsx|ts|js|mdx?)$/;

/**
 * `pages/link/fidelity/[id].vue` → `/link/fidelity/:id`。
 * Nuxt：`index.vue` → 目录本身；`[...slug]` → `:slug*`；`(group)` 不进路径。
 */
export function filePathToRoute(rel: string): string | null {
  if (!PAGE_EXT.test(rel)) return null;
  const segs = rel.replace(PAGE_EXT, "").split("/");
  const out: string[] = [];
  for (const seg of segs) {
    if (seg === "index" || seg === "page") continue;
    if (/^\(.*\)$/.test(seg)) continue;
    if (seg.startsWith("_") || seg.startsWith("@")) return null;
    const spread = /^\[\[?\.\.\.(\w+)\]?\]$/.exec(seg);
    if (spread?.[1] !== undefined) {
      out.push(`:${spread[1]}*`);
      continue;
    }
    const opt = /^\[\[(\w+)\]\]$/.exec(seg);
    if (opt?.[1] !== undefined) {
      out.push(`:${opt[1]}?`);
      continue;
    }
    out.push(seg.replace(/\[(\w+)\]/g, ":$1"));
  }
  return `/${out.join("/")}`;
}

/** Nuxt `definePageMeta({ … })` 里的 nav / layout / middleware。 */
function nuxtMeta(text: string): Map<string, string> {
  const src = stripJsComments(text);
  const m = /definePageMeta\s*\(\s*\{/.exec(src);
  if (m === null) return new Map();
  const open = m.index + m[0].length - 1;
  const close = matching(src, open);
  return close === -1
    ? new Map<string, string>()
    : objectProps(src.slice(open, close + 1));
}

/**
 * 页面里最显眼的标题：useHead 的 title，其次第一个 h1 / h2。
 *
 * h1 里写的是 `{{ t('x.y') }}` / `{t("x.y")}` 时交给 lookup 查中文文案。
 * 模板字符串里的 `${brand.name}` 这类运行时值去掉，只留写死的部分。
 */
export function pageHeading(
  text: string,
  lookup: (key: string) => string | undefined = () => undefined,
): string | null {
  const clean = (t: string): string | null => {
    const s = t
      .replace(/\$\{[^}]*\}/g, "")
      .replace(/^[\s\-–—|·:：]+|[\s\-–—|·:：]+$/g, "")
      .trim();
    return s === "" ? null : s;
  };
  const head =
    /useHead\s*\(\s*\{[\s\S]{0,300}?\btitle\s*:\s*(['"`])([^'"`]+)\1/.exec(
      text,
    );
  if (head?.[2] !== undefined) {
    const t = clean(head[2]);
    if (t !== null) return t;
  }
  // 页头组件：`<PageHeader title="API 密钥" …>`（真实仓库 mockmodel 每页都这么写）。
  const comp =
    /<(?:PageHeader|PageTitle|PageHead)\b[^>]*?\btitle\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*t\(\s*['"]([\w.-]+)['"])/.exec(
      text,
    );
  if (comp !== null) {
    const t =
      comp[1] ??
      comp[2] ??
      (comp[3] === undefined ? undefined : lookup(comp[3]));
    if (t !== undefined) return t;
  }
  for (const h of text.matchAll(/<h[12]\b[^>]*>([\s\S]{0,200}?)<\/h[12]>/g)) {
    const inner = h[1] ?? "";
    const key = /\$?t\(\s*['"]([\w.-]+)['"]/.exec(inner)?.[1];
    if (key !== undefined) {
      const zh = lookup(key);
      if (zh !== undefined) return zh;
      continue;
    }
    const plain = clean(
      inner
        .replace(/<[^>]+>/g, "")
        .replace(/\{\{[\s\S]*?\}\}/g, "")
        .replace(/\{[^}]*\}/g, "")
        .replace(/[#＃]\s*$/, ""),
    );
    if (plain !== null && /[一-鿿A-Za-z]/.test(plain)) return plain;
  }
  return null;
}

/**
 * 文件路由。pagesDir 是 `pages` 目录（或 Next 的 `app` 目录）的文件库路径。
 */
export function parseFileRoutes(
  pagesDir: string,
  files: readonly SourceText[],
  format: "nuxt" | "next",
  lookup: (key: string) => string | undefined = () => undefined,
): UiPages {
  const bad = bag();
  const pages: UiPage[] = [];
  for (const f of files) {
    const rel = f.path.slice(pagesDir.length + 1);
    // Next 的 app 目录只认 page.*；其余（layout / loading / route）不是页面。
    if (format === "next" && /(^|\/)app$/.test(pagesDir)) {
      if (!/(^|\/)page\.(tsx|jsx|ts|js|mdx?)$/.test(rel)) continue;
    } else if (format === "next" && /(^|\/)_(app|document|error)\./.test(rel))
      continue;
    // Nuxt 页面目录里的组件子目录（如 profile-form/）里不是页面：只认 .vue。
    if (format === "nuxt" && !rel.endsWith(".vue")) continue;
    const path = filePathToRoute(rel);
    if (path === null) continue;
    const meta =
      format === "nuxt" ? nuxtMeta(f.text) : new Map<string, string>();
    const nav = objectProps(meta.get("nav") ?? "{}");
    const access: string[] = [];
    const layout = literal(meta.get("layout"));
    if (layout === "auth" || path.endsWith("/login")) access.push("不用登录");
    const perm = literal(nav.get("permission"));
    if (perm !== null) access.push(`权限 ${perm}`);
    const label = literal(nav.get("label"));
    const heading = label === null ? pageHeading(f.text, lookup) : null;
    const redirectRaw = meta.get("redirect");
    const redirect =
      redirectRaw === undefined
        ? null
        : (literal(redirectRaw) ??
          /path\s*:\s*['"]([^'"]+)['"]/.exec(redirectRaw)?.[1] ??
          "（运行时决定）");
    pages.push({
      path,
      name: null,
      title: label ?? heading,
      titleFrom:
        label !== null ? "literal" : heading !== null ? "heading" : null,
      section: literal(nav.get("section")),
      access,
      component: f.path,
      redirect,
      aliases: [],
      source: f.path,
      titleKey: null,
    });
  }
  pages.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { format, pages: dedupe(pages), unparsed: bad.done() };
}

// ─────────────────────────── i18n 标题 ───────────────────────────

/**
 * 从中文文案文件里抽「点分键 → 文案」。只认对象字面量里的字符串值，
 * `...spread` 和 import 进来的模块由调用方把文件都传进来、按顶层键合并。
 *
 * 文案文件是 TS 对象（`export default { nav: { dashboard: '仪表盘' } }`）或 JSON。
 */
export function flattenMessages(
  text: string,
  options: { requireZh?: boolean } = {},
): Map<string, string> {
  const out = new Map<string, string>();
  const src = stripJsComments(text);
  const walk = (obj: string, prefix: string): void => {
    const inner = obj.trim().replace(/^\{/, "").replace(/\}$/, "");
    for (const part of splitTop(inner)) {
      const m =
        /^(?:(['"])([^'"]+)\1|([A-Za-z_$][\w$]*))\s*:\s*([\s\S]*)$/.exec(part);
      const key = m?.[2] ?? m?.[3];
      const val = m?.[4]?.trim();
      if (key === undefined || val === undefined) continue;
      const full = prefix === "" ? key : `${prefix}.${key}`;
      if (val.startsWith("{")) walk(val, full);
      else {
        const s = literal(val);
        if (s !== null) out.set(full, s);
      }
    }
  };
  // 对象字面量的起点：`export default {`、`= {`（跳过 `: Record<…> =` 这类类型注解）、
  // 或 JSON 的根。类型注解里的 `{` 不是数据。
  const starts: number[] = [];
  for (const m of src.matchAll(/(?:export\s+default|=)\s*\{/g))
    starts.push(m.index + m[0].length - 1);
  if (starts.length === 0 && src.trimStart().startsWith("{"))
    starts.push(src.indexOf("{"));
  for (const start of starts) {
    const close = matching(src, start);
    if (close !== -1) walk(src.slice(start, close + 1), "");
  }
  // 双语包（`{ zh: { … }, en: { … } }`）：只取 zh 那一支，键去掉 zh 这一段。
  const zhOnly = new Map<string, string>();
  for (const [k, v] of out) {
    const z = /^(?:.*\.)?zh(?:-CN|_CN)?\.(.+)$/.exec(k);
    if (z?.[1] !== undefined) zhOnly.set(z[1], v);
  }
  if (zhOnly.size > 0) return zhOnly;
  // 要求必须是双语包时（扫 i18n 目录里的杂项文件），没有 zh 分支就不收——否则 en.ts 会被当成中文。
  return options.requireZh === true ? new Map<string, string>() : out;
}

/**
 * 按文件名把「模块文案」挂到对应前缀下：`locales/zh/admin/accounts.ts` 里的顶层键
 * 本来就以 `accounts` 开头，但它是被 `admin/index.ts` 展开进 `admin` 下的——
 * 所以 `locales/zh/<dir>/` 里的文件，键一律补上 `<dir>.` 前缀。
 */
export function mergeLocale(
  root: string,
  files: readonly SourceText[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of files) {
    const rel = f.path.slice(root.length + 1);
    const dirs = rel.split("/").slice(0, -1);
    const prefix = dirs.join(".");
    for (const [k, v] of flattenMessages(f.text)) {
      out.set(k, v);
      if (prefix !== "") out.set(`${prefix}.${k}`, v);
    }
  }
  return out;
}

/**
 * 用中文文案补标题。路由里直接写的英文 title 会被中文替换（产品经理看中文）。
 *
 * 还没有标题、又能读到页面组件的，用组件自己的大标题兜底（readComponent 由调用方给，
 * 只读文件库里的文本）。
 */
export function resolveTitles(
  pages: UiPage[],
  messages: ReadonlyMap<string, string>,
  readComponent?: (path: string) => string | null,
): void {
  for (const p of pages) {
    if (p.titleKey !== null) {
      const zh = messages.get(p.titleKey);
      if (zh !== undefined) {
        p.title = zh;
        p.titleFrom = "i18n";
        continue;
      }
    }
    // 路由里写的英文 title（「Dashboard」）也换成页面里的中文大标题——产品经理看中文。
    const english = p.title !== null && !/[一-鿿]/.test(p.title);
    if (
      (p.title === null || english) &&
      p.component !== null &&
      readComponent
    ) {
      const text = readComponent(p.component);
      const h =
        text === null ? null : pageHeading(text, (k) => messages.get(k));
      if (h !== null && (p.title === null || /[一-鿿]/.test(h))) {
        p.title = h;
        p.titleFrom = "heading";
      }
    }
  }
}

/** 子页没标题：借父页标题，写成「子用户管理 · overview」。在 resolveTitles 之后调。 */
export function inheritTitles(pages: UiPage[]): void {
  const by = new Map(pages.map((p) => [p.path, p]));
  for (const p of pages) {
    if (p.title !== null || p.parent === undefined) continue;
    const parent = by.get(p.parent);
    if (parent?.title == null) continue;
    const tail = p.path.slice(p.parent.length).replace(/^\//, "");
    p.title = tail === "" ? parent.title : `${parent.title} · ${tail}`;
    p.titleFrom = "parent";
  }
}

/** 同一路径出现多次（影子副本、别名）：保留信息最全的那条。 */
function dedupe(pages: UiPage[]): UiPage[] {
  const by = new Map<string, UiPage>();
  for (const p of pages) {
    const prev = by.get(p.path);
    const score = (x: UiPage): number =>
      (x.title === null ? 0 : 2) + (x.component === null ? 0 : 1);
    if (prev === undefined || score(p) > score(prev)) by.set(p.path, p);
  }
  return [...by.values()];
}
