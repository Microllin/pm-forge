import type { FastifyInstance } from "fastify";

import { notFound } from "../../errors.js";
import type { Catalog } from "../../products.js";
import { openReadOnly, type BrowserDeps } from "./browser.js";
import {
  browserSizeMb,
  findBrowser,
  installBrowser,
  removeBrowser,
} from "./chromium.js";
import type { EnvStore } from "./envs.js";

/**
 * 产品 → 测试环境登记。
 *
 *   GET    /api/products/:id/envs             列表（账号密码只回「已保存」）
 *   POST   /api/products/:id/envs             新增 { baseUrl, loginPath?, role?, frontendRoot?, selectors?, username?, password? }
 *   PATCH  /api/products/:id/envs/:envId      修改（不带账号密码 = 沿用原来的）
 *   DELETE /api/products/:id/envs/:envId      删除（连同账号密码文件）
 *   POST   /api/products/:id/envs/:envId/test 试登录一次：成功回首页标题与菜单，失败回原因
 *
 * 账号密码**永远不出现在任何响应里**。
 */
export function registerEnvRoutes(
  app: FastifyInstance,
  deps: {
    catalog: Catalog;
    envs: EnvStore;
    browser?: BrowserDeps;
    /** 数据目录：浏览器内核装在它下面。传了才开「安装浏览器」这组接口。 */
    dataDir?: string;
  },
): void {
  const productOr404 = (id: string) => {
    const p = deps.catalog
      .list()
      .flatMap((l) => l.products)
      .find((x) => x.id === id);
    if (p === undefined) throw notFound("产品不存在");
    return p;
  };
  const envOr404 = (productId: string, envId: string) => {
    const e = deps.envs.get(envId);
    if (e?.productId !== productId) throw notFound("没有这个测试环境");
    return e;
  };

  interface P {
    Params: { id: string };
  }
  interface PE {
    Params: { id: string; envId: string };
  }

  app.get<P>("/api/products/:id/envs", (request) => {
    productOr404(request.params.id);
    return { envs: deps.envs.list(request.params.id) };
  });

  app.post<P>("/api/products/:id/envs", async (request, reply) => {
    productOr404(request.params.id);
    const env = await deps.envs.save(
      request.params.id,
      request.body as Parameters<EnvStore["save"]>[1],
    );
    return reply.code(201).send(env);
  });

  app.patch<PE>("/api/products/:id/envs/:envId", async (request) => {
    productOr404(request.params.id);
    envOr404(request.params.id, request.params.envId);
    return deps.envs.save(
      request.params.id,
      request.body as Parameters<EnvStore["save"]>[1],
      request.params.envId,
    );
  });

  app.delete<PE>("/api/products/:id/envs/:envId", async (request, reply) => {
    productOr404(request.params.id);
    envOr404(request.params.id, request.params.envId);
    await deps.envs.remove(request.params.envId);
    return reply.code(204).send();
  });

  app.post<PE>("/api/products/:id/envs/:envId/test", async (request) => {
    productOr404(request.params.id);
    const env = envOr404(request.params.id, request.params.envId);
    const cred = await deps.envs.credential(env.id);
    if (cred === null) return { ok: false, reason: "还没存账号密码" };
    let browser: Awaited<ReturnType<typeof openReadOnly>> | undefined;
    try {
      browser = await openReadOnly(
        {
          baseUrl: env.baseUrl,
          loginPath: env.loginPath,
          username: cred.username,
          password: cred.password,
          selectors: env.selectors,
        },
        deps.browser,
      );
      const home = await browser.open("/");
      return {
        ok: true,
        landed: home.path,
        title: home.title,
        preview: home.text.split("\n").slice(0, 4).join("\n"),
      };
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : "登录失败" };
    } finally {
      await browser?.close();
    }
  });

  /* ── 浏览器内核：AI 的眼睛 ────────────────────────────────────────
   * 服务自己带一个内核（装到数据目录），不依赖这台机器碰巧装了什么。
   */

  /** 现在有没有可用内核、从哪来、服务自带那份占了多大。 */
  app.get("/api/browser/status", () => {
    const dataDir = deps.dataDir;
    if (dataDir === undefined)
      return { ok: false, source: null, sizeMb: 0, reason: "没有数据目录" };
    const info = findBrowser(dataDir);
    return {
      ok: info.path !== null,
      source: info.source,
      sizeMb: browserSizeMb(dataDir),
      reason:
        info.path === null
          ? "还没有可用的浏览器内核：AI 看不了页面"
          : info.source === "system-cache"
            ? "正在借用这台机器上已有的 playwright 缓存；建议装一份到服务自己名下"
            : null,
    };
  });

  /** 安装内核（SSE 推进度）。慢的时候能看着它走，不至于以为卡死。 */
  app.post("/api/browser/install", (request, reply) => {
    if (deps.dataDir === undefined) throw notFound("没有数据目录");
    const dataDir = deps.dataDir;
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // 断开后别再往这条流写（`writableEnded` 在客户端断开时为 false，不能只靠它）。
    // 安装本身继续跑完：它写的是磁盘，半途掐掉只会留下一个不完整的内核目录。
    let gone = false;
    raw.on("close", () => {
      gone = true;
    });
    const send = (event: Record<string, unknown>): void => {
      if (gone || raw.writableEnded) return;
      raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    void installBrowser(dataDir, (line) => {
      send({ type: "log", line });
    })
      .then((r) => {
        send({ type: "done", ...r });
        if (!gone) raw.end();
      })
      .catch((e: unknown) => {
        send({
          type: "done",
          ok: false,
          path: null,
          log: [e instanceof Error ? e.message : "安装失败"],
        });
        if (!gone) raw.end();
      });
  });

  app.delete("/api/browser", async (request, reply) => {
    if (deps.dataDir === undefined) throw notFound("没有数据目录");
    await removeBrowser(deps.dataDir);
    return reply.code(204).send();
  });
}
