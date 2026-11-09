import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 平台规范守卫：事实依据。
 *
 * 规范只在一条路上执行——会话带了所属产品（productId），运行器才知道依据库
 * 是哪个。所以服务端每一处建会话的地方都必须带 productId。
 *
 * 新功能漏带时这里变红并指出文件；确实不属于任何产品的，登记到白名单并写明理由。
 */

const SERVER = join(import.meta.dirname, "..");

/** 不属于任何产品的建会话入口：文件 → 理由。 */
const NO_PRODUCT_ALLOWED: Record<string, string> = {
  "analysis/routes.ts#discover":
    "AI 识别产线与产品：它的目的就是从一个文件夹里找出有哪些产品，此时还没有产品可绑",
  "app.ts#/api/sessions":
    "手动新建对话：用户可能只是闲聊；从产品页开的对话走同一个接口但会带上 productId",
  "presales-routes.ts#presales-recognize":
    "售前材料识别：按材料库而不是产品组织（材料库可以跨产品），依据由它自己从选定文件夹采集",
  "forge.ts#forge":
    "AI 工坊：编辑的是全局的技能 / 智能体库，不属于任何产品；素材靠工具按需读历史对话，不注入事实依据",
  "pi/selfcheck.ts#?":
    "升级 pi 前的离线自检：用假模型跑一轮，验的是对话链路本身，与任何产品无关",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(abs);
  }
  return out;
}

/** 取出每一处 `store.create({ ... })` 的参数对象（按括号配对）。 */
function createCalls(text: string): { body: string; at: number }[] {
  const out: { body: string; at: number }[] = [];
  const re = /\bstore\.create\(\{/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const start = m.index + m[0].length - 1;
    let depth = 0;
    let end = start;
    for (; end < text.length; end++) {
      const ch = text[end];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push({ body: text.slice(start, end + 1), at: m.index });
  }
  return out;
}

/** 用 task.kind 或附近的路由名给调用点起个能对上白名单的名字。 */
function siteName(
  rel: string,
  text: string,
  call: { body: string; at: number },
): string {
  const kind = /kind:\s*"([a-z-]+)"/.exec(call.body)?.[1];
  if (kind !== undefined) return `${rel}#${kind}`;
  const before = text.slice(0, call.at);
  const route = [
    ...before.matchAll(/app\.(?:post|get|put)\S*\(\s*"([^"]+)"/g),
  ].at(-1)?.[1];
  return `${rel}#${route ?? "?"}`;
}

describe("平台规范：建 AI 会话必须带所属产品", () => {
  const files = walk(SERVER).filter((f) => !f.includes(join("evidence", "")));

  it("每一处 store.create 都带 productId（或已登记白名单）", () => {
    const violations: string[] = [];
    let total = 0;
    for (const abs of files) {
      const rel = relative(SERVER, abs).split("\\").join("/");
      const text = readFileSync(abs, "utf8");
      for (const call of createCalls(text)) {
        total += 1;
        const name = siteName(rel, text, call);
        if (name in NO_PRODUCT_ALLOWED) continue;
        if (
          !/\bproductId\b/.test(call.body.replace(/task:\s*\{[\s\S]*?\}/, ""))
        )
          violations.push(name);
      }
    }
    // 守卫本身不能失效：改了写法一个都扫不到时也要变红。
    expect(total).toBeGreaterThan(3);
    expect(violations).toEqual([]);
  });

  it("运行器接入了依据服务（只此一处，覆盖全部 AI 功能）", () => {
    const app = readFileSync(join(SERVER, "app.ts"), "utf8");
    expect(app.match(/createRunner\(/g)).toHaveLength(1);
    const at = app.indexOf("createRunner(");
    const block = app.slice(at, app.indexOf("});", at));
    expect(block).toMatch(/evidence/);
    expect(block).toMatch(/brief/);
  });

  it("对话会话仍然没有文件工具（依据靠平台读，不靠 AI 自己读）", () => {
    const runtime = readFileSync(join(SERVER, "pi", "runtime.ts"), "utf8");
    expect(runtime).toMatch(/noTools:\s*"all"/);
  });
});
