/**
 * 产品模块的接口。形状与 server/product-routes.ts 一一对应。
 */

import { createRequest, json } from "../http";

export { ApiError } from "../http";

const request = createRequest("/api");

export interface Product {
  id: string;
  lineId: string;
  name: string;
  description: string;
  /** 绑定的生命周期规范模板；null = 还没绑。 */
  templateId: string | null;
  /** 绑定的**文档**目录（事实底座 → 文件）；null = 还没绑。AI 比对产出物读它。 */
  folderPath: string | null;
  /** 绑定的**代码**目录（事实底座 → 代码）；null = 还没绑。AI 分析功能架构读它。 */
  codePath: string | null;
  /**
   * 参考资料：文档目录或单个文件。Wiki 规划与写正文时额外读它们。
   * 可选：比这一栏早的服务端（以及各处测试桩）不带它，界面按「没挂」处理，不能崩。
   */
  refPaths?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ProductLine {
  id: string;
  name: string;
  description: string;
  folderPath: string | null;
  createdAt: number;
  updatedAt: number;
  products: Product[];
}

export interface Fields {
  name: string;
  description: string;
  /**
   * 绑定的目录。服务端 schema 一直接受它，前端类型里漏了——
   * 结果是「产品线识别」自动绑上的目录，用户事后在界面上改不掉，只能删了重建。
   */
  folderPath?: string;
}

export const listLines = () =>
  request<{ lines: ProductLine[] }>("/product-lines").then((r) => r.lines);
export const createLine = (fields: Fields) =>
  request<ProductLine>("/product-lines", { method: "POST", ...json(fields) });
export const updateLine = (id: string, fields: Partial<Fields>) =>
  request<ProductLine>(`/product-lines/${id}`, {
    method: "PATCH",
    ...json(fields),
  });
export const deleteLine = (id: string) =>
  request<undefined>(`/product-lines/${id}`, { method: "DELETE" });

export const createProduct = (
  lineId: string,
  fields: Fields & {
    templateId?: string;
    folderPath?: string;
    codePath?: string;
  },
) =>
  request<Product>(`/product-lines/${lineId}/products`, {
    method: "POST",
    ...json(fields),
  });
export const updateProduct = (
  id: string,
  fields: Partial<Fields> & {
    lineId?: string;
    templateId?: string;
    folderPath?: string;
    codePath?: string;
    /** 整组替换；空数组 = 清空。 */
    refPaths?: string[];
  },
) => request<Product>(`/products/${id}`, { method: "PATCH", ...json(fields) });
export const deleteProduct = (id: string) =>
  request<undefined>(`/products/${id}`, { method: "DELETE" });
