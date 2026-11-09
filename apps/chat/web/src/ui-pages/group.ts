import type { UiPage } from "./api";

/**
 * 页面清单的分组与筛选。纯函数，便于单测。
 *
 * 分组口径：代码里写了菜单分组（nav.section）就按它；没写的按路径第一段
 * （`/admin/accounts` → `/admin`），因为管理端 / 用户端 / 团队端通常就是这么分的；
 * 只有一段的页面合成一组「顶层页面」。
 */

export interface PageGroup {
  key: string;
  label: string;
  pages: UiPage[];
}

export type AccessFilter = "all" | "public" | "login" | "admin";

export function accessKind(p: UiPage): Exclude<AccessFilter, "all"> {
  if (
    p.access.some(
      (a) => a === "仅管理员" || a.startsWith("角色") || a.startsWith("权限"),
    )
  )
    return "admin";
  if (p.access.includes("需登录")) return "login";
  return "public";
}

export function groupPages(
  pages: readonly UiPage[],
  options: { query: string; access: AccessFilter; showRedirects: boolean },
): PageGroup[] {
  const q = options.query.trim().toLowerCase();
  const kept = pages.filter((p) => {
    if (!options.showRedirects && p.redirect !== null) return false;
    if (options.access !== "all" && accessKind(p) !== options.access)
      return false;
    if (q === "") return true;
    return (
      p.path.toLowerCase().includes(q) ||
      (p.title ?? "").toLowerCase().includes(q) ||
      (p.section ?? "").toLowerCase().includes(q) ||
      (p.component ?? "").toLowerCase().includes(q)
    );
  });
  const groups = new Map<string, PageGroup>();
  for (const p of kept) {
    const segs = p.path.split("/").filter((x) => x !== "");
    // 只有一段的（/login、/subscriptions）归「顶层页面」：按第一段分会把它们拆成一堆
    // 只有一页的组（真实仓库 console-v2 实测拆出十几组）。两段以上才按第一段分。
    const first =
      segs.length >= 2 && !segs[0]?.startsWith(":") ? segs[0] : null;
    const key =
      p.section !== null ? `s:${p.section}` : first == null ? "/" : `/${first}`;
    const label = p.section ?? (first == null ? "顶层页面" : `/${first}`);
    const g = groups.get(key) ?? { key, label, pages: [] };
    g.pages.push(p);
    groups.set(key, g);
  }
  // 顶层页面在前，其余按页面数从多到少：页多的那组通常是主战场。
  return [...groups.values()].sort((a, b) =>
    a.key === "/"
      ? -1
      : b.key === "/"
        ? 1
        : b.pages.length - a.pages.length || (a.label < b.label ? -1 : 1),
  );
}

export const TITLE_FROM_LABEL: Record<
  Exclude<UiPage["titleFrom"], null>,
  string
> = {
  literal: "路由里写的",
  i18n: "按文案键查到的中文",
  heading: "页面自己的大标题",
  parent: "借父页面的标题",
};

/** 去掉文件库前缀，给人看相对路径。 */
export const shortPath = (path: string, root: string): string =>
  path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
