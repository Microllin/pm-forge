import { z } from "zod";

import { badRequest } from "../errors.js";
import { CODE_ROOT } from "../files/paths.js";
import type { Template } from "../lifecycle.js";
import {
  renderFocus,
  renderScan,
  type FocusResult,
  type ScanResult,
} from "./scan.js";

/**
 * 两个 AI 分析任务的提示词与结果契约。
 *
 * ## 为什么结果是「回答末尾的一个 json 代码块」，而不是工具调用或结构化输出
 *
 * 分析**跑在真对话里**（用户要看得见过程、还要能追问）。那就得接受两件事：
 * ① 回答是给人看的文字；② 用户追问后模型会再答一遍。
 * 所以契约定成「正文随便写，但末尾必须附一个 ```json 块」，取结果时**取最后一个**——
 * 追问后自然就是最新那版，不需要额外的「重新生成」按钮。
 *
 * 代价是模型可能不给块、或给出不合 schema 的块。这两种都当「还没有可用结果」处理，
 * 界面上说清楚原因（见 extract* 的报错文案），而不是硬塞一个半对的结果进库。
 */

/* ── 产线与产品识别 ────────────────────────────────────────────────── */

export const discoverResultSchema = z.object({
  lines: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(2000).default(""),
        folderPath: z.string().trim().default(""),
        reason: z.string().trim().max(500).default(""),
        products: z
          .array(
            z.object({
              name: z.string().trim().min(1).max(80),
              description: z.string().trim().max(2000).default(""),
              folderPath: z.string().trim().default(""),
              /** 代码目录（/代码库 下）。几个产品共用一个仓库时各自填同一个。 */
              codePath: z.string().trim().default(""),
              /** 参考资料：文档目录或单个文件，不放代码。 */
              refPaths: z.array(z.string().trim()).default([]),
              reason: z.string().trim().max(500).default(""),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  /** 拿不准的东西放这里，不要硬塞进 lines。 */
  uncertain: z.array(z.string().trim().max(500)).default([]),
});
export type DiscoverResult = z.infer<typeof discoverResultSchema>;

/**
 * 识别产线与产品的提示词。
 *
 * 产品的事实依据是三样：文档目录、代码目录、参考资料。
 * 识别时三样一起给出，否则建出来的产品只有文档，后面每次 AI 对话都缺代码依据，
 * 要人逐个回去补。代码库在「事实底座 → 代码」那一层、不在被识别的文件夹里，
 * 所以把它的仓库清单单独列给模型，让它按声明文件（如 `repo:`）或名字对上。
 */
export function discoverPrompt(
  docScans: ScanResult[],
  codeRepos: string[],
  codeScans: ScanResult[] = [],
): string {
  const picked = codeScans.length > 0;
  return [
    "请从下面这些资料里识别出**产品线**与**产品**，用于初始化产品台账。",
    "每个产品还要给出它的**事实依据**：文档目录、代码目录、参考资料。",
    "",
    ...(docScans.length === 0
      ? ["（这次没有选文档，只能从代码仓库的目录与 README 判断）", ""]
      : docScans.flatMap((scan) => [renderScan(scan), ""])),
    `<代码库 根="${CODE_ROOT}"${picked ? ' 范围="使用者勾选"' : ""}>`,
    ...(codeRepos.length === 0
      ? ["（代码库里还没有任何仓库）"]
      : codeRepos.map((p) => `- ${p}`)),
    "</代码库>",
    ...codeScans.flatMap((scan) => ["", renderScan(scan)]),
    "",
    "## 怎么判断",
    "",
    "1. **有声明文件就以它为准**：`product.yaml` / `product.json` / README 里若明写了产品线名、产品清单（如 `modules:`），直接采信，不要改写它给的名字。",
    "2. **没有声明文件就看目录结构**：承载多个同级业务单元的目录是产品线，其下每个业务单元是产品。",
    "3. **不是每个子目录都是产品**。`_archive`、`docs`、`assets`、`references`、按阶段或按职能切分的目录（如 `prd`、`research`、`bug`）都不是产品，是产品内部的分类。",
    "4. **描述要从事实里来**。能在说明文件里找到依据就引用它的说法；找不到就把描述留空，不要替产品编一句定位。",
    "5. **拿不准的放 `uncertain`**，用一句话说清在犹豫什么（例如「skillcenter 只有一个空目录，看不出是产品还是占位」）。宁可少报，不要硬凑。",
    `6. **代码目录（\`codePath\`）只能从上面 <代码库> 里选**。声明文件写了仓库（如 \`repo: ../repos/RouteHub\`）就按仓库名对上 \`${CODE_ROOT}/RouteHub\`；没写就按产品名、README 的说法对。几个产品共用一个仓库时，各自填同一个仓库路径。对不上就留空，并在 \`uncertain\` 里说一句。`,
    "7. **参考资料（`refPaths`）是文档目录之外、专门描述这个产品的文件或目录**。使用者单独勾选的文件（上面只有一行文件名的<目录事实>）优先考虑，判断它属于哪个产品，产品线共用的就挂到每个产品上；其次是例如声明文件里的 `capabilityDetail`、`capabilityMap`、规格说明。声明文件里的相对路径要按它注明的基准换算成上面目录事实里的完整路径（以 / 开头）。产品线级的共用资料（如能力地图）挂到它下面每个产品上。不要放代码，不要放产品自己的文档目录，最多 8 条。找不到确切路径就不填。",
    "",
    "## 输出",
    "",
    "先用自然语言说明你的判断依据（尤其是哪些目录你判定为「不是产品」以及为什么），",
    "然后在回答**末尾**附一个 json 代码块，格式如下（所有路径都用上面事实里的真实路径，没有就留空字符串 / 空数组）：",
    "",
    "```json",
    JSON.stringify(
      {
        lines: [
          {
            name: "产品线名",
            description: "一句话，来自说明文件",
            folderPath: "/示例/路径",
            reason: "判定依据",
            products: [
              {
                name: "产品名",
                description: "一句话",
                folderPath: "/示例/路径/产品",
                codePath: `${CODE_ROOT}/示例仓库`,
                refPaths: ["/示例/路径/产品/specs/能力明细.md"],
                reason: "判定依据",
              },
            ],
          },
        ],
        uncertain: ["拿不准的事情"],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

/* ── 产出物比对 ────────────────────────────────────────────────────── */

export const ARTIFACT_STATUSES = ["present", "partial", "missing"] as const;
export type ArtifactStatus = (typeof ARTIFACT_STATUSES)[number];

export const compareResultSchema = z.object({
  findings: z
    .array(
      z.object({
        /** 产出物名，必须与模板里的逐字一致，否则对不上行。 */
        artifact: z.string().trim().min(1).max(200),
        status: z.enum(ARTIFACT_STATUSES),
        /** 判断依据的文件（文件模块里的路径）。 */
        files: z.array(z.string().trim().max(1000)).default([]),
        /** 没答到的判定要点，原样抄模板里那一条。 */
        missedCheckpoints: z.array(z.string().trim().max(500)).default([]),
        note: z.string().trim().max(1000).default(""),
      }),
    )
    .default([]),
});
export type CompareResult = z.infer<typeof compareResultSchema>;

/** 比对结果的汇总。界面上「8/13 齐」就是它算出来的。 */
export interface CompareSummary {
  total: number;
  present: number;
  partial: number;
  missing: number;
  /** 必交却缺失或不全的数量——这才是真正要紧的那个数。 */
  requiredGap: number;
}

export function comparePrompt(template: Template, scan: ScanResult): string {
  const checklist = template.stages.flatMap((stage) =>
    stage.artifacts.map((a) =>
      [
        `### ${stage.code} ${stage.label} · ${a.name}（${a.required ? "必交" : "选填"}）`,
        a.guide === "" ? null : `写作指引：${a.guide}`,
        a.fileHints.length === 0
          ? null
          : `文件线索：${a.fileHints.join(" / ")}`,
        a.checkpoints.length === 0
          ? "判定要点：（这一件没有定判定要点，只判在不在，不判答没答全）"
          : [
              "判定要点：",
              ...a.checkpoints.map((c, i) => `${String(i + 1)}. ${c}`),
            ].join("\n"),
      ]
        .filter((l) => l !== null)
        .join("\n"),
    ),
  );

  return [
    `请对照规范模板「${template.name}」，核对下面这个产品目录里该有的产出物在不在、答没答全。`,
    "",
    renderScan(scan),
    "",
    "## 要核对的产出物清单",
    "",
    checklist.join("\n\n"),
    "",
    "## 怎么判",
    "",
    "1. **先用文件线索缩小范围**，再看文件名与说明文件正文判断它是不是这件产出物。文件名不含线索词但内容明显是的，也算。",
    "2. 三种结论：`present`（有，且判定要点基本都答到了）、`partial`（有这份东西，但有要点没答到）、`missing`（找不到）。",
    "3. **判 `partial` 必须在 `missedCheckpoints` 里列出没答到的是哪几条**，逐字抄清单里的那一条，不要改写。列不出来就不要判 partial。",
    "4. **只看得到文件名、看不到正文时，不要断言要点答没答到**——这种情况判 `present` 并在 `note` 里写明「仅凭文件名判断，未读正文」，或判 `missing` 如果连名字都对不上。",
    "5. 目录事实若标了「已被截断」，不要据此断言缺失；在 `note` 里说明。",
    "6. `artifact` 字段必须与上面清单里的产出物名**逐字一致**，否则对不上。清单里每一件都要有一条结论，不许漏。",
    "",
    "## 输出",
    "",
    "先用自然语言给出结论概述（哪些齐了、哪些缺、最该先补哪一件），然后在回答**末尾**附一个 json 代码块：",
    "",
    "```json",
    JSON.stringify(
      {
        findings: [
          {
            artifact: "产出物名（逐字抄清单）",
            status: "present",
            files: ["/示例/路径/某文件.md"],
            missedCheckpoints: [],
            note: "",
          },
        ],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

/**
 * 把模型给的 findings 对回模板，算出汇总。
 *
 * 对不上名字的 finding 直接丢弃（模型改写了产出物名），模板里没被覆盖到的产出物
 * 按 `missing` 计——**漏判不能等于通过**，否则「模型少答一行」会被读成「这件齐了」。
 */
export function summarize(
  template: Template,
  result: CompareResult,
): { summary: CompareSummary; findings: NormalizedFinding[] } {
  const byName = new Map(result.findings.map((f) => [f.artifact, f]));
  const findings: NormalizedFinding[] = [];
  for (const stage of template.stages) {
    for (const a of stage.artifacts) {
      const hit = byName.get(a.name);
      findings.push({
        stageCode: stage.code,
        stageLabel: stage.label,
        artifact: a.name,
        required: a.required,
        status: hit?.status ?? "missing",
        files: hit?.files ?? [],
        missedCheckpoints: hit?.missedCheckpoints ?? [],
        note:
          hit === undefined
            ? "模型这一轮没有给出这件产出物的结论，按「缺」计。"
            : hit.note,
        judged: hit !== undefined,
      });
    }
  }
  const summary: CompareSummary = {
    total: findings.length,
    present: findings.filter((f) => f.status === "present").length,
    partial: findings.filter((f) => f.status === "partial").length,
    missing: findings.filter((f) => f.status === "missing").length,
    requiredGap: findings.filter((f) => f.required && f.status !== "present")
      .length,
  };
  return { summary, findings };
}

export interface NormalizedFinding {
  stageCode: string;
  stageLabel: string;
  artifact: string;
  required: boolean;
  status: ArtifactStatus;
  files: string[];
  missedCheckpoints: string[];
  note: string;
  /** 模型是否真的给了这一条。false 表示它漏了，被按「缺」计。 */
  judged: boolean;
}

/* ── 从回答里抠 json ───────────────────────────────────────────────── */

/**
 * 取**最后一个** json 代码块。追问后模型会再给一版，取最后一个就等于「以最新为准」。
 * 没有围栏块时退而求其次扫最后一个花括号块——有些模型会忘了加围栏。
 */
export function extractJsonBlock(text: string): string | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  const last = fenced.at(-1)?.[1];
  if (last !== undefined && last.trim() !== "") return last.trim();
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}

/** 解析并校验。失败一律抛 400 并说清是哪一步不对——界面要能告诉用户下一步做什么。 */
export function parseResult<T>(text: string, schema: z.ZodType<T>): T {
  const block = extractJsonBlock(text);
  if (block === null)
    throw badRequest(
      "这一轮回答里没有找到 json 结果块。可以在对话里追一句「请按要求在末尾补一个 json 块」，然后再点一次。",
    );
  let data: unknown;
  try {
    data = JSON.parse(block);
  } catch {
    throw badRequest(
      "回答末尾的 json 块解析失败（可能被截断了）。可以在对话里追一句「json 块不完整，请重发一遍」。",
    );
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success)
    throw badRequest(
      `json 块的结构对不上：${parsed.error.issues[0]?.message ?? "字段不符合要求"}。可以在对话里指出来让它改。`,
    );
  return parsed.data;
}

/* ── 产品功能架构（读代码） ────────────────────────────────────────── */

/**
 * 功能架构的提示词。与前两个任务的区别在于**事实源是代码不是文档**，
 * 所以判断规则要专门压住两类常见跑偏：
 *
 * ① 把**技术分层**当功能（「API 层」「工具函数」「类型定义」不是产品功能）；
 * ② 把**目录名**直接抄成功能名（`utils/` 不是功能，`apps/console-v2/` 也不是）。
 *
 * `path` 是「现在在拆哪一支」——根级分析时为空，展开某个节点时带上从根到它的链路，
 * 否则模型不知道自己该产出第几层、也会重复上层已有的功能。
 */
export function architecturePrompt(
  /**
   * 多份：一个功能可以有多条代码证据，每条是一个扫描根。
   * **不能合并成一份**——合并后 `renderScan` 只会打印第一个根，
   * 模型据此理解所有相对路径，第二个根以后的证据路径就全错了。
   */
  scans: readonly ScanResult[],
  context: {
    productName: string;
    /** 从根到当前节点（含自己）。空 = 分析一级功能。 */
    path: { name: string; duty: string; evidence: string[] }[];
    /** 这一支下已有的子功能名，避免重复产出。 */
    existing: string[];
    /** append = 补下一层；replace = 这一支整个重来。 */
    mode: "append" | "replace";
  },
): string {
  const target = context.path.at(-1);
  const level = context.path.length + 1;
  return [
    target === undefined
      ? `请读下面这个代码库，分析出产品「${context.productName}」的**一级功能**。`
      : `请读下面这段代码，把功能「${target.name}」拆成它的**直接子功能**（第 ${String(level)} 层）。`,
    "",
    ...(context.path.length === 0
      ? []
      : [
          "## 现在在拆哪一支",
          "",
          context.path
            .map(
              (n, i) =>
                `${"  ".repeat(i)}- ${n.name}${n.duty === "" ? "" : `：${n.duty}`}${
                  n.evidence.length === 0
                    ? ""
                    : `（代码证据：${n.evidence.join(" / ")}）`
                }`,
            )
            .join("\n"),
          "",
          "**只拆最后那一个**，不要重复上层已有的功能，也不要越过它去拆别的分支。",
          "",
        ]),
    ...(context.existing.length === 0
      ? []
      : [
          `这一支下已经有这些子功能，**不要重复产出**（要补的是它们之外的）：${context.existing.join("、")}`,
          "",
        ]),
    scans.map(renderScan).join("\n\n"),
    "",
    "## 怎么判",
    "",
    "1. **功能是「用户能说出口的事」**，不是技术分层。`API 层`、`工具函数`、`类型定义`、`中间件`、`配置` 都不是产品功能——它们是实现手段。",
    "2. **不要把目录名直接抄成功能名**。`utils/`、`components/`、`apps/xxx/` 是代码组织方式；功能名要能让不看代码的人懂（如「渠道健康监控」而不是「monitor 模块」）。",
    "3. **职责一句话**，说清「它为谁做了什么」。说不清就说明这一条可能不是一个功能。",
    "4. **每条必须带代码证据**：让你这么判的文件或目录（相对上面目录事实的路径）。拿不出证据的不要写进 features。",
    "5. **一层就是一层**。" +
      (target === undefined
        ? "这一轮只产出一级功能；每个一级功能下**最多**顺带给一层子功能，不确定就不给，留给用户逐个展开。"
        : "这一轮只产出它的直接子功能；再往下的留给用户继续展开。"),
    "6. **拿不准的放 `uncertain`**，用一句话说清在犹豫什么（例如「`crypto-gateway/` 看不出是独立产品还是本产品的一个功能」）。宁可少报。",
    ...(context.mode === "replace"
      ? [
          "7. 这是一次**重新分析**：用户对上一轮结果不满意，请重新从代码出发判断，不要沿用上面列出的已有子功能。",
        ]
      : []),
    "",
    "## 输出",
    "",
    "先用自然语言说明判断依据（尤其是哪些目录你判定为「不是功能」以及为什么），然后在回答**末尾**附一个 json 代码块：",
    "",
    "```json",
    JSON.stringify(
      {
        features: [
          {
            name: "功能名（用户能说出口的那种）",
            duty: "一句话职责",
            evidence: ["apps/示例/路径", "apps/示例/另一个文件.ts"],
            children: [
              {
                name: "子功能名",
                duty: "一句话",
                evidence: ["..."],
                children: [],
              },
            ],
          },
        ],
        uncertain: ["拿不准的事情"],
      },
      null,
      2,
    ),
    "```",
  ].join("\n");
}

/* ── 产品 Wiki：第一步，生成目录 ───────────────────────────────────── */

/**
 * Wiki 分两步走：
 * 先出目录（每章只有标题 + 提纲），再逐页成文。
 *
 * 这一步要压住的跑偏，和功能架构那边不是同一组：
 *
 * ① **按目录结构编章节**。模型很容易把 `apps/` `packages/` 变成「apps 模块」
 *    「packages 模块」这种章——那是代码组织方式，不是读者想知道的事。
 * ② **编出事实源里没有的章**。没绑代码目录就写不了「架构分层」，
 *    这时该如实放进 uncertain，而不是靠常识凑一章出来。
 */
/* ── 产品 Wiki：事实源覆盖情况 ─────────────────────────────────────── */

/** 一个事实源（文档目录 / 代码目录）这一次的状态。 */
export type SourceState =
  | { state: "bound"; root: string }
  | { state: "unbound" }
  | { state: "unreadable"; root: string };

export interface SourceCoverage {
  docs: SourceState;
  code: SourceState;
  /** 参考资料，每条一个状态。 */
  refs: SourceState[];
}

/**
 * 把「这次到底给了哪些事实源」明说给模型，并交代**事实是一次性快照**。
 *
 * 真实撞上过的：用户先发起规划（当时只绑了文档），中途去「事实底座 → 代码」上传并绑定，
 * 回到同一条对话说「代码我绑定了」。对话会话没有读文件的工具，事实只在发起那一刻采集一次，
 * 于是模型只能反过来让用户贴目录树——几轮下来所有代码章都被打成 uncertain。
 * 正确的出路是**重新发起**，这里让模型直接这么告诉用户。
 */
export function renderCoverage(
  coverage: SourceCoverage,
  rerun: string,
): string {
  const line = (label: string, s: SourceState, where: string): string =>
    s.state === "bound"
      ? `- ${label}：已绑定 \`${s.root}\`，内容见下方对应的 <目录事实>。`
      : s.state === "unbound"
        ? `- ${label}：**未绑定**（要绑去「${where}」上传，再在产品页上指定目录）。`
        : `- ${label}：绑定了 \`${s.root}\`，但**这次读取失败**（目录可能被删或改名）。`;
  return [
    "## 事实源覆盖情况",
    "",
    line("文档目录", coverage.docs, "事实底座 → 文件"),
    line("代码目录", coverage.code, "事实底座 → 代码"),
    ...(coverage.refs.length === 0
      ? [
          "- 参考资料：**未挂**（产品页上可以额外挂手册、能力地图等文档目录或单个文件）。",
        ]
      : coverage.refs.map((r) => line("参考资料", r, "事实底座 → 文件"))),
    "",
    `下方的目录事实是**发起这次任务那一刻的快照**，你没有读取文件的工具，对话中途也不会更新。如果用户在对话里说「刚绑了/刚上传了代码」或「你怎么读不到代码」，**不要让他把代码或目录树贴进来**——直接告诉他：回到 Wiki 页面${rerun}，新绑的目录才会被读进来。`,
  ].join("\n");
}

export function wikiOutlinePrompt(
  scans: readonly ScanResult[],
  context: {
    productName: string;
    productDescription: string;
    /** 已有章节（replace 模式下要让它知道现状）。 */
    existing: string[];
    mode: "append" | "replace";
    /** 出厂目录的章节名，作为「一本产品 wiki 通常该有哪些章」的参照。 */
    suggested: readonly { title: string; brief: string }[];
    coverage: SourceCoverage;
  },
): string {
  return [
    `请读下面的事实源，为产品「${context.productName}」规划一本 **wiki 的目录**。`,
    context.productDescription === ""
      ? ""
      : `产品说明：${context.productDescription}`,
    "",
    "这一步**只出目录，不写正文**——每一章给标题和一句「这一章要写什么」，正文之后逐页生成。",
    "",
    ...(context.existing.length === 0
      ? []
      : [
          `现有章节：${context.existing.join("、")}`,
          context.mode === "replace"
            ? "这是一次**重新规划**：请从事实源出发重新判断，不必沿用上面这些。"
            : "**不要重复上面已有的章节**，补的是它们之外的。",
          "",
        ]),
    renderCoverage(context.coverage, "重新点一次「AI 重新规划目录」"),
    "",
    scans.map(renderScan).join("\n\n"),
    "",
    "## 参照目录",
    "",
    "一本产品 wiki 通常包含下面这些章。**它是参照不是模板**：事实源里没有对应材料的章要删掉，",
    "这个产品特有的东西要加进来（比如它有一套别处没有的计费模型，就该单独成章）。",
    "",
    context.suggested.map((p) => `- ${p.title}：${p.brief}`).join("\n"),
    "",
    "## 怎么判",
    "",
    "1. **章节是读者的问题，不是代码的结构**。`apps/`、`packages/`、`src/` 不该变成章名。读者问的是「这产品给谁用」「改一个需求该动哪」，不是「apps 目录里有什么」。",
    "2. **每一章都要有事实源撑着**。没绑代码目录就别规划「架构分层」「数据与接口」；没有文档就别规划「商业模式」。写不了的放进 `uncertain`，说清缺什么。",
    "3. **`brief` 写成祈使句**——它是下一步生成正文的输入，不是摘要。写「列出一级功能与边界，并指出与功能架构图不一致的地方」，不要写「本章介绍功能」。",
    "4. **最多两层**（章 / 节）。再细的放进 brief 里交代，不要开第三层。",
    "5. 顺序要能当阅读路径：先「是什么、给谁」，再「怎么实现」，最后「风险与上手」。",
    "6. **每一章、每一节都要给 `sources`**：写这一章时要精读的路径（1–6 条，目录或文件都行），**写完整路径**，从上面 <目录事实> 的根路径往下拼（如 `/代码库/xxx/server/internal/handler`）。",
    "   下一步写正文时，系统**只会精读这些路径下的文件正文（含源代码）**，别处只给浅层目录。所以：",
    "   - 代码类章节（数据模型、接口、架构分层、改动落点）必须指到**具体的代码子目录**，不要只给仓库根——仓库根太大，精读预算会被摊薄到读不到关键文件；",
    "   - 文档类章节指到对应的文档子目录或具体文件；",
    "   - 目录树被截断、看不到更深一层时，指到你能看到的最深那一层即可，系统会从那里往下找文件。",
    "",
    "## 输出",
    "",
    "先说明你是怎么判的（尤其哪些章因为缺事实源而没规划），然后在回答**末尾**附一个 json 代码块：",
    "",
    "```json",
    JSON.stringify(
      {
        pages: [
          {
            title: "章节名",
            brief: "这一章要写什么（祈使句）",
            sources: ["/代码库/xxx/server/internal/handler"],
            children: [
              {
                title: "小节名",
                brief: "要写什么",
                sources: ["/product-docs/xxx/prd"],
              },
            ],
          },
        ],
        uncertain: ["因为缺什么事实所以没有规划的章节"],
      },
      null,
      2,
    ),
    "```",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/* ── 产品 Wiki：第二步，写某一页 ───────────────────────────────────── */

/**
 * 正文用**分隔符信封**包，不塞进 json 字符串。
 *
 * 原因有两条，都是硬的：
 * ① 一章正文本身就会包含 ``` 代码围栏，所以不能再用围栏块当信封（会提前闭合）；
 * ② 几千字 Markdown 塞进 json 字符串意味着每个换行都要转义成 `\n`，
 *    这正是模型最容易写崩的地方（漏转义引号、中途断行），而崩了就整页拿不到。
 *
 * 所以：正文在 `===WIKI===` / `===/WIKI===` 之间原样给，
 * 元数据（出处、写不了的部分）另附一个小 json 块。两者都取**最后一组**，
 * 与「取最后一个 json 块」的追问覆盖语义保持一致。
 */
export const WIKI_OPEN = "===WIKI===";
export const WIKI_CLOSE = "===/WIKI===";

export function wikiPagePrompt(
  scans: readonly ScanResult[],
  context: {
    productName: string;
    /** 这一页：编号 + 标题 + 提纲。 */
    page: { number: string; title: string; brief: string };
    /** 整本目录，让它知道别的章写什么、避免重复与矛盾。 */
    outline: { number: string; title: string; brief: string }[];
    /** 这一页已有的正文（重写时给，让它知道哪里不满意可以改）。 */
    previous: string;
    coverage: SourceCoverage;
    /** 这一章的精读结果。null = 这一章没指定精读路径。 */
    focus: FocusResult | null;
    /** 指定了但不在本产品绑定范围内、被忽略的精读路径。 */
    outOfBound: readonly string[];
  },
): string {
  return [
    `请为产品「${context.productName}」的 wiki 写第 ${context.page.number} 章：**${context.page.title}**。`,
    "",
    "## 这一章要写什么",
    "",
    context.page.brief === ""
      ? "（提纲为空，请按章节名自行把握）"
      : context.page.brief,
    "",
    "## 整本目录（避免与别章重复或矛盾）",
    "",
    context.outline
      .map(
        (p) =>
          `- ${p.number} ${p.title}${p.brief === "" ? "" : `：${p.brief}`}`,
      )
      .join("\n"),
    "",
    ...(context.previous === ""
      ? []
      : [
          "## 这一章已有的正文",
          "",
          "用户对它不满意要求重写。可以保留对的部分，但要真的改进，不要原样复述。",
          "",
          "```markdown",
          context.previous.slice(0, 8000),
          "```",
          "",
        ]),
    renderCoverage(context.coverage, "对这一章重新点一次「让 AI 重写」"),
    "",
    ...(context.outOfBound.length === 0
      ? []
      : [
          `这一章指定的精读路径里有 ${String(context.outOfBound.length)} 条不在本产品绑定的资料范围内，已忽略：${context.outOfBound.join("、")}。`,
          "",
        ]),
    context.focus === null
      ? "## 本章精读资料\n\n**这一章没有指定精读路径**，下面只有整体的目录骨架与说明文件，没有源代码正文。涉及字段、接口、代码落点的内容一律标 `[待核实]`，并在开头说明：在章节编辑里填上「精读路径」再重写，这部分才能核实。"
      : [
          "## 本章精读资料",
          "",
          "下面是专门为这一章读的路径与**源文件正文**，是本章最主要的证据。字段、接口、调用关系以这里的正文为准，引用时写出文件路径。",
          "",
          renderFocus(context.focus),
        ].join("\n"),
    "",
    "## 整体目录（地图，用来定位，不是本章的主要证据）",
    "",
    scans.map(renderScan).join("\n\n"),
    "",
    "## 怎么写",
    "",
    "1. **每条结论都要标证据等级**，就标在该句句尾：",
    "   - `[已核实]`——有代码或文档出处，出处写进句内（如「见 `server/app.ts`」）或紧跟其后；",
    "   - `[待核实]`——从命名、惯例、上下文推断的，没有直接出处；",
    "   - `[未覆盖]`——事实源里压根没有这块。",
    "   **宁可大量标 `[待核实]`，也不要把推断写成事实。** 这是这本 wiki 能不能被信任的底。",
    "2. **写不了就说写不了**。缺事实源的部分写一句「事实源中未包含 X，待补」并放进 `gaps`，不要用常识补位、不要编目录名之外的文件路径。",
    "3. **散文为主，表格用在该用的地方**（字段清单、对照关系、矩阵）。不要通篇要点列表——那是提纲不是正文。",
    "4. 用 `##` / `###` 分节（不要用 `#`，页面标题已经是它了）。右侧目录是从这些标题抽的，所以标题要能独立看懂。",
    "5. 代码引用给**相对上面目录事实的路径**，必要时带行号。不要编路径。",
    "6. 涉及凭据的配置项只写「有这一项」，不写值。",
    "7. 篇幅按内容给，不凑字数。一章 800–3000 字是常见区间，事实不够就短。",
    "",
    "## 输出",
    "",
    `先简单说一下你打算怎么写（一两句即可），然后把正文放在 ${WIKI_OPEN} 与 ${WIKI_CLOSE} 之间原样给出（正文里可以正常使用代码围栏），最后附一个 json 块：`,
    "",
    WIKI_OPEN,
    "## 小节标题",
    "",
    "正文…… [已核实]",
    WIKI_CLOSE,
    "",
    "```json",
    JSON.stringify(
      {
        sources: ["用到的文件或目录（相对目录事实的路径）"],
        gaps: ["因为缺事实而没能写的部分"],
      },
      null,
      2,
    ),
    "```",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/**
 * 从回答里抠出 wiki 正文 + 元数据。
 *
 * 信封缺失时**不退化成「把整段回答当正文」**：那样会把「好的，我来写……」这种
 * 对话口吻写进 wiki，而用户多半要到看见成品才发现。宁可报错让他追一句。
 */
export function extractWikiPage(text: string): {
  content: string;
  sources: string[];
  gaps: string[];
} {
  const open = text.lastIndexOf(WIKI_OPEN);
  const close = text.lastIndexOf(WIKI_CLOSE);
  if (open < 0 || close <= open)
    throw badRequest(
      `这一轮回答里没有找到 ${WIKI_OPEN} … ${WIKI_CLOSE} 包起来的正文。可以在对话里追一句「请把正文用 ${WIKI_OPEN} 和 ${WIKI_CLOSE} 包起来重发一遍」，然后再点一次。`,
    );
  const content = text.slice(open + WIKI_OPEN.length, close).trim();
  if (content === "")
    throw badRequest("正文信封是空的。可以在对话里让它重发一遍。");

  // 元数据可缺：正文才是主体，sources/gaps 缺了只是少了抽查线索，不该因此整页作废。
  let sources: string[] = [];
  let gaps: string[] = [];
  const block = extractJsonBlock(text.slice(close));
  if (block !== null) {
    try {
      const parsed = z
        .object({
          sources: z.array(z.string().trim().max(500)).default([]),
          gaps: z.array(z.string().trim().max(300)).default([]),
        })
        .safeParse(JSON.parse(block));
      if (parsed.success) {
        sources = parsed.data.sources;
        gaps = parsed.data.gaps;
      }
    } catch {
      // 元数据块坏了就当没有。
    }
  }
  return { content, sources, gaps };
}
