import { join } from "node:path";

import type { FileStore } from "../../files/store.js";
import type { Catalog } from "../../products.js";
import type { UiIndex } from "../ui/index.js";
import { openReadOnly, type BrowserDeps } from "./browser.js";
import type { EnvStore } from "./envs.js";
import {
  readVersion,
  versionLabel,
  versionSlug,
  type CodeVersion,
} from "./version.js";

/**
 * 页面快照库：把「产品在某个版本下真实长什么样」存下来。
 *
 * 与文件库、代码库并列，是事实底座里的第三处依据：
 * - **文件库**：人写的文档；**代码库**：源码；
 * - **页面快照库**：浏览器真实渲染后截下来的页面 + 页面文字，**按版本留档**。
 *
 * 为什么单独放：页面长什么样是「事实」，既不在文档里（文档会过期），也不在源码里（源码看不出
 * 实际渲染结果）。而它又必须能回答「这个版本是这样，上个版本是不是这样」——所以每次采集都带
 * 版本标记（提交 / 分支 / 标签 / PR 号），按版本存成一份，历史不覆盖。
 *
 * 存储布局（都在文件库的 `/页面快照/` 下）：
 *   /页面快照/<产品>/<时间-提交号>/manifest.json   这一版的全量清单与版本信息
 *                               /<页面>.jpg         截图
 *                               /<页面>.txt         页面文字结构
 */

export const SNAPSHOT_ROOT = "/页面快照";
const MAX_PAGES = 200;

export interface SnapshotPage {
  path: string;
  title: string | null;
  image: string | null;
  text: string | null;
  status: "ok" | "blank" | "redirected" | "skipped";
  note: string | null;
}

export interface Snapshot {
  /** 版本目录名：`20261028-101500-882917bc2` */
  id: string;
  productId: string;
  productName: string;
  frontendRoot: string | null;
  envId: string;
  /** 采集时的环境地址与身份（给人看「这是哪个环境的视角」） */
  envBaseUrl: string;
  envRole: string;
  /** 版本标记 */
  version: CodeVersion;
  /** 一句话版本说明，如「v2.7.2 · PR #3827（main）」 */
  label: string;
  capturedAt: number;
  folder: string;
  pages: SnapshotPage[];
  /** 采集失败 / 部分失败的原因 */
  error: string | null;
}

export interface CaptureProgress {
  /** 正在跑的后台任务 id；与快照 id 不同（快照要采完才落盘）。 */
  jobId: string;
  stage: "queued" | "login" | "capture" | "done" | "failed" | "cancelled";
  pages: SnapshotPage[];
  error: string | null;
  total: number;
  /** 采集的页面清单总量与已完成数，给界面画进度条。 */
  done: number;
  startedAt: number;
  finishedAt: number | null;
  /** 采完之后落成的快照 id */
  snapshotId: string | null;
}

export interface SnapshotStore {
  /** 某个产品的全部快照版本，最新在前。 */
  list(productId: string): Promise<Snapshot[]>;
  /** 某个快照的明细（读 manifest）。 */
  get(productId: string, id: string): Promise<Snapshot | null>;
  /**
   * 在后台开始采一版：**立即返回任务状态**，采集跑在服务端，关掉页面也继续。
   * 同一个产品同时只允许一个任务，重复发会报错。
   */
  start(input: {
    productId: string;
    frontendRoot: string | null;
    envId: string;
  }): Promise<CaptureProgress>;
  /** 正在跑 / 刚跑完的任务状态（按产品取）。 */
  status(productId: string): CaptureProgress | null;
  /** 停止这个产品正在跑的采集：已采的页保留，但不会生成这一版快照。 */
  cancel(productId: string): Promise<boolean>;
  /** 服务退出时把还在跑的都停掉，别留下浏览器进程。 */
  closeAll(): Promise<void>;
}

interface Job {
  controller: AbortController;
  progress: CaptureProgress;
}

const done = (p: CaptureProgress): boolean =>
  p.stage === "done" || p.stage === "failed" || p.stage === "cancelled";

const slug = (s: string): string =>
  s
    .replace(/[^\w一-龥-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "x";

export function createSnapshotStore(deps: {
  files: FileStore;
  catalog: Catalog;
  ui: UiIndex;
  envs: EnvStore;
  browser?: BrowserDeps;
  now?: () => number;
}): SnapshotStore {
  const now = deps.now ?? Date.now;

  const folderOf = (productName: string, id: string): string =>
    `${SNAPSHOT_ROOT}/${slug(productName)}/${id}`;

  const read = async (path: string): Promise<string | null> => {
    const item = await deps.files
      .item(path, { content: true })
      .catch(() => null);
    return typeof item?.content === "string" ? item.content : null;
  };

  const jobs = new Map<string, Job>();

  return {
    async list(productId) {
      const product = deps.catalog
        .list()
        .flatMap((l) => l.products)
        .find((p) => p.id === productId);
      if (product === undefined) return [];
      const base = `${SNAPSHOT_ROOT}/${slug(product.name)}`;
      const { files: listed } = deps.files.listFilesDeep(base, { limit: 5000 });
      const manifests = listed
        .filter((e) => e.name === "manifest.json")
        .map((e) => e.path)
        .sort()
        .reverse();
      const out: Snapshot[] = [];
      for (const m of manifests) {
        const text = await read(m);
        if (text === null) continue;
        try {
          const s = JSON.parse(text) as Snapshot;
          if (s.productId === productId) out.push(s);
        } catch {
          // 坏掉的 manifest 跳过
        }
      }
      return out.sort((a, b) => b.capturedAt - a.capturedAt);
    },

    async get(productId, id) {
      const all = await this.list(productId);
      return all.find((s) => s.id === id) ?? null;
    },

    async start({ productId, frontendRoot, envId }) {
      const existing = jobs.get(productId);
      if (existing !== undefined && !done(existing.progress))
        throw new Error("这个产品正在采集，先等它跑完或点停止");
      // 先校验再起任务：产品、环境、账号密码任何一样不对都当场报，不留一个必败的后台任务。
      const product = deps.catalog
        .list()
        .flatMap((l) => l.products)
        .find((p) => p.id === productId);
      if (product === undefined) throw new Error("产品不存在");
      const env = deps.envs.get(envId);
      if (env?.productId !== productId)
        throw new Error("这个产品没有登记这个测试环境");
      const cred = await deps.envs.credential(env.id);
      if (cred === null) throw new Error("这个测试环境还没存账号密码");
      const job: Job = {
        controller: new AbortController(),
        progress: {
          jobId: `job_${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
          stage: "queued",
          pages: [],
          error: null,
          total: 0,
          done: 0,
          startedAt: now(),
          finishedAt: null,
          snapshotId: null,
        },
      };
      jobs.set(productId, job);
      // 不等它：采集跑在服务端，页面关了也继续。
      void run(job, {
        product,
        productId,
        frontendRoot,
        envId,
        env,
        cred,
      }).catch(() => undefined);
      return { ...job.progress, pages: [...job.progress.pages] };
    },

    status(productId) {
      const j = jobs.get(productId);
      return j === undefined
        ? null
        : { ...j.progress, pages: [...j.progress.pages] };
    },

    cancel(productId) {
      const j = jobs.get(productId);
      if (j === undefined || done(j.progress)) return Promise.resolve(false);
      j.controller.abort();
      j.progress.stage = "cancelled";
      j.progress.finishedAt = now();
      return Promise.resolve(true);
    },

    closeAll() {
      for (const j of jobs.values())
        if (!done(j.progress)) j.controller.abort();
      return Promise.resolve();
    },
  };

  /** 真正的采集：拆出来，由 start 在后台调用。 */
  async function run(
    job: Job,
    input: {
      product: { name: string; codePath: string | null };
      productId: string;
      frontendRoot: string | null;
      envId: string;
      env: {
        id: string;
        baseUrl: string;
        loginPath: string;
        role: string;
        selectors: Record<string, string | undefined>;
      };
      cred: { username: string; password: string };
    },
  ): Promise<void> {
    const { product, productId, frontendRoot, envId, env, cred } = input;
    const signal = job.controller.signal;
    const progress = job.progress;
    const say = (): void => {
      // 状态对象就地更新；查询方每次拿到的是拷贝。
    };
    void say;
    // 版本：从代码目录读 git；读不到就用空版本（manifest 里如实写 unavailable）。
    const codePath = product.codePath;
    const mountAbs =
      codePath === null
        ? deps.files.root
        : join(deps.files.root, ...codePath.split("/").filter(Boolean));
    const version = await readVersion(mountAbs);
    const capturedAt = now();
    const id = versionSlug(version, capturedAt);
    const folder = folderOf(product.name, id);

    // 页面清单：这个前端有哪些页。
    const pages = await (async (): Promise<
      { path: string; title: string | null }[]
    > => {
      if (codePath === null) return [{ path: "/", title: "首页" }];
      const fes = await deps.ui.frontends(codePath);
      // 指定了前端就只采它；没指定就把这个代码目录里所有前端的页面合起来（按路径去重）——
      // 一个产品下面常有好几个前端（管理端 / 用户端 / 门户），只采一个会漏掉大半。
      const picked =
        frontendRoot === null
          ? fes
          : fes.filter((f) => f.root === frontendRoot);
      if (picked.length === 0) return [{ path: "/", title: "首页" }];
      const seen = new Set<string>();
      const out: { path: string; title: string | null }[] = [];
      for (const fe of picked)
        for (const p of fe.pages) {
          if (p.redirect !== null || seen.has(p.path)) continue;
          seen.add(p.path);
          out.push({ path: p.path, title: p.title });
          if (out.length >= MAX_PAGES) return out;
        }
      return out;
    })();

    progress.stage = "login";
    progress.total = pages.length;

    let browser: Awaited<ReturnType<typeof openReadOnly>> | undefined;
    try {
      browser = await openReadOnly(
        {
          baseUrl: env.baseUrl,
          loginPath: env.loginPath,
          username: cred.username,
          password: cred.password,
          selectors: env.selectors,
        },
        deps.browser,
      );
      progress.stage = "capture";

      for (const p of pages) {
        // 用户点了停止：不再继续开页面，已采的页保留。
        if (signal.aborted) break;
        if (/[:*]/.test(p.path)) {
          progress.pages.push({
            path: p.path,
            title: p.title,
            image: null,
            text: null,
            status: "skipped",
            note: "带参数的页面，没有示例值",
          });
          progress.done += 1;
          continue;
        }
        try {
          const snap = await browser.open(p.path);
          const name = slug(p.path === "/" ? "首页" : p.path);
          const image = `${folder}/${name}.jpg`;
          const textPath = `${folder}/${name}.txt`;
          await deps.files.write(image, snap.screenshot, {
            mode: "overwrite",
            parents: true,
          });
          await deps.files.write(
            textPath,
            Buffer.from(`${snap.url}\n\n${snap.text}`),
            { mode: "overwrite", parents: true },
          );
          const redirected =
            snap.path !== p.path && !snap.path.startsWith(`${p.path}/`);
          const chars = snap.text.replace(/\s+/g, "").length;
          progress.pages.push({
            path: p.path,
            title: p.title,
            image,
            text: textPath,
            status: redirected ? "redirected" : chars < 20 ? "blank" : "ok",
            note: redirected
              ? `被前端跳到了 ${snap.path}`
              : chars < 20
                ? "正文几乎没有字"
                : null,
          });
        } catch (e) {
          progress.pages.push({
            path: p.path,
            title: p.title,
            image: null,
            text: null,
            status: "blank",
            note: e instanceof Error ? e.message : "打不开",
          });
        }
        progress.done += 1;
      }

      // 中途被停：不生成这一版（采了一半的快照当成历史会误导人）。
      if (signal.aborted) {
        progress.stage = "cancelled";
        progress.finishedAt = now();
        return;
      }

      const doneSnap: Snapshot = {
        id,
        productId,
        productName: product.name,
        frontendRoot,
        envId,
        envBaseUrl: env.baseUrl,
        envRole: env.role,
        version,
        label: versionLabel(version),
        capturedAt,
        folder,
        pages: progress.pages,
        error: null,
      };
      await deps.files.write(
        `${folder}/manifest.json`,
        Buffer.from(JSON.stringify(doneSnap, null, 2)),
        { mode: "overwrite", parents: true },
      );
      progress.stage = "done";
      progress.snapshotId = doneSnap.id;
      progress.finishedAt = now();
    } catch (e) {
      if (signal.aborted) {
        progress.stage = "cancelled";
      } else {
        progress.stage = "failed";
        progress.error = e instanceof Error ? e.message : "采集失败";
      }
      progress.finishedAt = now();
    } finally {
      await browser?.close();
    }
  }
}
