import type { FastifyInstance } from "fastify";
import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";

import type { Db } from "./db.js";
import { notFound } from "./errors.js";
import type { SessionProfile } from "./pi/runner.js";
import type { SessionRow, SessionStore } from "./sessions.js";

/**
 * 售前助手：每本售前库一个常驻 agent + 一套不花模型额度的巡检。
 *
 * 设计取舍：
 * - **助手是一条真会话**（task.kind = "presales-agent"），挂在售前页右侧。和普通对话的
 *   区别只有两样：整段换掉的身份说明，以及一组只对它开放的售前工具。
 * - **工具全部走本服务自己的接口**（app.inject），不另写一套读写：界面能做的、规则卡住的，
 *   助手一样被卡住，不会出现「助手绕过了界面的校验」。
 * - **助手不能改现行版**：它能发起审阅、能起草，但起草只落成草稿版本；采纳修订、设为
 *   可对外、删除文件都留给人在界面上点。对外口径不能不经人眼生效。
 * - **巡检是规则不是模型**：缺口、文件丢失、对不上模板、没审过、审完又换了文件……这些
 *   判断写死在代码里，打开页面就算，不花一分钱。唯一花钱的是「上传后自动审阅」，有开关。
 */

/* ── 接口返回的形状（只取这里用得到的字段） ── */

interface VersionDto {
  id: string;
  version: string;
  status: "draft" | "review" | "current" | "archived";
  fileName: string | null;
  fileExists?: boolean;
  updatedAt: number;
  createdAt: number;
}

interface SlotDto {
  id: string;
  title: string;
  stage: string;
  priority: boolean;
  audience: "external" | "internal";
  guide: string;
  checkpoints: string[];
  link: "linked" | "outside" | "unmatched" | "none";
  templateItem: { id: string; name: string; stageLabel: string } | null;
  versions: VersionDto[];
  current: VersionDto | null;
}

interface DetailDto {
  lib: {
    id: string;
    name: string;
    productId: string | null;
    templateId: string | null;
    templateName: string | null;
  };
  stages: { code: string; label: string }[];
  slots: SlotDto[];
  templateGaps: {
    id: string;
    name: string;
    stageCode: string;
    stageLabel: string;
    required: boolean;
    audience: "external" | "internal";
  }[];
}

interface ReviewBriefDto {
  id: string;
  versionId: string | null;
  status: string;
  error: string | null;
  verdict: string | null;
  counts: {
    total: number;
    p0: number;
    pending: number;
    accepted: number;
    applied: number;
  };
}

interface AiDto {
  reviews: Record<string, ReviewBriefDto>;
  busy: boolean;
}

/* ── 巡检待办 ── */

export type TodoLevel = "high" | "mid" | "low";
export type TodoAction =
  | "add" // 模板要求、库里没有：加进清单
  | "upload" // 有条目没文件：上传
  | "promote" // 有草稿待审定：预览后设为可对外
  | "review" // 没审过 / 审阅过期：发起审阅
  | "open-review" // 审阅有待定条目：打开修订清单
  | "link" // 对不上模板：去编辑里指定
  | "draft"; // 让助手起草

export interface Todo {
  id: string;
  level: TodoLevel;
  title: string;
  detail: string;
  slotId: string | null;
  /** 模板缺口那一项的 id（action = add 时用）。 */
  gapId: string | null;
  actions: TodoAction[];
}

const REVIEWABLE = /\.(md|markdown|txt|csv|docx|pptx|xlsx)$/i;
const STALE_MS = 180 * 24 * 3600 * 1000;

/** 纯函数：清单 + AI 状态 → 待办。导出给单测。 */
export function computeTodos(
  detail: DetailDto,
  ai: AiDto,
  now: number,
): Todo[] {
  const out: Todo[] = [];
  const stageLabel = (code: string): string =>
    detail.stages.find((s) => s.code === code)?.label ?? code;

  if (detail.lib.templateId === null)
    out.push({
      id: "no-template",
      level: "high",
      title: "这本库没绑售前模板",
      detail: "没有标准就比不出差距，AI 审阅也没有检查要点可依。先绑一个模板。",
      slotId: null,
      gapId: null,
      actions: [],
    });

  for (const g of detail.templateGaps)
    out.push({
      id: `gap:${g.id}`,
      level: g.required ? "high" : "low",
      title: `模板要求「${g.name}」，库里还没有这一项`,
      detail: `${g.stageLabel} · ${g.audience === "internal" ? "对内" : "对外"}${g.required ? " · 必备" : ""}`,
      slotId: null,
      gapId: g.id,
      actions: ["add"],
    });

  for (const s of detail.slots) {
    const where = `${stageLabel(s.stage)} · ${s.audience === "internal" ? "对内" : "对外"}`;
    const cur = s.current;
    const drafts = s.versions.filter(
      (v) => v.status === "draft" || v.status === "review",
    );
    if (drafts.length > 0)
      out.push({
        id: `draft:${s.id}`,
        level: "mid",
        title: `「${s.title}」有 ${String(drafts.length)} 份草稿待审定`,
        detail: `${drafts[0]?.fileName ?? ""}——预览没问题就「设为可对外」，否则删掉。`,
        slotId: s.id,
        gapId: null,
        actions: ["promote"],
      });
    if (cur === null) {
      if (drafts.length === 0)
        out.push({
          id: `missing:${s.id}`,
          level: s.priority ? "high" : "mid",
          title: `「${s.title}」还是缺口`,
          detail: `${where}${s.priority ? " · 高优先级" : ""}`,
          slotId: s.id,
          gapId: null,
          actions: ["upload", "draft"],
        });
      continue;
    }
    if (cur.fileExists === false) {
      out.push({
        id: `lost:${s.id}`,
        level: "high",
        title: `「${s.title}」的文件已不在文件库`,
        detail: `${cur.fileName ?? ""} 被移走或删了，清单指向的是一个空位。重新上传。`,
        slotId: s.id,
        gapId: null,
        actions: ["upload"],
      });
      continue;
    }
    if (s.link === "unmatched")
      out.push({
        id: `unmatched:${s.id}`,
        level: "mid",
        title: `「${s.title}」对不上模板里的任何一项`,
        detail:
          "没对上就没有检查要点，审阅时缺标准。去「编辑」里指定，或标成模板外。",
        slotId: s.id,
        gapId: null,
        actions: ["link"],
      });

    const review = ai.reviews[s.id];
    const canReview = REVIEWABLE.test(cur.fileName ?? "");
    if (canReview) {
      if (review === undefined)
        out.push({
          id: `unreviewed:${s.id}`,
          level: s.audience === "external" ? "mid" : "low",
          title: `「${s.title}」还没审过`,
          detail:
            s.audience === "external"
              ? "对外材料发出前至少审一遍：与代码 / PRD / 其他材料对不对得上。"
              : "对内材料，有空再审。",
          slotId: s.id,
          gapId: null,
          actions: ["review"],
        });
      else if (review.status === "done" && review.versionId !== cur.id)
        out.push({
          id: `stale-review:${s.id}`,
          level: "mid",
          title: `「${s.title}」审完之后文件换过`,
          detail: "上次审阅针对的是旧文件，结论可能已经不适用。重新审一遍。",
          slotId: s.id,
          gapId: null,
          actions: ["review"],
        });
      else if (review.status === "done" && review.counts.pending > 0)
        out.push({
          id: `pending:${s.id}`,
          level: review.counts.p0 > 0 ? "high" : "mid",
          title: `「${s.title}」审出 ${String(review.counts.pending)} 条待定修订${review.counts.p0 > 0 ? `（含 P0×${String(review.counts.p0)}）` : ""}`,
          detail: review.verdict ?? "逐条采纳或驳回，采纳的可一键生成修订稿。",
          slotId: s.id,
          gapId: null,
          actions: ["open-review"],
        });
      else if (review.status === "failed")
        out.push({
          id: `review-failed:${s.id}`,
          level: "low",
          title: `「${s.title}」上次审阅失败`,
          detail: review.error ?? "",
          slotId: s.id,
          gapId: null,
          actions: ["review"],
        });
    }
    if (now - cur.updatedAt > STALE_MS)
      out.push({
        id: `old:${s.id}`,
        level: "low",
        title: `「${s.title}」半年多没更新`,
        detail: "产品半年里多半变过，对外前确认说法还成立。",
        slotId: s.id,
        gapId: null,
        actions: canReview ? ["review"] : [],
      });
  }

  const rank: Record<TodoLevel, number> = { high: 0, mid: 1, low: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}

/* ── 助手身份 ── */

export const PRESALES_AGENT_PROMPT = (libName: string): string =>
  [
    `你是「${libName}」这本售前材料库的专属售前助手，和产品经理一起维护对外售前材料。`,
    "",
    "## 你能做什么",
    "- 用 presales_overview 看清单：模板（标准）要求哪些材料、库里实际有哪些、哪项缺、哪份有问题、巡检待办。回答任何关于「齐不齐 / 先补什么」的问题前先调它，不凭记忆。",
    "- 用 presales_read_material 读某份材料的正文（Office 只能读到文字）。",
    "- 用 presales_start_review 对某份材料发起 AI 审阅（对照代码 > PRD > 其他资料与同库材料出修订清单，后台跑几分钟）；用 presales_review_result 取结果。",
    "- 用 presales_write_draft 给缺口起草一份 Markdown 草稿。草稿不会替换现行版，要人预览后点「设为可对外」才生效。",
    "",
    "## 纪律",
    "- 回答用简体中文，先给结论，再给理由；面向的是产品经理，不堆技术细节。",
    "- 只说有依据的话。依据来自：工具返回、对话里附带的事实依据。找不到依据就标「待核实」，不编造功能、指标、价格、客户案例。",
    "- 售前口径红线：对外材料不得出现底价、折扣底线、内部代号；企业卖点不夸大，规划中的能力不写成已有；各站点材料能否出现公司主体元素、能否出现某类模型名，按团队自己的售前规范执行。技能库里有 presales-material 时，起草或审口径前先加载它。",
    "- 你不能采纳修订、设为可对外、删文件——这些告诉人去界面上点哪里。发起审阅会花模型额度，一次超过 3 份前先问一句。",
    "- 起草前先读模板对这一项的说明与检查要点，再读同库相关材料保持口径一致；草稿末尾列出「待核实」清单。",
  ].join("\n");

/* ── 注册 ── */

export interface PresalesAgentDeps {
  db: Db;
  store: SessionStore;
  newHeader: () => unknown;
  /** 走自己接口时用的 Host（安全检查只认白名单里的）。 */
  selfHost: string;
  /** 调自己接口时额外带的头（登录闸的内部凭证）。 */
  selfHeaders?: Record<string, string>;
  now?: () => number;
}

export interface PresalesAgent {
  profile(session: SessionRow): SessionProfile | undefined;
  onUploaded(slotId: string): void;
}

const idParams = z.object({ id: z.string().min(1) });
const MATERIAL_LIMIT = 40_000;

export function registerPresalesAgent(
  app: FastifyInstance,
  deps: PresalesAgentDeps,
): PresalesAgent {
  const { db, store } = deps;
  const now = deps.now ?? Date.now;

  /** 调自己的接口。失败抛带服务端文案的错误——工具里抛出会原样回给模型。 */
  const call = async <T>(
    method: "GET" | "POST",
    url: string,
    body?: unknown,
  ): Promise<T> => {
    const res = await app.inject({
      method,
      url: encodeURI(url),
      headers: { ...deps.selfHeaders, host: deps.selfHost },
      ...(body === undefined ? {} : { payload: body as object }),
    });
    const parsed: unknown = res.body === "" ? undefined : JSON.parse(res.body);
    if (res.statusCode >= 400) {
      const message =
        (parsed as { error?: { message?: string } } | undefined)?.error
          ?.message ?? `接口返回 ${String(res.statusCode)}`;
      throw new Error(message);
    }
    return parsed as T;
  };

  const libRow = (id: string) =>
    db
      .prepare<
        [string],
        {
          id: string;
          name: string;
          product_id: string | null;
          agent_session_id: string | null;
          auto_review: number;
        }
      >(
        "SELECT id, name, product_id, agent_session_id, auto_review FROM presales_libs WHERE id = ?",
      )
      .get(id);

  const todosOf = async (libId: string): Promise<Todo[]> => {
    const [detail, ai] = await Promise.all([
      call<DetailDto>("GET", `/api/presales/${libId}`),
      call<AiDto>("GET", `/api/presales/${libId}/ai`),
    ]);
    return computeTodos(detail, ai, now());
  };

  /* ── 工具 ── */

  const text = (t: string) => ({
    content: [{ type: "text" as const, text: t }],
    details: {},
  });

  /** 按 id 或名称找条目：模型常常只记得名字。 */
  const findSlot = (detail: DetailDto, ref: string): SlotDto => {
    const exact = detail.slots.find((s) => s.id === ref || s.title === ref);
    if (exact !== undefined) return exact;
    const fuzzy = detail.slots.filter(
      (s) => s.title.includes(ref) || ref.includes(s.title),
    );
    if (fuzzy.length === 1 && fuzzy[0] !== undefined) return fuzzy[0];
    throw new Error(
      `找不到材料「${ref}」。库里有：${detail.slots.map((s) => s.title).join("、")}`,
    );
  };

  const toolsFor = (libId: string): ToolDefinition[] => {
    const slotParam = Type.Object({
      material: Type.String({
        description:
          "材料名称（如「产品白皮书」）或条目 id，见 presales_overview。",
      }),
    });

    const overview = defineTool({
      name: "presales_overview",
      label: "售前清单",
      description:
        "Read this presales library: the template standard (each item's guide and checkpoints), what file is actually there, status, AI review summary, and the patrol to-do list. Call before answering anything about completeness or priorities.",
      parameters: Type.Object({}),
      async execute() {
        const [detail, ai] = await Promise.all([
          call<DetailDto>("GET", `/api/presales/${libId}`),
          call<AiDto>("GET", `/api/presales/${libId}/ai`),
        ]);
        const todos = computeTodos(detail, ai, now());
        const stageLabel = (code: string): string =>
          detail.stages.find((s) => s.code === code)?.label ?? code;
        const lines: string[] = [
          `# ${detail.lib.name}`,
          `标准模板：${detail.lib.templateName ?? "（未绑定）"}`,
          "",
          "## 标准 vs 实际",
        ];
        for (const st of detail.stages) {
          const slots = detail.slots.filter((s) => s.stage === st.code);
          const gaps = detail.templateGaps.filter(
            (g) => g.stageCode === st.code,
          );
          if (slots.length === 0 && gaps.length === 0) continue;
          lines.push(`### ${st.label}`);
          for (const s of slots) {
            const r = ai.reviews[s.id];
            const cur = s.current;
            const actual =
              cur === null
                ? s.versions.some((v) => v.status === "draft")
                  ? "缺口（有草稿待审定）"
                  : "缺口"
                : cur.fileExists === false
                  ? `文件丢失（${cur.fileName ?? ""}）`
                  : `${cur.fileName ?? ""}（${cur.version}）`;
            const rev =
              r === undefined
                ? "未审"
                : r.status === "done"
                  ? `已审：${String(r.counts.total)} 条，待定 ${String(r.counts.pending)}${r.counts.p0 > 0 ? `，P0×${String(r.counts.p0)}` : ""}${cur !== null && r.versionId !== cur.id ? "（审的是旧文件）" : ""}`
                  : r.status;
            lines.push(
              `- [${s.id}] **${s.title}**${s.priority ? " ★" : ""} · ${s.audience === "internal" ? "对内" : "对外"}${s.link === "outside" ? " · 模板外" : s.link === "unmatched" ? " · 对不上模板" : ""}`,
              `  - 实际：${actual}；审阅：${rev}`,
            );
            if (s.guide !== "") lines.push(`  - 标准说明：${s.guide}`);
            if (s.checkpoints.length > 0)
              lines.push(`  - 检查要点：${s.checkpoints.join("；")}`);
          }
          for (const g of gaps)
            lines.push(
              `- **${g.name}**${g.required ? "（必备）" : ""} · 模板要求但库里没有这一项`,
            );
        }
        // 模板外的阶段（理论上不会有）也别漏掉。
        const known = new Set(detail.stages.map((s) => s.code));
        for (const s of detail.slots.filter((x) => !known.has(x.stage)))
          lines.push(`- [${s.id}] **${s.title}** · ${stageLabel(s.stage)}`);
        lines.push("", "## 巡检待办");
        if (todos.length === 0) lines.push("（没有）");
        for (const t of todos)
          lines.push(
            `- [${t.level === "high" ? "高" : t.level === "mid" ? "中" : "低"}] ${t.title}——${t.detail}`,
          );
        return text(lines.join("\n"));
      },
    });

    const readMaterial = defineTool({
      name: "presales_read_material",
      label: "读材料",
      description:
        "Read the text of one material's current file (Office files: text only). Falls back to the latest draft when there is no current version.",
      parameters: slotParam,
      async execute(_id, params) {
        const detail = await call<DetailDto>("GET", `/api/presales/${libId}`);
        const slot = findSlot(detail, params.material);
        const v =
          slot.current ??
          slot.versions.find(
            (x) => x.status === "draft" || x.status === "review",
          );
        if (v?.fileName == null) throw new Error(`「${slot.title}」还没有文件`);
        const preview = await call<{
          kind: string;
          text?: string;
          reason?: string;
          truncated?: boolean;
        }>("GET", `/api/presales/versions/${v.id}/preview`);
        if (preview.text === undefined)
          throw new Error(preview.reason ?? "这份文件读不出文字");
        const cut = preview.text.length > MATERIAL_LIMIT;
        return text(
          `# ${slot.title} · ${v.fileName}（${v.version}，${v.status === "current" ? "现行版" : "草稿"}）\n\n${cut ? preview.text.slice(0, MATERIAL_LIMIT) : preview.text}${cut || preview.truncated === true ? "\n\n[正文过长，后面没读到]" : ""}`,
        );
      },
    });

    const startReview = defineTool({
      name: "presales_start_review",
      label: "发起审阅",
      description:
        "Start an AI review of one material's current file (runs in the background for a few minutes, costs model quota). The result appears in the list and via presales_review_result.",
      parameters: slotParam,
      async execute(_id, params) {
        const detail = await call<DetailDto>("GET", `/api/presales/${libId}`);
        const slot = findSlot(detail, params.material);
        await call("POST", `/api/presales/slots/${slot.id}/ai/review`, {});
        return text(
          `已对「${slot.title}」发起审阅，后台排队中。几分钟后用 presales_review_result 取结果；人也能在清单的「AI 审阅」一列看到进度。`,
        );
      },
    });

    const reviewResult = defineTool({
      name: "presales_review_result",
      label: "审阅结果",
      description:
        "Get the latest AI review of one material: verdict and each suggested revision (severity, original text, replacement, reason, evidence, decision).",
      parameters: slotParam,
      async execute(_id, params) {
        const detail = await call<DetailDto>("GET", `/api/presales/${libId}`);
        const slot = findSlot(detail, params.material);
        const ai = await call<AiDto>("GET", `/api/presales/${libId}/ai`);
        const brief = ai.reviews[slot.id];
        if (brief === undefined) return text(`「${slot.title}」还没审过。`);
        if (brief.status === "queued" || brief.status === "running")
          return text(
            `「${slot.title}」的审阅还在跑（${brief.status}），稍后再取。`,
          );
        if (brief.status !== "done")
          return text(
            `「${slot.title}」上次审阅${brief.status}：${brief.error ?? ""}`,
          );
        const job = await call<{
          result: {
            verdict: string;
            summary: string;
            issues: {
              severity: string;
              type: string;
              original: string;
              replacement: string | null;
              reason: string;
              evidence: string[];
              decision: string;
              applied: boolean;
            }[];
            gaps: string[];
          } | null;
        }>("GET", `/api/presales/ai/jobs/${brief.id}`);
        const r = job.result;
        if (r === null) return text("结果为空。");
        const decision: Record<string, string> = {
          pending: "待定",
          accepted: "已采纳",
          rejected: "已驳回",
        };
        return text(
          [
            `# 「${slot.title}」审阅：${r.verdict}`,
            r.summary,
            ...(brief.versionId !== slot.current?.id
              ? ["（注意：审的是旧文件，现行版之后换过）"]
              : []),
            "",
            ...r.issues.map(
              (i, n) =>
                `${String(n + 1)}. [${i.severity}·${i.type}·${i.applied ? "已写进修订稿" : (decision[i.decision] ?? i.decision)}] 「${i.original}」→「${i.replacement ?? "（删除/需手改）"}」——${i.reason}${i.evidence.length > 0 ? `（依据：${i.evidence.join("、")}）` : ""}`,
            ),
            ...(r.gaps.length > 0
              ? ["", `缺的检查要点：${r.gaps.join("；")}`]
              : []),
          ].join("\n"),
        );
      },
    });

    const writeDraft = defineTool({
      name: "presales_write_draft",
      label: "起草",
      description:
        "Save a Markdown draft for one material. It becomes a DRAFT version only (the current version is untouched); a human previews and promotes it. Include a 待核实 list at the end.",
      parameters: Type.Object({
        material: Type.String({
          description: "材料名称或条目 id（必须是清单里已有的条目）。",
        }),
        fileName: Type.String({
          description:
            "文件名（不含路径），按售前命名规则，如「RouteHub-POC方案-v0.1-20261022」。",
        }),
        markdown: Type.String({ description: "草稿全文（Markdown）。" }),
      }),
      async execute(_id, params) {
        const detail = await call<DetailDto>("GET", `/api/presales/${libId}`);
        const slot = findSlot(detail, params.material);
        const v = await call<VersionDto & { filePath: string }>(
          "POST",
          `/api/presales/slots/${slot.id}/draft`,
          { name: params.fileName, text: params.markdown },
        );
        return text(
          `草稿已存为「${v.fileName ?? ""}」（${v.version}，草稿状态，路径 ${v.filePath}）。现行版没动；请人在清单里预览，没问题再「设为可对外」。`,
        );
      },
    });

    return [overview, readMaterial, startReview, reviewResult, writeDraft].map(
      (t) => t as unknown as ToolDefinition,
    );
  };

  /* ── 接口 ── */

  app.get("/api/presales/:id/agent", async (request) => {
    const { id } = idParams.parse(request.params);
    const row = libRow(id);
    if (row === undefined) throw notFound("售前库不存在");
    const sessionId =
      row.agent_session_id !== null && store.get(row.agent_session_id)
        ? row.agent_session_id
        : null;
    return {
      sessionId,
      autoReview: row.auto_review === 1,
      todos: await todosOf(id),
    };
  });

  /** 取（没有就建）这本库的助手会话。 */
  app.post("/api/presales/:id/agent/session", (request) => {
    const { id } = idParams.parse(request.params);
    const row = libRow(id);
    if (row === undefined) throw notFound("售前库不存在");
    if (row.agent_session_id !== null && store.get(row.agent_session_id))
      return { sessionId: row.agent_session_id };
    const header = deps.newHeader() as { id: string };
    const created = store.create({
      id: header.id,
      title: `售前助手 · ${row.name}`,
      header,
      task: { kind: "presales-agent", libId: id },
      productId: row.product_id,
    });
    db.prepare(
      "UPDATE presales_libs SET agent_session_id = ? WHERE id = ?",
    ).run(created.id, id);
    return { sessionId: created.id };
  });

  app.post("/api/presales/:id/agent/patrol", (request) => {
    const { id } = idParams.parse(request.params);
    const { autoReview } = z
      .object({ autoReview: z.boolean() })
      .parse(request.body);
    if (libRow(id) === undefined) throw notFound("售前库不存在");
    db.prepare("UPDATE presales_libs SET auto_review = ? WHERE id = ?").run(
      autoReview ? 1 : 0,
      id,
    );
    return { autoReview };
  });

  return {
    profile(session) {
      if (session.task?.kind !== "presales-agent") return undefined;
      const row = libRow(session.task.libId);
      if (row === undefined) return undefined;
      return {
        systemPrompt: PRESALES_AGENT_PROMPT(row.name),
        tools: toolsFor(row.id),
      };
    },
    onUploaded(slotId) {
      const lib = db
        .prepare<[string], { auto_review: number; name: string | null }>(
          `SELECT l.auto_review, v.file_name AS name
             FROM presales_slots s
             JOIN presales_libs l ON l.id = s.lib_id
             LEFT JOIN presales_versions v ON v.slot_id = s.id AND v.status = 'current'
            WHERE s.id = ?`,
        )
        .get(slotId);
      if (lib?.auto_review !== 1 || !REVIEWABLE.test(lib.name ?? "")) return;
      // 不等它：上传接口先回，审阅在后台排队。已有一次在跑会被拒，忽略即可。
      void call("POST", `/api/presales/slots/${slotId}/ai/review`, {}).catch(
        () => undefined,
      );
    },
  };
}
