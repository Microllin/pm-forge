import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import type { Db } from "./db.js";

/**
 * 模型接入配置——照 pi CLI 的心智模型：
 *
 * - **provider 可以有多个**：pi 内置的 provider 只要有 key 就算接入；自定义中转
 *   （RouteHub 这类）额外记接口地址、协议和它提供的模型清单。
 * - **可用模型 = 所有已接入 provider 的模型并集**，对话里随时切换（pi 的 /model）。
 * - **默认模型 / 默认思考强度只决定新会话的起点**；会话一旦切过模型，以会话自己
 *   transcript 里的 model_change 为准（pi 的语义，恢复时也按它来）。
 */

export const thinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ThinkingLevel = (typeof thinkingLevels)[number];

export const customApis = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
] as const;
export type CustomApi = (typeof customApis)[number];

export const providerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "只能用小写字母、数字、短横线");

export const customProviderSchema = z.object({
  id: providerIdSchema,
  baseUrl: z.url().max(500),
  api: z.enum(customApis),
  /** 这个中转提供的模型 id（通常由 /v1/models 拉取后勾选）。 */
  models: z
    .array(z.string().trim().min(1).max(200))
    .min(1, "至少要有一个模型")
    .max(500),
});
export type CustomProvider = z.infer<typeof customProviderSchema>;

export const modelRefSchema = z.object({
  provider: providerIdSchema,
  modelId: z.string().trim().min(1).max(200),
});
export type ModelRef = z.infer<typeof modelRefSchema>;

export const providersConfigSchema = z.object({
  custom: z.array(customProviderSchema),
  defaultModel: modelRefSchema.nullable(),
  defaultThinking: z.enum(thinkingLevels),
});
export type ProvidersConfig = z.infer<typeof providersConfigSchema>;

export const EMPTY_CONFIG: ProvidersConfig = {
  custom: [],
  defaultModel: null,
  defaultThinking: "medium",
};

const KEY = "providers";
/** 上一版的单份配置（一个 provider + 一个模型），读到时迁移成新结构。 */
const LEGACY_KEY = "model";

const legacySchema = z.object({
  providerId: providerIdSchema,
  modelId: z.string(),
  thinkingLevel: z.enum(thinkingLevels),
  custom: z
    .object({ baseUrl: z.url(), api: z.enum(customApis) })
    .loose()
    .nullable(),
});

function readSetting(db: Db, key: string): unknown {
  const row = db
    .prepare<[string], { value: string }>(
      "SELECT value FROM settings WHERE key = ?",
    )
    .get(key);
  return row ? (JSON.parse(row.value) as unknown) : undefined;
}

export function writeProvidersConfig(db: Db, config: ProvidersConfig): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(KEY, JSON.stringify(config));
}

export function readProvidersConfig(db: Db): ProvidersConfig {
  const current = providersConfigSchema.safeParse(readSetting(db, KEY));
  if (current.success) return current.data;

  // 迁移上一版的单份配置：中转变成一个自定义 provider，那个模型成为默认模型。
  const legacy = legacySchema.safeParse(readSetting(db, LEGACY_KEY));
  if (legacy.success) {
    const old = legacy.data;
    const migrated: ProvidersConfig = {
      custom: old.custom
        ? [
            {
              id: old.providerId,
              baseUrl: old.custom.baseUrl,
              api: old.custom.api,
              models: [old.modelId],
            },
          ]
        : [],
      defaultModel:
        old.modelId === ""
          ? null
          : { provider: old.providerId, modelId: old.modelId },
      defaultThinking: old.thinkingLevel,
    };
    writeProvidersConfig(db, migrated);
    db.prepare("DELETE FROM settings WHERE key = ?").run(LEGACY_KEY);
    return migrated;
  }
  // 宽容读：结构不合法当作空配置，而不是让整个服务起不来。
  return EMPTY_CONFIG;
}

/**
 * API key：按 provider 存文件（0600，目录 0700），不进数据库——数据库会被备份、
 * 复制、拿去排查问题，key 不该跟着走。
 *
 * 环境变量 `PMFORGE_CHAT_KEY_<PROVIDER>`（大写，`-` 换成 `_`）优先：临时实例 /
 * 容器注入用，不落盘。按 provider 分开而不是一个总变量：pi 内置几十个 provider，
 * 一个总 key 会让它们全部「看起来已接入」，模型列表里塞满用不了的模型。
 */
export type KeySource = "env" | "file" | "none";

export interface KeyStore {
  get(providerId: string): Promise<{ value: string | null; source: KeySource }>;
  set(providerId: string, value: string): Promise<void>;
  clear(providerId: string): Promise<void>;
  /** 有 key 的 provider（文件 + 环境变量）。 */
  list(): Promise<string[]>;
}

export const envKeyName = (providerId: string): string =>
  `PMFORGE_CHAT_KEY_${providerId.toUpperCase().replace(/-/g, "_")}`;

export function createKeyStore(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): KeyStore {
  const dir = join(dataDir, "keys");
  const pathOf = (providerId: string): string =>
    join(dir, providerIdSchema.parse(providerId));
  // 空字符串也算没有：`KEY=` 这种写法常见于模板，不该让 provider 显示为已接入。
  const fromEnv = (providerId: string): string | undefined => {
    const value = env[envKeyName(providerId)]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  return {
    async get(providerId) {
      const e = fromEnv(providerId);
      if (e) return { value: e, source: "env" };
      const value = (
        await readFile(pathOf(providerId), "utf8").catch(() => "")
      ).trim();
      return value === ""
        ? { value: null, source: "none" }
        : { value, source: "file" };
    },
    async set(providerId, value) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(pathOf(providerId), `${value.trim()}\n`, { mode: 0o600 });
      // writeFile 的 mode 只在新建时生效；已存在的文件也收紧一次。
      await chmod(pathOf(providerId), 0o600);
    },
    async clear(providerId) {
      await rm(pathOf(providerId), { force: true });
    },
    async list() {
      const files = await readdir(dir).catch(() => [] as string[]);
      const fromFiles = files.filter(
        (f) => providerIdSchema.safeParse(f).success,
      );
      const fromEnvVars = Object.keys(env)
        .filter((k) => k.startsWith("PMFORGE_CHAT_KEY_") && env[k]?.trim())
        .map((k) =>
          k.slice("PMFORGE_CHAT_KEY_".length).toLowerCase().replace(/_/g, "-"),
        );
      return [...new Set([...fromFiles, ...fromEnvVars])].sort();
    },
  };
}
