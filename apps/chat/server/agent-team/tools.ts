import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { Db } from "../db.js";
import type { EvidenceService } from "../evidence/index.js";
import type { FileStore } from "../files/store.js";
import { secretByContent, secretByName } from "../analysis/scan.js";
import type { IntelStore } from "../intel/store.js";
import {
  intelProposeTool,
  intelReadTool,
  intelSearchTool,
} from "../intel/tools.js";
import type { DraftStore } from "../staging/drafts.js";
import { STAGING_DIRS } from "../staging/paths.js";
import { suggestTarget } from "../staging/suggest.js";
import {
  formatWebSearch,
  webSearch,
  type WebSearchTarget,
} from "./web-search.js";

/**
 * 智能体的「手」：PMForge 工具注册表。
 *
 * 智能体定义的 `tools:` 写的是这里的名字。不在表里的名字（比如终端 pi 的
 * read / bash）在平台内运行时**静默忽略**——同一份定义还要分发给终端里的 pi，
 * 那边的工具名不归我们校验。
 *
 * 权限级别：
 * - 观察：只读，无副作用。
 * - 协调：只产生「待人确认」的东西（草稿）。
 * 没有执行级工具：智能体不能改正式文档、不能改代码、不能提交任何外部系统。
 */

export type ToolLevel = "observe" | "coordinate";

export interface ToolContext {
  /** 派活那条会话绑定的产品（可空）。 */
  productId: string | null;
  /** 谁在用（写草稿时进路径，人一眼看出是谁写的）。 */
  agentName: string;
  /** 本次运行 id（写草稿时进路径，同一次运行的产出放一起）。 */
  runId: string;
  /** 当前模型的联网目标；null = 当前模型协议不支持联网。 */
  webTarget: () => Promise<WebSearchTarget | null>;
}

export interface ToolDeps {
  db: Db;
  files?: FileStore | undefined;
  evidence?: EvidenceService | undefined;
  /** 临时区的草稿登记。没有它时 draft_write 只写文件不登记（测试里的最小装配）。 */
  drafts?: DraftStore | undefined;
  /** 市场情报库（外部参考资料）。没有它就不注册 intel_* 三件工具。 */
  intel?: IntelStore | undefined;
  now?: () => number;
  /** 测试注入。 */
  fetchImpl?: typeof fetch;
}

export interface ToolSpec {
  name: string;
  label: string;
  level: ToolLevel;
  /** 给人看的一句话（执行体页面用）。 */
  summary: string;
  build(ctx: ToolContext): ToolDefinition;
}

/** 一次读文件交回的最大字符数。更长的分页读（offset）。 */
export const READ_LIMIT = 30_000;
/** 智能体草稿在临时区里的位置。人确认后才进正式位置。 */
export const AGENT_DRAFT_ROOT = STAGING_DIRS.agent;

/**
 * 疑似凭据：只给路径不给正文（与事实依据同一条红线）。
 *
 * 规则统一放在 `analysis/scan.ts`（按文件名 + 按正文特征两道），这里直接用同一份，
 * 不维护第二套。原来这里只有文件名一道、且正则比那边窄：`docker-compose.yml`、
 * `application.yml`、`values.yaml` 里常写着库密码与第三方 key，按文件名匹配不到，
 * 正文也没人看，于是直接进了模型上下文——再随对话外发。
 */
const isSecret = (path: string, text: string): boolean =>
  secretByName(path.slice(path.lastIndexOf("/") + 1)) || secretByContent(text);

const text = (
  t: string,
): { content: { type: "text"; text: string }[]; details: undefined } => ({
  content: [{ type: "text", text: t }],
  details: undefined,
});

/** 同步实现的工具也要回 Promise（pi 的 execute 约定）。 */
const done = (t: string): Promise<ReturnType<typeof text>> =>
  Promise.resolve(text(t));

const asTool = (t: unknown): ToolDefinition => t as ToolDefinition;

const pad = (n: number): string => String(n).padStart(2, "0");
function stamp(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getFullYear())}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
const safeSegment = (s: string): string =>
  s
    .replace(/[\\/:*?"<>|\n\r\t]/g, "_")
    .trim()
    .slice(0, 80) || "未命名";

export function createToolRegistry(deps: ToolDeps): Map<string, ToolSpec> {
  const now = deps.now ?? Date.now;
  const specs: ToolSpec[] = [];
  const { db, files, evidence } = deps;

  specs.push({
    name: "product_overview",
    label: "产品概览",
    level: "observe",
    summary:
      "产品线 / 产品清单；指定产品时给出功能树、文档与代码目录、生命周期标准",
    build: (ctx) =>
      asTool(
        defineTool({
          name: "product_overview",
          label: "产品概览",
          description:
            "List product lines and products. With `product` (name or id; defaults to the conversation's product), also returns its feature tree (module → feature, with duty and evidence paths), docs folder, code folder, and the lifecycle standard (which artifacts each stage requires).",
          parameters: Type.Object({
            product: Type.Optional(
              Type.String({
                description: "产品名或 id；省略则用当前对话绑定的产品",
              }),
            ),
          }),
          execute(_id, params) {
            const lines = db
              .prepare<[], { id: string; name: string }>(
                "SELECT id, name FROM product_lines ORDER BY sort_order",
              )
              .all();
            const products = db
              .prepare<
                [],
                {
                  id: string;
                  line_id: string;
                  name: string;
                  description: string;
                  folder_path: string | null;
                  code_path: string | null;
                  template_id: string | null;
                }
              >(
                "SELECT id, line_id, name, description, folder_path, code_path, template_id FROM products ORDER BY sort_order",
              )
              .all();
            const out: string[] = ["# 产品清单"];
            for (const l of lines) {
              out.push(`## ${l.name}`);
              for (const p of products.filter((x) => x.line_id === l.id))
                out.push(
                  `- ${p.name}（id: ${p.id}）${p.description ? `：${p.description}` : ""}`,
                );
            }
            const key = params.product ?? ctx.productId;
            if (key) {
              const p = products.find(
                (x) =>
                  x.id === key || x.name.toLowerCase() === key.toLowerCase(),
              );
              if (!p) {
                out.push("", `（没找到产品「${key}」）`);
              } else {
                out.push("", `# 产品：${p.name}`);
                out.push(`- 文档目录：${p.folder_path ?? "（未绑定）"}`);
                out.push(`- 代码目录：${p.code_path ?? "（未绑定）"}`);
                const nodes = db
                  .prepare<
                    [string],
                    {
                      id: string;
                      parent_id: string | null;
                      name: string;
                      duty: string;
                      evidence: string;
                    }
                  >(
                    "SELECT id, parent_id, name, duty, evidence FROM feature_nodes WHERE product_id = ? ORDER BY sort_order",
                  )
                  .all(p.id);
                out.push("", "## 功能树");
                if (nodes.length === 0) out.push("（还没有梳理）");
                const walk = (parent: string | null, depth: number): void => {
                  for (const n of nodes.filter((x) => x.parent_id === parent)) {
                    const ev = n.evidence
                      .split("\n")
                      .filter(Boolean)
                      .slice(0, 3)
                      .join("、");
                    out.push(
                      `${"  ".repeat(depth)}- **${n.name}**${n.duty ? `：${n.duty}` : ""}${ev ? `（依据：${ev}）` : ""}`,
                    );
                    walk(n.id, depth + 1);
                  }
                };
                walk(null, 0);
                if (p.template_id) {
                  const arts = db
                    .prepare<
                      [string],
                      {
                        stage: string;
                        name: string;
                        required: number;
                        guide: string;
                      }
                    >(
                      `SELECT s.label AS stage, a.name, a.required, a.guide
                         FROM lifecycle_artifacts a JOIN lifecycle_stages s ON s.id = a.stage_id
                        WHERE s.template_id = ? ORDER BY s.sort_order, a.sort_order`,
                    )
                    .all(p.template_id);
                  out.push("", "## 生命周期标准（每阶段应有的产出物）");
                  for (const a of arts)
                    out.push(
                      `- [${a.stage}] ${a.name}${a.required ? "（必备）" : ""}${a.guide ? `：${a.guide.slice(0, 80)}` : ""}`,
                    );
                }
              }
            }
            return done(out.join("\n"));
          },
        }),
      ),
  });

  if (files) {
    specs.push({
      name: "file_search",
      label: "搜文件",
      level: "observe",
      summary: "在文件库（含代码库）里按文件名与内容搜索",
      build: () =>
        asTool(
          defineTool({
            name: "file_search",
            label: "搜文件",
            description:
              "Search the file library (documents and uploaded code repositories) by file name and text content. Returns paths with a snippet. Use `scope` (a folder path) to narrow, e.g. a product's docs or code folder from product_overview.",
            parameters: Type.Object({
              query: Type.String({
                description: "关键词（一个词或短语效果最好）",
              }),
              scope: Type.Optional(
                Type.String({
                  description: "只在这个文件夹下搜，如 /代码库/xxx",
                }),
              ),
            }),
            execute(_id, params) {
              const hits = files
                .search(params.query, 200)
                .filter((h) => !params.scope || h.path.startsWith(params.scope))
                .slice(0, 40);
              if (hits.length === 0)
                return done(
                  `没有搜到「${params.query}」。换个词，或去掉范围再试。`,
                );
              return done(
                hits
                  .map(
                    (h) =>
                      `- ${h.path}${h.isDir ? "/" : ""}（${h.match === "name" ? "名称命中" : "内容命中"}）${h.snippet ? `：${h.snippet}` : ""}`,
                  )
                  .join("\n"),
              );
            },
          }),
        ),
    });

    specs.push({
      name: "file_list",
      label: "列目录",
      level: "observe",
      summary: "列出文件库里某个文件夹的内容",
      build: () =>
        asTool(
          defineTool({
            name: "file_list",
            label: "列目录",
            description:
              "List a folder in the file library. Root is `/`; code repositories live under `/代码库`.",
            parameters: Type.Object({
              path: Type.String({ description: "文件夹路径，如 / 或 /代码库" }),
            }),
            async execute(_id, params) {
              const { entries } = await files.list(params.path);
              if (entries.length === 0) return text("（空文件夹）");
              return text(
                entries
                  .slice(0, 300)
                  .map((e) => `- ${e.name}${e.isDir ? "/" : ""}`)
                  .join("\n") +
                  (entries.length > 300
                    ? `\n…共 ${String(entries.length)} 项，只列了前 300`
                    : ""),
              );
            },
          }),
        ),
    });

    specs.push({
      name: "file_read",
      label: "读文件",
      level: "observe",
      summary: "读文件库里一个文本文件的正文（长文件分页）",
      build: () =>
        asTool(
          defineTool({
            name: "file_read",
            label: "读文件",
            description: `Read a text file from the file library. Returns up to ${String(READ_LIMIT)} characters starting at \`offset\`; call again with a larger offset for the rest.`,
            parameters: Type.Object({
              path: Type.String(),
              offset: Type.Optional(
                Type.Number({ description: "从第几个字符开始，默认 0" }),
              ),
            }),
            async execute(_id, params) {
              const item = await files.item(params.path, { content: true });
              if (item.content !== null && isSecret(params.path, item.content))
                return text(`「${params.path}」疑似含凭据，按规定不读正文。`);
              if (item.content === null)
                return text(
                  item.contentOmitted === "too-large"
                    ? "文件太大，无法读取正文。"
                    : "不是文本文件（Office/PDF/图片等），无法读取正文。",
                );
              const start = Math.max(0, Math.floor(params.offset ?? 0));
              const chunk = item.content.slice(start, start + READ_LIMIT);
              const rest = item.content.length - start - chunk.length;
              return text(
                `# ${params.path}（共 ${String(item.content.length)} 字符，本段从 ${String(start)} 起）\n\n${chunk}` +
                  (rest > 0
                    ? `\n\n…还有 ${String(rest)} 字符，用 offset=${String(start + chunk.length)} 继续读`
                    : ""),
              );
            },
          }),
        ),
    });

    specs.push({
      name: "draft_write",
      label: "写草稿",
      level: "coordinate",
      summary: `把产出写进临时区（${AGENT_DRAFT_ROOT}），人确认后再进正式位置`,
      build: (ctx) =>
        asTool(
          defineTool({
            name: "draft_write",
            label: "写草稿",
            description: `Save a Markdown deliverable (e.g. a PRD draft) to the staging area ${AGENT_DRAFT_ROOT}. A human reviews it on the 临时区 page before it goes to an official folder; you cannot write anywhere else, and staged drafts are NOT evidence for later turns. Returns the draft path — mention it in your final answer.`,
            parameters: Type.Object({
              title: Type.String({
                description: "文件名（不含扩展名），如「订阅席位分配 PRD」",
              }),
              markdown: Type.String(),
            }),
            async execute(_id, params) {
              const folder = `${AGENT_DRAFT_ROOT}/${stamp(now())}-${ctx.agentName}-${ctx.runId.slice(0, 6)}`;
              if (deps.drafts === undefined) {
                const path = `${folder}/${safeSegment(params.title)}.md`;
                const { entry } = await files.write(
                  path,
                  Buffer.from(`${params.markdown}\n`, "utf8"),
                  { mode: "autorename", parents: true },
                );
                return text(`已写入临时区：${entry.path}（待人确认）`);
              }
              const saved = await deps.drafts.save({
                source: "agent",
                productId: ctx.productId,
                title: params.title,
                markdown: params.markdown,
                origin: `智能体 ${ctx.agentName}`,
                folder,
                targetPath: suggestTarget(deps.db, ctx.productId, params.title),
                sessionId: null,
              });
              return text(
                `已写入临时区：${saved.draftPath}（待人在「临时区」页确认后才进正式位置）`,
              );
            },
          }),
        ),
    });
  }

  if (evidence) {
    specs.push({
      name: "evidence_locate",
      label: "定位依据",
      level: "observe",
      summary:
        "按任务描述在产品的文档 / 代码 / 数据结构里定位最相关的文件并读出正文",
      build: (ctx) =>
        asTool(
          defineTool({
            name: "evidence_locate",
            label: "定位依据",
            description:
              "Given a task or question, locate the most relevant files in the product's evidence library (docs, code, database schema, page list) and return their content. Best first step for anything about how the product currently works.",
            parameters: Type.Object({
              task: Type.String({ description: "要查的问题，越具体越准" }),
              product: Type.Optional(
                Type.String({ description: "产品 id；省略用当前对话的产品" }),
              ),
            }),
            async execute(_id, params) {
              const productId = params.product ?? ctx.productId;
              const r = await evidence.locate({ productId }, params.task);
              const out: string[] = [
                `# 依据定位：${params.task}`,
                `关键词：${r.keywords.map((k) => k.term).join("、") || "（无）"}`,
              ];
              if (r.files.length === 0)
                out.push(
                  "",
                  "没有定位到相关文件。依据库可能为空，或换个说法再试。",
                );
              for (const f of r.files) {
                out.push(
                  "",
                  `## ${f.path}（${f.sourceLabel}；命中：${f.matched.join("、")}）`,
                  f.content.slice(0, 8_000),
                );
                if (f.truncated || f.content.length > 8_000)
                  out.push("…（已截断，需要全文用 file_read）");
              }
              for (const s of r.skipped)
                out.push(`- 跳过 ${s.path}：${s.reason}`);
              if (r.truncated.length > 0)
                out.push(
                  `（这些目录文件过多被截断，没列到不代表不存在：${r.truncated.join("、")}）`,
                );
              return text(out.join("\n"));
            },
          }),
        ),
    });
  }

  specs.push({
    name: "history_search",
    label: "翻历史对话",
    level: "observe",
    summary: "在过往对话里按关键词找讨论过的内容（谁、哪天、说了什么）",
    build: () =>
      asTool(
        defineTool({
          name: "history_search",
          label: "翻历史对话",
          description:
            "Search past conversations on this platform by keyword. Returns matching messages with conversation title, date and a snippet. Use several short keywords (synonyms, module names) — matching is literal.",
          parameters: Type.Object({
            keywords: Type.Array(Type.String(), { minItems: 1, maxItems: 6 }),
          }),
          execute(_id, params) {
            const rows = db
              .prepare<
                [],
                {
                  id: string;
                  title: string;
                  updated_at: number;
                  payload: string;
                }
              >(
                `SELECT s.id, s.title, s.updated_at, e.payload FROM entries e JOIN sessions s ON s.id = e.session_id
                  WHERE json_extract(e.payload, '$.type') = 'message'
                    AND json_extract(e.payload, '$.message.role') IN ('user', 'assistant')
                    -- AI 工坊的过程不是业务讨论，翻出来只会干扰（见 forge.ts）。
                    AND (s.task IS NULL OR json_extract(s.task, '$.kind') != 'forge')
                  ORDER BY s.updated_at DESC, e.seq`,
              )
              .all();
            const kws = params.keywords
              .map((k) => k.toLowerCase())
              .filter(Boolean);
            const hits: string[] = [];
            for (const r of rows) {
              const msg = (
                JSON.parse(r.payload) as {
                  message?: { role?: string; content?: unknown };
                }
              ).message;
              const content = msg?.content;
              const body =
                typeof content === "string"
                  ? content
                  : Array.isArray(content)
                    ? content
                        .map((c: { type?: string; text?: string }) =>
                          c.type === "text" ? (c.text ?? "") : "",
                        )
                        .join("")
                    : "";
              const lower = body.toLowerCase();
              const matched = kws.filter((k) => lower.includes(k));
              if (matched.length === 0) continue;
              const at = lower.indexOf(matched[0] ?? "");
              const snip = body
                .slice(Math.max(0, at - 120), at + 280)
                .replace(/\s+/g, " ");
              hits.push(
                `- 【${r.title}】${new Date(r.updated_at).toISOString().slice(0, 10)} · ${msg?.role === "user" ? "用户" : "AI"} · 命中 ${matched.join("、")}：…${snip}…`,
              );
              if (hits.length >= 30) break;
            }
            return done(
              hits.length === 0
                ? "过往对话里没有找到这些关键词。"
                : hits.join("\n"),
            );
          },
        }),
      ),
  });

  specs.push({
    name: "web_search",
    label: "联网搜索",
    level: "observe",
    summary: "借模型接口自带的搜索上网查资料，交回结论与来源链接",
    build: (ctx) =>
      asTool(
        defineTool({
          name: "web_search",
          label: "联网搜索",
          description:
            'Search the web. Returns a sourced answer with links. Ask one focused question per call (e.g. "X 产品 2026 年定价"); call several times for broader research.',
          parameters: Type.Object({ query: Type.String() }),
          async execute(_id, params, signal) {
            const target = await ctx.webTarget();
            if (!target)
              return text(
                "当前模型的接口不支持联网搜索。请在结论里标注「未联网核实」。",
              );
            const r = await webSearch(
              target,
              params.query,
              signal,
              deps.fetchImpl,
            );
            return text(formatWebSearch(params.query, r));
          },
        }),
      ),
  });

  const intel = deps.intel;
  if (intel !== undefined) {
    // 情报是外部参考：查与读是观察级；提交只落成「待确认」，
    // 和 draft_write 同属协调级——人在市场情报页确认后才生效。
    const intelCtx = (ctx: ToolContext) => ({
      productId: ctx.productId,
      sessionId: null,
    });
    specs.push(
      {
        name: "intel_search",
        label: "查情报库",
        level: "observe",
        summary: "在市场情报库里查竞品、市场、行业动态、合规等外部参考资料",
        build: (ctx) => intelSearchTool(intel, intelCtx(ctx)),
      },
      {
        name: "intel_read",
        label: "读情报",
        level: "observe",
        summary: "读一条情报的全文、来源与时效",
        build: () => intelReadTool(intel),
      },
      {
        name: "intel_propose",
        label: "提交情报",
        level: "coordinate",
        summary: "把调研发现提交进情报库（待人确认后生效）",
        build: (ctx) => intelProposeTool(intel, intelCtx(ctx)),
      },
    );
  }

  return new Map(specs.map((s) => [s.name, s]));
}
