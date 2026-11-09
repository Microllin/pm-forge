/** 把常见的接入层错误翻成「去哪修」。认不出返回 null（界面直接显示原文）。 */
export function errorHint(message: string): string | null {
  if (/\b401\b|invalid.*(api[_ ]?key|token)|unauthorized/i.test(message)) {
    return "API key 无效或已过期，去设置里重新填写";
  }
  if (/\b403\b|forbidden|permission/i.test(message))
    return "这把 key 没有调用该模型的权限";
  if (/\b404\b|model.*not.*(found|exist)/i.test(message))
    return "模型不存在，检查设置里的模型 id";
  if (/\b429\b|rate.?limit|quota/i.test(message))
    return "触发限流或额度用尽，稍后再试";
  if (
    /timed? ?out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|fetch failed/i.test(message)
  ) {
    return "连不上模型服务，检查接口地址与网络";
  }
  return null;
}
