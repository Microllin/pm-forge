import type { LocateResult } from "./locate.js";

/**
 * 把定位结果写成交给 AI 的「本次事实依据」。
 *
 * **这个服务里它是唯一的事实入口**：3200 的对话会话没有文件工具（见
 * pi/runtime.ts 的 `noTools: "all"`，那是防提示词注入的安全边界），所以依据
 * 不能只给路径——正文必须由这里一并附上。
 *
 * 三条规则随清单一起下发，是平台规范的执行面：
 * 1. 结论要落在附上的正文里；
 * 2. 没附上的内容不算读过，涉及它们就标「未核实」；
 * 3. 凭据只报名字不报值。
 *
 * 续聊（first=false）只补新命中、不重复规则——规则第一轮已经在上下文里了。
 */

const KIND_CN = { doc: "文档", code: "代码" } as const;

/** 包住依据段的标记。界面上据此折叠回「你自己说的那句话」。 */
export const EVIDENCE_OPEN = "<pmforge-evidence>";
export const EVIDENCE_CLOSE = "</pmforge-evidence>";

/** 把一条用户消息拆成「依据段」与「正文」。没有依据段时 brief 为 null。 */
export function splitEvidence(text: string): {
  brief: string | null;
  body: string;
} {
  if (!text.startsWith(EVIDENCE_OPEN)) return { brief: null, body: text };
  const end = text.indexOf(EVIDENCE_CLOSE);
  if (end === -1) return { brief: null, body: text };
  return {
    brief: text.slice(EVIDENCE_OPEN.length, end).trim(),
    body: text.slice(end + EVIDENCE_CLOSE.length).replace(/^\s+/, ""),
  };
}

export function renderEvidenceBrief(
  result: LocateResult,
  options: { first: boolean; task: string },
): string | null {
  const { library, files } = result;
  if (library.productName === null) return null;

  // 有产品却一条依据都没登记：说清楚，别让它装作读过东西。
  if (library.sources.length === 0 && library.missing.length === 0) {
    if (!options.first) return null;
    return wrap([
      `【本次事实依据】产品「${library.productName}」还没有绑定任何事实依据（文档目录 / 代码目录 / 参考资料）。`,
      "凡是关于这个产品现状的结论一律标 `[待核实]`，不要凭经验或推断补位；需要依据时提醒用户去产品的「事实依据」里绑定目录。",
    ]);
  }
  if (!options.first && files.length === 0) return null;

  const lines: string[] = [];
  lines.push(
    options.first
      ? `【本次事实依据】平台按这次任务，从「${library.productName}」的事实依据里挑出了下面这些文件，正文已附在最后。`
      : "【补充事实依据】针对这条消息又定位到下面这些文件，正文已附在最后：",
  );

  if (files.length === 0) {
    lines.push(
      "这次没有定位到直接相关的文件。依据范围如下，其中没有覆盖到的内容不要当作事实。",
    );
  } else {
    lines.push("结论必须落在下面这些正文里，引用时写出文件路径：");
    let i = 0;
    for (const kind of ["doc", "code"] as const) {
      const group = files.filter((f) => f.kind === kind);
      if (group.length === 0) continue;
      lines.push(`${KIND_CN[kind]}：`);
      for (const f of group) {
        const title = f.title === null ? "" : `《${f.title}》`;
        lines.push(
          `${String(++i)}. ${f.path}${title} — 命中：${f.matched.join("、")}`,
        );
      }
    }
  }

  if (options.first) {
    lines.push("", "依据范围（只在这里面取证，范围外的不当事实用）：");
    for (const s of result.searched) {
      lines.push(`- [${KIND_CN[s.kind]}] ${s.label}：${s.path}`);
    }
    if (library.missing.length > 0) {
      lines.push(
        "绑定了但文件库里找不到（没读，涉及它们的结论一律标 `[待核实]`，并提醒用户去产品里修正绑定）：",
      );
      for (const p of library.missing) lines.push(`- ${p}`);
    }
    if (result.truncated.length > 0) {
      lines.push(
        `（${result.truncated.join("、")} 文件过多，这次只扫了一部分；没列到不代表不存在。）`,
      );
    }
    if (result.skipped.length > 0) {
      lines.push("疑似含凭据、只记了路径没附正文（不要臆测其内容）：");
      for (const s of result.skipped) lines.push(`- ${s.path}（${s.reason}）`);
    }
    lines.push(
      "",
      "规则：",
      "1. 没有文件工具，你读不到这些路径之外的东西。清单就是你能用到的全部依据。",
      "2. 依据覆盖不到的结论标 `[待核实]`，不要用常识补位、不要编路径。",
      "3. 涉及凭据的配置项只写「有这一项」，不写值。",
      "4. 产出末尾附一节「参考依据」，列出实际用上的文件路径。",
    );
  }

  const body = renderFiles(result);
  return wrap([...lines, ...(body.length > 0 ? ["", ...body] : [])]);
}

/** 正文按文件包起来。用 XML 风格标签：Markdown 渲染时不会被当成正文段落。 */
function renderFiles(result: LocateResult): string[] {
  const out: string[] = [];
  for (const f of result.files) {
    out.push(
      "",
      `<事实来源 路径="${f.path}"${f.truncated ? ' 截断="是"' : ""}>`,
      f.content.trim(),
      "</事实来源>",
    );
  }
  if (out.length > 0) {
    out.push(
      "",
      `（共附上 ${String(result.files.length)} 份正文；${
        result.hits.length > result.files.length
          ? `另有 ${String(result.hits.length - result.files.length)} 份因篇幅或读取失败没附上——没附上不代表不存在。`
          : "篇幅上限内已全部附上。"
      }）`,
    );
  }
  return out;
}

function wrap(lines: string[]): string {
  return `${EVIDENCE_OPEN}\n${lines.join("\n")}\n${EVIDENCE_CLOSE}`;
}
