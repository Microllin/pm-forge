/**
 * 从任务文本里抽关键词。
 *
 * 这是「听懂任务」的**本地保底**：不调模型、不联网，毫秒级。AI 扩写同义词
 * （中英对照，如 退款→refund）由 locate.ts 里可注入的 expand 补上；expand
 * 失败或没配模型时，只靠这里也能定位，只是跨语言命中会变差。
 *
 * 中文没有空格分词，用「整段 + 二元组」两路：整段（≤8 字）命中目录名/标题
 * 时很准，二元组负责长句里的局部命中。代价是二元组会产生「求退」这种跨词碎片，
 * 所以它的权重在排序里低于整段与模型给的词。
 */

/** 任务文本里大量是方法论/流程套话，命中它们等于什么也没说明。 */
const CJK_STOP = new Set([
  "请用",
  "方法",
  "法论",
  "产出",
  "出物",
  "撰写",
  "这个",
  "一个",
  "一份",
  "我们",
  "需要",
  "进行",
  "完成",
  "调用",
  "工具",
  "文件",
  "不要",
  "以下",
  "现状",
  "上下",
  "下文",
  "节点",
  "参数",
  "写入",
  "工作",
  "作区",
  "如果",
  "然后",
  "可以",
  "什么",
  "怎么",
  "是否",
  "以及",
  "或者",
  "已经",
  "没有",
  "结论",
  "依据",
  "事实",
  "实际",
  "读取",
  "建议",
  "清单",
  "候选",
  "分析",
  "只做",
  "标准",
  "要求",
  "产品",
  "功能",
  "模块",
  "用户",
  "内容",
  "相关",
  "对应",
  "所有",
  "当前",
  "范围",
  "一下",
  "帮我",
  "看看",
  "继续",
  "好的",
  "哪些",
  "支持",
  "现在",
  "目前",
  "情况",
  "梳理",
  "怎样",
  "如何",
  "一些",
  "写一",
]);

const ASCII_STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "use",
  "md",
  "prd",
  "skill",
  "pmforge",
  "save",
  "artifact",
  "kind",
  "tool",
  "http",
  "https",
  "www",
  "com",
]);

export interface Keyword {
  term: string;
  /** 1 = 本地二元组；2 = 本地整段 / 英文词；3 = 节点标题链或模型给的词。 */
  weight: number;
}

const CJK_RUN = /[一-鿿]{2,}/g;
const ASCII_WORD = /[A-Za-z][A-Za-z0-9_-]{1,40}/g;

/**
 * 先把套话短语和虚词切掉，再取中文整段。
 *
 * 不切的话「为退款审批撰写产出物」是一整段 10 个字，既超出整段长度上限，
 * 二元组里又混着「为退」「批撰」这种碎片——真正的词「退款审批」反而出不来。
 */
const CJK_CUT = new RegExp(
  [
    "方法论",
    "产出物",
    "请用",
    "撰写",
    "调用",
    "以下",
    "这个",
    "那个",
    "一份",
    "一个",
    "我们",
    "需要",
    "进行",
    "帮我",
    "现状",
    "上下文",
    "[的了和与及为把将对给在是从用请并或吗呢吧啊]",
  ].join("|"),
  "g",
);

/** 驼峰 / 连字符 / 下划线拆成子词：billingRefund → billing, refund。 */
function splitIdentifier(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w.length >= 3);
}

export function extractKeywords(text: string, limit = 30): Keyword[] {
  // 只看前 2000 字：系统拼的 seed prompt 后半段多是产品树快照，越往后越是噪音。
  const head = text.slice(0, 2000);
  const score = new Map<string, Keyword & { hits: number }>();
  const add = (term: string, weight: number): void => {
    const prev = score.get(term);
    if (prev) {
      prev.hits += 1;
      prev.weight = Math.max(prev.weight, weight);
    } else score.set(term, { term, weight, hits: 1 });
  };

  for (const run of head.replace(CJK_CUT, " ").match(CJK_RUN) ?? []) {
    if (run.length <= 8 && !CJK_STOP.has(run)) add(run, 2);
    for (let i = 0; i + 2 <= run.length; i++) {
      const bi = run.slice(i, i + 2);
      if (!CJK_STOP.has(bi)) add(bi, 1);
    }
  }
  for (const word of head.match(ASCII_WORD) ?? []) {
    const lower = word.toLowerCase();
    if (!ASCII_STOP.has(lower) && lower.length >= 3) add(lower, 2);
    for (const sub of splitIdentifier(word)) {
      if (sub !== lower && !ASCII_STOP.has(sub)) add(sub, 2);
    }
  }

  return [...score.values()]
    .sort((a, b) => b.weight * b.hits - a.weight * a.hits)
    .slice(0, limit)
    .map(({ term, weight }) => ({ term, weight }));
}

/** 合并多路关键词：同词取最高权重，保序（先来的在前）。 */
export function mergeKeywords(...groups: Keyword[][]): Keyword[] {
  const map = new Map<string, Keyword>();
  for (const group of groups) {
    for (const k of group) {
      const term = k.term.trim().toLowerCase();
      if (term.length < 2) continue;
      const prev = map.get(term);
      if (!prev || prev.weight < k.weight)
        map.set(term, { term, weight: k.weight });
    }
  }
  return [...map.values()];
}
