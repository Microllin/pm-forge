import { createRequest, json } from "../http";

/** 登录接口（服务端 server/auth.ts）。 */
export const authRequest = createRequest("/api/auth");

export interface AuthUser {
  id: string;
  username: string;
}
export interface AuthStatus {
  setupRequired: boolean;
  user: AuthUser | null;
}

export const AUTH_KEY = ["auth-status"] as const;

export const getAuthStatus = () => authRequest<AuthStatus>("/status");
export const logout = () =>
  authRequest<{ ok: true }>("/logout", { method: "POST", ...json({}) });
export const changePassword = (current: string, next: string) =>
  authRequest<{ ok: true }>("/password", {
    method: "POST",
    ...json({ current, next }),
  });
