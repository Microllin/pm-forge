import { randomUUID } from "node:crypto";

import type { UIMessageChunk } from "ai";

import { badRequest, conflict, notFound } from "../errors.js";
import type { ModelRef, ThinkingLevel } from "../model-config.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { SessionRow, SessionStore } from "../sessions.js";
import {
  findModel,
  openAgentSession,
  transcriptSelection,
  type ModelSetup,
  type OpenedSession,
  type PiModel,
  type PiPaths,
} from "./runtime.js";
import { expandSkillCommand } from "./skills.js";
import {
  createStreamTranslator,
  errorChunk,
  type StreamTranslator,
} from "./stream.js";

/**
 * 对话运行器：持有活着的 pi 会话，把每一轮翻译成 UI Message Stream 广播出去。
 *
 * 三条原则：
 * - **连接与运行解耦**：浏览器断开只摘掉那一路监听，agent 照跑、条目照落库；
 *   停止只走 abort()。否则刷新页面就等于点了停止。
 * - **每轮一个内存缓冲**：断线续流时先重放本轮已发出的 chunk，再接实时。
 * - **「是否在跑」只信这里**：库里没有运行状态，重启后自然归零。
 */

export interface ModelProvision {
  /** 配置指纹。变了说明 provider / key 换了，活着的会话要在空闲时重开。 */
  key: string;
  setup: ModelSetup;
  /** 新会话的起点。会话切过模型后以它自己 transcript 里的为准。 */
  defaultModel: PiModel | undefined;
  defaultThinking: ThinkingLevel;
}

/** 一个会话当前的模型状态（输入框上的模型按钮显示的就是它）。 */
export interface SessionModelState {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  /** 这个模型支持的思考强度（pi 按模型能力给出）。 */
  thinkingLevels: ThinkingLevel[];
}

export interface RunnerDeps {
  store: SessionStore;
  paths: PiPaths;
  /** 按当前配置提供模型；未配置时抛出（带给人看的原因）。 */
  provision: () => Promise<ModelProvision>;
  systemPrompt?: string;
  /**
   * 按会话定制身份与工具（如售前库的专属助手）。返回 undefined = 普通对话。
   * 开会话时取一次；会话活着期间不变（改了身份要等它被回收重开）。
   */
  profile?: (session: SessionRow) => SessionProfile | undefined;
  /** 每轮对话开始时调一次（只读浏览工具用它把「本轮看了几页」清零）。 */
  onTurn?: (sessionId: string) => void;
  /**
   * 事实依据（平台规范，见 server/evidence/index.ts）。
   *
   * 放在运行器而不是各个入口：所有 AI 功能最后都经过 chat()，接在这里一处覆盖
   * 全部，包括以后新加的功能——它们不需要知道这件事也会遵循。
   */
  evidence?: EvidenceDeps;
}

/** 一条会话的专属身份：整段系统提示词 + 额外工具。 */
export interface SessionProfile {
  systemPrompt?: string;
  tools?: readonly ToolDefinition[];
  /** 每轮现场追加的系统提示词段（见 OpenSessionOptions.promptExtra）。 */
  promptExtra?: () => string;
}

/** 运行器只需要这两件事，不认识依据库怎么算。 */
export interface EvidenceDeps {
  brief(
    session: {
      productId: string | null;
      evidenceScope: string[];
      task: SessionRow["task"];
    },
    message: string,
    state: { first: boolean; given: Set<string> },
  ): Promise<string | null>;
}

interface Run {
  /** 触发这一轮的原话。轮中途刷新时补回界面（pi 轮末才落库它）。 */
  prompt: string;
  /** 开轮时库里已有的条目数。之后的条目属于这一轮，续流会重放它们。 */
  startEntries: number;
  translator: StreamTranslator;
  chunks: UIMessageChunk[];
  listeners: Set<(chunk: UIMessageChunk) => void>;
  done: boolean;
  finished: Promise<void>;
  finish: () => void;
}

interface Live {
  opened: OpenedSession;
  provisionKey: string;
  /**
   * 依据段状态：首轮判定与「已经给过哪些文件」。
   *
   * 首轮看库里有没有消息而不是内存：服务重启后重开的会话不是第一轮，再发一遍
   * 完整规则只会让上下文越来越长。
   */
  evidence: { first: boolean; given: Set<string> };
  /** 把 SessionManager 的新条目落库。切模型这类不经过 message_end 的变化要手动调。 */
  persist: () => void;
  unsubscribe: () => void;
  lastUsed: number;
  run?: Run | undefined;
}

/** 同时活着的会话上限。回收只释放运行时，历史在库里，下次发消息会原样恢复。 */
const MAX_LIVE = 8;
/** 单轮缓冲上限。超过只影响「这一轮断线后能否续流」，不影响转发与落库。 */
const MAX_RUN_CHUNKS = 50_000;

export const DEFAULT_TITLE = "新对话";

export interface ChatParams {
  sessionId: string;
  message: string;
  onChunk: (chunk: UIMessageChunk) => void;
  /** 只表示「这一路连接还听不听」。 */
  signal: AbortSignal;
}

export interface Runner {
  chat(params: ChatParams): Promise<void>;
  /** 接上正在跑的一轮：先重放再跟实时。没有在跑返回 false（协议要求回 204）。 */
  resume(
    sessionId: string,
    onChunk: (chunk: UIMessageChunk) => void,
    signal: AbortSignal,
  ): Promise<boolean>;
  /** 流式中把一句话排到当前轮后面（pi followUp）。不在跑时 queued=false，调用方改走 chat。 */
  queue(
    sessionId: string,
    message: string,
  ): Promise<{ queued: boolean; pending: number }>;
  abort(sessionId: string): void;
  activeRun(
    sessionId: string,
  ): { prompt: string; startEntries: number } | undefined;
  /** 是否有任意一轮在跑。升级 pi 前要确认为 false。 */
  busy(): boolean;
  /** 会话当前的模型与思考强度。 */
  sessionModel(sessionId: string): Promise<SessionModelState>;
  /** 切换模型（pi 的 /model）。写进 transcript，恢复会话时按它来。 */
  setModel(sessionId: string, ref: ModelRef): Promise<SessionModelState>;
  /** 切换思考强度（pi 的 Shift+Tab）。pi 会按模型能力收敛到支持的档位。 */
  setThinking(
    sessionId: string,
    level: ThinkingLevel,
  ): Promise<SessionModelState>;
  dispose(sessionId: string): void;
  disposeAll(): void;
}

function modelState(opened: OpenedSession): SessionModelState {
  const { session } = opened;
  const model = session.model;
  if (!model) throw badRequest("会话没有可用的模型");
  return {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: session.getAvailableThinkingLevels(),
  };
}

export function createRunner(deps: RunnerDeps): Runner {
  const live = new Map<string, Live>();

  const disposeOne = (sessionId: string): void => {
    const entry = live.get(sessionId);
    if (!entry) return;
    /*
     * 先把未结束的那一轮收尾，再摘 entry。
     *
     * 不收尾的话 `run.finished` 这个 Promise 永远没人兑现：`chat()` 卡在
     * `await run.finished` 上不返回，`app.ts` 的 `finally { stream.end() }` 也执行不到——
     * 表现是删掉一条正在回答的会话后，那次请求永远不结束、前端一直停在「生成中」，
     * 连接和这一轮最多 5 万条 chunk 全挂在内存里。
     */
    const running = entry.run;
    if (running !== undefined && !running.done) finishRun(entry, running);
    live.delete(sessionId);
    entry.unsubscribe();
    entry.opened.dispose();
  };

  const evict = (): void => {
    while (live.size >= MAX_LIVE) {
      const idle = [...live.entries()]
        .filter(([, l]) => !l.run || l.run.done)
        .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) return; // 全在跑：宁可超上限，也不能掐掉进行中的对话。
      disposeOne(idle[0]);
    }
  };

  const broadcast = (run: Run, chunk: UIMessageChunk): void => {
    if (run.chunks.length < MAX_RUN_CHUNKS) run.chunks.push(chunk);
    for (const listener of run.listeners) listener(chunk);
  };

  const finishRun = (entry: Live, run: Run): void => {
    run.done = true;
    run.listeners.clear();
    if (entry.run === run) entry.run = undefined;
    run.finish();
  };

  const open = async (sessionId: string): Promise<Live> => {
    const provision = await deps.provision();
    const existing = live.get(sessionId);
    if (existing) {
      const running = existing.run !== undefined && !existing.run.done;
      // 配置换了且空闲：重开，下一轮用新模型。在跑就先用着，不打断。
      if (existing.provisionKey === provision.key || running) {
        existing.lastUsed = Date.now();
        return existing;
      }
      disposeOne(sessionId);
    }
    evict();
    const header = deps.store.header(sessionId);
    const entries = deps.store.entries(sessionId);
    // 会话自己 transcript 里的选择优先；那个模型已不可用（provider 被移除等）
    // 才退回默认模型。
    const selection = transcriptSelection(deps.paths, header, entries);
    const recorded = findModel(provision.setup, selection.model);
    const model =
      recorded ?? provision.defaultModel ?? provision.setup.available[0];
    if (!model) throw badRequest("还没有可用的模型，去设置里接入一个 provider");
    const row = deps.store.get(sessionId);
    const profile = row === undefined ? undefined : deps.profile?.(row);
    const systemPrompt = profile?.systemPrompt ?? deps.systemPrompt;
    const opened = await openAgentSession({
      paths: deps.paths,
      runtime: provision.setup.runtime,
      model,
      thinkingLevel: selection.thinking ?? provision.defaultThinking,
      header,
      entries,
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      ...(profile?.tools === undefined ? {} : { extraTools: profile.tools }),
      ...(profile?.promptExtra === undefined
        ? {}
        : { promptExtra: profile.promptExtra }),
    });
    // 已有对话但原模型用不了：把退回的模型记进 transcript，免得记录与实际不符。
    if (!recorded && selection.hasMessages)
      await opened.session.setModel(model);
    const persist = (): void => {
      deps.store.append(sessionId, opened.sessionManager.getEntries());
    };
    // 首轮判定看库里有没有真正的消息（会话一打开 pi 会写 model_change 等条目，
    // 按条目数判会把每条新会话都当成「续聊」）。
    const hasMessages = deps.store
      .entries(sessionId)
      .some((e) => (e as { type?: unknown }).type === "message");
    const entry: Live = {
      opened,
      provisionKey: provision.key,
      evidence: { first: !hasMessages, given: new Set() },
      persist,
      unsubscribe: () => undefined,
      lastUsed: Date.now(),
    };
    persist(); // 新会话由 pi 写入的初始 model_change / thinking_level_change
    // 订阅长期有效（不是每轮一订）：断线后 pi 仍在跑，条目要继续落库。
    entry.unsubscribe = opened.session.subscribe((event) => {
      // 每条消息完成就落库，收尾再落一次（工具结果、压缩不伴随 message_end）。
      // 收尾那次必须在 finish 帧之前：前端收到 finish 就可能重拉历史。
      if (event.type === "message_end" || event.type === "agent_settled")
        persist();
      const run = entry.run;
      if (!run || run.done) return;
      for (const chunk of run.translator.push(event)) broadcast(run, chunk);
      if (event.type === "agent_settled") finishRun(entry, run);
    });
    live.set(sessionId, entry);
    return entry;
  };

  const attach = async (
    run: Run,
    onChunk: (chunk: UIMessageChunk) => void,
    signal: AbortSignal,
  ): Promise<void> => {
    for (const chunk of run.chunks) onChunk(chunk);
    if (run.done || signal.aborted) return;
    run.listeners.add(onChunk);
    await Promise.race([
      run.finished,
      new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            resolve();
          },
          { once: true },
        );
      }),
    ]);
    run.listeners.delete(onChunk);
  };

  const newRun = (prompt: string, startEntries: number): Run => {
    let finish = (): void => undefined;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      prompt,
      startEntries,
      translator: createStreamTranslator(randomUUID()),
      chunks: [],
      listeners: new Set(),
      done: false,
      finished,
      finish,
    };
  };

  return {
    async chat({ sessionId, message, onChunk, signal }) {
      const row = deps.store.get(sessionId);
      if (!row) throw notFound("会话不存在");
      const entry = await open(sessionId);
      const session = entry.opened.session;
      deps.onTurn?.(sessionId);

      /**
       * `/skill:名字 参数` 在这里展开成「技能正文 + 用户请求」再交给 pi（见
       * pi/skills.ts）。放服务端而不是前端：正文是服务端的文件，前端不该为了
       * 发一条消息先去拉几千字回来；展开失败（名字打错）就照原话发。
       */
      let outgoing =
        (await expandSkillCommand(deps.paths.skillsDir, message)) ?? message;
      // 事实依据放在最前面。定位失败不能让对话开不起来：没有依据段，AI 仍会
      // 按「没有文件工具」的规矩把结论标待核实。
      if (deps.evidence !== undefined) {
        try {
          const brief = await deps.evidence.brief(
            {
              productId: row.productId,
              evidenceScope: row.evidenceScope,
              task: row.task,
            },
            message,
            entry.evidence,
          );
          if (brief !== null) outgoing = `${brief}\n\n${outgoing}`;
        } catch {
          // 忽略：依据是增强，不是前置条件。
        }
      }

      /*
       * 判断「要不要排到当前轮后面」，看的是**我们自己这一轮的 run**，不是
       * `session.isStreaming`。pi 要到 `prompt()` 内部处理完输入才把它置真；在那之前来的
       * 第二条消息会走「新建一轮」分支，把 `entry.run` 覆盖掉——第一条的 run 从此再也
       * 收不到事件、`run.finished` 永不兑现，那个标签页就永久停在半截回答上。
       */
      const active = entry.run;
      if (active !== undefined && !active.done) {
        if (session.isStreaming) {
          await session.followUp(outgoing);
          await attach(active, onChunk, signal);
          return;
        }
        // 上一轮还没收到收尾事件，但 pi 已经不认为在流了：先把它结掉再开新的。
        finishRun(entry, active);
      }

      // 第一句话当标题：「新对话」排一列等于没有标题。判断「还没有消息」而不是
      // 「还没有条目」：会话一打开 pi 就会写入初始的 model_change 等条目。
      const hasMessages = deps.store
        .entries(sessionId)
        .some((e) => (e as { type?: unknown }).type === "message");
      if (row.title === DEFAULT_TITLE && !hasMessages) {
        deps.store.rename(
          sessionId,
          message.replace(/\s+/g, " ").trim().slice(0, 40),
        );
      }

      const run = newRun(message, deps.store.entries(sessionId).length);
      entry.run = run;
      const attached = attach(run, onChunk, signal);
      try {
        // 必须给 streamingBehavior：pi 在「已经在流」时收到 prompt 会抛错。
        // 用 followUp（排队）而不是 steer（打断），不截断上一轮。
        await session.prompt(outgoing, { streamingBehavior: "followUp" });
        await run.finished;
      } catch (cause) {
        // prompt 自己抛了，pi 不会再发 agent_settled：由这里收尾，
        // 否则前端会一直停在「生成中」。
        if (!run.done) {
          const text = cause instanceof Error ? cause.message : "对话失败";
          if (run.chunks.length === 0) {
            broadcast(run, {
              type: "start",
              messageId: run.translator.messageId,
            });
          }
          broadcast(run, errorChunk(`${run.translator.messageId}:error`, text));
          broadcast(run, { type: "finish", finishReason: "error" });
          finishRun(entry, run);
        }
      }
      await attached;
    },

    async resume(sessionId, onChunk, signal) {
      const run = live.get(sessionId)?.run;
      if (!run || run.done) return false;
      await attach(run, onChunk, signal);
      return true;
    },

    async queue(sessionId, message) {
      const entry = live.get(sessionId);
      const session = entry?.opened.session;
      // 空闲会话上调 followUp，消息会进队列但永远等不到投递（投递时机是
      // 「当前轮结束」，而没有当前轮）——表现是 AI 再也不回应。必须拒。
      if (!session?.isStreaming) return { queued: false, pending: 0 };
      await session.followUp(message);
      // 新深度由 pi 的 queue_update 经翻译层推给正在听的那一路（data-queue）。
      return { queued: true, pending: session.pendingMessageCount };
    },

    abort(sessionId) {
      const session = live.get(sessionId)?.opened.session;
      if (!session) return;
      // 先清队列再中断：反过来，中断结束当前轮的那一刻正好是 followUp 的投递
      // 时机——你按了停止，它反而开始处理排队的下一句。
      session.clearQueue();
      void session.abort();
    },

    activeRun(sessionId) {
      const run = live.get(sessionId)?.run;
      return run && !run.done
        ? { prompt: run.prompt, startEntries: run.startEntries }
        : undefined;
    },

    busy() {
      return [...live.values()].some((l) => l.run !== undefined && !l.run.done);
    },

    async sessionModel(sessionId) {
      if (!deps.store.get(sessionId)) throw notFound("会话不存在");
      return modelState((await open(sessionId)).opened);
    },

    async setModel(sessionId, ref) {
      if (!deps.store.get(sessionId)) throw notFound("会话不存在");
      const entry = await open(sessionId);
      if (entry.run && !entry.run.done)
        throw conflict("回答进行中，结束后再切换模型");
      const provision = await deps.provision();
      const model = findModel(provision.setup, ref);
      if (!model)
        throw badRequest(`没有可用的模型 ${ref.provider}/${ref.modelId}`);
      await entry.opened.session.setModel(model);
      entry.persist();
      return modelState(entry.opened);
    },

    async setThinking(sessionId, level) {
      if (!deps.store.get(sessionId)) throw notFound("会话不存在");
      const entry = await open(sessionId);
      if (entry.run && !entry.run.done)
        throw conflict("回答进行中，结束后再切换思考强度");
      entry.opened.session.setThinkingLevel(level);
      entry.persist();
      return modelState(entry.opened);
    },

    dispose: disposeOne,

    disposeAll() {
      for (const id of [...live.keys()]) disposeOne(id);
    },
  };
}
