import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 服务配置。全部来自环境变量，给默认值——本地单用户服务，零配置能跑起来。
 *
 * 只监听回环地址：这个服务能替你调用模型、花你的 key，不该暴露到局域网。
 * 真要远程用，应当前面加一层带鉴权的反代，而不是把这里改成 0.0.0.0。
 */
export interface ChatConfig {
  host: string;
  port: number;
  /** 前端开发服务器端口。只用于 Origin 白名单。 */
  webPort: number;
  dataDir: string;
  /** 额外放行的 Origin（逗号分隔）。 */
  extraOrigins: string[];
  /** 文件模块单个文件的上传上限（字节）。 */
  fileUploadLimit: number;
}

export const DEFAULT_PORT = 4400;
export const DEFAULT_WEB_PORT = 3200;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ChatConfig {
  return {
    host: env.PMFORGE_CHAT_HOST ?? "127.0.0.1",
    port: Number(env.PMFORGE_CHAT_PORT ?? DEFAULT_PORT),
    webPort: Number(env.PMFORGE_CHAT_WEB_PORT ?? DEFAULT_WEB_PORT),
    dataDir: env.PMFORGE_CHAT_DATA_DIR ?? join(homedir(), ".pmforge-chat"),
    fileUploadLimit:
      Number(env.PMFORGE_CHAT_FILE_LIMIT_MB ?? 2048) * 1024 * 1024,
    extraOrigins: (env.PMFORGE_CHAT_ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** supervisor 与服务之间的约定：以此退出码退出 = 请求重启（如升级 pi 之后）。 */
export const RESTART_EXIT_CODE = 75;
