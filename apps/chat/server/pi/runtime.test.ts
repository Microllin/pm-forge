import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";

import { IN_MEMORY, openDb } from "../db.js";
import { createSessionStore, type SessionStore } from "../sessions.js";
import { createFauxSetup } from "./faux.js";
import {
  newSessionHeader,
  openAgentSession,
  piPaths,
  resolveCustomModel,
  type PiPaths,
} from "./runtime.js";
import { emptyRuntime } from "./runtime.js";

/**
 * 镜像的核心承诺：**原样存、原样还**。
 *
 * 全程真实的 pi（假的只有模型——faux provider），断言的是「恢复之后模型实际
 * 收到的上下文」，而不是我们自己的数据结构。这是 pm-forge 的镜像没做到、
 * 也是那批回放 bug 的来源。
 */

let dir: string;
let paths: PiPaths;
let store: SessionStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "chat-runtime-"));
  paths = piPaths(dir);
  store = createSessionStore(openDb(IN_MEMORY));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** faux 响应工厂收到的 transcript 里，取出 user / assistant 的纯文本。 */
function transcriptTexts(context: { messages: unknown[] }): string[] {
  return context.messages.flatMap((m) => {
    const msg = m as { role?: string; content?: unknown };
    if (msg.role !== "user" && msg.role !== "assistant") return [];
    const content = Array.isArray(msg.content) ? msg.content : [msg.content];
    const text = content
      .map((c) =>
        typeof c === "string" ? c : ((c as { text?: string }).text ?? ""),
      )
      .join("");
    return [`${msg.role}:${text}`];
  });
}

describe("中转模型的元数据继承", () => {
  it("不继承 supportsMidConvoEffort：它会让请求带上中转不认的 beta 头", async () => {
    /*
     * 实测（2026-11-02）：某中转服务上的 claude-opus-5-5 继承了这项之后，任何一轮
     * 对话都返回 `Invalid request`（400），而同一个请求去掉 beta 头就 200。
     * 根因是 pi 看到这个标记会加两个 beta：mid-conversation-output-config-* 与
     * thinking-binding-controls-*，中转只认前者、拒绝后者。
     */
    interface CompatModel {
      id: string;
      api: string;
      compat?: {
        supportsMidConvoEffort?: boolean;
        forceAdaptiveThinking?: boolean;
      };
    }
    const runtime = await emptyRuntime(piPaths("/tmp/pmforge-runtime-test"));
    const models = runtime.getModels() as unknown as CompatModel[];
    const builtin = models.find(
      (m) => m.id === "claude-opus-5-5" && m.api === "anthropic-messages",
    );
    // 前提：内置目录里确实带这个标记，否则这条测试证明不了什么。
    expect(builtin?.compat?.supportsMidConvoEffort).toBe(true);

    const relayed = resolveCustomModel(
      runtime,
      "anthropic-messages",
      "claude-opus-5-5",
    );
    const compat = (
      relayed.definition as {
        compat?: {
          supportsMidConvoEffort?: boolean;
          forceAdaptiveThinking?: boolean;
        };
      }
    ).compat;
    expect(compat?.supportsMidConvoEffort).toBeUndefined();
    // 别的兼容标记照旧继承——尤其是 forceAdaptiveThinking，少了它直接 400。
    expect(compat?.forceAdaptiveThinking).toBe(true);
  });
});

describe("系统提示词", () => {
  it("模型收到的就是我们给的那段，没有 pi 追加的 cwd 等段落", async () => {
    const setup = await createFauxSetup(paths);
    let system: unknown[] = [];
    setup.faux.setResponses([
      (context) => {
        system = context.messages.filter(
          (m) => (m as { role?: string }).role === "system",
        );
        return fauxAssistantMessage(fauxText("ok"));
      },
    ]);
    const opened = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header: newSessionHeader(paths),
      entries: [],
      systemPrompt: "你是测试助手。",
    });
    await opened.session.prompt("hi");
    const serialized = JSON.stringify(system);
    expect(serialized).toContain("你是测试助手。");
    expect(serialized).not.toContain("<cwd>");
    expect(serialized).not.toContain(paths.cwd);
    opened.dispose();
  });
});

describe("会话原样镜像与恢复", () => {
  it("一轮对话后落库，重新打开时模型能看到完整历史", async () => {
    const setup = await createFauxSetup(paths);
    const header = newSessionHeader(paths, "s1");
    store.create({ id: "s1", title: "测试", header });

    // 第一轮
    setup.faux.setResponses([fauxAssistantMessage(fauxText("蓝鲸"))]);
    const first = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header,
      entries: [],
    });
    await first.session.prompt("记住暗号：蓝鲸");
    store.append("s1", first.sessionManager.getEntries());
    first.dispose();

    // 「重启」：从库里原样恢复，第二轮看模型收到了什么
    let seen: string[] = [];
    setup.faux.setResponses([
      (context) => {
        seen = transcriptTexts(context);
        return fauxAssistantMessage(fauxText("暗号是蓝鲸"));
      },
    ]);
    const second = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header: store.header("s1"),
      entries: store.entries("s1"),
    });
    await second.session.prompt("暗号是什么？");
    expect(seen).toEqual([
      "user:记住暗号：蓝鲸",
      "assistant:蓝鲸",
      "user:暗号是什么？",
    ]);
    second.dispose();
  });

  it("恢复保留原始条目 id 与会话 id——不是换新 id 重放", async () => {
    const setup = await createFauxSetup(paths);
    const header = newSessionHeader(paths, "s2");
    store.create({ id: "s2", title: "测试", header });
    setup.faux.setResponses([fauxAssistantMessage(fauxText("好"))]);
    const first = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header,
      entries: [],
    });
    await first.session.prompt("你好");
    const originalIds = first.sessionManager.getEntries().map((e) => e.id);
    store.append("s2", first.sessionManager.getEntries());
    first.dispose();

    const restored = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header: store.header("s2"),
      entries: store.entries("s2"),
    });
    expect(restored.sessionManager.getSessionId()).toBe("s2");
    expect(restored.sessionManager.getEntries().map((e) => e.id)).toEqual(
      originalIds,
    );
    restored.dispose();
  });

  it("context_edit 拿掉的条目，恢复后模型看不到（由 pi 自己解释）", async () => {
    const setup = await createFauxSetup(paths);
    const header = newSessionHeader(paths, "s3");
    store.create({ id: "s3", title: "测试", header });
    setup.faux.setResponses([fauxAssistantMessage(fauxText("不该被看到"))]);
    const first = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header,
      entries: [],
    });
    await first.session.prompt("第一句");
    const assistant = first.sessionManager
      .getEntries()
      .find(
        (e) =>
          e.type === "message" &&
          (e.message as { role?: string }).role === "assistant",
      );
    if (!assistant) throw new Error("没有 assistant 条目");
    first.sessionManager.appendContextEdit(assistant.id, null);
    store.append("s3", first.sessionManager.getEntries());
    first.dispose();

    let seen: string[] = [];
    setup.faux.setResponses([
      (context) => {
        seen = transcriptTexts(context);
        return fauxAssistantMessage(fauxText("ok"));
      },
    ]);
    const second = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header: store.header("s3"),
      entries: store.entries("s3"),
    });
    await second.session.prompt("第二句");
    expect(seen).toEqual(["user:第一句", "user:第二句"]);
    second.dispose();
  });

  it("重复同步只落新条目", async () => {
    const setup = await createFauxSetup(paths);
    const header = newSessionHeader(paths, "s4");
    store.create({ id: "s4", title: "测试", header });
    setup.faux.setResponses([fauxAssistantMessage(fauxText("好"))]);
    const opened = await openAgentSession({
      paths,
      ...setup,
      thinkingLevel: "off",
      header,
      entries: [],
    });
    await opened.session.prompt("你好");
    const n = store.append("s4", opened.sessionManager.getEntries());
    expect(n).toBeGreaterThan(0);
    expect(store.append("s4", opened.sessionManager.getEntries())).toBe(0);
    opened.dispose();
  });
});
