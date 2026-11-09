import { isIP } from "node:net";

/**
 * 出站地址校验：拦住指向本机、内网与云元数据地址的请求。
 *
 * 为什么需要：模型接口地址（baseUrl）由用户在设置页填，服务端会**带着真实 API key**
 * 去请求它。填成 `http://169.254.169.254/latest/meta-data/...`（云厂商元数据）、
 * `http://127.0.0.1:4400/api/...`（打自己）或者内网某台机器时，服务端会照做，
 * 并且把 key 一起发过去。改这个地址虽然要登录，但属于「被诱导一次就外泄」的面。
 *
 * 取舍：**只拦字面量 IP 与已知元数据主机名，不做 DNS 解析**。
 * 解析再校验会引入「解析时是公网、请求时是内网」的 TOCTOU 窗口，且会让每次请求多一次
 * DNS 往返；而真实使用里没人会把模型接口填成内网域名。留一条白名单给本地推理服务
 * （Ollama 之类跑在 127.0.0.1 上很常见），由调用方显式放行。
 */

/** 云厂商元数据地址：这些是「请求一次就能拿到临时凭证」的地址，必须挡死。 */
const METADATA_HOSTS = new Set([
  "169.254.169.254", // AWS / GCP / Azure / OpenStack
  "metadata.google.internal",
  "metadata.goog",
  "instance-data", // AWS 旧版
  "fd00:ec2::254", // AWS IPv6
]);

/** 本机与内网的地址段。 */
function isPrivateAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  const v = isIP(bare);
  if (v === 4) {
    const [a = 0, b = 0] = bare.split(".").map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // 链路本地，含元数据地址
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (v === 6) {
    const lower = bare.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fe80")) return true; // 链路本地
    if (/^f[cd]/.test(lower)) return true; // 唯一本地地址 fc00::/7
    // IPv4 映射地址：::ffff:127.0.0.1
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
    return mapped === undefined ? false : isPrivateAddress(mapped);
  }
  // 不是 IP：按主机名判。
  return (
    METADATA_HOSTS.has(bare.toLowerCase()) || bare.toLowerCase() === "localhost"
  );
}

export interface OutboundCheck {
  /** 允许指向本机与内网（本地推理服务）。 */
  allowLocal?: boolean;
}

/**
 * 校验一个出站 URL；不合法抛错误消息（调用方转成 400）。
 * 返回 null 表示通过。
 */
export function outboundProblem(
  raw: string,
  options: OutboundCheck = {},
): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "地址不是合法的 URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return "地址只能用 http 或 https";
  if (options.allowLocal === true) return null;
  if (isPrivateAddress(url.hostname))
    return "地址指向本机或内网。如果是在本机跑模型服务，请在设置里勾选「允许本机地址」";
  return null;
}
