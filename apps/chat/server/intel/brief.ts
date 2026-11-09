import { EVIDENCE_CLOSE, EVIDENCE_OPEN } from "../evidence/brief.js";
import {
  CONFIDENCE_LABEL,
  KIND_LABEL,
  type IntelHit,
  type IntelItem,
} from "./store.js";

/**
 * 情报怎么交给 AI：一段「参考情报」，跟在事实依据后面，**标签上写明是参考**。
 *
 * 用户的原话：这些资料是 AI 写 PRD 时「应该考虑的，不是准则」。所以下发的说明
 * 只要求「考虑到、引用时标出处与时效」，不要求「遵守」；也明说它不能拿来描述我们
 * 自己的产品（那是事实依据的事），避免 AI 把竞品的功能写成我们已有的。
 */

export const INTEL_OPEN = "<参考情报>";
export const INTEL_CLOSE = "</参考情报>";

/** 单条正文上限与整段上限：情报是背景，不能把事实依据挤出上下文。 */
const ITEM_BUDGET = 1_500;
const TOTAL_BUDGET = 7_000;
export const BRIEF_LIMIT = 6;

const RULES = [
  "以下是情报库里与本次任务相关的外部资料（竞品、市场、行业动态、合规）。",
  "它们是**参考**：不是要照做的准则，也不是我们产品自身的事实依据。",
  "- 用来让方案考虑到外部情况：竞品怎么做、市场与政策在怎么变。不要因为竞品这么做就照搬，取舍要说出理由。",
  "- 引用时标【情报：标题｜日期】；标了「可能过时」「单一来源」「推断」的，结论里要说出来。",
  "- 描述我们自己的产品只用事实依据；情报只描述外部。两者冲突时不要用情报改写我们的现状。",
  "- 合规类条目只提示「可能涉及」，是否适用标「需法务 / 合规确认」，不要替人下结论。",
  "- 情报没覆盖到的外部事实，不要编；需要时说明「情报库里没有，建议补充调研」。",
];

export function itemHeader(item: IntelItem): string {
  const flags = [
    KIND_LABEL[item.kind],
    item.subject === "" ? null : `对象：${item.subject}`,
    item.observedAt === null ? "日期不明" : `观察于 ${item.observedAt}`,
    CONFIDENCE_LABEL[item.confidence],
    item.stale ? "可能过时" : null,
  ].filter((x): x is string => x !== null);
  return flags.join("｜");
}

export function renderItem(item: IntelItem, budget = ITEM_BUDGET): string {
  const body = item.content.trim();
  const clipped =
    body.length > budget ? `${body.slice(0, budget)}\n…（已截断）` : body;
  const sources = item.sources
    .slice(0, 5)
    .map((s) => (s.title ? `${s.title} ${s.url}` : s.url));
  return [
    `<情报条目 编号="${item.id}" 标题="${item.title.replace(/"/g, "'")}">`,
    itemHeader(item),
    item.summary === "" ? null : `结论：${item.summary}`,
    clipped === "" ? null : clipped,
    sources.length === 0 ? "来源：未注明" : `来源：${sources.join("；")}`,
    "</情报条目>",
  ]
    .filter((x): x is string => x !== null)
    .join("\n");
}

/** 一组命中 → 参考情报段；没有命中返回 null。 */
export function renderIntelBrief(hits: readonly IntelHit[]): string | null {
  if (hits.length === 0) return null;
  const parts: string[] = [];
  let used = 0;
  for (const h of hits) {
    const block = renderItem(h.item);
    if (used + block.length > TOTAL_BUDGET && parts.length > 0) break;
    parts.push(block);
    used += block.length;
  }
  return [INTEL_OPEN, ...RULES, "", ...parts, INTEL_CLOSE].join("\n");
}

/**
 * 把参考情报并进依据段：同在一个 <pmforge-evidence> 包裹里，界面才会把它折叠成一行
 * （见 web/src/chat/parts.tsx），而不是糊在用户的话前面。
 */
export function mergeBriefs(
  evidence: string | null,
  intel: string | null,
): string | null {
  if (intel === null) return evidence;
  if (evidence === null) return `${EVIDENCE_OPEN}\n${intel}\n${EVIDENCE_CLOSE}`;
  const at = evidence.lastIndexOf(EVIDENCE_CLOSE);
  if (at < 0)
    return `${evidence}\n\n${EVIDENCE_OPEN}\n${intel}\n${EVIDENCE_CLOSE}`;
  return `${evidence.slice(0, at)}\n${intel}\n${evidence.slice(at)}`;
}
