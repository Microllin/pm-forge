import { z } from "zod";

import { EVIDENCE_CLOSE, EVIDENCE_OPEN } from "./evidence/brief.js";

/**
 * 售前材料 AI 审阅 / 体系复盘：提示词与结果契约。
 *
 * 与其它分析同一套信封：正文给人看，**末尾附一个 ```json 块**，取最后一个（用户在
 * 对话里追问后，点「重新取结果」拿到的就是最新那版）。
 *
 * ## 三种任务
 *
 * - **ledger 口径台账**：一份材料「声称了哪些事实」——功能、指标、价格、版本、案例……
 *   只抽取不评判。它是体系复盘的中间产物，也让单份审阅能拿到兄弟材料的说法。
 * - **cross 跨材料比对**：把所有台账放在一起，对照事实依据，找腐烂文字、互相矛盾、
 *   与代码 / PRD 不符。
 * - **review 修订清单**：一份材料逐条给出「原文 → 改为」，人逐条采纳后在原文件里替换。
 *
 * ## 为什么「原文」必须逐字摘
 *
 * 采纳后是在原 Word / PPT / Excel 里**按原文找、按原文换**（office-edit.ts），保留样式。
 * 原文差一个标点就找不到，只能标「需手改」。所以契约里把摘法写死：一段之内、逐字、
 * 够短又不至于在文中出现多处。
 */

/* ── 公共 ─────────────────────────────────────────────────────────── */

export const SEVERITIES = ["P0", "P1", "P2"] as const;
export const ISSUE_TYPES = [
  "code-mismatch",
  "prd-mismatch",
  "roadmap-as-shipped",
  "stale",
  "inconsistent",
  "caliber",
  "checkpoint",
  "other",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  "code-mismatch": "与代码不符",
  "prd-mismatch": "与 PRD 不符",
  "roadmap-as-shipped": "把规划写成已有",
  stale: "过时 / 腐烂",
  inconsistent: "与其他材料不一致",
  caliber: "违反口径 / 对内信息外泄",
  checkpoint: "缺检查要点",
  other: "其他",
};

/** 模型偶尔给中文类型名或大小写不一；归一不了的落到 other，不让整份结果作废。 */
const issueType = z
  .string()
  .trim()
  .transform((v): IssueType => {
    const hit = ISSUE_TYPES.find((t) => t === v.toLowerCase());
    if (hit !== undefined) return hit;
    const byLabel = (
      Object.entries(ISSUE_TYPE_LABEL) as [IssueType, string][]
    ).find(([, label]) => label === v);
    return byLabel?.[0] ?? "other";
  });
const severity = z
  .string()
  .trim()
  .transform((v) => {
    const up = v.toUpperCase();
    return (SEVERITIES as readonly string[]).includes(up)
      ? (up as (typeof SEVERITIES)[number])
      : "P2";
  });
const paths = z.array(z.string().trim().max(1000)).max(12).default([]);

/** 不需要事实依据的任务：仍带一个依据段，明说「本任务不取依据」，运行器就不会另去定位。 */
export function noEvidenceBlock(reason: string): string {
  return `${EVIDENCE_OPEN}\n【本次事实依据】${reason}\n${EVIDENCE_CLOSE}`;
}

export interface MaterialMeta {
  title: string;
  stageLabel: string;
  audience: "external" | "internal";
  required: boolean;
  templateItemName: string | null;
  guide: string;
  checkpoints: readonly string[];
  version: string;
  fileName: string;
}

const audienceText = (a: "external" | "internal"): string =>
  a === "external" ? "对外（会发给客户）" : "对内（只给销售 / 售前自己看）";

function renderMeta(m: MaterialMeta): string[] {
  return [
    `- 材料：${m.title}${m.templateItemName !== null && m.templateItemName !== m.title ? `（模板条目：${m.templateItemName}）` : ""}`,
    `- 阶段：${m.stageLabel}`,
    `- 给谁看：${audienceText(m.audience)}`,
    `- 必备：${m.required ? "是" : "否"}`,
    `- 当前审阅的文件：${m.fileName}（${m.version}）`,
    ...(m.guide === "" ? [] : [`- 这类材料该写什么：${m.guide}`]),
    ...(m.checkpoints.length === 0
      ? ["- 检查要点：模板没给（这份材料没对上模板条目，或模板条目没写要点）"]
      : ["- 检查要点：", ...m.checkpoints.map((c) => `  - ${c}`)]),
  ];
}

function renderMaterial(
  m: MaterialMeta,
  text: string,
  truncated: boolean,
): string[] {
  return [
    `<待审材料 名称="${m.title}" 文件="${m.fileName}"${truncated ? ' 截断="是"' : ""}>`,
    text.trim(),
    "</待审材料>",
    ...(truncated
      ? ["（材料太长，只附了前一部分；后面的部分这次审不到，请在结论里说明。）"]
      : []),
  ];
}

/* ── ledger：口径台账 ────────────────────────────────────────────── */

export const LEDGER_CATEGORIES = [
  "feature",
  "metric",
  "price",
  "version",
  "customer",
  "compliance",
  "naming",
  "process",
  "other",
] as const;

export const ledgerResultSchema = z.object({
  summary: z.string().trim().max(1000).default(""),
  claims: z
    .array(
      z.object({
        topic: z.string().trim().min(1).max(60),
        category: z
          .string()
          .trim()
          .transform((v) =>
            (LEDGER_CATEGORIES as readonly string[]).includes(v) ? v : "other",
          ),
        claim: z.string().trim().min(1).max(300),
        quote: z.string().trim().max(300).default(""),
      }),
    )
    .max(120)
    .default([]),
});
export type LedgerResult = z.infer<typeof ledgerResultSchema>;

export function ledgerPrompt(input: {
  libName: string;
  material: MaterialMeta;
  text: string;
  truncated: boolean;
}): string {
  return [
    noEvidenceBlock("这一步只从材料里抽取它的说法，不做核对，不需要事实依据。"),
    "",
    `请为售前材料库「${input.libName}」里的一份材料抽一份**口径台账**：这份材料对外（或对内）**声称了哪些事实**。`,
    "这是体系复盘的第一步，后面会把所有材料的台账放在一起比对、再对照代码和 PRD 核实。所以这一步**只抽取，不评判**。",
    "",
    "## 材料信息",
    "",
    ...renderMeta(input.material),
    "",
    "## 抽什么",
    "",
    "凡是可以被核实、或者可能和别的材料说得不一样的，都抽出来：",
    "- feature 功能与能力（支持什么、不支持什么、怎么支持）；",
    "- metric 指标与规格（并发、延迟、可用性、容量、模型数量……）；",
    "- price 价格、计费方式、折扣、套餐；",
    "- version 版本号、发布时间、产品名称与版本对应关系；",
    "- customer 客户案例、客户数量、行业；",
    "- compliance 资质、认证、合规承诺；",
    "- naming 产品 / 模块 / 功能的叫法（同一个东西各材料叫法不一致是常见问题）；",
    "- process 交付、部署、服务流程与时限。",
    "",
    "每条：`topic` 用 2–8 个字点明主题（如「并发上限」「SSO」「产品名称」），便于和别的材料按主题对齐；",
    "`claim` 用一句话复述它的说法（保留数字和限定词）；`quote` 逐字摘一小段原文（≤ 80 字）。",
    "同一主题说了几次、说法不同的，各抽一条——材料内部自相矛盾也是要找的问题。",
    "",
    ...renderMaterial(input.material, input.text, input.truncated),
    "",
    "## 输出",
    "",
    "先用一两句话概括这份材料讲了什么，然后在回答**末尾**附一个 json 代码块：",
    "",
    "```json",
    '{"summary":"一两句话","claims":[{"topic":"并发上限","category":"metric","claim":"单租户默认并发 100","quote":"默认并发上限为 100"}]}',
    "```",
  ].join("\n");
}

/* ── review：修订清单 ───────────────────────────────────────────── */

export const reviewResultSchema = z.object({
  verdict: z
    .string()
    .trim()
    .transform((v) =>
      ["可直接用", "小修后可用", "需大改"].includes(v) ? v : "小修后可用",
    ),
  summary: z.string().trim().max(2000).default(""),
  issues: z
    .array(
      z.object({
        severity,
        type: issueType,
        original: z.string().max(2000).default(""),
        replacement: z.string().max(4000).nullable().default(null),
        reason: z.string().trim().max(1500).default(""),
        evidence: paths,
        related: z.array(z.string().trim().max(200)).max(12).default([]),
      }),
    )
    .max(80)
    .default([]),
  gaps: z.array(z.string().trim().max(500)).max(30).default([]),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export interface SiblingContext {
  title: string;
  audience: "external" | "internal";
  /** ledger = 体系复盘抽过台账；excerpt = 按主题挑的原文片段。 */
  source: "ledger" | "excerpt";
  body: string;
}

/** 跨材料比对里点到这份材料的问题（体系复盘的第三步会带上）。 */
export interface CrossNote {
  severity: string;
  type: string;
  title: string;
  detail: string;
  suggestion: string;
}

export function reviewPrompt(input: {
  libName: string;
  productName: string | null;
  evidence: string;
  material: MaterialMeta;
  text: string;
  truncated: boolean;
  siblings: readonly SiblingContext[];
  caliber: readonly { title: string; text: string }[];
  crossNotes: readonly CrossNote[];
}): string {
  const m = input.material;
  return [
    input.evidence,
    "",
    `请审阅售前材料库「${input.libName}」里的一份材料，给出一份**可以逐条采纳的修订清单**。`,
    input.productName === null
      ? "这本库是公司级的，没有绑定单一产品。"
      : `材料讲的产品：${input.productName}。`,
    "",
    "## 材料信息",
    "",
    ...renderMeta(m),
    "",
    "## 修改的依据（按优先级）",
    "",
    "1. **代码**——产品实际做成了什么。材料里写的能力、指标、流程和代码对不上，以代码为准；",
    "2. **PRD**——已定稿的需求。代码里找不到依据时，以 PRD 为准，但 PRD 里写着「规划 / 二期 / 待开发」的不能当成已有；",
    "3. **路线图等其他资料**——只能用来判断「这是规划中的」或补充背景，不能用来证明某能力已经上线；",
    "4. 同一库里的**其他材料**——用来发现说法不一致。其他材料不是权威：两份材料说法不同时，先看依据支持哪一边；依据都不支持，就标出来让人定，不要随便挑一边。",
    "",
    "依据（代码 / PRD / 其他资料）已附在最前面的依据段里；其他材料的说法附在下面。",
    "",
    "## 要找的问题",
    "",
    "- `code-mismatch` 与代码不符；`prd-mismatch` 与 PRD 不符；",
    "- `roadmap-as-shipped` **把规划写成已有**——对外材料里最危险的一类，客户会按它验收；",
    "- `stale` 过时 / 腐烂的文字：旧产品名、旧版本号、旧价格、已下线的功能、过期日期、失效的联系人与链接；",
    "- `inconsistent` 与同库其他材料说法不一致（同一主题数字不同、叫法不同）；",
    `- \`caliber\` 违反口径：${m.audience === "external" ? "这是**对外**材料，出现底价、折扣底线、内部成本、内部代号、未公开客户名、竞品贬损话术，一律 P0；" : "这是对内材料，重点看口径是否和对外材料一致、底线数字是否和报价体系一致；"}以及违反下面「口径规范」的措辞；`,
    "- `checkpoint` 模板检查要点里要求、材料没覆盖的（这类通常没法一句话改，`replacement` 可给 null，在 reason 里写清缺什么）；",
    "- `other` 其他明显错误（错别字、前后矛盾、算错的数）。",
    "",
    "严重度：P0 = 发出去会出事（承诺做不到的、泄露对内信息、价格指标错）；P1 = 有明显误导或不一致；P2 = 措辞、完整性。",
    "",
    "**不要为了凑数挑刺。**依据不足以判断的，不要硬改；确实可疑就提一条，replacement 给 null，reason 里写「[待核实]」并说明要核实什么。",
    "",
    ...(input.caliber.length === 0
      ? []
      : [
          "## 口径规范（同库里的口径类材料，原文）",
          "",
          ...input.caliber.flatMap((c) => [
            `<口径规范 名称="${c.title}">`,
            c.text.trim(),
            "</口径规范>",
            "",
          ]),
        ]),
    ...(input.siblings.length === 0
      ? ["## 同库其他材料", "", "（库里没有其他可读的现行材料。）", ""]
      : [
          "## 同库其他材料的说法",
          "",
          "台账是体系复盘时抽出的「这份材料声称的事实」；片段是按本材料的主题从原文里挑的几段。",
          "",
          ...input.siblings.flatMap((s) => [
            `<其他材料 名称="${s.title}" 给谁看="${s.audience === "external" ? "对外" : "对内"}" 形式="${s.source === "ledger" ? "台账" : "原文片段"}">`,
            s.body.trim(),
            "</其他材料>",
            "",
          ]),
        ]),
    ...(input.crossNotes.length === 0
      ? []
      : [
          "## 体系复盘里点到这份材料的问题",
          "",
          "跨材料比对时已经发现了下面这些问题，修订清单要**覆盖它们**（能改的给出原文与改法；改不了的说明原因）：",
          "",
          ...input.crossNotes.map(
            (n) =>
              `- [${n.severity}] ${n.title}：${n.detail}${n.suggestion === "" ? "" : `（建议：${n.suggestion}）`}`,
          ),
          "",
        ]),
    ...renderMaterial(m, input.text, input.truncated),
    "",
    "## 怎么写每一条",
    "",
    "- `original`：从上面 <待审材料> 里**逐字**摘要改的那句或那几个词，必须原样出现在材料里。",
    "  - 只摘**一段之内**的文字：不要跨行、不要带 `【第 N 页】`、`【Sheet1】` 这类标记、不要带表格里的制表符；",
    "  - 尽量短，但要短到不会误伤：如果这几个字在材料里出现多处而你只想改其中一处，就多带几个字让它唯一；",
    "    如果同一个错误说法在多处出现、都该改，摘那个说法本身即可，采纳时会全部替换；",
    "  - 缺检查要点这类「没有原文可改」的，original 写空串。",
    "- `replacement`：改成的文字，能直接替换 original；只提醒、不给改法时写 null。",
    "  - 不要在 replacement 里编依据里没有的新数字、新承诺；依据只说了「规划中」，就改成「规划中」或删掉这句。",
    "- `reason`：一两句话说为什么，引用依据时写文件路径；`evidence`：用到的依据文件路径；`related`：涉及的其他材料名称。",
    "",
    "## 输出",
    "",
    "先用几句话说结论（整体能不能用、最要紧的几处），再列问题。回答**末尾**附一个 json 代码块：",
    "",
    "```json",
    '{"verdict":"可直接用 | 小修后可用 | 需大改","summary":"一两句话","issues":[{"severity":"P0","type":"roadmap-as-shipped","original":"已支持私有化一键部署","replacement":"私有化一键部署在规划中（预计 2026 Q4）","reason":"PRD 标为二期，代码里未见部署脚本 [待核实]","evidence":["/product-docs/.../prd/私有化部署.md"],"related":["部署使用手册"]}],"gaps":["检查要点「列明 SLA」材料里没有"]}',
    "```",
  ].join("\n");
}

/* ── cross：跨材料比对 ──────────────────────────────────────────── */

export const crossResultSchema = z.object({
  summary: z.string().trim().max(3000).default(""),
  issues: z
    .array(
      z.object({
        severity,
        type: issueType,
        title: z.string().trim().min(1).max(200),
        detail: z.string().trim().max(2000).default(""),
        materials: z.array(z.string().trim().max(200)).max(30).default([]),
        evidence: paths,
        suggestion: z.string().trim().max(1500).default(""),
      }),
    )
    .max(100)
    .default([]),
});
export type CrossResult = z.infer<typeof crossResultSchema>;

export function crossPrompt(input: {
  libName: string;
  productName: string | null;
  evidence: string;
  ledgers: readonly {
    title: string;
    audience: "external" | "internal";
    stageLabel: string;
    fileName: string;
    claims: LedgerResult["claims"];
  }[];
  /** 读不了 / 没有台账的材料：如实告诉模型，别让它以为全看过了。 */
  missing: readonly { title: string; reason: string }[];
  caliber: readonly { title: string; text: string }[];
}): string {
  return [
    input.evidence,
    "",
    `请对售前材料库「${input.libName}」做一次**体系复盘**：把整套材料放在一起看，找出体系层面的问题。`,
    input.productName === null ? "" : `材料讲的产品：${input.productName}。`,
    "",
    "每份材料的「口径台账」（它声称的事实）附在下面；事实依据（代码 / PRD / 其他资料）在最前面的依据段里。",
    "这一步的结论会交给下一步，逐份材料出修订清单，所以**每个问题都要写清涉及哪几份材料**（用下面给的材料名称原文）。",
    "",
    "## 要找的问题",
    "",
    "1. `inconsistent` **上下文不一致**：同一主题（topic 相近的条目）在不同材料里说法不同——数字、叫法、范围、流程。写清各自怎么说的。",
    "2. `stale` **腐烂文字**：旧产品名、旧版本号、旧价格、已下线或改名的功能、过期的时间。",
    "3. `code-mismatch` / `prd-mismatch` / `roadmap-as-shipped` **与依据不符**：取信顺序 代码 > PRD > 其他资料；PRD 或路线图里是规划、材料里写成已有的，单独标出来。",
    "4. `caliber` **口径问题**：对外材料出现对内信息（底价、折扣底线、成本、内部代号、未公开客户），或违反口径规范。",
    "",
    "不要逐份材料复述台账；只报**问题**。依据不足以判断的写进 detail 并标 `[待核实]`。",
    "",
    ...(input.caliber.length === 0
      ? []
      : [
          "## 口径规范",
          "",
          ...input.caliber.flatMap((c) => [
            `<口径规范 名称="${c.title}">`,
            c.text.trim(),
            "</口径规范>",
            "",
          ]),
        ]),
    "## 各材料的口径台账",
    "",
    ...input.ledgers.flatMap((l) => [
      `<材料台账 名称="${l.title}" 阶段="${l.stageLabel}" 给谁看="${l.audience === "external" ? "对外" : "对内"}" 文件="${l.fileName}">`,
      ...l.claims.map(
        (c) =>
          `- [${c.category}] ${c.topic}：${c.claim}${c.quote === "" ? "" : `（原文：「${c.quote}」）`}`,
      ),
      "</材料台账>",
      "",
    ]),
    ...(input.missing.length === 0
      ? []
      : [
          "以下材料这次没有台账（没参与比对，不要对它们下结论）：",
          ...input.missing.map((x) => `- ${x.title}：${x.reason}`),
          "",
        ]),
    "## 输出",
    "",
    "先写几句体系层面的结论（整体健康度、最要紧的问题），然后在回答**末尾**附一个 json 代码块：",
    "",
    "```json",
    '{"summary":"几句话","issues":[{"severity":"P1","type":"inconsistent","title":"并发上限说法不一","detail":"白皮书写 100，FAQ 写 200","materials":["产品白皮书","常见问题回答（FAQ）"],"evidence":["/代码库/.../limits.go"],"suggestion":"统一为代码里的 100"}]}',
    "```",
  ].join("\n");
}
