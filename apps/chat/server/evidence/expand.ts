/**
 * 关键词扩写：一次性调模型，把任务改写成检索词（中英同义、业务词 ↔ 代码词）。
 *
 * 这一步解决的是「用户说退款、代码里叫 refund」——本地关键词抽取跨不过语言。
 * 它是可选增强：没配模型、超时、返回不合格，一律返回空数组，定位器照样能用
 * 本地关键词跑完，只是跨语言命中差一些。**绝不让它把对话卡住或打断**。
 */

export type OneShot = (prompt: string, system: string) => Promise<string>;

const SYSTEM =
  "你是检索词生成器。只输出一个 JSON 字符串数组，不要任何解释或代码块标记。";

/** 从模型回复里尽量捞出字符串数组；捞不出返回空。 */
export function parseTerms(reply: string): string[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  try {
    const arr: unknown = JSON.parse(reply.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((x): x is string => typeof x === "string")
      .map((s) => s.trim())
      .filter((s) => s.length >= 2 && s.length <= 40)
      .slice(0, 20);
  } catch {
    return [];
  }
}

export function createModelExpander(
  oneShot: () => OneShot | undefined,
  timeoutMs = 8000,
) {
  return async (input: {
    task: string;
    productName: string | null;
    local: string[];
  }): Promise<string[]> => {
    const call = oneShot();
    if (call === undefined) return [];
    const prompt = [
      "下面是一个产品经理交给 AI 的任务。请给出用于在该产品的文档与代码里定位相关文件的检索词，8~16 个：",
      "- 同时给中文业务词和代码里可能的英文写法（如 退款 → refund、Refund）；",
      "- 只要具体的业务名词 / 模块名 / 功能名，不要「方法论」「PRD」「分析」这类通用词；",
      "- 每个词 2~20 个字符。",
      input.productName === null ? "" : `所属产品：${input.productName}`,
      `本地已抽到：${input.local.join("、")}`,
      "任务：",
      input.task,
    ]
      .filter(Boolean)
      .join("\n");

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<string>((resolve) => {
      timer = setTimeout(() => {
        resolve("");
      }, timeoutMs);
    });
    try {
      const reply = await Promise.race([call(prompt, SYSTEM), timeout]);
      return parseTerms(reply);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  };
}
