/**
 * 出厂模板「标准 SaaS Web 产品」。
 *
 * 内容是生命周期方法论 v0.2 的机器可读投影：
 * 层级与主产出物取自第 1 节全链总览，`checkpoints` 取自各层的必答项与出口判据
 * （G0.1–G5.2），`guide` 沿用老版本 `apps/core/src/lifecycle-schema.ts` 里
 * 已经打磨过的那版措辞。**改方法论要先改那份文档**，这里只是它的投影。
 *
 * 与老版本的区别只有一个，但很关键：老版本这张表是 TS 字面量，用户造不出第三个模板；
 * 这里它只是「第一次打开时灌进数据库的一行种子」，之后层、产出物、判定要点全可改。
 * 所以**这份常量同时是两件事的唯一来源**：首次播种，与「恢复出厂内容」。
 *
 * checkpoints 一行一条：它是 AI 比对产出物时的判定清单，让结论能落到
 * 「有，但第 2 点没答」而不是「有 / 没有」。
 * fileHints 是文件名与路径关键词（`|` 分隔），用来先把扫描面缩小。
 */

export interface BuiltinArtifact {
  name: string;
  required: boolean;
  guide: string;
  checkpoints: string[];
  fileHints: string[];
}

export interface BuiltinStage {
  code: string;
  label: string;
  question: string;
  artifacts: BuiltinArtifact[];
}

export interface BuiltinTemplate {
  name: string;
  description: string;
  stages: BuiltinStage[];
}

export const BUILTIN_TEMPLATE: BuiltinTemplate = {
  name: "标准 SaaS Web 产品",
  description:
    "从零到一做一个对外 SaaS Web 产品的完整档：L0 立项（想法卡 → PR-FAQ → 市场与商业定义 → 产品一页纸 → 可用性预检）→ L1 Roadmap → L2 功能分解 → L3 需求规格 → L4 技术方案 → L5 验收与复盘。依据生命周期方法论 v0.2。",
  stages: [
    {
      code: "L0.1",
      label: "想法卡",
      question: "这个想法值不值得细看",
      artifacts: [
        {
          name: "想法卡",
          required: true,
          guide:
            "一页纸、不超过 200 字。刻意做得便宜——绝大多数想法死在这一步，不该消耗一份完整文档。答不出的处置是挂起等信号（Hold），不是枪毙（Kill）。",
          checkpoints: [
            "谁的什么痛点：具体到人和场景，「企业需要更好的 X」不算答案",
            "他们现在怎么凑合解决的",
            "为什么值得细看",
            "至少 1 个具体的人、在具体场景下的原话或真实行为记录（不是 PM 推断的合理凑合方案）",
          ],
          fileHints: ["想法卡", "idea", "idea-card"],
        },
      ],
    },
    {
      code: "L0.2",
      label: "立项 PR-FAQ",
      question: "这个产品值不值得做",
      artifacts: [
        {
          name: "立项 PR-FAQ",
          required: true,
          guide:
            "从零起步产品的第一份正式文档。用「新闻稿 + 常见问答」形式，站在上线那天倒推。它是过滤器不是论证书——通过率低是设计本意。",
          checkpoints: [
            "一句话：上市那天对谁解决了什么",
            "痛点：按严重度排序，每条落在事实上并标来源",
            "现有替代方案：今天怎么办的、为什么不够",
            "为什么是现在：什么条件变了",
            "成功长什么样：可量化、带时限",
            "关键假设清单 + 每条怎么验证（重要性 × 证据充分度二维分级）",
            "明确不做（Out of Scope）非空",
            "分受众 FAQ：客户 / 内部 / 合规各一组",
            "客户证言：一句虚构但具体的客户原话，不允许抽象转述",
            "Appetite：准备投入多少时间人力，并以此反推范围边界",
            "已知风险点：哪些细节容易在推进中才发现代价",
            "为什么是我们：凭什么最适合做这件事",
            "出口判据：「重要且无证据」象限已清零（是有证据，不是有信心）",
            "出口判据：至少标出一条 importance 高的假设",
            "涉及技术不确定性的高重要性假设，已有工程师 spike 结果作为证据",
          ],
          fileHints: ["PR-FAQ", "PRFAQ", "立项", "新闻稿"],
        },
      ],
    },
    {
      code: "L0.3",
      label: "市场与商业定义",
      question: "卖给谁、市场多大、值多少钱",
      artifacts: [
        {
          name: "市场与商业定义",
          required: true,
          guide:
            "讲清目标市场规模、目标客户画像、付费意愿与商业模式；结论要有外部证据支撑，不能只凭判断。",
          checkpoints: [
            "理想客户画像 ICP：五维（firmographics / technographics / trigger_events / pain_points / derived_from），且从现有最佳客户反推而非凭空定义",
            "场景清单：按频次与价值排序",
            "竞品格局：含「客户干脆不解决」这个选项，且同时写出我们赢在哪与输在哪",
            "定价与商业模式假设：以价值定价为主，成本加成只当价格下限",
            "市场规模 TAM / SAM / SOM：自上而下与自下而上两种都算并交叉验证",
            "付费意愿的定量验证（van Westendorp / Gabor-Granger 等），不是态度陈述",
          ],
          fileHints: ["市场", "商业定义", "ICP", "定价", "market"],
        },
      ],
    },
    {
      code: "L0.4",
      label: "产品定位与范围",
      question: "这个产品到底是什么",
      artifacts: [
        {
          name: "产品定位与范围（产品一页纸）",
          required: true,
          guide:
            "一句话定位（为谁、解决什么、区别于谁）+ 明确的做与不做边界 + 成功指标树；范围要可落地，不含糊。",
          checkpoints: [
            "价值主张：一句话说清对谁、解决什么、比替代方案好在哪",
            "能力地图：能力级而非功能级，且逐条覆盖 L0.2 列出的痛点",
            "边界与明确不做",
            "成功指标树：已指定唯一北极星",
            "成功指标树：已区分领先指标与滞后指标",
            "成功指标树：护栏指标非空（防止「指标涨了但客户在变差」）",
            "每个叶子指标可观测，且写明数据来源系统或埋点名称",
            "能力地图规模与 L0.2 的 Appetite 相容（做不完就砍范围，不是延期）",
          ],
          fileHints: ["定位", "范围", "一页纸", "positioning", "能力地图"],
        },
      ],
    },
    {
      code: "L0.5",
      label: "可用性预检",
      question: "这东西会不会用",
      artifacts: [
        {
          name: "可用性预检记录",
          required: false,
          guide:
            "找 5 个目标客户，给纸面或可点击原型，让他们独立完成 1-2 个关键任务，记录卡在哪一步。主责是设计，或 PM 明确代行。纯接口 / 后台产品无界面可跳过并留痕。",
          checkpoints: [
            "至少 1 个关键任务经过 ≥5 名目标用户独立走通测试",
            "记录的是观察到的行为，不是用户的口头评价",
            "严重度「高」的阻塞点已有处置结论（改方案 / 接受并在 L3 说明 / 判定为测试设计问题）",
          ],
          fileHints: ["可用性", "usability", "原型测试"],
        },
      ],
    },
    {
      code: "L1",
      label: "阶段规划",
      question: "这一期做哪些模块",
      artifacts: [
        {
          name: "阶段规划（Roadmap）",
          required: true,
          guide:
            "本期目标 + 候选模块清单 + 优先级与取舍理由 + 里程碑；每个模块要能对上一个明确的产出目标。",
          checkpoints: [
            "本期 outcomes 来源于 L0.4 的成功指标树（含北极星与护栏）",
            "每个候选模块已判代码底座档位：新建 / 完善 / 增强 / 已有 / 有风险",
            "判为「已有」的候选按伪需求处置（Kill 或降级）",
            "判为「有风险」的已标风险并给出替代路径",
            "L0.4 → L1 的 100% Rule：有 outcome 无模块承接时已显式说明本期不做",
            "未达 40% 的 PMF 信号已登记进关键假设",
          ],
          fileHints: ["阶段规划", "roadmap", "规划", "plan"],
        },
      ],
    },
    {
      code: "L2",
      label: "模块功能分解",
      question: "模块拆成哪些功能",
      artifacts: [
        {
          name: "模块功能分解",
          required: true,
          guide:
            "把一个模块拆成边界清晰、可独立交付的功能清单，每个功能一句话职责；拆解粒度以能写需求规格为准。",
          checkpoints: [
            "每个功能 parent_module 非空",
            "原子性：每个功能能用一个不含「和 / 或」的句子描述完",
            "L1 → L2 的 100% Rule：模块下所有功能合起来等于该模块范围",
            "每个功能带档位与优先级标注",
          ],
          fileHints: ["功能分解", "拆解", "decompose"],
        },
        {
          name: "方案比选",
          required: false,
          guide:
            "L2 → L3 之间的子步骤：对已确定要做的功能发散多个候选做法，收敛成一张比选表，并入需求规格的一节，不另起文档。",
          checkpoints: [
            "候选方案 ≥2 个",
            "每个候选都写了优点与代价",
            "选中项已标注，未选项写清不选的理由",
          ],
          fileHints: ["方案比选", "候选方案"],
        },
      ],
    },
    {
      code: "L3",
      label: "需求规格",
      question: "每个功能具体怎么做",
      artifacts: [
        {
          name: "需求规格（PRD）",
          required: true,
          guide:
            "需求清单、主流程与异常边界、数据规则、权限、可测的验收标准、线框图；用词写死、无待定项。",
          checkpoints: [
            "parent_feature 非空",
            "需求条目带优先级与稳定性标注（核心逻辑 / 细节）",
            "验收标准采用 EARS 句式，≥3 条且每条可验证、有明确预期值",
            "非功能维度已点名（性能 / 兼容 / 安全等 nfr_flags）",
            "异常与边界表无空行",
            "数据规则表含取值范围、必填性、默认值",
            "权限矩阵已填",
            "文案清单为准确文本",
            "明确不做（Out of Scope）非空",
            "零未明确点：无待定 / TBD / TODO / 待补充 / 开放问题",
            "无模糊词：尽快 / 友好提示 / 合理 / 优化一下 / 体验更好",
          ],
          fileHints: ["PRD", "需求规格", "需求文档", "spec"],
        },
      ],
    },
    {
      code: "L4",
      label: "技术方案",
      question: "技术上能不能落地、扛不扛得住",
      artifacts: [
        {
          name: "技术方案与非功能要求",
          required: false,
          guide:
            "研发产出，产品侧审查：可行性、性能与安全、对既有系统的影响、替代方案与风险。产品侧记录结论与遗留。",
          checkpoints: [
            "L3 点名的每个非功能维度都有对应数字与验证方式",
            "对既有系统的影响已评估（是否改既有表结构、是否影响存量功能）",
            "parent_id 指向对应需求，双向可追溯链未断",
          ],
          fileHints: ["技术方案", "技术设计", "design doc"],
        },
        {
          name: "关键技术决策记录（ADR）",
          required: false,
          guide:
            "逐条记录面临的权衡、备选方案、选择与后果（含代价）、状态。源自 ADR。",
          checkpoints: [
            "每条决策写清背景（面临什么权衡）",
            "备选方案 ≥2 个",
            "后果一栏同时写了好处与代价",
            "状态已标（Proposed / Accepted / Superseded）",
          ],
          fileHints: ["ADR", "决策记录", "技术决策"],
        },
      ],
    },
    {
      code: "L5.1",
      label: "交付验收",
      question: "做出来对不对",
      artifacts: [
        {
          name: "验收报告",
          required: false,
          guide:
            "把 L3 需求规格的验收标准逐条转成可执行检查项，逐条核对实现，记录通过 / 不通过与证据；不通过项回研发并留痕。",
          checkpoints: [
            "验收标准逐条有结论，无「基本可用」「大致符合」这类不可判定结论",
            "不通过项已有回研发的记录",
            "每条结论附可核验的证据（截图 / 接口返回 / 日志）",
          ],
          fileHints: ["验收", "acceptance", "verify"],
        },
      ],
    },
    {
      code: "L5.2",
      label: "上线后复盘",
      question: "上线后成不成",
      artifacts: [
        {
          name: "上线后指标复盘",
          required: false,
          guide:
            "对照 L0.2 的成功指标与 L0.4 的成功指标树（含护栏）逐条填实际值。目标必须在上线前就量化写死——事后才定义「什么算成功」是自我合理化，不是测量。",
          checkpoints: [
            "数字可信性已核实：有基线、口径未变、观测期足够（不是测太早）",
            "已产出四选一结论：达标维持 / 有希望要迭代 / 未达标要深挖 / 明确失败转移资源",
            "每条未达成指标已按回退路径表定位到具体层，或明确判为外部因素 / 度量问题",
            "指标达标但护栏破线的，没有被记成「达成、闭环」",
            "每条洞察已分级：本次修复 / 纳入路线图 / 明确拒绝并写清理由",
            "结论已回流为下一轮 L1 阶段规划的现状输入",
          ],
          fileHints: ["复盘", "回顾", "retro", "上线后"],
        },
      ],
    },
  ],
};
