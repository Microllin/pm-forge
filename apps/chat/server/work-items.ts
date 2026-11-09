import { randomUUID } from "node:crypto";

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import type { Db } from "./db.js";
import { HttpError, badRequest, notFound } from "./errors.js";
import type { KeyStore } from "./model-config.js";
import type { SessionStore } from "./sessions.js";

/**
 * 任务与需求（一级菜单「任务与需求」）。
 *
 * 两类条目共用一张表、一套接口：
 * - 用户需求（request）：人手记的，类似备忘录，纯增删改查；
 * - 内部任务（task）：只从外部系统拉取、只读，不能手建。第一版只接 Linear。
 *
 * 两类都能「一键开对话」：建一条会话（带上条目绑定的产品，以便注入事实依据），
 * 把条目整理成开场提示词交回前端发出去——和产品页的 AI 分析同一条路，
 * 用户看得见 AI 在干什么、也能接着追问。
 *
 * 外部来源只读：同步只把 Linear 的状态拉下来，不回写。回写要处理冲突与权限，
 * 等真有人要再做。
 */

export type WorkKind = "request" | "task";
export type WorkStatus = "todo" | "doing" | "done" | "canceled";
export type WorkSource = "manual" | "linear";

export interface WorkItem {
  id: string;
  kind: WorkKind;
  source: WorkSource;
  externalKey: string | null;
  url: string | null;
  title: string;
  description: string;
  status: WorkStatus;
  /** 外部系统里的原始状态名（如 Linear 的 "In Review"）；手建的为 null。 */
  externalStatus: string | null;
  /** 0 无 / 1 紧急 / 2 高 / 3 中 / 4 低（与 Linear 同一套编号）。 */
  priority: number;
  requester: string;
  assignee: string;
  labels: string[];
  team: string;
  productId: string | null;
  productName: string | null;
  /** 最近一次开的对话；会话已删则为 null。 */
  sessionId: string | null;
  externalUpdatedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

/* ── 输入校验 ───────────────────────────────────────────────────────── */

const STATUSES = ["todo", "doing", "done", "canceled"] as const;
const title = z
  .string({ error: "标题必填" })
  .trim()
  .min(1, "标题不能为空")
  .max(200, "标题最多 200 个字");
const description = z.string().max(20_000, "描述最多 20000 个字");
const priority = z.number().int().min(0).max(4);
const requester = z.string().trim().max(80, "提出人最多 80 个字");
const productId = z.string().trim().min(1).nullable();

/** 只有用户需求能手建；内部任务一律从外部系统拉取。 */
export const createWorkItemSchema = z.object({
  kind: z.literal("request", { error: "内部任务只能从 Linear 拉取，不能手建" }),
  title,
  description: description.default(""),
  status: z.enum(STATUSES).default("todo"),
  priority: priority.default(0),
  requester: requester.default(""),
  productId: productId.default(null),
});
export const updateWorkItemSchema = z
  .object({
    title: title.optional(),
    description: description.optional(),
    status: z.enum(STATUSES).optional(),
    priority: priority.optional(),
    requester: requester.optional(),
    productId: productId.optional(),
  })
  .refine(
    (v) => Object.values(v).some((x) => x !== undefined),
    "没有要修改的字段",
  );

/* ── 存储 ───────────────────────────────────────────────────────────── */

interface Row {
  id: string;
  kind: WorkKind;
  source: WorkSource;
  external_key: string | null;
  url: string | null;
  title: string;
  description: string;
  status: WorkStatus;
  external_status: string | null;
  priority: number;
  requester: string;
  assignee: string;
  labels: string;
  team: string;
  product_id: string | null;
  product_name: string | null;
  session_id: string | null;
  external_updated_at: number | null;
  created_at: number;
  updated_at: number;
}

const parseLabels = (raw: string): string[] => {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
};

const toItem = (r: Row): WorkItem => ({
  id: r.id,
  kind: r.kind,
  source: r.source,
  externalKey: r.external_key,
  url: r.url,
  title: r.title,
  description: r.description,
  status: r.status,
  externalStatus: r.external_status,
  priority: r.priority,
  requester: r.requester,
  assignee: r.assignee,
  labels: parseLabels(r.labels),
  team: r.team,
  productId: r.product_id,
  productName: r.product_name,
  sessionId: r.session_id,
  externalUpdatedAt: r.external_updated_at,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** 会话删了 session_id 就悬空：联表按存在性置空，不在删会话时回头改这张表。 */
const SELECT = `
  SELECT w.*, p.name AS product_name,
         CASE WHEN s.id IS NULL THEN NULL ELSE w.session_id END AS session_id
  FROM work_items w
  LEFT JOIN products p ON p.id = w.product_id
  LEFT JOIN sessions s ON s.id = w.session_id`;

/** 外部系统同步下来的一条。 */
export interface ExternalItem {
  externalId: string;
  externalKey: string;
  url: string;
  title: string;
  description: string;
  status: WorkStatus;
  externalStatus: string;
  priority: number;
  assignee: string;
  labels: string[];
  team: string;
  updatedAt: number;
}

export function createWorkItems(db: Db, now: () => number = Date.now) {
  const get = (id: string): WorkItem => {
    const row = db.prepare<[string], Row>(`${SELECT} WHERE w.id = ?`).get(id);
    if (!row) throw notFound("条目不存在");
    return toItem(row);
  };
  const checkProduct = (id: string | null | undefined): void => {
    if (id === null || id === undefined) return;
    const hit = db.prepare("SELECT 1 FROM products WHERE id = ?").get(id);
    if (!hit) throw badRequest("产品不存在");
  };

  return {
    get,

    list(kind: WorkKind): WorkItem[] {
      return db
        .prepare<[WorkKind], Row>(
          `${SELECT} WHERE w.kind = ? ORDER BY w.updated_at DESC`,
        )
        .all(kind)
        .map(toItem);
    },

    create(input: z.infer<typeof createWorkItemSchema>): WorkItem {
      checkProduct(input.productId);
      const id = randomUUID();
      const t = now();
      db.prepare(
        `INSERT INTO work_items (id, kind, source, title, description, status, priority, requester, product_id, created_at, updated_at)
         VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.kind,
        input.title,
        input.description,
        input.status,
        input.priority,
        input.requester,
        input.productId,
        t,
        t,
      );
      return get(id);
    },

    update(id: string, patch: z.infer<typeof updateWorkItemSchema>): WorkItem {
      const current = get(id);
      // 外部来的条目，标题、描述、状态、优先级以外部系统为准（下次同步会被覆盖），
      // 所以这里只放行本地字段，免得人改了以为生效、同步一下又没了。
      if (current.source !== "manual") {
        const touched = (
          ["title", "description", "status", "priority", "requester"] as const
        ).filter((k) => patch[k] !== undefined);
        if (touched.length > 0)
          throw badRequest(
            "这条来自外部系统，内容请到原系统里改；这里只能改关联产品",
          );
      }
      checkProduct(patch.productId);
      const sets: string[] = [];
      const args: (string | number | null)[] = [];
      const put = (col: string, v: string | number | null | undefined) => {
        if (v === undefined) return;
        sets.push(`${col} = ?`);
        args.push(v);
      };
      put("title", patch.title);
      put("description", patch.description);
      put("status", patch.status);
      put("priority", patch.priority);
      put("requester", patch.requester);
      put("product_id", patch.productId);
      sets.push("updated_at = ?");
      args.push(now());
      db.prepare(`UPDATE work_items SET ${sets.join(", ")} WHERE id = ?`).run(
        ...args,
        id,
      );
      return get(id);
    },

    remove(id: string): void {
      const info = db.prepare("DELETE FROM work_items WHERE id = ?").run(id);
      if (info.changes === 0) throw notFound("条目不存在");
    },

    /** 记下开出来的对话；手记的需求顺手挪到「进行中」——开了对话就是开始干了。 */
    attachSession(id: string, sessionId: string): WorkItem {
      const current = get(id);
      const status =
        current.source === "manual" && current.status === "todo"
          ? "doing"
          : current.status;
      db.prepare(
        "UPDATE work_items SET session_id = ?, status = ?, updated_at = ? WHERE id = ?",
      ).run(sessionId, status, now(), id);
      return get(id);
    },

    /**
     * 同步进来一批外部条目。按 (source, external_id) 增或改；外部字段覆盖，
     * 本地字段（产品、对话）不动。外部已经不在结果里的条目保留——可能只是被
     * 过滤条件筛掉了（比如刚改成已完成），删掉会连带丢掉本地挂的对话。
     */
    upsertExternal(
      source: Exclude<WorkSource, "manual">,
      items: readonly ExternalItem[],
    ): { added: number; updated: number } {
      const t = now();
      const exists = db.prepare<[string, string], { id: string }>(
        "SELECT id FROM work_items WHERE source = ? AND external_id = ?",
      );
      const insert = db.prepare(
        `INSERT INTO work_items (id, kind, source, external_id, external_key, url, title, description, status, external_status, priority, assignee, labels, team, external_updated_at, created_at, updated_at)
         VALUES (?, 'task', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const update = db.prepare(
        `UPDATE work_items SET external_key = ?, url = ?, title = ?, description = ?, status = ?, external_status = ?, priority = ?, assignee = ?, labels = ?, team = ?, external_updated_at = ?, updated_at = ?
         WHERE id = ?`,
      );
      let added = 0;
      let updated = 0;
      db.transaction(() => {
        for (const x of items) {
          const hit = exists.get(source, x.externalId);
          const labels = JSON.stringify(x.labels);
          if (hit) {
            update.run(
              x.externalKey,
              x.url,
              x.title,
              x.description,
              x.status,
              x.externalStatus,
              x.priority,
              x.assignee,
              labels,
              x.team,
              x.updatedAt,
              t,
              hit.id,
            );
            updated += 1;
          } else {
            insert.run(
              randomUUID(),
              source,
              x.externalId,
              x.externalKey,
              x.url,
              x.title,
              x.description,
              x.status,
              x.externalStatus,
              x.priority,
              x.assignee,
              labels,
              x.team,
              x.updatedAt,
              t,
              t,
            );
            added += 1;
          }
        }
      })();
      return { added, updated };
    },
  };
}
export type WorkItems = ReturnType<typeof createWorkItems>;

/* ── Linear ─────────────────────────────────────────────────────────── */

const LINEAR_ENDPOINT = "https://api.linear.app/graphql";
/** 一次同步最多拉几条。再多就该让人用过滤条件收窄，而不是一口气灌进来。 */
const LINEAR_MAX = 250;
const LINEAR_PAGE = 50;
export const LINEAR_KEY_ID = "linear";

export const linearConfigSchema = z.object({
  /** mine = 只拉分给我的；all = 拉团队里所有的（受 teamKey 约束）。 */
  scope: z.enum(["mine", "all"]).default("mine"),
  /** 团队标识（如 ENG），空 = 不限团队。 */
  teamKey: z.string().trim().max(20).default(""),
  /** 是否连已完成 / 已取消的也拉。默认不拉——任务清单是拿来干活的。 */
  includeDone: z.boolean().default(false),
});
export type LinearConfig = z.infer<typeof linearConfigSchema>;

interface LinearSyncResult {
  at: number;
  ok: boolean;
  added: number;
  updated: number;
  error: string | null;
}

const CONFIG_KEY = "work.linear.config";
const SYNC_KEY = "work.linear.lastSync";

const readSetting = (db: Db, key: string): unknown => {
  const row = db
    .prepare<[string], { value: string }>(
      "SELECT value FROM settings WHERE key = ?",
    )
    .get(key);
  if (!row) return null;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return null;
  }
};
const writeSetting = (db: Db, key: string, value: unknown): void => {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, JSON.stringify(value));
};

/** Linear 的 state.type → 本地四态。 */
export const linearStatus = (type: string): WorkStatus =>
  type === "started"
    ? "doing"
    : type === "completed"
      ? "done"
      : type === "canceled"
        ? "canceled"
        : "todo"; // backlog / unstarted / triage

const ISSUES_QUERY = `
query Issues($first: Int!, $after: String, $filter: IssueFilter) {
  issues(first: $first, after: $after, filter: $filter, orderBy: updatedAt) {
    nodes {
      id identifier title description url priority updatedAt
      state { name type }
      assignee { name }
      team { key }
      labels { nodes { name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const VIEWER_QUERY = `query { viewer { name email } teams(first: 50) { nodes { key name } } }`;

interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  priority: number;
  updatedAt: string;
  state: { name: string; type: string } | null;
  assignee: { name: string } | null;
  team: { key: string } | null;
  labels: { nodes: { name: string }[] } | null;
}

export function createLinearClient(fetchImpl: typeof fetch = fetch) {
  const call = async <T>(
    key: string,
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(LINEAR_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Linear 的个人 API Key 直接放 Authorization，不带 Bearer。
          authorization: key,
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new HttpError(
        502,
        "LINEAR_UNREACHABLE",
        "连不上 Linear，检查一下网络或代理",
      );
    }
    if (res.status === 401 || res.status === 403)
      throw badRequest("Linear 拒绝了这个 API Key，确认它没填错、没被撤销");
    const body = (await res.json().catch(() => null)) as {
      data?: T;
      errors?: { message?: string }[];
    } | null;
    if (!res.ok || !body || body.errors?.length || !body.data) {
      const msg = body?.errors?.[0]?.message;
      if (msg && /auth/i.test(msg))
        throw badRequest("Linear 拒绝了这个 API Key，确认它没填错、没被撤销");
      throw new HttpError(
        502,
        "LINEAR_ERROR",
        `Linear 返回错误：${msg ?? String(res.status)}`,
      );
    }
    return body.data;
  };

  return {
    async viewer(key: string) {
      const data = await call<{
        viewer: { name: string; email: string };
        teams: { nodes: { key: string; name: string }[] };
      }>(key, VIEWER_QUERY);
      return { viewer: data.viewer, teams: data.teams.nodes };
    },

    async issues(key: string, config: LinearConfig): Promise<ExternalItem[]> {
      const filter: Record<string, unknown> = {};
      if (config.scope === "mine") filter.assignee = { isMe: { eq: true } };
      if (config.teamKey !== "")
        filter.team = { key: { eq: config.teamKey.toUpperCase() } };
      if (!config.includeDone)
        filter.state = { type: { nin: ["completed", "canceled"] } };
      const out: ExternalItem[] = [];
      let after: string | null = null;
      while (out.length < LINEAR_MAX) {
        const data: {
          issues: {
            nodes: LinearIssue[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        } = await call(key, ISSUES_QUERY, {
          first: LINEAR_PAGE,
          after,
          filter,
        });
        for (const n of data.issues.nodes) {
          out.push({
            externalId: n.id,
            externalKey: n.identifier,
            url: n.url,
            title: n.title.slice(0, 200),
            description: (n.description ?? "").slice(0, 20_000),
            status: linearStatus(n.state?.type ?? ""),
            externalStatus: n.state?.name ?? "",
            priority: n.priority,
            assignee: n.assignee?.name ?? "",
            labels: (n.labels?.nodes ?? []).map((l) => l.name),
            team: n.team?.key ?? "",
            updatedAt: Date.parse(n.updatedAt) || 0,
          });
        }
        if (!data.issues.pageInfo.hasNextPage) break;
        after = data.issues.pageInfo.endCursor;
      }
      return out.slice(0, LINEAR_MAX);
    },
  };
}
export type LinearClient = ReturnType<typeof createLinearClient>;

/* ── 开场提示词 ─────────────────────────────────────────────────────── */

const PRIORITY_LABEL = ["无", "紧急", "高", "中", "低"];
const STATUS_LABEL: Record<WorkStatus, string> = {
  todo: "待处理",
  doing: "进行中",
  done: "已完成",
  canceled: "已取消",
};

export function workItemPrompt(item: WorkItem): string {
  const isRequest = item.kind === "request";
  const meta: string[] = [];
  if (item.externalKey)
    meta.push(
      `- 编号：${item.externalKey}${item.url ? `（${item.url}）` : ""}`,
    );
  meta.push(
    `- 状态：${item.externalStatus ?? STATUS_LABEL[item.status]}`,
    `- 优先级：${PRIORITY_LABEL[item.priority] ?? "无"}`,
  );
  if (item.productName) meta.push(`- 关联产品：${item.productName}`);
  if (item.requester) meta.push(`- 提出人：${item.requester}`);
  if (item.assignee) meta.push(`- 负责人：${item.assignee}`);
  if (item.labels.length > 0) meta.push(`- 标签：${item.labels.join("、")}`);

  const body = item.description.trim() || "（没有写描述）";
  const ask = isRequest
    ? [
        "请帮我把这条用户需求理清楚：",
        "1. 用一两句话复述用户真正想解决的问题（不是他说的方案）；",
        "2. 列出还不清楚、需要找用户或内部确认的点；",
        "3. 判断它和现有产品能力的关系（已有 / 部分有 / 全新），有事实依据就引用；",
        "4. 给出建议的下一步（直接做、先调研、合并到已有需求、或暂不做），并说明理由。",
      ]
    : [
        "请帮我开始这个任务：",
        "1. 先复述任务目标与完成标准，有歧义的地方指出来；",
        "2. 结合事实依据，拆成可执行的步骤；",
        "3. 标出风险和需要别人配合的地方；",
        "4. 然后从第一步开始推进。",
      ];

  return [
    `## ${isRequest ? "用户需求" : "任务"}：${item.title}`,
    "",
    ...meta,
    "",
    "### 描述",
    "",
    body,
    "",
    "---",
    "",
    ...ask,
  ].join("\n");
}

/* ── 接口 ───────────────────────────────────────────────────────────── */

/**
 *   GET    /api/work-items?kind=request|task     清单
 *   POST   /api/work-items                       新建（手记）
 *   PATCH  /api/work-items/:id                   修改
 *   DELETE /api/work-items/:id                   删除
 *   POST   /api/work-items/:id/chat              开对话：建会话 + 返回开场提示词
 *
 *   GET    /api/integrations/linear              连接状态与过滤条件（不回 Key 原文）
 *   PUT    /api/integrations/linear              保存 Key（先验证）与过滤条件
 *   DELETE /api/integrations/linear/key          断开（删 Key）
 *   POST   /api/integrations/linear/sync         按过滤条件拉一次
 */
const idParams = z.object({ id: z.string() });
const kindQuery = z.object({ kind: z.enum(["request", "task"]) });
const linearPutBody = linearConfigSchema.extend({
  key: z.string().trim().min(1).max(500).optional(),
});

export function registerWorkItemRoutes(
  app: FastifyInstance,
  deps: {
    db: Db;
    sessions: SessionStore;
    newHeader: () => unknown;
    /** 外部系统的凭证。与模型 Key 分开存：放一起会被当成模型服务商列出来。 */
    keys?: KeyStore;
    linear?: LinearClient;
    now?: () => number;
  },
): WorkItems {
  const now = deps.now ?? Date.now;
  const items = createWorkItems(deps.db, now);
  const linear = deps.linear ?? createLinearClient();

  app.get("/api/work-items", (request) => ({
    items: items.list(kindQuery.parse(request.query).kind),
  }));

  app.post("/api/work-items", (request, reply) =>
    reply
      .code(201)
      .send(items.create(createWorkItemSchema.parse(request.body))),
  );

  app.patch<{ Params: { id: string } }>("/api/work-items/:id", (request) =>
    items.update(
      idParams.parse(request.params).id,
      updateWorkItemSchema.parse(request.body),
    ),
  );

  app.delete<{ Params: { id: string } }>(
    "/api/work-items/:id",
    (request, reply) => {
      items.remove(idParams.parse(request.params).id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/work-items/:id/chat",
    (request, reply) => {
      const item = items.get(idParams.parse(request.params).id);
      const header = deps.newHeader() as { id: string };
      const label =
        item.externalKey ?? (item.kind === "request" ? "需求" : "任务");
      const row = deps.sessions.create({
        id: header.id,
        title: `${label}：${item.title}`.slice(0, 120),
        header,
        productId: item.productId,
      });
      const updated = items.attachSession(item.id, row.id);
      return reply.code(201).send({
        sessionId: row.id,
        prompt: workItemPrompt(updated),
        item: updated,
      });
    },
  );

  /* Linear 连接 */

  const keyStore = (): KeyStore => {
    if (!deps.keys)
      throw new HttpError(501, "NOT_CONFIGURED", "本服务没有开启外部系统接入");
    return deps.keys;
  };
  const config = (): LinearConfig =>
    linearConfigSchema.parse(readSetting(deps.db, CONFIG_KEY) ?? {});
  const state = async () => {
    const key = deps.keys ? await deps.keys.get(LINEAR_KEY_ID) : null;
    const value = key?.value ?? null;
    return {
      connected: value !== null,
      // 只回末四位，够人认出是哪把 Key，又不让页面拿到原文。
      keyHint: value === null ? null : `…${value.slice(-4)}`,
      keySource: key?.source ?? "none",
      ...config(),
      lastSync: readSetting(deps.db, SYNC_KEY) as LinearSyncResult | null,
    };
  };

  app.get("/api/integrations/linear", () => state());

  app.put("/api/integrations/linear", async (request) => {
    const body = linearPutBody.parse(request.body);
    const { key, ...rest } = body;
    if (key !== undefined) {
      // 先验再存：存一把用不了的 Key，下次同步才报错，人已经忘了刚改过什么。
      await linear.viewer(key);
      await keyStore().set(LINEAR_KEY_ID, key);
    }
    writeSetting(deps.db, CONFIG_KEY, rest);
    return state();
  });

  app.delete("/api/integrations/linear/key", async () => {
    await keyStore().clear(LINEAR_KEY_ID);
    return state();
  });

  app.post("/api/integrations/linear/sync", async () => {
    const { value } = await keyStore().get(LINEAR_KEY_ID);
    if (value === null) throw badRequest("还没有配置 Linear API Key");
    const at = now();
    try {
      const pulled = await linear.issues(value, config());
      const { added, updated } = items.upsertExternal("linear", pulled);
      writeSetting(deps.db, SYNC_KEY, {
        at,
        ok: true,
        added,
        updated,
        error: null,
      } satisfies LinearSyncResult);
    } catch (e) {
      writeSetting(deps.db, SYNC_KEY, {
        at,
        ok: false,
        added: 0,
        updated: 0,
        error: e instanceof Error ? e.message : "同步失败",
      } satisfies LinearSyncResult);
      throw e;
    }
    return state();
  });

  return items;
}
