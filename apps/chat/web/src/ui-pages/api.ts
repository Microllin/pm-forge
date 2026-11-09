/**
 * 产品 → 页面（前端视角）的接口。形状与 server/evidence/ui/routes.ts 一一对应。
 */

import { createRequest } from "../http";

const request = createRequest("/api");

export type RouterFormat = "vue-router" | "react-router" | "nuxt" | "next";

export interface UiPage {
  path: string;
  name: string | null;
  title: string | null;
  titleFrom: "literal" | "i18n" | "heading" | "parent" | null;
  section: string | null;
  access: string[];
  component: string | null;
  redirect: string | null;
  aliases: string[];
  source: string;
  titleKey: string | null;
  parent?: string;
}

export interface FrontendSummary {
  root: string;
  label: string;
  format: RouterFormat;
  entry: string;
  pages: number;
  redirects: number;
  untitled: number;
  messages: number;
  unparsed: { count: number; samples: string[] };
}

export interface FrontendDetail extends FrontendSummary {
  pageList: UiPage[];
}

export const listFrontends = (productId: string) =>
  request<{ codePath: string | null; frontends: FrontendSummary[] }>(
    `/products/${productId}/ui`,
  );

export const getFrontend = (productId: string, root: string) =>
  request<FrontendDetail>(
    `/products/${productId}/ui/pages?root=${encodeURIComponent(root)}`,
  );
