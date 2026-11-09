import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { Db } from "../../db.js";

/**
 * 测试环境登记：一个产品的某个前端 → 测试环境地址 + 测试账号。
 *
 * 地址、登录页、身份说明进数据库；**账号密码不进数据库**，单独写到数据目录
 * `envs/<id>.json`（目录 700、文件 600，与模型 Key 同一口径），接口永远不回传它们，
 * 只回「已保存」。
 */

export interface TestEnv {
  id: string;
  productId: string;
  /** 前端根目录（页面清单认出来的那个）；整个产品只登记一个环境时可为 null。 */
  frontendRoot: string | null;
  baseUrl: string;
  loginPath: string;
  /** 这个账号是什么身份，如「平台管理员」「普通租户」：写进 AI 看到的结果里。 */
  role: string;
  selectors: { username?: string; password?: string; submit?: string };
  hasCredential: boolean;
  createdAt: number;
  updatedAt: number;
}

export const envInput = z.object({
  frontendRoot: z.string().trim().min(1).nullable().optional(),
  baseUrl: z
    .url({ message: "环境地址不是有效的网址" })
    .trim()
    .refine((u) => /^https?:\/\//.test(u), "只支持 http / https"),
  loginPath: z.string().trim().startsWith("/").default("/login"),
  role: z.string().trim().max(40).default(""),
  selectors: z
    .object({
      username: z.string().trim().max(200).optional(),
      password: z.string().trim().max(200).optional(),
      submit: z.string().trim().max(200).optional(),
    })
    .default({}),
  username: z.string().max(200).optional(),
  password: z.string().max(500).optional(),
});
export type EnvInput = z.input<typeof envInput>;

export const ENV_MIGRATION = `
  CREATE TABLE test_envs (
    id            TEXT PRIMARY KEY,
    product_id    TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    frontend_root TEXT,
    base_url      TEXT NOT NULL,
    login_path    TEXT NOT NULL DEFAULT '/login',
    role          TEXT NOT NULL DEFAULT '',
    selectors     TEXT NOT NULL DEFAULT '{}',
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE INDEX test_envs_product_idx ON test_envs(product_id);
`;

interface Row {
  id: string;
  product_id: string;
  frontend_root: string | null;
  base_url: string;
  login_path: string;
  role: string;
  selectors: string;
  created_at: number;
  updated_at: number;
}

export interface Credential {
  username: string;
  password: string;
}

export interface EnvStore {
  list(productId: string): TestEnv[];
  get(id: string): TestEnv | undefined;
  save(productId: string, input: EnvInput, id?: string): Promise<TestEnv>;
  remove(id: string): Promise<void>;
  /** 只给浏览器层用：拿账号密码。 */
  credential(id: string): Promise<Credential | null>;
}

export function createEnvStore(
  db: Db,
  dataDir: string,
  now: () => number = Date.now,
): EnvStore {
  const dir = join(dataDir, "envs");
  const credPath = (id: string): string => join(dir, `${id}.json`);
  const hasCred = new Map<string, boolean>();

  const toEnv = (r: Row): TestEnv => ({
    id: r.id,
    productId: r.product_id,
    frontendRoot: r.frontend_root,
    baseUrl: r.base_url,
    loginPath: r.login_path,
    role: r.role,
    selectors: JSON.parse(r.selectors) as TestEnv["selectors"],
    hasCredential: hasCred.get(r.id) ?? false,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  });

  const readCred = async (id: string): Promise<Credential | null> => {
    try {
      const v = JSON.parse(await readFile(credPath(id), "utf8")) as Credential;
      return typeof v.username === "string" && typeof v.password === "string"
        ? v
        : null;
    } catch {
      return null;
    }
  };

  // 启动时记下哪些环境存了账号（列表接口是同步的，不为它每次读盘）。
  void (async () => {
    for (const r of db
      .prepare<[], { id: string }>("SELECT id FROM test_envs")
      .all())
      hasCred.set(r.id, (await readCred(r.id)) !== null);
  })();

  return {
    list(productId) {
      return db
        .prepare<[string], Row>(
          "SELECT * FROM test_envs WHERE product_id = ? ORDER BY created_at",
        )
        .all(productId)
        .map(toEnv);
    },
    get(id) {
      const r = db
        .prepare<[string], Row>("SELECT * FROM test_envs WHERE id = ?")
        .get(id);
      return r === undefined ? undefined : toEnv(r);
    },
    async save(productId, raw, id) {
      const v = envInput.parse(raw);
      const t = now();
      const envId =
        id ?? `env_${t.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      const base = new URL(v.baseUrl);
      const baseUrl = `${base.protocol}//${base.host}`;
      if (id === undefined)
        db.prepare(
          `INSERT INTO test_envs (id, product_id, frontend_root, base_url, login_path, role, selectors, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          envId,
          productId,
          v.frontendRoot ?? null,
          baseUrl,
          v.loginPath,
          v.role,
          JSON.stringify(v.selectors),
          t,
          t,
        );
      else
        db.prepare(
          `UPDATE test_envs SET frontend_root = ?, base_url = ?, login_path = ?, role = ?, selectors = ?, updated_at = ?
            WHERE id = ? AND product_id = ?`,
        ).run(
          v.frontendRoot ?? null,
          baseUrl,
          v.loginPath,
          v.role,
          JSON.stringify(v.selectors),
          t,
          envId,
          productId,
        );
      // 账号密码：给了才写（编辑时不填 = 沿用原来的）。
      if (
        v.username !== undefined &&
        v.password !== undefined &&
        v.username !== ""
      ) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        await writeFile(
          credPath(envId),
          JSON.stringify({ username: v.username, password: v.password }),
          { mode: 0o600 },
        );
        await chmod(credPath(envId), 0o600);
        hasCred.set(envId, true);
      }
      const saved = this.get(envId);
      if (saved === undefined) throw new Error("保存失败");
      return saved;
    },
    async remove(id) {
      db.prepare("DELETE FROM test_envs WHERE id = ?").run(id);
      await rm(credPath(id), { force: true });
      hasCred.delete(id);
    },
    credential: readCred,
  };
}
