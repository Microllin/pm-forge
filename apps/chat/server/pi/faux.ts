import { fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai";

import {
  emptyRuntime,
  type ModelSetup,
  type PiModel,
  type PiPaths,
} from "./runtime.js";

/**
 * 脚本化的假模型（pi-ai 自带的 faux provider）装进真实的 pi 运行时。
 *
 * 用途有二：测试里驱动**真实的 pi**（而不是 mock pi），以及 pi 升级后的自检
 * （pi/selfcheck.ts）——自检必须离线、确定、不花钱，faux 三样都满足。
 *
 * 带两个模型：切换模型（pi 的 /model）也要能在测试和自检里走真实路径。
 */
export interface FauxSetup extends ModelSetup {
  faux: FauxProviderHandle;
  /** 默认用的那个。 */
  model: PiModel;
  /** 用来测切换的第二个。 */
  alt: PiModel;
}

export const FAUX_PROVIDER = "faux";
export const FAUX_MODEL = "faux-chat";
export const FAUX_ALT_MODEL = "faux-alt";

export async function createFauxSetup(
  paths: PiPaths,
  options: { tokensPerSecond?: number } = {},
): Promise<FauxSetup> {
  const runtime = await emptyRuntime(paths);
  const faux = fauxProvider({
    provider: FAUX_PROVIDER,
    models: [
      { id: FAUX_MODEL, reasoning: true },
      { id: FAUX_ALT_MODEL, reasoning: true },
    ],
    ...(options.tokensPerSecond === undefined
      ? {}
      : { tokensPerSecond: options.tokensPerSecond }),
  });
  runtime.registerNativeProvider(faux.provider);
  const model = runtime.getModel(FAUX_PROVIDER, FAUX_MODEL);
  const alt = runtime.getModel(FAUX_PROVIDER, FAUX_ALT_MODEL);
  if (!model || !alt) throw new Error("faux 模型注册失败");
  return {
    runtime,
    available: [model, alt],
    inherited: new Map(),
    faux,
    model,
    alt,
  };
}
