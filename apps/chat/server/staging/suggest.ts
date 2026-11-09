import type { Db } from "../db.js";
import { childOf } from "../files/paths.js";
import { safeSegment } from "../global-fill-prompts.js";
import { createCatalog, type Product } from "../products.js";
import { isStagingPath } from "./paths.js";

/** 按 id 找产品（含产品线里的全部）。找不到 = null。 */
export function findProduct(db: Db, productId: string | null): Product | null {
  if (productId === null) return null;
  return (
    createCatalog(db)
      .list()
      .flatMap((line) => line.products)
      .find((p) => p.id === productId) ?? null
  );
}

/**
 * 对话 / 智能体草稿的默认去处：产品绑定的文档目录 + 标题.md。
 *
 * 只是建议，确认时人可以改。没有产品、或产品没绑文档目录，就不给建议——
 * 不替人猜一个目录，猜错了等于把东西塞进别人的地方。
 */
export function suggestTarget(
  db: Db,
  productId: string | null,
  title: string,
): string | null {
  const folder = findProduct(db, productId)?.folderPath ?? null;
  if (folder === null || isStagingPath(folder)) return null;
  return childOf(folder, `${safeSegment(title)}.md`);
}
