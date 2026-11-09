import { EVIDENCE_CLOSE, EVIDENCE_OPEN } from "./brief.js";
import type { EvidenceLibrary, EvidenceSource } from "./library.js";
import {
  STALE_SEGMENT,
  type LocateResult,
  type LocatedFile,
} from "./locate.js";

/**
 * 依据分层：代码 > PRD > 其他资料。
 *
 * 定位器只分「文档 / 代码」两类，够用来「找到该读的文件」；但做**核对**（售前材料
 * 对不对、口径一致不一致）时还得知道**说法冲突时信谁**：
 *
 * 1. **代码**——产品实际是什么样，以它为准；
 * 2. **PRD**——产品打算做成什么样（已定稿的需求）；
 * 3. **其他资料**——路线图、规格、调研、参考资料。
 *
 * 分层只改变「怎么交给 AI、冲突时怎么判」，不改变「找哪些文件」——找文件仍然只走
 * 定位器。
 */

export type EvidenceTier = "code" | "prd" | "other";

export const TIER_ORDER: readonly EvidenceTier[] = ["code", "prd", "other"];

export const TIER_LABEL: Record<EvidenceTier, string> = {
  code: "第一层 · 代码",
  prd: "第二层 · PRD",
  other: "第三层 · 其他资料（路线图 / 规格 / 调研等）",
};

/** 文件名或目录名像 PRD / 需求规格。 */
const PRD_PATH =
  /(^|[/_\-. （(])prds?([/_\-. ）)]|$)|需求规格|需求文档|产品需求|功能需求/i;

export function tierOf(
  file: { path: string; kind: "doc" | "code" },
  prdPaths: ReadonlySet<string>,
): EvidenceTier {
  if (file.kind === "code") return "code";
  if (prdPaths.has(file.path) || PRD_PATH.test(file.path)) return "prd";
  return "other";
}

export interface TieredFile extends LocatedFile {
  tier: EvidenceTier;
}

export interface TieredEvidence {
  library: EvidenceLibrary;
  searched: EvidenceSource[];
  files: TieredFile[];
  /** 命中了但因预算没附正文的份数（按层）。 */
  dropped: Record<EvidenceTier, number>;
  /** 归档 / 旧版目录里命中、被排除的份数。 */
  stale: number;
  skipped: { path: string; reason: string }[];
  truncated: string[];
}

/**
 * 把几次定位的结果并起来、分层、按层花预算。
 *
 * 为什么要「几次」：定位器只看任务文本的前 2000 字抽关键词，一份售前材料动辄上万字，
 * 一次只能照顾到开头。调用方按材料分段各定位一次，这里同一文件取最高分去重。
 *
 * 归档目录**直接排除**而不是降权：做核对时，作废的旧口径被当成依据比没有依据更糟
 * （真实库里 `_archive/legacy-roadmap` 的 README 明写「不得作为需求前提」）。
 */
export function pickTiered(
  results: readonly LocateResult[],
  options: {
    prdPaths: ReadonlySet<string>;
    /** 每层的正文字符预算。 */
    budgets: Record<EvidenceTier, number>;
  },
): TieredEvidence {
  const first = results[0];
  const best = new Map<string, LocatedFile>();
  let stale = 0;
  const staleSeen = new Set<string>();
  for (const r of results) {
    for (const f of r.files) {
      if (STALE_SEGMENT.test(f.path)) {
        if (!staleSeen.has(f.path)) stale += 1;
        staleSeen.add(f.path);
        continue;
      }
      const prev = best.get(f.path);
      if (prev === undefined || prev.score < f.score) best.set(f.path, f);
    }
  }
  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  const left = { ...options.budgets };
  const files: TieredFile[] = [];
  const over: { f: LocatedFile; tier: EvidenceTier }[] = [];
  const take = (f: LocatedFile, tier: EvidenceTier, room: number): number => {
    const content = f.content.slice(0, room);
    files.push({
      ...f,
      tier,
      content,
      truncated: f.truncated || content.length < f.content.length,
    });
    return content.length;
  };
  for (const f of ranked) {
    const tier = tierOf(f, options.prdPaths);
    if (left[tier] <= 0) {
      over.push({ f, tier });
      continue;
    }
    left[tier] -= take(f, tier, left[tier]);
  }
  // 某一层没用完的预算让给别的层里超出的（按分数）：中文材料定位代码常常命中很少，
  // 那部分预算空着不如多附几份 PRD。每层自己的份额仍然优先，不会被别层挤占。
  let spare =
    Math.max(0, left.code) + Math.max(0, left.prd) + Math.max(0, left.other);
  const dropped: Record<EvidenceTier, number> = { code: 0, prd: 0, other: 0 };
  for (const { f, tier } of over) {
    if (spare <= 0) {
      dropped[tier] += 1;
      continue;
    }
    spare -= take(f, tier, spare);
  }
  files.sort(
    (a, b) =>
      TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) ||
      b.score - a.score,
  );
  const uniq = <T>(list: T[], key: (x: T) => string): T[] => [
    ...new Map(list.map((x) => [key(x), x])).values(),
  ];
  return {
    library: first?.library ?? {
      product: null,
      productName: null,
      sources: [],
      missing: [],
    },
    searched: first?.searched ?? [],
    files,
    dropped,
    stale,
    skipped: uniq(
      results.flatMap((r) => r.skipped),
      (s) => s.path,
    ),
    truncated: [...new Set(results.flatMap((r) => r.truncated))],
  };
}

/**
 * 写成交给 AI 的依据段（与 brief.ts 同一对标记，界面同样会折叠它）。
 *
 * 入口自带依据段时，运行器不再按整条消息另定位一遍（见 evidence/index.ts 的 brief）。
 */
export function renderTieredBrief(evidence: TieredEvidence): string {
  const { library } = evidence;
  const lines: string[] = [];
  if (library.productName === null) {
    lines.push(
      "【本次事实依据】这本材料库没有绑定产品，因而没有代码 / PRD 等事实依据。",
      "涉及产品现状的判断一律标 `[待核实]`，不要凭经验断定材料写错了；只做材料之间的一致性与口径检查。",
    );
    return wrap(lines);
  }
  lines.push(
    `【本次事实依据】平台按这份任务，从「${library.productName}」的事实依据里分层挑出了下面这些文件，正文附在最后。`,
    "",
    "取信顺序（说法冲突时以排在前面的为准）：",
    "1. **代码**——产品实际做成了什么；",
    "2. **PRD**——已定稿的需求；",
    "3. **其他资料**——路线图、规格、调研、参考资料。",
    "PRD 或路线图里有、而附上的代码里明确没有（或明确写着未上线 / 规划中）的能力，只能算「规划中」。",
    "**附上的代码里找不到 ≠ 代码里没有**：定位是按关键词挑的，没附上的部分你看不到。这种情况标 `[待核实]`，不要断定材料写错。",
  );
  for (const tier of TIER_ORDER) {
    const group = evidence.files.filter((f) => f.tier === tier);
    lines.push("", `${TIER_LABEL[tier]}：`);
    if (group.length === 0) lines.push("（这一层没有定位到相关文件）");
    group.forEach((f, i) => {
      const title = f.title === null ? "" : `《${f.title}》`;
      lines.push(
        `${String(i + 1)}. ${f.path}${title} — 命中：${f.matched.join("、")}`,
      );
    });
    if (evidence.dropped[tier] > 0)
      lines.push(
        `（另有 ${String(evidence.dropped[tier])} 份命中但超出篇幅没附上——没附上不代表不存在。）`,
      );
  }
  lines.push("", "依据范围（只在这里面取证）：");
  for (const s of evidence.searched) lines.push(`- ${s.label}：${s.path}`);
  if (library.missing.length > 0) {
    lines.push("绑定了但文件库里找不到（涉及它们的结论标 `[待核实]`）：");
    for (const p of library.missing) lines.push(`- ${p}`);
  }
  if (evidence.stale > 0)
    lines.push(
      `归档 / 旧版目录里另有 ${String(evidence.stale)} 份命中，已排除——作废的旧口径不作依据。`,
    );
  if (evidence.truncated.length > 0)
    lines.push(
      `（${evidence.truncated.join("、")} 文件过多，这次只扫了一部分。）`,
    );
  if (evidence.skipped.length > 0) {
    lines.push("疑似含凭据、只记了路径没附正文：");
    for (const s of evidence.skipped) lines.push(`- ${s.path}（${s.reason}）`);
  }
  lines.push(
    "",
    "规则：没有文件工具，你读不到这里之外的东西；涉及凭据的配置只写「有这一项」，不写值；引用依据时写出文件路径。",
  );
  for (const f of evidence.files) {
    lines.push(
      "",
      `<事实来源 路径="${f.path}" 层级="${TIER_LABEL[f.tier]}"${f.truncated ? ' 截断="是"' : ""}>`,
      f.content.trim(),
      "</事实来源>",
    );
  }
  return wrap(lines);
}

function wrap(lines: string[]): string {
  return `${EVIDENCE_OPEN}\n${lines.join("\n")}\n${EVIDENCE_CLOSE}`;
}
