import type { Keyword } from "../keywords.js";

/**
 * 中文业务词 → 表名里常见的英文写法。只给「数据结构」挑表用。
 *
 * 为什么需要：表名几乎全是英文（user_subscriptions），中文只出现在部分表的注释里。
 * 产品经理说「订阅续费」，不翻一下就一张表也挑不中——真实仓库上实测过。
 * 定位器另有可选的模型扩写（expand.ts），但它要配模型、有 8 秒延迟、还可能失败；
 * 表名用词高度集中，一张固定词表就能覆盖大部分，而且结果可复查。
 *
 * 只收**业务名词**，不收「配置」「记录」「信息」这类到处都有的词——它们会把
 * 半个库都挑进来。
 */
const GLOSSARY: Record<string, readonly string[]> = {
  订阅: ["subscription"],
  套餐: ["plan"],
  续费: ["renew"],
  订单: ["order"],
  支付: ["payment"],
  付款: ["payment"],
  退款: ["refund"],
  充值: ["topup", "recharge"],
  余额: ["balance"],
  发票: ["invoice"],
  优惠: ["promo", "coupon", "discount"],
  折扣: ["discount"],
  兑换: ["redeem"],
  激活码: ["activation"],
  价格: ["price", "pricing"],
  定价: ["pricing", "price"],
  计费: ["billing", "usage"],
  账单: ["billing", "bill"],
  用量: ["usage"],
  额度: ["quota", "limit"],
  配额: ["quota"],
  限流: ["rate_limit", "concurrency"],
  并发: ["concurrency"],
  用户: ["user"],
  账号: ["account", "user"],
  子账号: ["sub_user", "subuser", "sub-user"],
  子用户: ["sub_user", "subuser", "sub-user"],
  席位: ["seat"],
  团队: ["team", "org"],
  租户: ["tenant"],
  组织: ["org", "tenant"],
  企业: ["org", "tenant"],
  部门: ["department", "dept"],
  成员: ["member"],
  角色: ["role"],
  权限: ["permission", "grant", "role"],
  登录: ["auth", "login", "session"],
  注册: ["register", "signup", "user"],
  认证: ["auth", "identity"],
  身份: ["identity"],
  密钥: ["api_key", "key", "secret"],
  令牌: ["token", "api_key"],
  分组: ["group"],
  渠道: ["channel"],
  上游: ["upstream", "channel", "account"],
  模型: ["model"],
  路由: ["route"],
  代理: ["proxy"],
  公告: ["announcement"],
  协议: ["agreement"],
  审批: ["approval"],
  飞书: ["feishu"],
  告警: ["alert"],
  监控: ["monitor"],
  通知: ["notification"],
  日志: ["log"],
  审计: ["audit"],
  租约: ["lease"],
  机器: ["machine"],
  主机: ["machine", "host"],
  资产: ["asset"],
  安全: ["security"],
  检测: ["detector", "detection"],
  策略: ["policy", "rule"],
  规则: ["rule"],
  任务: ["job", "task"],
  推广: ["affiliate", "kol"],
  返佣: ["affiliate", "kol"],
  邀请: ["invitation", "invite"],
  短信: ["sms"],
  手机: ["phone"],
};

/** 按词表把中文关键词扩成英文检索词（权重 2：等同本地整段词）。 */
export function expandForTables(keywords: readonly Keyword[]): Keyword[] {
  const out = new Map<string, Keyword>();
  for (const k of keywords) out.set(k.term, k);
  for (const k of keywords) {
    for (const [zh, en] of Object.entries(GLOSSARY)) {
      if (!k.term.includes(zh)) continue;
      for (const term of en) {
        const prev = out.get(term);
        if (prev === undefined || prev.weight < 2)
          out.set(term, { term, weight: 2 });
      }
    }
  }
  return [...out.values()];
}
