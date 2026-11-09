import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { readUIMessageStream, type UIMessage, type UIMessageChunk } from "ai";

import { IN_MEMORY, openDb } from "../db.js";
import { createSessionStore } from "../sessions.js";
import { createFauxSetup } from "./faux.js";
import { historyToUiMessages } from "./history.js";
import { DEFAULT_TITLE, createRunner } from "./runner.js";
import { newSessionHeader, piPaths } from "./runtime.js";
import { SKILL_TOOL_NAME } from "./skills.js";

/**
 * pi 升级自检：用 faux 模型离线跑真实的 pi，验证本服务依赖的每一条契约。
 *
 * 升级流程在**子进程**里跑它（`node --import tsx server/pi/selfcheck.ts`），
 * 这样加载的是刚装上的新版 pi，而不是当前进程里已缓存的旧模块。
 *
 * 检查项对应本服务对 pi 的全部依赖面：
 * 1. 运行时装配 + 会话创建（runtime.ts 的构造 API）
 * 2. 事件流能被翻译成合规的 UI Message Stream（思考 / 正文 / 结束）
 * 3. 条目原样落库后能原样恢复，第二轮模型看得到完整历史
 * 4. 对话中切换模型（setModel）写进 transcript，恢复后仍生效
 * 5. 历史还原与流式产出一致
 * 6. 技能：清单进系统提示词、skill 工具能把正文交给模型（loadSkillsFromDir /
 *    formatSkillsForPrompt / customTools 这几个 pi API 一起钉住）
 * 7. 自动重试对用户可见（auto_retry_start / auto_retry_end 的字段是 pi 的契约）
 */

export interface SelfcheckResult {
  ok: boolean;
  checks: { name: string; ok: boolean; detail?: string }[];
}

async function parse(chunks: UIMessageChunk[]): Promise<UIMessage | undefined> {
  let last: UIMessage | undefined;
  for await (const m of readUIMessageStream({
    stream: new ReadableStream<UIMessageChunk>({
      start(c) {
        for (const x of chunks) c.enqueue(x);
        c.close();
      },
    }),
    terminateOnError: false,
  })) {
    last = m;
  }
  return last;
}

export async function runSelfcheck(): Promise<SelfcheckResult> {
  const checks: SelfcheckResult["checks"] = [];
  const check = async (
    name: string,
    fn: () => Promise<void>,
  ): Promise<boolean> => {
    try {
      await fn();
      checks.push({ name, ok: true });
      return true;
    } catch (cause) {
      checks.push({
        name,
        ok: false,
        detail: cause instanceof Error ? cause.message : String(cause),
      });
      return false;
    }
  };
  const assert = (cond: boolean, message: string): void => {
    if (!cond) throw new Error(message);
  };

  const dir = await mkdtemp(join(tmpdir(), "chat-selfcheck-"));
  try {
    const paths = piPaths(dir);
    // 自检里的重试要能在一秒内跑完，退避按毫秒给。
    await writeFile(
      join(paths.agentDir, "settings.json"),
      JSON.stringify({
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
      }),
      "utf8",
    );
    const store = createSessionStore(openDb(IN_MEMORY));
    let seenHistory: string[] = [];
    const setup = await createFauxSetup(paths);
    const runner = createRunner({
      store,
      paths,
      provision: () =>
        Promise.resolve({
          key: "faux",
          setup,
          defaultModel: setup.model,
          defaultThinking: "medium",
        }),
    });
    const id = "selfcheck";
    store.create({
      id,
      title: DEFAULT_TITLE,
      header: newSessionHeader(paths, id),
    });

    let firstTurn: UIMessage | undefined;
    const turnOk = await check("一轮对话：思考 + 正文流式翻译", async () => {
      setup.faux.setResponses([
        fauxAssistantMessage([fauxThinking("思考"), fauxText("回答")]),
      ]);
      const chunks: UIMessageChunk[] = [];
      await runner.chat({
        sessionId: id,
        message: "第一句",
        onChunk: (c) => chunks.push(c),
        signal: new AbortController().signal,
      });
      assert(chunks[0]?.type === "start", "首帧不是 start");
      const last = chunks.at(-1);
      assert(
        last?.type === "finish" && last.finishReason === "stop",
        "末帧不是 finish(stop)",
      );
      firstTurn = await parse(chunks);
      const types = (firstTurn?.parts ?? [])
        .map((p) => p.type)
        .filter((t) => t !== "step-start" && t !== "data-model");
      assert(
        JSON.stringify(types) === JSON.stringify(["reasoning", "text"]),
        `部件不符：${JSON.stringify(types)}`,
      );
    });

    if (turnOk) {
      await check("条目原样落库与恢复：第二轮能看到历史", async () => {
        runner.disposeAll(); // 模拟重启：强制从库里恢复
        setup.faux.setResponses([
          (context) => {
            seenHistory = context.messages.flatMap((m) => {
              const msg = m as { role?: string };
              return msg.role === "user" || msg.role === "assistant"
                ? [msg.role]
                : [];
            });
            return fauxAssistantMessage(fauxText("第二轮"));
          },
        ]);
        await runner.chat({
          sessionId: id,
          message: "第二句",
          onChunk: () => undefined,
          signal: new AbortController().signal,
        });
        assert(
          JSON.stringify(seenHistory) ===
            JSON.stringify(["user", "assistant", "user"]),
          `模型收到的历史不符：${JSON.stringify(seenHistory)}`,
        );
      });

      await check(
        "对话中切换模型：写进 transcript，重启后仍是新模型",
        async () => {
          await runner.setModel(id, {
            provider: setup.alt.provider,
            modelId: setup.alt.id,
          });
          setup.faux.setResponses([fauxAssistantMessage(fauxText("换了模型"))]);
          const chunks: UIMessageChunk[] = [];
          await runner.chat({
            sessionId: id,
            message: "第三句",
            onChunk: (c) => chunks.push(c),
            signal: new AbortController().signal,
          });
          const label = chunks.find((c) => c.type === "data-model") as
            { data?: { model?: string } } | undefined;
          assert(
            label?.data?.model === `${setup.alt.provider}/${setup.alt.id}`,
            `回答没有用切换后的模型：${JSON.stringify(label)}`,
          );
          runner.disposeAll();
          const state = await runner.sessionModel(id);
          assert(
            state.modelId === setup.alt.id,
            `重启后模型回到了 ${state.modelId}`,
          );
          // 切回去，免得影响后面「历史还原」那项对第一轮的比对。
          await runner.setModel(id, {
            provider: setup.model.provider,
            modelId: setup.model.id,
          });
        },
      );

      await check("技能：清单进提示词，skill 工具把正文交给模型", async () => {
        await mkdir(join(paths.skillsDir, "selfcheck-skill"), {
          recursive: true,
        });
        await writeFile(
          join(paths.skillsDir, "selfcheck-skill", "SKILL.md"),
          "---\nname: selfcheck-skill\ndescription: 自检用技能。\n---\n\n自检标记：技能正文已送达。\n",
          "utf8",
        );
        runner.disposeAll();
        let system = "";
        let delivered = "";
        setup.faux.setResponses([
          (context) => {
            system = JSON.stringify(
              context.messages.filter(
                (m) => (m as { role?: string }).role === "system",
              ),
            );
            return fauxAssistantMessage([
              fauxToolCall(SKILL_TOOL_NAME, { name: "selfcheck-skill" }),
            ]);
          },
          (context) => {
            delivered = JSON.stringify(context.messages);
            return fauxAssistantMessage(fauxText("已加载"));
          },
        ]);
        await runner.chat({
          sessionId: id,
          message: "用一下自检技能",
          onChunk: () => undefined,
          signal: new AbortController().signal,
        });
        assert(system.includes("selfcheck-skill"), "系统提示词里没有技能清单");
        assert(
          delivered.includes("自检标记：技能正文已送达。"),
          "skill 工具没把正文交给模型",
        );
      });

      await check(
        "自动重试：失败后重试成功，且重试过程对用户可见",
        async () => {
          runner.disposeAll();
          setup.faux.setResponses([
            fauxAssistantMessage([], {
              stopReason: "error",
              errorMessage: "Request timed out.",
            }),
            fauxAssistantMessage(fauxText("重试成功")),
          ]);
          const chunks: UIMessageChunk[] = [];
          await runner.chat({
            sessionId: id,
            message: "第四句",
            onChunk: (c) => chunks.push(c),
            signal: new AbortController().signal,
          });
          const retries = chunks.filter((c) => c.type === "data-retry") as {
            data: {
              attempt?: number;
              message?: string;
              done?: boolean;
              success?: boolean;
            };
          }[];
          assert(
            retries.length >= 2,
            `没有发出重试提示：${JSON.stringify(chunks.map((c) => c.type))}`,
          );
          assert(
            retries[0]?.data.attempt === 1 &&
              retries[0].data.message === "Request timed out.",
            `重试提示缺字段（pi 可能改了 auto_retry_start）：${JSON.stringify(retries[0])}`,
          );
          assert(
            retries.at(-1)?.data.done === true &&
              retries.at(-1)?.data.success === true,
            `没有「已恢复」提示（pi 可能改了 auto_retry_end）：${JSON.stringify(retries.at(-1))}`,
          );
          const last = chunks.at(-1);
          assert(
            last?.type === "finish" && last.finishReason === "stop",
            "重试成功的一轮被报成了失败",
          );
        },
      );

      await check("历史还原与流式产出一致", () => {
        const history = historyToUiMessages(
          paths.cwd,
          store.header(id),
          store.entries(id),
        );
        const shape = (m: UIMessage | undefined) =>
          JSON.stringify(
            (m?.parts ?? [])
              .filter((p) => p.type !== "step-start")
              .map((p) => [p.type, (p as { text?: string }).text]),
          );
        assert(
          shape(history[1]) === shape(firstTurn),
          "刷新后的第一轮回答与流式时不一致",
        );
        return Promise.resolve();
      });
    }
    runner.disposeAll();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  return { ok: checks.every((c) => c.ok), checks };
}

// 作为子进程直接运行：结果打到 stdout（一行 JSON），退出码表示成败。
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const result = await runSelfcheck().catch(
    (cause: unknown): SelfcheckResult => ({
      ok: false,
      checks: [
        {
          name: "加载 pi",
          ok: false,
          detail: cause instanceof Error ? cause.message : String(cause),
        },
      ],
    }),
  );
  process.stdout.write(`SELFCHECK ${JSON.stringify(result)}\n`);
  process.exit(result.ok ? 0 : 1);
}
