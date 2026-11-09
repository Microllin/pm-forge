import { z } from "zod";

import { badRequest } from "./errors.js";
import type { Artifact, Stage } from "./lifecycle.js";
import { renderScan, type ScanResult } from "./analysis/scan.js";
import { extractJsonBlock } from "./analysis/tasks.js";

/**
 * 全局 AI 补齐：「写一份缺失的产出物」的提示词与结果契约。
 *
 * 与 wiki 写页同一套信封：正文放在 ===DRAFT=== … ===/DRAFT=== 之间，元数据另附 json 块，
 * 都取最后一组（用户在那条对话里追问后，补齐页上「重新取一次」拿到的就是最新版）。
 *
 * 产出物是**草稿**：先落到补齐草稿区，人看过再挪进产品目录。所以提示词要求它把拿不准的
 * 写成待确认，而不是为了「看起来齐了」去编——编出来的东西被挪进正式目录，比缺着更糟。
 */

export const DRAFT_OPEN = "===DRAFT===";
export const DRAFT_CLOSE = "===/DRAFT===";

export function artifactDraftPrompt(context: {
  productName: string;
  productDescription: string;
  templateName: string;
  stage: Pick<Stage, "code" | "label" | "question">;
  artifact: Pick<Artifact, "name" | "required" | "guide" | "checkpoints">;
  /** 比对时对这一项的判断（为什么算缺）。 */
  note: string;
  defaultFileName: string;
  scans: readonly ScanResult[];
}): string {
  const a = context.artifact;
  return [
    `请为产品「${context.productName}」起草一份缺失的产出物：**${a.name}**。`,
    "",
    "## 背景",
    "",
    `- 产品：${context.productName}${context.productDescription === "" ? "" : `——${context.productDescription}`}`,
    `- 生命周期规范：${context.templateName}`,
    `- 所在阶段：${context.stage.code} ${context.stage.label}${context.stage.question === "" ? "" : `（这一阶段回答：${context.stage.question}）`}`,
    `- 是否必交：${a.required ? "必交" : "选交"}`,
    ...(context.note === "" ? [] : [`- 比对时的判断：${context.note}`]),
    "",
    "## 这份产出物要写什么",
    "",
    a.guide === "" ? "（规范里没写写作指引，按产出物名称把握）" : a.guide,
    "",
    ...(a.checkpoints.length === 0
      ? []
      : [
          "## 判定要点（写完后这几条要能逐条核对上）",
          "",
          ...a.checkpoints.map((c) => `- ${c}`),
          "",
        ]),
    "## 事实底座（只能从这里取事实）",
    "",
    context.scans.length === 0
      ? "（这个产品没有可读的目录）"
      : context.scans.map(renderScan).join("\n\n"),
    "",
    "## 怎么写",
    "",
    "1. **这是草稿，给人审的。** 能从上面的目录与说明文件里找到依据的写成正文并注明出处（文件路径）；找不到依据的写成「【待确认】……」，不要编数字、编客户、编结论。",
    "2. 结构按判定要点来：每条判定要点在正文里要有对应的一节或一段，缺事实的那节写明缺什么、该找谁补。",
    "3. 用 `#` 写文档标题，`##` / `###` 分节。表格用在字段、对照、矩阵这类地方，不要通篇要点列表。",
    "4. 涉及凭据的配置只写「有这一项」，不写值。",
    "5. 篇幅按事实给，事实少就短，不凑字数。",
    "",
    "## 输出",
    "",
    `先用一两句说明你打算怎么写，然后把正文放在 ${DRAFT_OPEN} 与 ${DRAFT_CLOSE} 之间原样给出，最后附一个 json 块：`,
    "",
    DRAFT_OPEN,
    `# ${a.name}`,
    "",
    "正文……",
    DRAFT_CLOSE,
    "",
    "```json",
    JSON.stringify(
      {
        fileName: context.defaultFileName,
        gaps: ["因为缺事实而只能写成【待确认】的部分"],
      },
      null,
      2,
    ),
    "```",
    "",
    `\`fileName\` 是建议放进产品文档目录里的相对路径（可以带一层子目录，例如 \`prd/${context.defaultFileName}\`；必须以 .md 结尾）。目录事实里已有合适的子目录就放进去，没有就用默认值。`,
  ].join("\n");
}

const draftMetaSchema = z.object({
  fileName: z.string().trim().max(200).default(""),
  gaps: z.array(z.string().trim().max(300)).default([]),
});

/** 从回答里抠出草稿正文与元数据。信封缺失就报错，让人在对话里追一句——不把对话口吻当正文。 */
export function extractArtifactDraft(text: string): {
  content: string;
  fileName: string;
  gaps: string[];
} {
  const open = text.lastIndexOf(DRAFT_OPEN);
  const close = text.lastIndexOf(DRAFT_CLOSE);
  if (open < 0 || close <= open)
    throw badRequest(
      `回答里没有找到 ${DRAFT_OPEN} … ${DRAFT_CLOSE} 包起来的正文。可以在那条对话里追一句「请把正文用 ${DRAFT_OPEN} 和 ${DRAFT_CLOSE} 包起来重发」。`,
    );
  const content = text.slice(open + DRAFT_OPEN.length, close).trim();
  if (content === "") throw badRequest("草稿正文是空的");
  let fileName = "";
  let gaps: string[] = [];
  const block = extractJsonBlock(text.slice(close));
  if (block !== null) {
    try {
      const parsed = draftMetaSchema.safeParse(JSON.parse(block));
      if (parsed.success) {
        fileName = parsed.data.fileName;
        gaps = parsed.data.gaps;
      }
    } catch {
      // 元数据坏了就当没有：正文才是主体。
    }
  }
  return { content, fileName, gaps };
}

/**
 * 把 AI 建议的文件名收拾成「产品文档目录下的安全相对路径」，不合格就用默认值。
 * AI 给的是字符串，不能直接拼路径：`../../别的产品/x.md`、`/` 开头、非 .md 一律不认。
 */
export function safeRelativeName(suggested: string, fallback: string): string {
  const parts = suggested
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const ok =
    parts.length > 0 &&
    parts.length <= 2 &&
    parts.every(
      (p) =>
        p !== "." &&
        p !== ".." &&
        !p.startsWith(".") &&
        p.length <= 120 &&
        !hasControl(p),
    ) &&
    /\.md$/i.test(parts.at(-1) ?? "") &&
    !suggested.trim().startsWith("/");
  return ok ? parts.join("/") : fallback;
}

/** 文件名里不能出现的字符换成 -，用于拼草稿路径与默认文件名。 */
export function safeSegment(name: string): string {
  let out = "";
  for (let i = 0; i < name.length; i += 1) {
    const ch = name.charAt(i);
    const code = name.charCodeAt(i);
    out += code < 0x20 || code === 0x7f || ch === "/" || ch === "\\" ? "-" : ch;
  }
  out = out.replace(/^\.+/, "").trim();
  return out === "" ? "未命名" : out.slice(0, 120);
}

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}
