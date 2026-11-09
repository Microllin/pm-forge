import { useSyncExternalStore } from "react";

/**
 * 界面偏好。存 localStorage，不进服务端：
 *
 * - 它是**纯呈现**偏好，每台设备一份；服务器就跑在本机，所谓「跨设备同步」没有收益。
 * - 它必须在**首帧之前**就拿到。走 HTTP 的话第一条思考部件会先按默认值画一次再跳，
 *   用户看到的就是闪一下。localStorage 是同步读，不存在这个窗口。
 */

const KEY = "pmforge-chat.reasoning-display";

export const REASONING_DISPLAY = [
  "collapsed",
  "streaming",
  "expanded",
] as const;
export type ReasoningDisplay = (typeof REASONING_DISPLAY)[number];

export const REASONING_DISPLAY_LABEL: Record<ReasoningDisplay, string> = {
  collapsed: "折叠",
  streaming: "边想边看",
  expanded: "始终展开",
};

export const REASONING_DISPLAY_HINT: Record<ReasoningDisplay, string> = {
  collapsed: "只显示标题与字数，点开才看正文。",
  streaming: "思考时自动展开，答完自动收起。",
  expanded: "思考过程一直摊开，不用点。",
};

const DEFAULT: ReasoningDisplay = "collapsed";

function isMode(value: unknown): value is ReasoningDisplay {
  return (
    typeof value === "string" &&
    (REASONING_DISPLAY as readonly string[]).includes(value)
  );
}

function read(): ReasoningDisplay {
  try {
    const raw = localStorage.getItem(KEY);
    return isMode(raw) ? raw : DEFAULT;
  } catch {
    // 隐私模式、禁用 site data，以及 Node 24 那个需要 --localstorage-file 才
    // 可用的实验性 localStorage（测试环境拿到的就是它）——读不到一律用默认值，
    // 不让一个偏好把页面带崩。测试要验真实解析逻辑就得自己注入一个可用的
    // Storage（见 ui-prefs.test.ts，口径与 apps/web 的 persist.test.ts 一致）。
    return DEFAULT;
  }
}

/**
 * 快照必须是**稳定引用**：useSyncExternalStore 每次渲染都会调 getSnapshot，
 * 现读现返回在值不变时也算「变了」，会把组件打进无限重渲染。
 */
let snapshot: ReasoningDisplay = read();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setReasoningDisplay(mode: ReasoningDisplay): void {
  snapshot = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // 存不下就只在本次会话里生效，总比点了没反应强。
  }
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // 同一个服务开了两个标签页时，另一边改了设置这边也跟上。
  const onStorage = (e: StorageEvent): void => {
    if (e.key !== null && e.key !== KEY) return;
    snapshot = read();
    emit();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

export function useReasoningDisplay(): ReasoningDisplay {
  return useSyncExternalStore(subscribe, () => snapshot);
}
