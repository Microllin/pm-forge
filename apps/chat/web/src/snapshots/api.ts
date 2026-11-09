import { createRequest, json } from "../http";

/** 页面快照库。形状与 server/evidence/live/snapshot-routes.ts 一一对应。 */

const request = createRequest("/api");

export interface CodeVersion {
  commit: string | null;
  short: string | null;
  branch: string | null;
  tag: string | null;
  pr: number | null;
  dirty: boolean;
  subject: string | null;
  committedAt: number | null;
  unavailable: string | null;
}

export interface SnapshotPage {
  path: string;
  title: string | null;
  image: string | null;
  text: string | null;
  status: "ok" | "blank" | "redirected" | "skipped";
  note: string | null;
}

export interface Snapshot {
  id: string;
  productId: string;
  productName: string;
  frontendRoot: string | null;
  envId: string;
  envBaseUrl: string;
  envRole: string;
  version: CodeVersion;
  label: string;
  capturedAt: number;
  folder: string;
  pages: SnapshotPage[];
  error: string | null;
}

export const listSnapshots = (productId: string) =>
  request<{ snapshots: Snapshot[] }>(`/products/${productId}/snapshots`).then(
    (r) => r.snapshots,
  );

export interface CaptureJob {
  jobId: string;
  stage: "queued" | "login" | "capture" | "done" | "failed" | "cancelled";
  pages: SnapshotPage[];
  error: string | null;
  total: number;
  done: number;
  startedAt: number;
  finishedAt: number | null;
  snapshotId: string | null;
}

/** 开始采集：立即返回任务，采集在服务端后台跑（关掉页面也继续）。 */
export const startCapture = (
  productId: string,
  envId: string,
  frontendRoot?: string,
) =>
  request<{ job: CaptureJob }>(`/products/${productId}/snapshots/capture`, {
    method: "POST",
    ...json({ envId, ...(frontendRoot === undefined ? {} : { frontendRoot }) }),
  });

/** 当前进度；没有任务时为 null。 */
export const captureStatus = (productId: string) =>
  request<{ job: CaptureJob | null }>(
    `/products/${productId}/snapshots/job`,
  ).then((r) => r.job);

export const cancelCapture = (productId: string) =>
  request<{ cancelled: boolean }>(`/products/${productId}/snapshots/cancel`, {
    method: "POST",
    ...json({}),
  });

export const shotUrl = (path: string): string =>
  `/api/files/raw?path=${encodeURIComponent(path)}`;

export { json };
