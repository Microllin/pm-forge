/**
 * 产品 Wiki 的接口。形状与 server/wiki-routes.ts 一一对应。
 */
import { createRequest, json } from "../http";

export { ApiError } from "../http";

const request = createRequest("/api");

export interface WikiNode {
  id: string;
  parentId: string | null;
  title: string;
  brief: string;
  /** 这一章要精读的路径。写正文时只对它们读源文件正文。空 = 没指定。 */
  sources: string[];
  /** 显示编号（`01` / `06.2`），服务端按位次算，不入库。 */
  number: string;
  /** 正文长度。0 = 还没写。 */
  length: number;
  source: "ai" | "manual";
  sessionId: string | null;
  updatedAt: number;
  children: WikiNode[];
}

export interface WikiPage extends Omit<WikiNode, "children"> {
  content: string;
  path: { id: string; title: string; number: string }[];
}

export const listWiki = (productId: string) =>
  request<{ pages: WikiNode[] }>(`/products/${productId}/wiki`).then(
    (r) => r.pages,
  );

export const getWikiPage = (id: string) =>
  request<WikiPage>(`/wiki-pages/${id}`);

export const createWikiPage = (
  productId: string,
  fields: { title: string; brief?: string; parentId?: string | null },
) =>
  request<WikiNode>(`/products/${productId}/wiki`, {
    method: "POST",
    ...json(fields),
  });

export const updateWikiPage = (
  id: string,
  fields: {
    title?: string;
    brief?: string;
    content?: string;
    sources?: string[];
  },
) =>
  request<WikiNode>(`/wiki-pages/${id}`, { method: "PATCH", ...json(fields) });

export const deleteWikiPage = (id: string) =>
  request<undefined>(`/wiki-pages/${id}`, { method: "DELETE" });

export const moveWikiPage = (id: string, delta: -1 | 1) =>
  request<{ pages: WikiNode[] }>(`/wiki-pages/${id}/move`, {
    method: "POST",
    ...json({ delta }),
  });

/** 恢复出厂目录。有写过正文的页时服务端先 409，确认后带 force 重试。 */
export const resetWiki = (productId: string, force = false) =>
  request<{ pages: WikiNode[] }>(`/products/${productId}/wiki/reset`, {
    method: "POST",
    ...json({ force }),
  });
