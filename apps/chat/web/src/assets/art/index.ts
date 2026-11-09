/**
 * 品牌配图（由生图模型生成，已压成 WebP 两档尺寸）。
 *
 * 统一风格：近黑底（#0b0a11）+ 单一紫色线稿，和黑紫主题一致。白紫主题下它们仍是暗底——
 * 这与产品页的截图、代码块同理：深色画面放在白色面板里是一块有意的「画」，不是漏改。
 * 两档：480 与 960（@2x），按 240px 显示时高分屏取 @2x。
 */
import loginForge from "./login-forge.webp";
import emptyTasks from "./empty-tasks.webp";
import emptyTasks2x from "./empty-tasks@2x.webp";
import emptyStaging from "./empty-staging.webp";
import emptyStaging2x from "./empty-staging@2x.webp";
import emptyProducts from "./empty-products.webp";
import emptyProducts2x from "./empty-products@2x.webp";
import emptySkills from "./empty-skills.webp";
import emptySkills2x from "./empty-skills@2x.webp";

export const LOGIN_ART = loginForge;

export interface ArtPair {
  src: string;
  srcSet: string;
}

const pair = (one: string, two: string): ArtPair => ({
  src: one,
  srcSet: `${one} 1x, ${two} 2x`,
});

export const ART = {
  tasks: pair(emptyTasks, emptyTasks2x),
  staging: pair(emptyStaging, emptyStaging2x),
  products: pair(emptyProducts, emptyProducts2x),
  skills: pair(emptySkills, emptySkills2x),
} satisfies Record<string, ArtPair>;
