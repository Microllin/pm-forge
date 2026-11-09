/**
 * 出厂售前模板。
 *
 * 组织方式：**按客户在每个阶段会问的问题**分层，每一类材料回答其中一个问题。
 * 「必备」的判定只有一条：**缺了它，这一单会卡在这个阶段推不下去**。
 * 能缓一缓、或只在部分客户（政企 / 招投标）那里才会被要到的，标为可选。
 *
 * 与「生命周期规范」同一口径：这份常量只是第一次打开时灌进数据库的种子，
 * 之后阶段、材料、检查要点全可改；它同时是「恢复出厂内容」的唯一来源。
 *
 * - checkpoints：这份材料必须答到哪几点。AI 核对时逐条对，结论才能落到
 *   「有，但没写交付形态」而不是「有 / 没有」。
 * - fileHints：文件名关键词，AI 从大文件夹里识别时先用它缩小范围。
 */

export interface BuiltinPresalesItem {
  name: string;
  /**
   * 旧名 / 别名。补模板按名称去重，老库里叫「需求摸底表」的材料
   * 不该因为模板里改叫「需求调研表」就再补一份。
   */
  aliases?: string[];
  required: boolean;
  audience: "external" | "internal";
  guide: string;
  checkpoints: string[];
  fileHints: string[];
}

export interface BuiltinPresalesStage {
  code: string;
  label: string;
  question: string;
  items: BuiltinPresalesItem[];
}

export interface BuiltinPresalesTemplate {
  /** 出厂模板的稳定标识：恢复出厂、按种类找默认模板都靠它，不靠名字（名字可改）。 */
  key: "product" | "company";
  name: string;
  description: string;
  stages: BuiltinPresalesStage[];
}

export const PRODUCT_PRESALES_TEMPLATE: BuiltinPresalesTemplate = {
  key: "product",
  name: "标准售前模板",
  description:
    "单个产品对外销售所需的材料。按客户在各阶段会问的问题分 5 层：认知与初访 → 需求确认 → 方案与报价 → 验证与交付，外加一层只给销售自己看的内部支撑。必备 = 缺了它这一单会卡在这一步。",
  stages: [
    {
      code: "S1",
      label: "认知与初访",
      question: "你们是谁、解决什么问题、凭什么是你们",
      items: [
        {
          name: "产品介绍PPT",
          required: true,
          audience: "external",
          guide:
            "第一次见客户讲的那套。20 页以内，讲清楚问题和价值，不堆功能。",
          checkpoints: [
            "客户的痛点与典型场景",
            "产品定位一句话",
            "核心能力（不超过 5 条）",
            "至少 1 个案例或可量化的效果",
            "交付形态与合作方式",
          ],
          fileHints: ["PPT", "介绍", "deck", "pptx"],
        },
        {
          name: "产品白皮书",
          required: true,
          audience: "external",
          guide:
            "对外能力口径的基准。其他对外材料与它冲突时，改材料、不改白皮书。",
          checkpoints: [
            "产品定位与适用客户",
            "整体架构图",
            "核心功能逐项说明",
            "部署形态与环境要求",
            "安全与合规说明",
          ],
          fileHints: ["白皮书", "whitepaper", "white-paper"],
        },
        {
          name: "演示视频 / 演示环境",
          aliases: ["演示视频"],
          required: true,
          audience: "external",
          guide:
            "3–5 分钟走完一条主流程。客户没时间看现场演示时，靠它判断要不要继续聊。",
          checkpoints: [
            "覆盖一条完整的主业务流程",
            "时长不超过 5 分钟",
            "不出现内部数据或测试账号",
          ],
          fileHints: ["演示", "demo", "视频", "mp4"],
        },
      ],
    },
    {
      code: "S2",
      label: "需求确认",
      question: "你们能不能解决我的问题",
      items: [
        {
          name: "需求调研表",
          aliases: ["需求摸底表", "客户问卷"],
          required: true,
          audience: "external",
          guide:
            "第二次沟通前发给客户填，或销售照着问。答案决定后面方案怎么写、报价怎么报。",
          checkpoints: [
            "业务现状与痛点",
            "目标与衡量指标",
            "规模（用户数 / 数据量 / 调用量）",
            "环境要求（私有化 / 云 / 信创）",
            "决策链与采购时间",
          ],
          fileHints: ["调研", "摸底", "问卷", "需求表"],
        },
        {
          name: "常见问题解答（FAQ）",
          aliases: ["常见问题回答（FAQ）", "FAQ"],
          required: false,
          audience: "external",
          guide: "客户反复问的问题统一口径，减少每次现编。",
          checkpoints: [
            "覆盖部署、安全、价格、服务四类问题",
            "答案与白皮书口径一致",
          ],
          fileHints: ["FAQ", "常见问题", "问答"],
        },
      ],
    },
    {
      code: "S3",
      label: "方案与报价",
      question: "怎么落地、多少钱、凭什么信你",
      items: [
        {
          name: "解决方案",
          required: true,
          audience: "external",
          guide:
            "标准方案模板，拿到客户需求后在它基础上改。不要每个项目从零写。",
          checkpoints: [
            "方案架构与部署拓扑",
            "与客户现有系统的对接方式",
            "实施计划与里程碑",
            "售后服务内容",
          ],
          fileHints: ["方案", "解决方案", "solution"],
        },
        {
          name: "功能清单与技术指标",
          aliases: ["标准指标", "功能清单", "技术指标"],
          required: true,
          audience: "external",
          guide:
            "逐项列功能与指标，是投标参数与合同附件的来源。已交付和规划中的必须分开写。",
          checkpoints: [
            "功能逐项列出",
            "性能与容量指标",
            "已交付与规划中分开标注（规划项不进合同）",
          ],
          fileHints: ["功能清单", "指标", "参数", "规格"],
        },
        {
          name: "报价单（对外版）",
          aliases: ["标准报价单模板", "报价单"],
          required: true,
          audience: "external",
          guide: "能直接发给客户的版本。不含底价、渠道价。",
          checkpoints: [
            "版本 / 套餐划分",
            "计价方式与单价",
            "包含与不包含的服务",
            "报价有效期",
          ],
          fileHints: ["报价", "价格", "quote", "对外"],
        },
        {
          name: "成功案例",
          required: true,
          audience: "external",
          guide:
            "至少 1 个可以公开讲的案例。招投标和说服客户时最常被要到的材料。",
          checkpoints: [
            "客户行业与规模（可脱敏）",
            "客户原来的问题",
            "我们的方案",
            "上线后的可量化结果",
          ],
          fileHints: ["案例", "case", "客户故事"],
        },
        {
          name: "资质与合规材料",
          required: false,
          audience: "external",
          guide: "政企与招投标会要。普通商业客户可以缓。",
          checkpoints: [
            "软件著作权",
            "相关认证 / 等保 / 安全测评",
            "信创适配证明（如有）",
          ],
          fileHints: ["资质", "证书", "软著", "等保", "认证"],
        },
      ],
    },
    {
      code: "S4",
      label: "验证与交付",
      question: "先让我试一下，买了之后怎么用",
      items: [
        {
          name: "POC测试方案",
          aliases: ["POC方案"],
          required: true,
          audience: "external",
          guide:
            "客户要试用时用它锁定范围和验收标准。没有它，POC 很容易变成没有终点的免费实施。",
          checkpoints: [
            "测试范围与用例",
            "验收标准（通过 / 不通过怎么判）",
            "所需资源与环境",
            "周期与双方责任",
          ],
          fileHints: ["POC", "测试方案", "试点", "验证"],
        },
        {
          name: "部署与使用手册",
          aliases: ["部署使用手册"],
          required: false,
          audience: "external",
          guide: "成交或 POC 时交给客户的操作文档。",
          checkpoints: [
            "部署步骤与环境要求",
            "主要功能的操作说明",
            "常见故障处理",
          ],
          fileHints: ["手册", "部署", "使用说明", "manual"],
        },
      ],
    },
    {
      code: "S5",
      label: "内部支撑（对内）",
      question: "销售该怎么讲、讲到哪为止",
      items: [
        {
          name: "价格底线与折扣政策",
          aliases: ["价格与折扣政策"],
          required: true,
          audience: "internal",
          guide: "只给销售与商务看。决定谈判时能让多少。",
          checkpoints: ["成交底价", "渠道价", "折扣审批规则"],
          fileHints: ["底价", "折扣", "价格政策", "对内"],
        },
        {
          name: "对外口径与禁区",
          aliases: ["口径与措辞规范", "对外口径"],
          required: true,
          audience: "internal",
          guide:
            "哪些能力不能承诺、哪些词不能用。所有对外材料与销售现场讲法都以它为准。",
          checkpoints: ["不可承诺的能力清单", "禁用表述", "与白皮书口径一致"],
          fileHints: ["口径", "措辞", "禁区", "传播"],
        },
        {
          name: "销售话术与竞品对比",
          aliases: ["销售话术", "竞品对比"],
          required: false,
          audience: "internal",
          guide: "典型异议怎么答、和主要竞品比赢在哪。",
          checkpoints: ["典型客户异议与应答", "主要竞品差异点"],
          fileHints: ["话术", "竞品", "battlecard", "对比"],
        },
      ],
    },
  ],
};

export const COMPANY_PRESALES_TEMPLATE: BuiltinPresalesTemplate = {
  key: "company",
  name: "公司级材料",
  description:
    "不隶属单一产品、所有产品线共用的材料：公司是谁、整体能力、统一的价格与口径规则。",
  stages: [
    {
      code: "S1",
      label: "认知与初访",
      question: "你们是一家什么公司",
      items: [
        {
          name: "公司简介",
          required: true,
          audience: "external",
          guide: "一页纸，邮件附件与投标文件都会用到。",
          checkpoints: ["公司定位一句话", "核心团队与背景", "主要客户与成绩"],
          fileHints: ["公司简介", "简介", "about"],
        },
        {
          name: "公司整体PPT",
          aliases: ["公司介绍"],
          required: true,
          audience: "external",
          guide: "讲公司整体能力与全部产品线，见高层时用。",
          checkpoints: ["公司愿景与定位", "产品线全景", "代表客户"],
          fileHints: ["公司", "整体", "PPT"],
        },
      ],
    },
    {
      code: "S3",
      label: "方案与报价",
      question: "整体能给我什么",
      items: [
        {
          name: "整体解决方案",
          required: false,
          audience: "external",
          guide: "多条产品线组合打包时用。各产品材料齐了再编。",
          checkpoints: ["产品组合与场景对应", "整体架构"],
          fileHints: ["整体方案", "解决方案"],
        },
        {
          name: "资质与合规材料",
          required: true,
          audience: "external",
          guide: "公司层面的资质，所有投标通用。",
          checkpoints: ["营业执照与公司资质", "认证与荣誉"],
          fileHints: ["资质", "证书", "营业执照"],
        },
      ],
    },
    {
      code: "S5",
      label: "内部支撑（对内）",
      question: "所有产品线共用的规则",
      items: [
        {
          name: "报价与销售执行手册",
          required: true,
          audience: "internal",
          guide: "统一的报价规则、审批流程与合同规范。",
          checkpoints: ["报价规则", "审批流程", "合同条款底线"],
          fileHints: ["报价", "销售执行", "手册"],
        },
        {
          name: "品牌与对外口径规范",
          aliases: ["产品定位与传播口径交底书"],
          required: true,
          audience: "internal",
          guide: "公司名称、产品命名、禁用表述的统一规范。",
          checkpoints: ["公司与产品的标准名称", "禁用表述"],
          fileHints: ["口径", "品牌", "传播", "交底"],
        },
      ],
    },
  ],
};

export const BUILTIN_PRESALES_TEMPLATES: readonly BuiltinPresalesTemplate[] = [
  PRODUCT_PRESALES_TEMPLATE,
  COMPANY_PRESALES_TEMPLATE,
];
