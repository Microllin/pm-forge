import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "./app.js";
import { IN_MEMORY, openDb, type Db } from "./db.js";
import { createFileStore, openFilesIndex } from "./files/store.js";
import type { FillRunView, Plan } from "./global-fill.js";
import { createKeyStore } from "./model-config.js";
import { piPaths } from "./pi/runtime.js";
import { createSessionStore } from "./sessions.js";
import { createSkillStore } from "./skills.js";

/**
 * 全局补齐的端到端：真分析接口 + 假对话运行器（按会话的任务种类回一段合规的回答）。
 * 断言三件事：闸（预览编号；不再要求手打确认语）、只写草稿区、挪入替换。
 */

const HOST = "127.0.0.1:4400";
let dir: string;
let root: string;
let db: Db;
let index: Db;
let app: ReturnType<typeof createApp>["app"];
/** 比对时要逐项给结论（漏给的按「缺」算）。跑起来前由测试填好。 */
let artifacts: string[] = [];
let missingArtifact = "";
const chats: string[] = [];

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pmforge-fill-")));
  root = join(dir, "files");
  mkdirSync(join(root, "产品", "Alpha"), { recursive: true });
  writeFileSync(join(root, "产品", "Alpha", "README.md"), "# Alpha\n路由平台");
  db = openDb(IN_MEMORY);
  index = openFilesIndex();
  chats.length = 0;
  const store = createSessionStore(db);
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
    files: createFileStore(root, index),
    security: { port: 4400, webPort: 3200, extraOrigins: [] },
    fillRunner: {
      chat({ sessionId, onChunk }) {
        const kind = store.get(sessionId)?.task?.kind ?? "none";
        chats.push(kind);
        const text =
          kind === "compare"
            ? fence({
                findings: artifacts.map((a) => ({
                  artifact: a,
                  status: a === missingArtifact ? "missing" : "present",
                })),
              })
            : kind === "fill-artifact"
              ? `好的。\n===DRAFT===\n# 草稿\nAI 写的产出物\n===/DRAFT===\n${fence({ fileName: "prd/补的.md" })}`
              : kind === "wiki-outline"
                ? fence({
                    pages: [
                      { title: "产品快照", brief: "是什么" },
                      { title: "架构", brief: "怎么搭" },
                    ],
                  })
                : "===WIKI===\n## 一节\nAI 写的章节\n===/WIKI===";
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
});
afterEach(async () => {
  await app.close();
  db.close();
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

const fence = (value: unknown): string =>
  `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

// 测试里按接口断言响应形状；T 只出现在返回值上是有意的。
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
async function call<T>(
  method: "GET" | "POST",
  url: string,
  payload?: object,
): Promise<{ status: number; body: T }> {
  const res = await app.inject({
    method,
    url,
    headers: { host: HOST },
    ...(payload === undefined ? {} : { payload }),
  });
  return { status: res.statusCode, body: res.json<T>() };
}

async function seedProduct(): Promise<string> {
  const templates = await call<{
    templates: {
      id: string;
      stages: { code: string; artifacts: { name: string }[] }[];
    }[];
  }>("GET", "/api/lifecycle-templates");
  const template = templates.body.templates[0];
  if (!template) throw new Error("没有出厂模板");
  artifacts = template.stages.flatMap((s) => s.artifacts.map((a) => a.name));
  missingArtifact = artifacts[0] ?? "";
  const line = await call<{ id: string }>("POST", "/api/product-lines", {
    name: "云路由",
  });
  const product = await call<{ id: string }>(
    "POST",
    `/api/product-lines/${line.body.id}/products`,
    { name: "Alpha", folderPath: "/产品/Alpha", templateId: template.id },
  );
  return product.body.id;
}

async function waitDone(): Promise<FillRunView> {
  for (let i = 0; i < 200; i += 1) {
    const { body } = await call<{ run: FillRunView | null }>(
      "GET",
      "/api/global-fill/current",
    );
    if (body.run && body.run.status !== "running") return body.run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("补齐没有跑完");
}

describe("全局 AI 补齐", () => {
  it("预览：没绑目录的产品整行跳过；有目录的先比对、先规划 wiki", async () => {
    const productId = await seedProduct();
    const line = await call<{ id: string }>("POST", "/api/product-lines", {
      name: "空产线",
    });
    await call("POST", `/api/product-lines/${line.body.id}/products`, {
      name: "Beta",
    });
    const { body } = await call<Plan>("GET", "/api/global-fill/plan");
    const alpha = body.rows.find((r) => r.productId === productId);
    const beta = body.rows.find((r) => r.productName === "Beta");
    expect(alpha?.lifecycle.state).toBe("compare");
    expect(alpha?.wiki.state).toBe("outline");
    expect(alpha?.idle).toBe(false);
    expect(beta?.idle).toBe(true);
    expect(beta?.lifecycle).toMatchObject({ state: "skip" });
    // 只算不跑：一条对话都没开。
    expect(chats).toEqual([]);
  });

  it("闸：预览之后情况变了 409，不开跑", async () => {
    const productId = await seedProduct();

    const stale = await call("POST", "/api/global-fill/start", {
      productIds: [productId],
      planId: "0000",
    });
    expect(stale.status).toBe(409);
    expect(chats).toEqual([]);
  });

  it("跑完：草稿只在草稿区；挪入后写进产品目录与 wiki，草稿区清空", async () => {
    const productId = await seedProduct();
    const { body: plan } = await call<Plan>("GET", "/api/global-fill/plan");
    const started = await call<FillRunView>("POST", "/api/global-fill/start", {
      productIds: [productId],
      planId: plan.planId,
    });
    expect(started.status).toBe(201);

    const run = await waitDone();
    expect(run.status).toBe("done");
    expect(run.jobs.every((j) => j.status === "done")).toBe(true);
    // 比对 1 + 写缺的那 1 份 + 规划目录 1 + 写 2 章
    expect(chats.sort()).toEqual(
      [
        "compare",
        "fill-artifact",
        "wiki-outline",
        "wiki-page",
        "wiki-page",
      ].sort(),
    );
    expect(run.drafts).toHaveLength(3);
    expect(
      run.drafts.every((d) => d.draftPath.startsWith("/临时区/AI补齐/")),
    ).toBe(true);
    // 产品目录没被碰。
    const target = join(root, "产品", "Alpha", "prd", "补的.md");
    expect(existsSync(target)).toBe(false);
    const artifact = run.drafts.find((d) => d.kind === "artifact");
    expect(artifact?.target).toBe("/产品/Alpha/prd/补的.md");

    const applied = await call<{ applied: string[]; failed: unknown[] }>(
      "POST",
      "/api/global-fill/drafts/apply",
      { ids: run.drafts.map((d) => d.id) },
    );
    expect(applied.body.failed).toEqual([]);
    expect(applied.body.applied).toHaveLength(3);
    expect(readFileSync(target, "utf8")).toContain("AI 写的产出物");
    const tree = await call<{ pages: { length: number }[] }>(
      "GET",
      `/api/products/${productId}/wiki`,
    );
    expect(tree.body.pages.every((p) => p.length > 0)).toBe(true);
    // 都处理完了：这次补齐的草稿文件夹被收掉。
    expect(existsSync(join(root, run.folder.slice(1)))).toBe(false);
  });

  it("临时区里看得到补齐草稿，并能在那里确认（与补齐页同一个动作、同一份状态）", async () => {
    const productId = await seedProduct();
    const { body: plan } = await call<Plan>("GET", "/api/global-fill/plan");
    await call("POST", "/api/global-fill/start", {
      productIds: [productId],
      planId: plan.planId,
    });
    const run = await waitDone();
    const staging = await call<{
      items: { key: string; source: string; target: string | null }[];
      counts: { fill: number };
    }>("GET", "/api/staging");
    expect(staging.body.counts.fill).toBe(3);
    const artifact = run.drafts.find((d) => d.kind === "artifact");
    if (!artifact) throw new Error("没有产出物草稿");
    const item = staging.body.items.find(
      (i) => i.key === `fill:${artifact.id}`,
    );
    expect(item?.target).toBe("/产品/Alpha/prd/补的.md");

    const applied = await call<{
      applied: { key: string; path: string | null }[];
      failed: unknown[];
    }>("POST", "/api/staging/apply", {
      items: [{ key: `fill:${artifact.id}` }],
    });
    expect(applied.body.failed).toEqual([]);
    expect(applied.body.applied).toEqual([
      {
        key: `fill:${artifact.id}`,
        title: expect.any(String) as unknown,
        path: "/产品/Alpha/prd/补的.md",
      },
    ]);
    expect(
      readFileSync(join(root, "产品", "Alpha", "prd", "补的.md"), "utf8"),
    ).toContain("AI 写的产出物");
    // 补齐页看到的是同一份状态。
    const current = await call<{ run: FillRunView | null }>(
      "GET",
      "/api/global-fill/current",
    );
    expect(
      current.body.run?.drafts.find((d) => d.id === artifact.id)?.status,
    ).toBe("applied");
  });

  it("丢弃：删掉草稿文件，不写正式位置", async () => {
    const productId = await seedProduct();
    const { body: plan } = await call<Plan>("GET", "/api/global-fill/plan");
    await call("POST", "/api/global-fill/start", {
      productIds: [productId],
      planId: plan.planId,
    });
    const run = await waitDone();
    const artifact = run.drafts.find((d) => d.kind === "artifact");
    if (!artifact) throw new Error("没有产出物草稿");
    await call("POST", "/api/global-fill/drafts/discard", {
      ids: [artifact.id],
    });
    expect(existsSync(join(root, artifact.draftPath.slice(1)))).toBe(false);
    expect(existsSync(join(root, "产品", "Alpha", "prd", "补的.md"))).toBe(
      false,
    );
  });
});
