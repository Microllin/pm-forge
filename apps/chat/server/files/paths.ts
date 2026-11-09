import { lstat } from "node:fs/promises";
import { join } from "node:path";

import { HttpError, badRequest } from "../errors.js";

/**
 * 文件模块的路径规则。对外一律是「以 / 开头的相对路径」（根目录是 "/"），
 * 绝对路径只在服务端内部出现。
 *
 * 安全边界：
 * - 路径段不能是 ".." / "."、不能含反斜杠与控制字符——拼接后绝不会跑出根目录。
 * - **不跟随符号链接**：路径上任何一段是软链就拒绝。否则有人在根目录里放一个指向
 *   ~/.ssh 的软链，就能经由本模块读写目录外的文件。
 * - 根目录本身在启动时 realpath 一次（见 store）：macOS 的 /tmp、/var 等是软链，
 *   不解析的话「路径上不许有软链」这条会把根目录自己拒掉。
 */

/**
 * 「代码」入口的根目录名（在同一个文件库里）。
 *
 * 「事实底座」菜单下「文件」与「代码」是同一个库的两个入口：前者从 `/` 起，
 * 后者从 `/代码库` 起。常量放这里是为了服务端（启动时建目录）与前端（入口根路径）
 * 对得上——两边各写一个字面量迟早会漂。
 */
export const CODE_ROOT_NAME = "代码库";
export const CODE_ROOT = `/${CODE_ROOT_NAME}`;

/** 以点开头的名字视为隐藏：列表不显示、也不允许新建（与 Finder 默认行为一致）。 */
export const isHiddenName = (name: string): boolean => name.startsWith(".");

/** 是否含控制字符（0x00–0x1f、0x7f）。用字符码判断，不把控制字符写进正则。 */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** 校验一个文件名 / 文件夹名（单段）。 */
export function assertValidName(name: string): void {
  if (name.trim() === "") throw badRequest("名称不能为空");
  if (name !== name.trim()) throw badRequest("名称首尾不能有空格");
  if (name === "." || name === "..") throw badRequest("名称不能是 . 或 ..");
  if (name.includes("/") || name.includes("\\"))
    throw badRequest("名称不能包含 / 或 \\");
  if (hasControl(name)) throw badRequest("名称不能包含控制字符");
  if (isHiddenName(name)) throw badRequest("名称不能以 . 开头");
  if (Buffer.byteLength(name) > 255) throw badRequest("名称太长");
}

/**
 * 规范化相对路径："a//b/" → "/a/b"；"" 与 "/" 都是根。非法路径抛 400。
 *
 * **点开头的段一并拒绝**。原来只拒 `.` 和 `..`，隐藏文件只在「列表」和「遍历」里被过滤，
 * 于是 `GET /api/files/raw?path=/代码库/x/.git/config` 能直接把克隆仓库里的 remote URL
 * 读出来（里面常带 token），`.env` 同理；`remove` 还能把它们删掉。列表看不见 ≠ 读不到，
 * 两个场景被混为一谈了。读写删三个入口共用这一处判断，才不会有漏网的。
 */
export function normalizePath(input: unknown): string {
  if (typeof input !== "string") throw badRequest("缺少路径");
  const parts = input.split("/").filter((p) => p !== "");
  for (const part of parts) {
    if (part === "." || part === "..") throw badRequest("路径不能包含 . 或 ..");
    if (part.includes("\\") || hasControl(part))
      throw badRequest("路径包含非法字符");
    if (isHiddenName(part))
      throw badRequest(`隐藏文件不能在这里访问：「${part}」`);
  }
  return `/${parts.join("/")}`;
}

export const isRoot = (path: string): boolean => path === "/";
export const nameOf = (path: string): string =>
  path.slice(path.lastIndexOf("/") + 1);
export const parentOf = (path: string): string => {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
};
export const childOf = (parent: string, name: string): string =>
  parent === "/" ? `/${name}` : `${parent}/${name}`;
/** `inner` 是否就是 `outer` 或在它里面。 */
export const isWithin = (inner: string, outer: string): boolean =>
  outer === "/" || inner === outer || inner.startsWith(`${outer}/`);

/**
 * 相对路径 → 绝对路径，并确认路径上已存在的每一段都不是软链。
 * 不存在的尾部（比如要新建的文件）不检查——它还没有，自然不是软链。
 */
export async function resolveSafe(root: string, path: string): Promise<string> {
  let current = root;
  for (const part of path.split("/").filter((p) => p !== "")) {
    current = join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new HttpError(400, "SYMLINK", "路径包含符号链接，不支持访问");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
  }
  return join(root, ...path.split("/").filter((p) => p !== ""));
}
