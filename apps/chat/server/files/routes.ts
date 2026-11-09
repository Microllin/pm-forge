import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import { contentTypeOf } from "./kinds.js";
import { Readable } from "node:stream";

import { HttpError } from "../errors.js";
import { formatLimit, type FileStore } from "./store.js";

/**
 * 文件模块（一级菜单「文件」）的接口。路径一律是以 / 开头的相对路径（根是 "/"）。
 *
 *   GET    /api/files/list?path=            列一个文件夹（文件夹在前）
 *   GET    /api/files/item?path=&content=1  单个文件的信息；文本类且不太大时带内容
 *   GET    /api/files/raw[/文件名]?path=[&download=1] 文件原始内容（在线查看 / 下载）
 *   PUT    /api/files/content?path=&mode=[&parents=1]  上传 / 新建 / 保存（请求体是原始字节）
 *          mode = create（同名 409）| overwrite（覆盖，可带 If-Match 防误覆盖）
 *               | autorename（同名时自动改成「名称 (1).ext」）
 *          parents=1：缺失的上级文件夹自动新建（上传整个文件夹时用）
 *   POST   /api/files/folders  { path, autorename? }  新建文件夹
 *   POST   /api/files/move     { from, to } 移动 / 改名
 *   POST   /api/files/copy     { from, to } 复制（目标已存在时自动改名）
 *   POST   /api/files/batch    { action: move|copy|delete, paths, target? }  批量，逐项报告结果
 *   POST   /api/files/zip      { paths }    打包下载（zip）
 *   DELETE /api/files/entry?path=[&recursive=1]  删除；非空文件夹必须带 recursive
 *   GET    /api/files/search?q=             按名称与内容搜索全部文件
 *   POST   /api/files/reindex               重建索引（在 Finder 里大量改动之后）
 */

const pathQuery = z.object({ path: z.string() });
const flag = z
  .enum(["1", "true", "0", "false"])
  .optional()
  .transform((v) => v === "1" || v === "true");

/**
 * 在线查看（inline）时的安全头。文本类本来就以 text/plain 下发；再加一层
 * `CSP: sandbox`——即使有人直接打开某个 SVG / HTML 的 raw 地址，它也运行在
 * 不透明来源里，碰不到本站的接口与 cookie。
 *
 * PDF 例外：Chrome 的内置 PDF 阅读器在 sandbox CSP 下会被拦掉；PDF 里的脚本
 * 由阅读器自己的沙箱处理。
 */
const SANDBOX_CSP =
  "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'";

/** Content-Disposition：ASCII 兜底名 + RFC 5987 的 UTF-8 名（中文文件名下载不乱码）。 */
function disposition(type: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function registerFileRoutes(
  app: FastifyInstance,
  files: FileStore,
): void {
  // 单独一个作用域：原始字节的请求体解析只对这里的路由生效。错误处理与安全闸从父级继承。
  void app.register((scope, _opts, done) => {
    // 原始字节的请求体不在这里读：原样把流交给路由，由存储边收边写进临时文件。
    // 这样几百 MB 的文件也不占内存；上限由存储计数把关（见 store.spill）。
    scope.addContentTypeParser(
      "application/octet-stream",
      (_request, payload, next) => {
        next(null, payload);
      },
    );

    scope.get("/api/files/list", (request) =>
      files.list(pathQuery.parse(request.query).path),
    );

    scope.get("/api/files/item", (request) => {
      const q = pathQuery.extend({ content: flag }).parse(request.query);
      return files.item(q.path, { content: q.content });
    });

    /**
     * 地址末尾可以带上文件名（/api/files/raw/规格.pdf?path=…）：浏览器内置的 PDF 阅读器
     * 拿 URL 最后一段当标题和「另存为」的默认文件名。这一段只是给浏览器看的，
     * 定位文件始终以 path 为准。
     */
    const raw = async (request: FastifyRequest, reply: FastifyReply) => {
      const q = pathQuery.extend({ download: flag }).parse(request.query);
      const { entry, stream } = await files.openRead(q.path);
      reply
        .header(
          "Content-Type",
          contentTypeOf(
            entry.name,
            entry.kind === "folder" ? "other" : entry.kind,
          ),
        )
        .header("Content-Length", String(entry.size))
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-cache")
        .header("ETag", `"${entry.version}"`)
        .header(
          "Content-Disposition",
          disposition(q.download ? "attachment" : "inline", entry.name),
        );
      if (!q.download && entry.kind !== "pdf")
        reply.header("Content-Security-Policy", SANDBOX_CSP);
      return reply.send(stream);
    };
    scope.get("/api/files/raw", raw);
    scope.get("/api/files/raw/:name", raw);

    scope.put("/api/files/content", async (request, reply) => {
      const q = pathQuery
        .extend({
          mode: z.enum(["create", "overwrite", "autorename"]).default("create"),
          parents: flag,
        })
        .parse(request.query);
      const ifMatch = request.headers["if-match"];
      const expectedVersion =
        typeof ifMatch === "string" && ifMatch !== ""
          ? ifMatch.replace(/^W\//, "").replace(/"/g, "")
          : undefined;
      // 声明的长度已经超过上限：不读请求体，直接拒绝（浏览器上传文件时总会带 Content-Length）。
      const declared = Number(request.headers["content-length"]);
      if (Number.isFinite(declared) && declared > files.uploadLimit) {
        throw new HttpError(
          413,
          "TOO_LARGE",
          `文件超过 ${formatLimit(files.uploadLimit)} 上限`,
        );
      }
      // 空请求体（比如新建一个空的 .md）时 fastify 不调用解析器，body 是 undefined。
      const data =
        request.body instanceof Readable ? request.body : Buffer.alloc(0);
      const result = await files.write(q.path, data, {
        mode: q.mode,
        parents: q.parents,
        ...(expectedVersion === undefined ? {} : { expectedVersion }),
      });
      return reply.code(result.created ? 201 : 200).send(result);
    });

    scope.post("/api/files/folders", async (request, reply) => {
      const body = pathQuery
        .extend({ autorename: z.boolean().optional() })
        .parse(request.body);
      const entry = await files.createFolder(body.path, {
        autorename: body.autorename === true,
      });
      return reply.code(201).send(entry);
    });

    scope.post("/api/files/move", (request) => {
      const body = z
        .object({ from: z.string(), to: z.string() })
        .parse(request.body);
      return files.move(body.from, body.to);
    });

    scope.post("/api/files/copy", async (request, reply) => {
      const body = z
        .object({ from: z.string(), to: z.string() })
        .parse(request.body);
      return reply.code(201).send(await files.copy(body.from, body.to));
    });

    scope.post("/api/files/batch", (request) => {
      const body = z
        .object({
          action: z.enum(["move", "copy", "delete"]),
          paths: z.array(z.string()).min(1, "没有选中任何文件").max(1000),
          target: z.string().optional(),
        })
        .parse(request.body);
      return files.batch(body.action, body.paths, body.target);
    });

    scope.post("/api/files/zip", async (request, reply) => {
      const body = z
        .object({
          paths: z.array(z.string()).min(1, "没有选中任何文件").max(1000),
        })
        .parse(request.body);
      const { data, name } = await files.zip(body.paths);
      return reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", disposition("attachment", name))
        .send(data);
    });

    scope.delete("/api/files/entry", async (request, reply) => {
      const q = pathQuery.extend({ recursive: flag }).parse(request.query);
      await files.remove(q.path, { recursive: q.recursive });
      return reply.code(204).send();
    });

    scope.get("/api/files/search", (request) => {
      const q = z.object({ q: z.string().max(200) }).parse(request.query);
      return { hits: files.search(q.q) };
    });

    scope.post("/api/files/reindex", async () => ({
      count: await files.reindex(),
    }));

    done();
  });
}
