import type { Catalog } from "../products.js";
import type { FileStore } from "../files/store.js";
import { createAtlas, type Atlas } from "./atlas.js";
import { createSchemaIndex, type SchemaIndex } from "./schema/index.js";
import { createUiIndex, type UiIndex } from "./ui/index.js";
import { renderEvidenceBrief } from "./brief.js";
import { resolveLibrary, type EvidenceLibrary } from "./library.js";
import {
  createLocator,
  type KeywordExpander,
  type LocateRequest,
  type LocateResult,
} from "./locate.js";
import { EVIDENCE_OPEN } from "./brief.js";

/**
 * 事实依据服务——平台基础组件的唯一入口。
 *
 * ## 平台规范（所有 AI 功能必须遵循）
 *
 * AI 不管写 PRD、写文档、做分析还是写 wiki，取事实依据都经过这里：
 * - **依据库**（library）：产品上绑定的文档目录 / 代码目录 / 参考资料；
 * - **定位器**（locate）：按这次任务从依据库里挑出该读的文件，**连正文一起**，
 *   自动交给 AI；
 * - **对话里可手选范围**：整个依据库，或其中几个目录。
 *
 * 接入方式只有一种：会话带上所属产品（`productId`）。接入点在 pi/runner.ts，
 * 每轮发消息前调用 `brief`，结果放在消息最前面。**新功能不要自己拼依据路径**，
 * 也不要把「让 AI 自己去读文件」当成方案——这个服务没有文件工具。
 */

export interface EvidenceContext {
  productId: string | null;
  /** 使用者手选的依据范围（文件库路径）；空 = 整个依据库。 */
  scope?: readonly string[] | undefined;
}

/** 每个活会话一份：记住已经给过的文件，续聊时只补新的。 */
export interface BriefState {
  first: boolean;
  given: Set<string>;
}

export interface EvidenceService {
  library(ctx: EvidenceContext): EvidenceLibrary;
  locate(
    ctx: EvidenceContext,
    task: string,
    options?: Pick<LocateRequest, "limits" | "budget" | "exclude">,
  ): Promise<LocateResult>;
  /** 一条消息的依据段；null 表示这条不注入。会更新 state。 */
  brief(
    ctx: EvidenceContext,
    message: string,
    state: BriefState,
  ): Promise<string | null>;
  atlas: Atlas;
  /** 数据结构索引：给「产品 → 数据结构」页面画图用，与交给 AI 的是同一份解析结果。 */
  schema: SchemaIndex;
  /** 页面清单索引：给「产品 → 页面」用，与交给 AI 的是同一份解析结果。 */
  ui: UiIndex;
}

/** 续聊里「继续」「好的」这种短句不值得再定位一次。 */
const MIN_FOLLOWUP_CHARS = 8;

export function createEvidenceService(deps: {
  files: FileStore;
  catalog: Catalog;
  expand?: KeywordExpander | undefined;
  atlas?: Atlas;
  schema?: SchemaIndex;
  ui?: UiIndex;
  now?: () => number;
}): EvidenceService {
  const atlas = deps.atlas ?? createAtlas(deps.files);
  const schema = deps.schema ?? createSchemaIndex(deps.files);
  const ui = deps.ui ?? createUiIndex(deps.files);
  const locate = createLocator({
    files: deps.files,
    atlas,
    schema,
    ui,
    ...(deps.expand === undefined ? {} : { expand: deps.expand }),
  });

  const libraryOf = (ctx: EvidenceContext): EvidenceLibrary => {
    const lib = resolveLibrary(deps.catalog, ctx.productId, (path) =>
      deps.files.exists(path),
    );
    const scope = ctx.scope ?? [];
    if (scope.length === 0) return lib;
    // 手选范围只能**缩小**：只保留落在所选目录里的依据，库外的路径一律不认。
    return {
      ...lib,
      sources: lib.sources.filter((s) =>
        scope.some(
          (p) =>
            s.path === p ||
            s.path.startsWith(`${p}/`) ||
            p.startsWith(`${s.path}/`),
        ),
      ),
    };
  };

  return {
    atlas,
    schema,
    ui,
    library: libraryOf,
    async locate(ctx, task, options) {
      return locate({ library: libraryOf(ctx), task, ...options });
    },
    async brief(ctx, message, state) {
      /*
       * 消息已经自带依据段：是入口按任务精选过的（例如售前审阅按「代码 > PRD > 其他」
       * 分层取的依据，见 evidence/tiers.ts）。再按整条消息定位一遍只会塞进一份
       * 不分层的重复依据，把上下文撑爆。记下给过哪些文件，续聊时不重复给。
       */
      if (message.startsWith(EVIDENCE_OPEN)) {
        state.first = false;
        for (const m of message.matchAll(/<事实来源 路径="([^"]+)"/g)) {
          if (m[1] !== undefined) state.given.add(m[1]);
        }
        return null;
      }
      if (!state.first && message.trim().length < MIN_FOLLOWUP_CHARS) {
        return null;
      }
      const library = libraryOf(ctx);
      if (library.productName === null) return null;
      const result = await locate({
        library,
        task: message,
        exclude: state.given,
      });
      const text = renderEvidenceBrief(result, {
        first: state.first,
        task: message,
      });
      state.first = false;
      for (const f of result.files) {
        // 数据结构摘要按表记：同一个子系统下次命中别的表还要能给。
        if (f.covers === undefined) state.given.add(f.path);
        else for (const k of f.covers) state.given.add(k);
      }
      return text;
    },
  };
}

export type { EvidenceLibrary, EvidenceSource } from "./library.js";
export type { LocateHit, LocateResult, LocatedFile } from "./locate.js";
export { splitEvidence, EVIDENCE_OPEN, EVIDENCE_CLOSE } from "./brief.js";
export { createModelExpander } from "./expand.js";
