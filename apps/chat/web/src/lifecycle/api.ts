/**
 * 生命周期规范（产品菜单下的二级页）的接口。形状与 server/lifecycle-routes.ts 一一对应。
 *
 * 判定要点与文件线索在传输上是**多行文本**（一行一条），返回时是数组：
 * 界面上它们就是一个 textarea，不值得为「一行」造一个结构化编辑器。
 */

import { createRequest, json } from "../http";

export { ApiError } from "../http";

const request = createRequest("/api");

export interface Artifact {
  id: string;
  stageId: string;
  name: string;
  required: boolean;
  guide: string;
  checkpoints: string[];
  fileHints: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Stage {
  id: string;
  templateId: string;
  code: string;
  label: string;
  question: string;
  createdAt: number;
  updatedAt: number;
  artifacts: Artifact[];
}

export interface Template {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
  stages: Stage[];
  productCount: number;
}

export interface TemplateFields {
  name: string;
  description: string;
}
export interface StageFields {
  code: string;
  label: string;
  question: string;
}
export interface ArtifactFields {
  name: string;
  required: boolean;
  guide: string;
  /** 多行文本，一行一条。 */
  checkpoints: string;
  /** 多行文本，一行一条。 */
  fileHints: string;
}

export const listTemplates = () =>
  request<{ templates: Template[] }>("/lifecycle-templates").then(
    (r) => r.templates,
  );
export const createTemplate = (fields: TemplateFields) =>
  request<Template>("/lifecycle-templates", {
    method: "POST",
    ...json(fields),
  });
export const updateTemplate = (id: string, fields: Partial<TemplateFields>) =>
  request<Template>(`/lifecycle-templates/${id}`, {
    method: "PATCH",
    ...json(fields),
  });
export const deleteTemplate = (id: string) =>
  request<undefined>(`/lifecycle-templates/${id}`, { method: "DELETE" });
export const duplicateTemplate = (id: string) =>
  request<Template>(`/lifecycle-templates/${id}/duplicate`, { method: "POST" });
export const resetTemplate = (id: string) =>
  request<Template>(`/lifecycle-templates/${id}/reset`, { method: "POST" });

export const createStage = (templateId: string, fields: StageFields) =>
  request<Template>(`/lifecycle-templates/${templateId}/stages`, {
    method: "POST",
    ...json(fields),
  });
export const updateStage = (id: string, fields: Partial<StageFields>) =>
  request<Template>(`/lifecycle-stages/${id}`, {
    method: "PATCH",
    ...json(fields),
  });
export const deleteStage = (id: string) =>
  request<Template>(`/lifecycle-stages/${id}`, { method: "DELETE" });
export const moveStage = (id: string, delta: -1 | 1) =>
  request<Template>(`/lifecycle-stages/${id}/move`, {
    method: "POST",
    ...json({ delta }),
  });

export const createArtifact = (stageId: string, fields: ArtifactFields) =>
  request<Template>(`/lifecycle-stages/${stageId}/artifacts`, {
    method: "POST",
    ...json(fields),
  });
export const updateArtifact = (id: string, fields: Partial<ArtifactFields>) =>
  request<Template>(`/lifecycle-artifacts/${id}`, {
    method: "PATCH",
    ...json(fields),
  });
export const deleteArtifact = (id: string) =>
  request<Template>(`/lifecycle-artifacts/${id}`, { method: "DELETE" });
