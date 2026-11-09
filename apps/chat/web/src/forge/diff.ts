/**
 * 逐行对比（工坊的「改动前后」视图）。
 *
 * 用最长公共子序列：技能文件通常几十到几百行，O(n·m) 足够快；超过上限
 * （约 2000×2000 行）就退化成「整段删 + 整段加」——宁可粗，也不能把页面卡死。
 */

export type DiffLine =
  | { type: "same"; text: string }
  | { type: "add"; text: string }
  | { type: "del"; text: string };

const MAX_CELLS = 4_000_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");
  // 首尾相同的行先剥掉：常见的小改动只动中间几行，表能小几个数量级。
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const same = (t: string): DiffLine => ({ type: "same", text: t });
  const out: DiffLine[] = a.slice(0, head).map(same);

  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_CELLS) {
    out.push(...midA.map((t): DiffLine => ({ type: "del", text: t })));
    out.push(...midB.map((t): DiffLine => ({ type: "add", text: t })));
  } else {
    // lcs[i][j] = midA[i..] 与 midB[j..] 的最长公共子序列长度（一维展开）。
    const w = m + 1;
    const lcs = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i -= 1)
      for (let j = m - 1; j >= 0; j -= 1)
        lcs[i * w + j] =
          midA[i] === midB[j]
            ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
            : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      const x = midA[i] ?? "";
      const y = midB[j] ?? "";
      if (x === y) {
        out.push(same(x));
        i += 1;
        j += 1;
      } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
        out.push({ type: "del", text: x });
        i += 1;
      } else {
        out.push({ type: "add", text: y });
        j += 1;
      }
    }
    for (; i < n; i += 1) out.push({ type: "del", text: midA[i] ?? "" });
    for (; j < m; j += 1) out.push({ type: "add", text: midB[j] ?? "" });
  }
  out.push(...a.slice(a.length - tail).map(same));
  return out;
}

/** 改了几行：给文件标签上的小计用。 */
export function diffStat(lines: readonly DiffLine[]): {
  added: number;
  removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.type === "add") added += 1;
    else if (l.type === "del") removed += 1;
  }
  return { added, removed };
}

export type DiffBlock =
  | { type: "lines"; lines: DiffLine[] }
  | { type: "fold"; count: number; lines: DiffLine[] };

/**
 * 把大段没改的行折起来，只留改动前后各 `context` 行。
 * 人审改动要看的是「改了哪」，几百行原样内容只会把改动淹没。
 */
export function foldUnchanged(
  lines: readonly DiffLine[],
  context = 3,
): DiffBlock[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.type === "same") return;
    for (
      let k = Math.max(0, i - context);
      k <= Math.min(lines.length - 1, i + context);
      k += 1
    )
      keep[k] = true;
  });
  const out: DiffBlock[] = [];
  let run: DiffLine[] = [];
  let folded: DiffLine[] = [];
  const flushRun = (): void => {
    if (run.length > 0) out.push({ type: "lines", lines: run });
    run = [];
  };
  const flushFold = (): void => {
    if (folded.length > 0)
      out.push({ type: "fold", count: folded.length, lines: folded });
    folded = [];
  };
  lines.forEach((l, i) => {
    if (keep[i] === true) {
      flushFold();
      run.push(l);
    } else {
      flushRun();
      folded.push(l);
    }
  });
  flushRun();
  flushFold();
  return out;
}
