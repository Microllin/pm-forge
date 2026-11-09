import { CODE_ROOT, isWithin } from "../files/paths.js";

/**
 * 临时区：AI 的产出一律先落这里，人确认后才进正式位置。
 *
 * 一个根、按来源分子目录。子目录是给人看的分类，不是权限边界——
 * 权限边界只有一条：**临时区不是事实依据**（见 evidence/atlas.ts 的 inNoiseDir）。
 */
export const STAGING_ROOT = "/临时区";

export const STAGING_DIRS = {
  chat: `${STAGING_ROOT}/对话`,
  agent: `${STAGING_ROOT}/智能体`,
  fill: `${STAGING_ROOT}/AI补齐`,
  presales: `${STAGING_ROOT}/售前`,
} as const;

export const isStagingPath = (path: string): boolean =>
  isWithin(path, STAGING_ROOT);

/**
 * 确认时能不能写到这里。挡两处：
 * - 临时区自己：「确认」写回临时区等于没确认；
 * - 代码库：PRD 写进别人共用的代码仓，那是事实源，不是产出物的去处。
 * 返回 null = 可以；否则是给人看的原因。
 */
export function targetProblem(path: string): string | null {
  if (path === "/" || path.endsWith("/")) return "要写到一个具体的文件";
  if (isStagingPath(path)) return "不能写回临时区";
  if (isWithin(path, CODE_ROOT)) return `不能写进代码库（${CODE_ROOT}）`;
  return null;
}
