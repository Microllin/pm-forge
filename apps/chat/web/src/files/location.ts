/** 文件菜单在外壳里记住的位置：当前文件夹与打开的文件。 */
export interface FilesLocation {
  folder: string;
  file: string | null;
  /** 打开即编辑（刚新建的 Markdown）。 */
  edit?: boolean;
}

export const FILES_HOME: FilesLocation = { folder: "/", file: null };

/**
 * 「代码」入口的根。与服务端 `files/paths.ts` 的 CODE_ROOT 必须一致
 * ——两边各写一个字面量迟早会漂，所以这里注明出处。
 */
export const CODE_ROOT = "/代码库";
export const CODE_HOME: FilesLocation = { folder: CODE_ROOT, file: null };
