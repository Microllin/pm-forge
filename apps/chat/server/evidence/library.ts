import type { Catalog, Product } from "../products.js";

/**
 * 事实依据库：一个产品的**全部**依据，粒度到文件夹。
 *
 * 平台规范：AI 不管产出什么，取依据都先经过这里——
 * 依据库给出「有哪些」，定位器（locate.ts）再挑「这次用哪几个」。
 *
 * 来源是产品上已经绑好的三样东西（见 apps/chat/server/products.ts）：
 * - `folderPath` —— 绑定的**文档**目录（事实底座 → 文件库）；
 * - `codePath`   —— 绑定的**代码**目录（事实底座 → 代码库）；
 * - `refPaths`   —— 参考资料，目录或单个文件。
 *
 * 刻意**不把整个文件库当依据**：那等于回到「丢一个大目录让它自己翻」。依据库的
 * 价值就在「产品自己声明了哪几处和它有关」。
 */

export type EvidenceKind = "doc" | "code";

export interface EvidenceSource {
  /** 去重键：文件库里的相对路径。 */
  key: string;
  kind: EvidenceKind;
  /** 文件库路径（以 / 开头）。 */
  path: string;
  /** 给人看的位置说明，如「文档目录」「参考资料」。 */
  label: string;
  /** 单个文件（参考资料可以直接指向一份文件）。 */
  isFile: boolean;
}

export interface EvidenceLibrary {
  product: Product | null;
  productName: string | null;
  sources: EvidenceSource[];
  /** 登记了但文件库里找不到的路径。要如实报出来，不能悄悄跳过。 */
  missing: string[];
}

export function resolveLibrary(
  catalog: Catalog,
  productId: string | null,
  exists: (path: string) => boolean,
): EvidenceLibrary {
  const product =
    productId === null
      ? undefined
      : catalog
          .list()
          .flatMap((line) => line.products)
          .find((p) => p.id === productId);
  if (product === undefined) {
    return { product: null, productName: null, sources: [], missing: [] };
  }

  const sources: EvidenceSource[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const push = (path: string, kind: EvidenceKind, label: string): void => {
    if (path === "" || seen.has(path)) return;
    seen.add(path);
    if (!exists(path)) {
      missing.push(path);
      return;
    }
    sources.push({ key: path, kind, path, label, isFile: looksLikeFile(path) });
  };

  if (product.folderPath !== null) push(product.folderPath, "doc", "文档目录");
  if (product.codePath !== null) push(product.codePath, "code", "代码目录");
  for (const ref of product.refPaths) push(ref, "doc", "参考资料");

  return {
    product,
    productName: product.name,
    sources,
    missing,
  };
}

/** 路径末段带扩展名就当单个文件。文件库路径一律是 `/` 分隔，不会误判 Windows 盘符。 */
function looksLikeFile(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1;
}
