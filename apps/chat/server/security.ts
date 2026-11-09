import type { FastifyInstance, FastifyRequest } from "fastify";

import { HttpError } from "./errors.js";

/**
 * Host / Origin 校验。
 *
 * 不做登录（本地单用户），但这两道必须有：
 * - **Host**：挡 DNS rebinding。恶意网页把自己的域名解析到 127.0.0.1 后，
 *   浏览器会带着它自己的 Host 来访问本服务——只认回环 Host 就挡住了。
 * - **Origin**（仅写请求）：挡跨站。任意网页都能向 127.0.0.1 发 POST，
 *   不校验 Origin 等于让任何网站都能用你的 key 发起对话、升级 pi。
 */
export function registerSecurity(
  app: FastifyInstance,
  options: {
    port: number;
    webPort: number;
    extraOrigins: string[];
    /**
     * 显式绑定到这些地址时，它们也算合法 Host。
     *
     * 原来白名单写死回环：把 `PMFORGE_CHAT_HOST` 设成 `0.0.0.0`（或局域网 IP）后，
     * 外部访问带的是 `Host: 192.168.x.x:4400`，直接被 403——按文档做的「局域网部署」
     * 反而整个不可用，于是人们转而去暴露前端代理，把攻击面放大。
     * 这里只放行**显式配置**的地址：默认仍然是回环，DNS rebinding 那层防护不变。
     */
    bindHost?: string;
  },
): void {
  const loopback = ["127.0.0.1", "localhost", "[::1]"];
  // `0.0.0.0` / `::` 是「监听所有网卡」的形参，本身不是一个可访问的 Host，
  // 所以它出现时白名单保持回环（外部要访问，得配 extraOrigins 里的具体地址）。
  const bound =
    options.bindHost !== undefined &&
    !["0.0.0.0", "::", "127.0.0.1", "localhost"].includes(options.bindHost)
      ? [options.bindHost]
      : [];
  const hosts = new Set(
    [...loopback, ...bound].map((h) => `${h}:${String(options.port)}`),
  );
  const origins = new Set([
    ...loopback.map((h) => `http://${h}:${String(options.port)}`),
    ...loopback.map((h) => `http://${h}:${String(options.webPort)}`),
    ...options.extraOrigins,
  ]);

  app.addHook("onRequest", (request: FastifyRequest, _reply, done) => {
    const host = request.headers.host ?? "";
    if (!hosts.has(host)) {
      done(new HttpError(403, "FORBIDDEN_HOST", "Host 不在白名单"));
      return;
    }
    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
      const origin = request.headers.origin;
      if (origin !== undefined) {
        if (!origins.has(origin)) {
          done(new HttpError(403, "FORBIDDEN_ORIGIN", "Origin 不在白名单"));
          return;
        }
      } else {
        /*
         * 没有 Origin 的写请求。
         *
         * 原来一律放行，理由是「浏览器发起的跨站请求一定带 Origin」。那句话今天成立，
         * 但它让服务端的安全性建立在「浏览器一定会带某个 header」这个外部假设上——
         * 服务端自己只检查了 header 在不在。
         *
         * 改成：Origin 与 Sec-Fetch-Site **至少命中一个**。浏览器发的请求两者必有其一
         * （Sec-Fetch-* 自 2020 年起是主流浏览器默认带的），而 curl / 脚本两个都没有，
         * 照常放行。代价是零，换掉的是一个「靠假设」的缺口。
         */
        const site = request.headers["sec-fetch-site"];
        if (
          typeof site === "string" &&
          site !== "same-origin" &&
          site !== "none"
        ) {
          done(new HttpError(403, "FORBIDDEN_ORIGIN", "跨站写请求被拒绝"));
          return;
        }
      }
    }
    done();
  });
}
