import { useSyncExternalStore } from "react";

/**
 * 主题偏好：跟随系统 / 浅色 / 深色，默认深色。口径与 ui-prefs.ts 一致——存本机 localStorage，
 * 不进服务端，模块加载时就读、就写到 <html data-theme>，首帧不闪。
 *
 * 「跟随系统」= 不写 data-theme，交给 styles.css 里的 prefers-color-scheme 媒体查询；
 * 选了浅色/深色才写属性，属性选择器优先级压过媒体查询。
 */

const KEY = "pmforge-chat.theme";

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export const THEME_LABEL: Record<Theme, string> = {
  system: "跟随系统",
  light: "浅色",
  dark: "深色",
};

function isTheme(value: unknown): value is Theme {
  return (
    typeof value === "string" && (THEMES as readonly string[]).includes(value)
  );
}

/** 没选过就是深色（黑紫）：这是平台的主视觉，白紫在顶栏切换。 */
const DEFAULT_THEME: Theme = "dark";

function read(): Theme {
  try {
    const raw = localStorage.getItem(KEY);
    return isTheme(raw) ? raw : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

function apply(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

let snapshot: Theme = read();
apply(snapshot);
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setTheme(theme: Theme): void {
  snapshot = theme;
  apply(theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // 存不下就只在本次会话里生效。
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (e: StorageEvent): void => {
    if (e.key !== null && e.key !== KEY) return;
    snapshot = read();
    apply(snapshot);
    emit();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => snapshot);
}
