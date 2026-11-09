import type { UploadItem } from "../files/upload";

/**
 * 把「浏览器交上来的一堆文件」分成若干个技能目录。
 *
 * 分组规则照抄 pi 的技能发现（docs/skills.md）：**含 SKILL.md 的目录就是一个技能根，
 * 不再往下递归**。于是「一次一个」和「一次一批」不需要两套交互——
 * 选中的目录自己带 SKILL.md 就是一个技能，否则就在子目录里找，找到几个算几个。
 *
 * 之所以在前端分组、服务端只收「一个技能」：这样每个技能一次请求，能逐个报成败、
 * 能单独重试（27 个技能里坏了 1 个，不该让另外 26 个一起回滚）。
 * 服务端仍然校验每份请求必须恰好带一个顶层 SKILL.md，不信前端分得对。
 */

export interface SkillFolderGroup {
  /** 技能根在所选文件夹里的相对路径（顶层技能为 ""）。只用于报错时指位置。 */
  root: string;
  /** 这个技能的文件，path 已改成相对技能根。 */
  files: { path: string; file: File }[];
}

export interface SkillFolderScan {
  groups: SkillFolderGroup[];
  /** 选中的目录自己就是一个技能（顶层有 SKILL.md）。 */
  single: boolean;
  /** 一个 SKILL.md 都没找到时，给人看的原因。 */
  problem: string | null;
}

/** 顶层目录名：webkitRelativePath 的第一段是所选文件夹本身，分组时要剥掉。 */
function stripChosenRoot(items: readonly UploadItem[]): string[] {
  const paths = items.map((i) => i.relPath.split("\\").join("/"));
  const firsts = new Set(
    paths.map((p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : "")),
  );
  // 只有「所有文件都在同一个顶层目录下」时才剥：拖放多个文件夹时不能剥。
  if (firsts.size !== 1) return paths;
  const only = [...firsts][0];
  if (only === undefined || only === "") return paths;
  return paths.map((p) => p.slice(only.length + 1));
}

const isHidden = (path: string): boolean =>
  path.split("/").some((part) => part.startsWith("."));

export function scanSkillFolders(
  items: readonly UploadItem[],
): SkillFolderScan {
  const stripped = stripChosenRoot(items);
  const files = items
    .map((item, i) => ({ file: item.file, path: stripped[i] ?? item.relPath }))
    .filter((f) => f.path !== "" && !isHidden(f.path));

  // 技能根 = 含 SKILL.md 的目录。按路径深度从浅到深，浅的先占——
  // 嵌套的 SKILL.md 归上层技能的附属文件（pi 也是这么认的）。
  const roots = files
    .filter((f) => f.path === "SKILL.md" || f.path.endsWith("/SKILL.md"))
    .map((f) =>
      f.path === "SKILL.md" ? "" : f.path.slice(0, -"/SKILL.md".length),
    )
    .sort(
      (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
    );

  if (roots.length === 0) {
    return {
      groups: [],
      single: false,
      problem:
        "这个文件夹里没有 SKILL.md。技能的可移植形态是「一个目录 + SKILL.md」，请选技能自己的目录，或装着若干技能目录的那一层。",
    };
  }

  const taken: string[] = [];
  const groups: SkillFolderGroup[] = [];
  // 空串是「所选目录本身」，它是任何路径的祖先——单独判，否则
  // `startsWith("/")` 永远为假，嵌套的 SKILL.md 会被误当成第二个技能。
  const covered = (root: string, by: string): boolean =>
    by === "" || root === by || root.startsWith(`${by}/`);
  for (const root of roots) {
    // 已被更浅的技能根收走的，不再单独成组。
    if (taken.some((t) => covered(root, t))) continue;
    taken.push(root);
    const prefix = root === "" ? "" : `${root}/`;
    groups.push({
      root,
      files: files
        .filter((f) => f.path.startsWith(prefix))
        .map((f) => ({ path: f.path.slice(prefix.length), file: f.file })),
    });
  }
  return { groups, single: roots[0] === "", problem: null };
}
