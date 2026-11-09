import { importSkillTree, type SkillDetail } from "../api";
import { bytesToBase64 } from "./skill-file";
import { scanSkillFolders, type SkillFolderGroup } from "./skill-folder";
import type { UploadItem } from "../files/upload";

/**
 * 文件夹导入的编排：分组 → 逐个技能上传 → 逐个报成败。
 *
 * 一个技能一次请求（不是整批一次）：27 个技能里坏了 1 个，另外 26 个不该跟着回滚；
 * 坏的那个要能单独看到原因、单独重试。
 */

export interface ImportOutcome {
  /** 成功导入的技能。 */
  imported: SkillDetail[];
  /** 失败的：技能根（或名字）+ 原因。 */
  failed: { root: string; message: string }[];
  /** 一个 SKILL.md 都没找到时的原因（此时 imported / failed 都是空的）。 */
  problem: string | null;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : "导入失败";

async function uploadGroup(group: SkillFolderGroup): Promise<SkillDetail> {
  const files = await Promise.all(
    group.files.map(async (f) => ({
      path: f.path,
      base64: bytesToBase64(new Uint8Array(await f.file.arrayBuffer())),
    })),
  );
  return importSkillTree(files);
}

/** onProgress(已处理, 总数)——批量导入 27 个技能时，没有进度等于界面假死。 */
export async function importSkillFolders(
  items: readonly UploadItem[],
  onProgress: (done: number, total: number) => void,
): Promise<ImportOutcome> {
  const scan = scanSkillFolders(items);
  if (scan.problem !== null) {
    return { imported: [], failed: [], problem: scan.problem };
  }
  const imported: SkillDetail[] = [];
  const failed: ImportOutcome["failed"] = [];
  let done = 0;
  onProgress(done, scan.groups.length);
  for (const group of scan.groups) {
    try {
      imported.push(await uploadGroup(group));
    } catch (cause) {
      failed.push({
        root: group.root === "" ? "（所选目录）" : group.root,
        message: messageOf(cause),
      });
    }
    done += 1;
    onProgress(done, scan.groups.length);
  }
  return { imported, failed, problem: null };
}

/** 导入结果的一句话。失败清单太长只列前几个。 */
export function describeImport(outcome: ImportOutcome): {
  ok: boolean;
  text: string;
} {
  if (outcome.problem !== null) return { ok: false, text: outcome.problem };
  const parts: string[] = [];
  if (outcome.imported.length > 0) {
    parts.push(
      `已导入 ${String(outcome.imported.length)} 个技能：${outcome.imported
        .map((s) => s.name)
        .slice(0, 5)
        .join("、")}${outcome.imported.length > 5 ? " 等" : ""}`,
    );
  }
  if (outcome.failed.length > 0) {
    const shown = outcome.failed
      .slice(0, 3)
      .map((f) => `${f.root}（${f.message}）`);
    parts.push(
      `失败 ${String(outcome.failed.length)} 个：${shown.join("、")}${
        outcome.failed.length > 3 ? " 等" : ""
      }`,
    );
  }
  if (parts.length === 0) parts.push("没有可导入的技能");
  return {
    ok: outcome.failed.length === 0 && outcome.imported.length > 0,
    text: parts.join("；"),
  };
}
