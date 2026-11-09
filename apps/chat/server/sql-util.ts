/**
 * 几个数据层共用的小工具。
 *
 * 为什么抽出来：`translateUnique` / `split` / `normalizeLines` 原来在
 * products.ts、lifecycle.ts、architecture.ts 里**逐字写了三遍**。
 * 重复本身不致命，致命的是它们会悄悄分叉——architecture.ts 里一度用
 * `name.toLowerCase()` 判重名，而索引是 `COLLATE NOCASE`，两者对非 ASCII 的
 * 处理不同，于是报告说「跳过（重名）」但库里根本没那一条。
 * 同一个语义只留一份实现，分叉就无处发生。
 */
import { conflict } from "./errors.js";

/**
 * 把 SQLite 的唯一约束冲突翻成一句人话（409）。
 *
 * 不在每个调用点手写 try/catch 的原因：`SQLITE_CONSTRAINT_UNIQUE` 不翻译的话
 * 会落到兜底 500，用户看到「服务器错误」而不是「这个名字已经有了」。
 */
export function translateUnique<T>(message: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "SQLITE_CONSTRAINT_UNIQUE"
    ) {
      throw conflict(message);
    }
    throw error;
  }
}

/**
 * 多行文本入库前的规范化：去掉空行与行尾空白，仍然是一段字符串。
 *
 * 不在 zod 里 transform 成数组：那会让 default 值和入参类型对不上。
 */
export const normalizeLines = (s: string): string => splitLines(s).join("\n");

/** 出库时把那段字符串切回数组。不另起一张表存「一行」。 */
export const splitLines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
