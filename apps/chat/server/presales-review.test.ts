import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { IN_MEMORY, openDb, type Db } from "./db.js";
import { EVIDENCE_OPEN } from "./evidence/brief.js";
import {
  createFileStore,
  openFilesIndex,
  type FileStore,
} from "./files/store.js";
import { createKeyStore } from "./model-config.js";
import { extractOfficeText } from "./office-text.js";
import { piPaths } from "./pi/runtime.js";
import { stripUbiquitous } from "./presales-review.js";
import { createSessionStore, type SessionStore } from "./sessions.js";
import { createSkillStore } from "./skills.js";

/**
 * 售前材料 AI 审阅与体系复盘的端到端：真接口 + 假对话运行器。
 *
 * 断言最要紧的几件事：
 * - 依据按「代码 > PRD > 其他」分层交给 AI，归档目录不进依据；
 * - 修订清单的原文在原文件里数得出命中，采纳后**在原文件里替换**、另存成草稿版，现行版不动；
 * - 体系复盘的闸（预览编号）与「台账 → 比对 → 每份修订」的顺序。
 */

const HOST = "127.0.0.1:4400";
let dir: string;
let db: Db;
let index: Db;
let files: FileStore;
let store: SessionStore;
let app: ReturnType<typeof createApp>["app"];
/** 每次对话收到的提示词，按任务种类记下。 */
const prompts: { job: string; title: string; message: string }[] = [];
/** 单份审阅时假模型给的修订清单。 */
let reviewIssues: unknown[] = [];

const fence = (value: unknown): string =>
  `好的，结论如下。\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

const docx = (paragraphs: string[]): Buffer =>
  Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8("<Types/>"),
      "word/document.xml": strToU8(
        `<w:document><w:body>${paragraphs
          .map(
            (p) => `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>${p}</w:t></w:r></w:p>`,
          )
          .join("")}</w:body></w:document>`,
      ),
    }),
  );

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-presales-ai-")));
  db = openDb(IN_MEMORY);
  index = openFilesIndex();
  mkdirSync(join(dir, "files"));
  files = createFileStore(join(dir, "files"), index);
  store = createSessionStore(db);
  prompts.length = 0;
  reviewIssues = [];
  ({ app } = createApp({
    auth: false,
    db,
    paths: piPaths(dir),
    keys: createKeyStore(dir, {}),
    skills: createSkillStore({
      dir: join(dir, "skills"),
      targetDirs: {
        pi: join(dir, "t", "pi"),
      },
    }),
    files,
    security: { port: 4400, webPort: 3200, extraOrigins: [] },
    fillRunner: {
      chat({ sessionId, message, onChunk }) {
        const task = store.get(sessionId)?.task;
        const job = task?.kind === "presales-ai" ? task.job : "none";
        prompts.push({
          job,
          title: store.get(sessionId)?.title ?? "",
          message,
        });
        const text =
          job === "ledger"
            ? fence({
                summary: "讲了并发",
                claims: [
                  {
                    topic: "并发上限",
                    category: "metric",
                    claim: "并发上限 100",
                    quote: "并发上限 100",
                  },
                ],
              })
            : job === "cross"
              ? fence({
                  summary: "并发说法不一",
                  issues: [
                    {
                      severity: "P1",
                      type: "inconsistent",
                      title: "并发上限说法不一",
                      detail: "白皮书 100，FAQ 200",
                      materials: ["产品白皮书", "常见问题解答（FAQ）"],
                      suggestion: "统一为代码里的 100",
                    },
                  ],
                })
              : fence({
                  verdict: "小修后可用",
                  summary: "有一处把规划写成已有",
                  issues: reviewIssues,
                });
        store.append(sessionId, [
          {
            type: "message",
            id: randomUUID(),
            message: { role: "assistant", content: [{ type: "text", text }] },
          },
        ]);
        onChunk({ type: "finish", finishReason: "stop" });
        return Promise.resolve();
      },
      abort: () => undefined,
    },
  }));

  // 事实依据：文档目录（含 PRD 与归档）+ 代码目录。
  const put = (path: string, text: string) =>
    files.write(path, Buffer.from(text, "utf8"), {
      mode: "overwrite",
      parents: true,
    });
  await put(
    "/产品/Alpha/prd/私有化部署-PRD.md",
    "# 私有化部署\n私有化一键部署为二期规划，尚未开发。",
  );
  await put("/产品/Alpha/roadmap.md", "# 路线图\n2027 Q1 私有化一键部署。");
  await put(
    "/产品/Alpha/_archive/旧白皮书.md",
    "# 旧\n私有化一键部署已上线（作废口径）。",
  );
  await put(
    "/代码库/alpha/limits.go",
    "package alpha\n// 私有化 一键部署 尚未实现\nconst MaxConcurrency = 100\n",
  );
});

afterEach(async () => {
  // 让后台还在跑的任务收尾，再关库。
  await new Promise((r) => setTimeout(r, 30));
  await app.close();
  db.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
async function call<T>(
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: object | Buffer,
  query = "",
): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method,
    url: `${url}${query}`,
    headers: {
      host: HOST,
      ...(Buffer.isBuffer(payload)
        ? { "content-type": "application/octet-stream" }
        : {}),
    },
    ...(payload === undefined ? {} : { payload }),
  });
  return {
    status: res.statusCode,
    body: res.body === "" ? (undefined as T) : res.json<T>(),
  };
}

interface SlotView {
  id: string;
  title: string;
  link: string;
  templateItem: { name: string } | null;
  guide: string;
  checkpoints: string[];
  current: { id: string; version: string; filePath: string } | null;
  versions: { id: string; version: string; status: string; filePath: string }[];
}

async function seedLib(): Promise<{ libId: string; slots: SlotView[] }> {
  const line = await call<{ id: string }>("POST", "/api/product-lines", {
    name: "云路由",
  });
  const product = await call<{ id: string }>(
    "POST",
    `/api/product-lines/${line.body.id}/products`,
    { name: "Alpha", folderPath: "/产品/Alpha", codePath: "/代码库/alpha" },
  );
  const lib = await call<{ lib: { id: string } }>("POST", "/api/presales", {
    productId: product.body.id,
  });
  const libId = lib.body.lib.id;
  // 这里测的是人手动发起的审阅 / 复盘；巡检的「上传后自动审阅」另有测试（presales-agent.test.ts）。
  await call("POST", `/api/presales/${libId}/agent/patrol`, {
    autoReview: false,
  });
  const detail = await call<{ slots: SlotView[] }>(
    "GET",
    `/api/presales/${libId}`,
  );
  return { libId, slots: detail.body.slots };
}

async function upload(slotId: string, name: string, bytes: Buffer) {
  return call<{ id: string }>(
    "POST",
    `/api/presales/slots/${slotId}/upload`,
    bytes,
    `?name=${encodeURIComponent(name)}`,
  );
}

async function waitIdle(libId: string): Promise<void> {
  for (let i = 0; i < 300; i += 1) {
    const { body } = await call<{ busy: boolean }>(
      "GET",
      `/api/presales/${libId}/ai`,
    );
    if (!body.busy) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("审阅没有跑完");
}

const slotNamed = (slots: SlotView[], title: string): SlotView => {
  const s = slots.find((x) => x.title === title);
  if (s === undefined) throw new Error(`没有「${title}」`);
  return s;
};

describe("售前条目对上模板条目", () => {
  it("建库即对号；说明与检查要点实时取模板；改名后仍对得上", async () => {
    const { libId, slots } = await seedLib();
    const paper = slotNamed(slots, "产品白皮书");
    expect(paper.link).toBe("linked");
    expect(paper.checkpoints.length).toBeGreaterThan(0);

    // 改模板里这一项的说明 → 库里立刻跟着变（审阅标准跟着模板走）。
    const tpls = await call<{
      templates: {
        id: string;
        builtinKey: string | null;
        stages: { items: { id: string; name: string }[] }[];
      }[];
    }>("GET", "/api/presales-templates");
    const tpl = tpls.body.templates.find((t) => t.builtinKey === "product");
    const item = tpl?.stages
      .flatMap((s) => s.items)
      .find((i) => i.name === "产品白皮书");
    expect(item).toBeDefined();
    await call("PATCH", `/api/presales-items/${item?.id ?? ""}`, {
      guide: "新的说明",
      checkpoints: "要点一\n要点二",
    });
    // 条目自己改名：靠 id 仍对得上。
    await call("PATCH", `/api/presales/slots/${paper.id}`, {
      title: "白皮书（2026 版）",
    });
    const after = await call<{ slots: SlotView[]; templateGaps: unknown[] }>(
      "GET",
      `/api/presales/${libId}`,
    );
    const renamed = slotNamed(after.body.slots, "白皮书（2026 版）");
    expect(renamed.link).toBe("linked");
    expect(renamed.guide).toBe("新的说明");
    expect(renamed.checkpoints).toEqual(["要点一", "要点二"]);
    expect(after.body.templateGaps).toEqual([]);
  });

  it("老库（没绑模板、名字是旧叫法）：绑模板后按别名对号，模板外与缺口都报出来", async () => {
    const { libId, slots } = await seedLib();
    // 模拟老库：解绑模板，改成旧叫法，再加一条模板外的。
    await call("POST", `/api/presales/${libId}/template`, { templateId: null });
    const survey = slots.find((s) => s.title === "需求调研表");
    await call("PATCH", `/api/presales/slots/${survey?.id ?? ""}`, {
      title: "需求摸底表",
    });
    await call("POST", `/api/presales/${libId}/slots`, {
      title: "客户画像",
      stage: "S1",
    });
    const unbound = await call<{ slots: SlotView[]; templateGaps: unknown[] }>(
      "GET",
      `/api/presales/${libId}`,
    );
    expect(unbound.body.slots.every((s) => s.link === "none")).toBe(true);

    const tpls = await call<{
      templates: { id: string; builtinKey: string | null }[];
    }>("GET", "/api/presales-templates");
    const tplId =
      tpls.body.templates.find((t) => t.builtinKey === "product")?.id ?? "";
    const bound = await call<{
      linked: number;
      unmatched: string[];
      gaps: string[];
    }>("POST", `/api/presales/${libId}/template`, { templateId: tplId });
    expect(bound.body.unmatched).toEqual(["客户画像"]);
    expect(bound.body.gaps).toEqual([]);
    const detail = await call<{ slots: SlotView[] }>(
      "GET",
      `/api/presales/${libId}`,
    );
    expect(slotNamed(detail.body.slots, "需求摸底表").templateItem?.name).toBe(
      "需求调研表",
    );

    // 人把它明确标成模板外。
    const persona = slotNamed(detail.body.slots, "客户画像");
    await call("PATCH", `/api/presales/slots/${persona.id}`, {
      templateItemId: "-",
    });
    const marked = await call<{ slots: SlotView[] }>(
      "GET",
      `/api/presales/${libId}`,
    );
    expect(slotNamed(marked.body.slots, "客户画像").link).toBe("outside");
  });
});

describe("单份 AI 审阅", () => {
  it("依据分层交给 AI；采纳后在原文件里替换、另存草稿版，现行版不动", async () => {
    const { libId, slots } = await seedLib();
    const paper = slotNamed(slots, "产品白皮书");
    const faq = slotNamed(slots, "常见问题解答（FAQ）");
    await upload(
      paper.id,
      "白皮书.docx",
      docx(["平台已支持私有化一键部署。", "默认并发上限 100。"]),
    );
    await upload(faq.id, "FAQ.md", Buffer.from("# FAQ\n并发上限是 200。\n"));
    reviewIssues = [
      {
        severity: "P0",
        type: "roadmap-as-shipped",
        original: "已支持私有化一键部署",
        replacement: "私有化一键部署在规划中",
        reason: "PRD 标为二期",
        evidence: ["/产品/Alpha/prd/私有化部署-PRD.md"],
      },
      {
        severity: "P2",
        type: "checkpoint",
        original: "",
        replacement: null,
        reason: "缺 SLA",
      },
      {
        severity: "P1",
        type: "inconsistent",
        original: "这句话不在材料里",
        replacement: "x",
        reason: "模型没逐字摘",
      },
    ];

    const started = await call<{ id: string; status: string }>(
      "POST",
      `/api/presales/slots/${paper.id}/ai/review`,
      {},
    );
    expect(started.status).toBe(201);
    await waitIdle(libId);

    const sent = prompts.find((p) => p.job === "review");
    expect(sent?.message.startsWith(EVIDENCE_OPEN)).toBe(true);
    expect(sent?.message).toContain("第二层 · PRD");
    expect(sent?.message).toContain("/产品/Alpha/prd/私有化部署-PRD.md");
    expect(sent?.message).toContain("/代码库/alpha/limits.go");
    // 归档里的旧口径不当依据。
    expect(sent?.message).not.toContain('路径="/产品/Alpha/_archive');
    // 同库其他材料的说法带上了。
    expect(sent?.message).toContain('<其他材料 名称="常见问题解答（FAQ）"');
    expect(sent?.message).toContain("并发上限是 200");

    const job = await call<{
      status: string;
      result: { issues: { id: string; matches: number }[] };
    }>("GET", `/api/presales/ai/jobs/${started.body.id}`);
    expect(job.body.status).toBe("done");
    expect(job.body.result.issues.map((i) => i.matches)).toEqual([1, 0, 0]);

    // 没采纳就采纳不了。
    const early = await call(
      "POST",
      `/api/presales/ai/jobs/${started.body.id}/apply`,
      {},
    );
    expect(early.status).toBe(400);

    await call("POST", `/api/presales/ai/jobs/${started.body.id}/decisions`, {
      decisions: { "1": "accepted", "3": "accepted" },
    });
    const applied = await call<{
      version: {
        id: string;
        version: string;
        status: string;
        filePath: string;
      };
      applied: string[];
    }>("POST", `/api/presales/ai/jobs/${started.body.id}/apply`, {});
    expect(applied.status).toBe(201);
    expect(applied.body.applied).toEqual(["1"]);
    expect(applied.body.version.status).toBe("draft");
    expect(applied.body.version.version).toBe("v1.1");
    expect(applied.body.version.filePath).toMatch(
      /^\/临时区\/售前\/.+\/AI修订\//,
    );

    const { stream } = await files.openRead(applied.body.version.filePath);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(Buffer.from(c as Uint8Array));
    expect(extractOfficeText("x.docx", Buffer.concat(chunks))?.text).toContain(
      "平台私有化一键部署在规划中。",
    );

    const detail = await call<{ slots: SlotView[] }>(
      "GET",
      `/api/presales/${libId}`,
    );
    const now = slotNamed(detail.body.slots, "产品白皮书");
    expect(now.current?.version).toBe("v1.0");
    expect(now.versions.map((v) => v.status).sort()).toEqual([
      "current",
      "draft",
    ]);
  });

  it("视频这类读不出文字的：直接失败并说明原因", async () => {
    const { libId, slots } = await seedLib();
    const demo = slots.find((s) => s.title.startsWith("演示视频"));
    await upload(demo?.id ?? "", "演示.mp4", Buffer.from([0, 1, 2]));
    const started = await call<{ id: string }>(
      "POST",
      `/api/presales/slots/${demo?.id ?? ""}/ai/review`,
      {},
    );
    await waitIdle(libId);
    const job = await call<{ status: string; error: string }>(
      "GET",
      `/api/presales/ai/jobs/${started.body.id}`,
    );
    expect(job.body.status).toBe("failed");
    expect(job.body.error).toContain("读不出文字");
    expect(prompts).toHaveLength(0);
  });
});

describe("体系复盘", () => {
  it("预览 → 预览编号闸 → 台账 → 比对 → 每份修订（带上比对点到它的问题）", async () => {
    const { libId, slots } = await seedLib();
    const paper = slotNamed(slots, "产品白皮书");
    const faq = slotNamed(slots, "常见问题解答（FAQ）");
    await upload(paper.id, "白皮书.docx", docx(["默认并发上限 100。"]));
    await upload(faq.id, "FAQ.md", Buffer.from("并发上限是 200。\n"));

    const plan = await call<{
      planId: string;
      materials: { title: string }[];
      skipped: { title: string; reason: string }[];
      sessions: number;
    }>("GET", `/api/presales/${libId}/ai/plan`);
    expect(plan.body.materials.map((m) => m.title).sort()).toEqual([
      "产品白皮书",
      "常见问题解答（FAQ）",
    ]);
    expect(plan.body.sessions).toBe(5);
    expect(plan.body.skipped.every((s) => s.reason.startsWith("缺口"))).toBe(
      true,
    );

    // 预览编号对不上（预览之后材料变了）不开跑；不再要求手打确认语。
    const stale = await call("POST", `/api/presales/${libId}/ai/runs`, {
      planId: "0000",
    });
    expect(stale.status).toBe(409);

    reviewIssues = [
      {
        severity: "P1",
        type: "inconsistent",
        original: "200",
        replacement: "100",
        reason: "代码里是 100",
        evidence: ["/代码库/alpha/limits.go"],
      },
    ];
    const run = await call<{ id: string }>(
      "POST",
      `/api/presales/${libId}/ai/runs`,
      { planId: plan.body.planId },
    );
    expect(run.status).toBe(201);
    await waitIdle(libId);

    expect(prompts.map((p) => p.job)).toEqual([
      "ledger",
      "ledger",
      "cross",
      "review",
      "review",
    ]);
    const cross = prompts.find((p) => p.job === "cross");
    expect(cross?.message).toContain('<材料台账 名称="产品白皮书"');
    const faqReview = prompts.find(
      (p) => p.job === "review" && p.title.includes("FAQ"),
    );
    expect(faqReview?.message).toContain("体系复盘里点到这份材料的问题");
    expect(faqReview?.message).toContain("并发上限说法不一");
    // 有了台账，其他材料用台账而不是原文片段。
    expect(faqReview?.message).toContain('形式="台账"');

    const state = await call<{
      run: {
        status: string;
        reviews: { slotId: string; counts: { total: number } }[];
      };
    }>("GET", `/api/presales/${libId}/ai`);
    expect(state.body.run.status).toBe("done");
    expect(state.body.run.reviews).toHaveLength(2);

    // 收尾：采纳 FAQ 那条，一次性生成修订稿。
    const faqJob = state.body.run.reviews.find((r) => r.slotId === faq.id);
    await call(
      "POST",
      `/api/presales/ai/jobs/${(faqJob as unknown as { id: string }).id}/decisions`,
      { decisions: { "1": "accepted" } },
    );
    const all = await call<{
      results: { slotId: string; ok: boolean; message: string }[];
    }>("POST", `/api/presales/ai/runs/${run.body.id}/apply`, {});
    expect(all.body.results.find((r) => r.slotId === faq.id)?.ok).toBe(true);
    expect(all.body.results.find((r) => r.slotId === paper.id)?.ok).toBe(false);
  });
});

describe("定位用的分段：剥掉通篇词", () => {
  it("每段都有的品牌词、产品名拆出来的词不拿去定位；段落特有的词留着", () => {
    const windows = [
      "RouteHub 支持私有化部署与离线授权",
      "RouteHub 的计费按 token 结算，支持预付费",
      "RouteHub 提供审计日志与敏感词拦截",
      "RouteHub 兼容 OpenAI 协议",
    ];
    const out = stripUbiquitous(windows, ["ModelHub（模型路由中枢）"]);
    expect(out.every((w) => !/routehub/i.test(w))).toBe(true);
    expect(out[0]).toContain("私有化部署");
    expect(out[1]).toContain("预付费");
    expect(out[3]).toContain("OpenAI");
    // 分段太少时不判「通篇」：两段都出现不说明什么。
    expect(stripUbiquitous(["A 产品 退款", "A 产品 审批"], [])[0]).toContain(
      "产品",
    );
  });
});
