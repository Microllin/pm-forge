import { describe, expect, it } from "vitest";

import type { UiPage } from "./api";
import { accessKind, groupPages, shortPath } from "./group";

/**
 * 页面清单的分组与筛选。要钉住：有菜单分组按菜单分、没有按路径第一段；
 * 跳转默认藏起来；访问筛选三档互斥。
 */

const page = (path: string, extra: Partial<UiPage> = {}): UiPage => ({
  path,
  name: null,
  title: null,
  titleFrom: null,
  section: null,
  access: [],
  component: null,
  redirect: null,
  aliases: [],
  source: "/r/router.ts",
  titleKey: null,
  ...extra,
});

describe("页面清单分组", () => {
  const pages = [
    page("/"),
    page("/login", { access: ["不用登录"] }),
    page("/admin/a", { access: ["需登录", "仅管理员"] }),
    page("/admin/b", { access: ["需登录", "仅管理员"] }),
    page("/keys", { access: ["需登录"], title: "API 密钥" }),
    page("/old", { redirect: "/keys" }),
    page("/system/users", {
      section: "系统管理",
      access: ["权限 system:manage"],
    }),
  ];
  const all = { query: "", access: "all" as const, showRedirects: false };

  it("有菜单分组按菜单分；没有按路径第一段；只有一段的合成「顶层页面」排最前", () => {
    const groups = groupPages(pages, all);
    expect(groups[0]?.label).toBe("顶层页面");
    expect(groups[0]?.pages.map((p) => p.path)).toEqual([
      "/",
      "/login",
      "/keys",
    ]);
    expect(groups.map((g) => g.label)).toContain("系统管理");
    expect(groups.find((g) => g.label === "/admin")?.pages).toHaveLength(2);
  });

  it("只做跳转的默认藏起来，勾上才显示", () => {
    const count = (o: typeof all) =>
      groupPages(pages, o).reduce((n, g) => n + g.pages.length, 0);
    expect(count(all)).toBe(6);
    expect(count({ ...all, showRedirects: true })).toBe(7);
  });

  it("访问筛选：公开 / 登录可见 / 限角色三档互斥", () => {
    expect(accessKind(pages[1] ?? page("/"))).toBe("public");
    expect(accessKind(pages[4] ?? page("/"))).toBe("login");
    expect(accessKind(pages[2] ?? page("/"))).toBe("admin");
    expect(accessKind(pages[6] ?? page("/"))).toBe("admin");
    const admin = groupPages(pages, { ...all, access: "admin" });
    expect(admin.flatMap((g) => g.pages.map((p) => p.path))).toEqual([
      "/admin/a",
      "/admin/b",
      "/system/users",
    ]);
  });

  it("搜索认标题、路径、菜单", () => {
    const hit = (q: string) =>
      groupPages(pages, { ...all, query: q }).flatMap((g) =>
        g.pages.map((p) => p.path),
      );
    expect(hit("密钥")).toEqual(["/keys"]);
    expect(hit("系统管理")).toEqual(["/system/users"]);
  });

  it("相对路径只去掉代码目录前缀", () => {
    expect(shortPath("/代码库/R/a/b.vue", "/代码库/R")).toBe("a/b.vue");
    expect(shortPath("/别处/x.vue", "/代码库/R")).toBe("/别处/x.vue");
  });
});
