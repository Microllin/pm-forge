import { readSse } from "../api";
import { createRequest, json } from "../http";

/** 测试环境登记。形状与 server/browse/routes.ts 一一对应；账号密码只写不读。 */

const request = createRequest("/api");

export interface TestEnv {
  id: string;
  productId: string;
  frontendRoot: string | null;
  baseUrl: string;
  loginPath: string;
  role: string;
  selectors: { username?: string; password?: string; submit?: string };
  /** 账号密码存了没有（值本身永远拿不到） */
  hasCredential: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface EnvForm {
  baseUrl: string;
  loginPath: string;
  role: string;
  frontendRoot: string | null;
  /** 编辑时留空 = 沿用原来存的 */
  username?: string;
  password?: string;
}

export const listEnvs = (productId: string) =>
  request<{ envs: TestEnv[] }>(`/products/${productId}/envs`).then(
    (r) => r.envs,
  );

export const createEnv = (productId: string, form: EnvForm) =>
  request<TestEnv>(`/products/${productId}/envs`, {
    method: "POST",
    ...json(form),
  });

export const updateEnv = (productId: string, envId: string, form: EnvForm) =>
  request<TestEnv>(`/products/${productId}/envs/${envId}`, {
    method: "PATCH",
    ...json(form),
  });

export const deleteEnv = (productId: string, envId: string) =>
  request<undefined>(`/products/${productId}/envs/${envId}`, {
    method: "DELETE",
  });

export const testEnv = (productId: string, envId: string) =>
  request<
    | { ok: true; landed: string; title: string; preview: string }
    | { ok: false; reason: string }
  >(`/products/${productId}/envs/${envId}/test`, { method: "POST" });

/* ── 浏览器内核（AI 的眼睛）：服务自己带一个，不依赖这台机器装了什么 ── */

export interface BrowserStatus {
  ok: boolean;
  source: "env" | "bundled" | "system-cache" | null;
  sizeMb: number;
  reason: string | null;
}

export const browserStatus = () => request<BrowserStatus>("/browser/status");

export const removeBrowser = () =>
  request<undefined>("/browser", { method: "DELETE" });

/** 安装内核（SSE 推进度；下载慢是常态，界面要能边看边等）。 */
export const installBrowser = (
  onEvent: (
    e:
      | { type: "log"; line: string }
      | { type: "done"; ok: boolean; log: string[] },
  ) => void,
) =>
  readSse("/api/browser/install", {}, (e) =>
    onEvent(
      e as
        | { type: "log"; line: string }
        | { type: "done"; ok: boolean; log: string[] },
    ),
  );
