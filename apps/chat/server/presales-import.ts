import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { Db } from "./db.js";
import type { FileStore } from "./files/store.js";

/**
 * 售前材料「AI 识别」。
 *
 * ## 不做目录映射
 *
 * 用户的真实情况是：一个超大文件夹里散着几百个文件，命名不统一、版本混在一起，
 * 有的还躺在子目录里。所以不能按「哪个目录对应哪类材料」去猜——那套规则在真实
 * 的旧材料堆里必然错。做法是：**把范围内的文件清单交给模型，让它判每类材料
 * 该用哪一份**，判断依据是文件名、路径、修改时间、大小。
 *
 * ## 只挑不写
 *
 * 识别结果先落成一份**候选清单**（presales_import_candidates），人在界面上逐条
 * 改判、勾选，确认后才真正建版本、挂文件。理由：AI 认错一版「报价单-对内」
 * 当「对外版」发出去，代价远高于多点几下确认。
 *
 * ## 文件不入库，只记指针
 *
 * 候选记录存的是**文件库里的路径**，确认时才把指针对应到版本上。这样同一次识别
 * 可以反复确认、调完再确认，不会在还没定的时候就把文件复制一份。
 */

/* ── 扫描范围 ───────────────────────────────────────────────────────── */

/** 一次最多看多少个文件。再多就是「挑错了范围」，让人先把范围缩小。 */
export const MAX_SCAN_FILES = 800;
/** 发给模型的清单最多多少行。超出时只发最近的这些，并明确告诉模型这是截断的。 */
const MAX_PROMPT_LINES = 320;

export interface ScannedFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: number;
}

/**
 * 列出范围内的文件名清单。
 *
 * 刻意不读文件正文：售前材料大多是 PPT / PDF / 视频，读不出东西；而且几百个文件
 * 的正文会直接撑爆上下文。靠「文件名 + 路径 + 修改时间 + 大小」判断已经足够
 * ——这类材料的文件名本来就带着版本号和日期，也正是用户平时挑文件的方式。
 */
export function scanForRecognition(
  files: FileStore,
  scopePath: string,
): { files: ScannedFile[]; total: number; truncated: boolean } {
  if (!files.exists(scopePath)) {
    throw Object.assign(new Error("选中的文件夹不存在"), { status: 404 });
  }
  const result = files.listFilesDeep(scopePath, { limit: MAX_SCAN_FILES });
  return {
    files: result.files
      .filter((f) => !f.isDir)
      .map((f) => ({
        path: f.path,
        name: f.name,
        size: f.size,
        modifiedAt: f.modifiedAt,
      })),
    total: result.total,
    truncated: result.truncated,
  };
}

/* ── 提示词 ─────────────────────────────────────────────────────────── */

const fmtDate = (ms: number): string => {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const fmtSize = (bytes: number): string => {
  if (bytes < 1024 * 1024)
    return `${String(Math.max(1, Math.round(bytes / 1024)))}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
};

export interface RecognizePromptInput {
  scopePath: string;
  files: ScannedFile[];
  /** 范围内的文件总数（清单可能被截断）。 */
  total: number;
  truncated: boolean;
  /** 这本售前库现有的槽位（应该有哪些材料）。 */
  slots: { id: string; title: string; stage: string; audience: string }[];
}

export function recognizePrompt(input: RecognizePromptInput): string {
  const slots = input.slots
    .map(
      (s) =>
        `- ${s.title}（阶段：${s.stage}；${s.audience === "internal" ? "对内" : "对外"}）`,
    )
    .join("\n");

  // 最近的排前面：挑「最新一版」时它们是候选。截断时也优先保住这些。
  const list = input.files
    .slice()
    .sort((a, b) => b.modifiedAt - a.modifiedAt)
    .slice(0, MAX_PROMPT_LINES)
    .map((f) => `${f.path}\t${fmtDate(f.modifiedAt)}\t${fmtSize(f.size)}`)
    .join("\n");

  return `你是售前材料管理员。下面是一个文件夹范围内的**全部文件清单**，以及一本售前库**应该有的材料清单**。

你的任务：对每一类材料，从文件里挑出**最合适的一份**（能挑就挑，挑不出就留空）。

## 文件清单

范围：${input.scopePath}
共 ${String(input.total)} 个文件${input.truncated ? `（清单只给了最近修改的 ${String(input.files.length)} 个，其余未列出）` : ""}。
每行格式：路径 \t 最后修改日期 \t 大小

\`\`\`
${list}
\`\`\`

## 这本库应该有的材料

${slots}

## 判断规则（按优先级）

1. **先认类型**：按文件名和路径判断属于哪一类材料。类型对不上宁可留空，不要硬塞。
2. **同一类有多份时挑最新有效版**：
   - 文件名里带版本号（v1.0 / v2.2 / V3）——取数字最大的；
   - 带日期（20261010 / 2026-10-10 / 20250313）——取日期最新的；
   - 都没有就看最后修改时间，取最新的；
   - **但要排除**：名字里带「旧」「历史」「归档」「废弃」「草稿」「backup」「copy」「副本」「(1)」这类标记的，除非没有别的可选。
3. **对内外要看清楚**：库里的材料标注了「对内」还是「对外」。
   - 标「对内」的（如报价单含底价、招投标参数）：挑文件名带「对内」「内部」「保密」的，或者文件名没标但内容明显是内部的；
   - 标「对外」的：挑「对外版」或没标对内的那份；
   - **绝对不能**把「对内」的文件挑给「对外」的槽位——这是最容易出事的错，宁可留空并在说明里写一句「只有对内版」。
4. **同一材料的不同交付形态**（如白皮书同时有 word 和 pdf）取 pdf/docx 中排版完整的那份；不确定时两条都列出来，把更可能的那条放前面。
5. 视频、图片这类素材只按名字匹配，不要因为大小异常就排除。

## 输出

先在正文里用几句话说明你怎么挑的（尤其是拿不准的、留空的），然后在**末尾**给一个 json 块，严格是这个形状：

\`\`\`json
{
  "picks": [
    {
      "slotTitle": "产品白皮书",
      "filePath": "/售前材料/RouteHub-白皮书-v2.2-20261010.docx",
      "confidence": "high",
      "reason": "文件名含 v2.2，是带版本号的最新一份",
      "alternates": [
        { "filePath": "/售前材料/RouteHub-白皮书-v2.0-20260721.docx", "reason": "旧版本" }
      ]
    }
  ]
}
\`\`\`

要求：
- \`slotTitle\` 必须是上面「应该有的材料」清单里的原文标题，不要自创。
- \`filePath\` 必须是文件清单里的**完整路径原文**，不要改写、不要省略。
- \`confidence\` 只能是 \`high\` / \`medium\` / \`low\`。
- 挑不出文件的材料**不要出现在 picks 里**（正文里说明原因即可）。
- 同一类材料只给一条 pick；备选放 \`alternates\`，最多 3 条。`;
}

/* ── 结果解析 ───────────────────────────────────────────────────────── */

export const recognizeResultSchema = z.object({
  picks: z.array(
    z.object({
      slotTitle: z.string(),
      filePath: z.string(),
      confidence: z.enum(["high", "medium", "low"]).catch("low"),
      reason: z.string().default(""),
      alternates: z
        .array(
          z.object({ filePath: z.string(), reason: z.string().default("") }),
        )
        .default([]),
    }),
  ),
});
export type RecognizeResult = z.infer<typeof recognizeResultSchema>;

/* ── 候选落库 ───────────────────────────────────────────────────────── */

export interface Candidate {
  id: string;
  libId: string;
  slotId: string;
  slotTitle: string;
  filePath: string;
  /** 从文件路径推出的文件名。 */
  fileName: string;
  fileSize: number;
  fileModifiedAt: number;
  confidence: "high" | "medium" | "low";
  reason: string;
  /** 备选文件（不建版本，只记着，供人切换）。 */
  alternates: { filePath: string; reason: string }[];
  /** pending 待确认 / accepted 已入库 / rejected 已忽略。 */
  status: "pending" | "accepted" | "rejected";
  /** 确认后建出来的版本。 */
  versionId: string | null;
  createdAt: number;
}

interface CandidateRow {
  id: string;
  lib_id: string;
  slot_id: string;
  file_path: string;
  file_name: string;
  file_size: number;
  file_modified_at: number;
  confidence: string;
  reason: string;
  alternates: string;
  status: string;
  version_id: string | null;
  created_at: number;
}

const toCandidate = (r: CandidateRow, slotTitle: string): Candidate => ({
  id: r.id,
  libId: r.lib_id,
  slotId: r.slot_id,
  slotTitle,
  filePath: r.file_path,
  fileName: r.file_name,
  fileSize: r.file_size,
  fileModifiedAt: r.file_modified_at,
  confidence: r.confidence as Candidate["confidence"],
  reason: r.reason,
  alternates: JSON.parse(r.alternates) as {
    filePath: string;
    reason: string;
  }[],
  status: r.status as Candidate["status"],
  versionId: r.version_id,
  createdAt: r.created_at,
});

export interface CandidateStore {
  /** 存一批候选（先清掉这本库上一轮还没处理的 pending）。 */
  replace(libId: string, rows: Omit<Candidate, "id" | "createdAt">[]): void;
  list(libId: string): Candidate[];
  get(id: string): Candidate | undefined;
  /** 改判：换文件 / 忽略 / 恢复待确认。 */
  update(
    id: string,
    input: { filePath?: string; status?: Candidate["status"] },
  ): void;
  /** 标记已入库，记下建出来的版本。 */
  accept(id: string, versionId: string): void;
  clear(libId: string): void;
}

export function createCandidateStore(
  db: Db,
  slotTitleOf: (slotId: string) => string,
): CandidateStore {
  const rowOf = (id: string): CandidateRow | undefined =>
    db
      .prepare<[string], CandidateRow>(
        `SELECT c.*, s.title AS slot_title
           FROM presales_import_candidates c
           JOIN presales_slots s ON s.id = c.slot_id
          WHERE c.id = ?`,
      )
      .get(id);

  return {
    replace(libId, rows) {
      const now = Date.now();
      db.transaction(() => {
        // 只清上一轮还没处理的；已经确认入库的留着，方便回看「上次导了什么」。
        db.prepare(
          "DELETE FROM presales_import_candidates WHERE lib_id = ? AND status = 'pending'",
        ).run(libId);
        const insert = db.prepare(
          `INSERT INTO presales_import_candidates
             (id, lib_id, slot_id, file_path, file_name, file_size, file_modified_at,
              confidence, reason, alternates, status, version_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, ?)`,
        );
        for (const row of rows) {
          insert.run(
            randomUUID(),
            libId,
            row.slotId,
            row.filePath,
            row.fileName,
            row.fileSize,
            row.fileModifiedAt,
            row.confidence,
            row.reason,
            JSON.stringify(row.alternates),
            now,
          );
        }
      })();
    },

    list(libId) {
      return db
        .prepare<[string], CandidateRow & { slot_title: string }>(
          `SELECT c.*, s.title AS slot_title
             FROM presales_import_candidates c
             JOIN presales_slots s ON s.id = c.slot_id
            WHERE c.lib_id = ?
            ORDER BY s.sort_order, c.created_at`,
        )
        .all(libId)
        .map((r) => toCandidate(r, r.slot_title));
    },

    get(id) {
      const row = rowOf(id);
      if (row === undefined) return undefined;
      const title = db
        .prepare<[string], { title: string }>(
          "SELECT title FROM presales_slots WHERE id = ?",
        )
        .get(row.slot_id)?.title;
      return toCandidate(row, title ?? slotTitleOf(row.slot_id));
    },

    update(id, input) {
      const row = rowOf(id);
      if (row === undefined) return;
      db.prepare(
        `UPDATE presales_import_candidates
            SET file_path = ?, status = ?
          WHERE id = ?`,
      ).run(input.filePath ?? row.file_path, input.status ?? row.status, id);
    },

    accept(id, versionId) {
      db.prepare(
        "UPDATE presales_import_candidates SET status = 'accepted', version_id = ? WHERE id = ?",
      ).run(versionId, id);
    },

    clear(libId) {
      db.prepare("DELETE FROM presales_import_candidates WHERE lib_id = ?").run(
        libId,
      );
    },
  };
}

/* ── 提示词：从候选里挑最新版 ───────────────────────────────────────── */

/** 台账口径：把「文件名 → 版本/日期」的猜测规则写死在提示词里，别指望模型自己发明。 */
export function pickLatestPrompt(input: {
  slotTitle: string;
  files: ScannedFile[];
}): string {
  const list = input.files
    .map((f) => `${f.path}\t${fmtDate(f.modifiedAt)}\t${fmtSize(f.size)}`)
    .join("\n");
  return `在下面这些文件里，挑出「${input.slotTitle}」**最新的一版**。

文件清单（路径 \t 最后修改 \t 大小）：
\`\`\`
${list}
\`\`\`

判断优先级：文件名里的版本号（v2.2 > v1.0）→ 文件名里的日期（20261010 最新）→ 最后修改时间。
排除名字里带「旧」「历史」「归档」「废弃」「草稿」「backup」「副本」「(1)」的，除非没有别的可选。

末尾给一个 json 块：
\`\`\`json
{ "filePath": "清单里的完整路径原文", "version": "v2.2", "releasedAt": "20261010", "reason": "一句话" }
\`\`\`
挑不出来时 filePath 给空字符串，并在 reason 里说明。`;
}
