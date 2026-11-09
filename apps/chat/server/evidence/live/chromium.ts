import { spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * 浏览器内核：系统自己带一个，不依赖这台机器碰巧装了什么。
 *
 * 查找顺序（先找到先用）：
 * 1. `PMFORGE_CHROMIUM` —— 手工指定（部署到别的机器时可以指到系统装的 Chrome）；
 * 2. 数据目录 `browsers/` —— 本服务自己装的那份（界面上的「安装浏览器」装到这里）；
 * 3. `~/.cache/ms-playwright/chromium-*` —— 机器上已有 playwright 缓存时直接借用，不必再下一份。
 *
 * 都找不到时 `installBrowser()` 按下面的顺序装：
 * - 从机器上已有的 playwright 缓存**复制**（最快，不联网）；
 * - 否则从 npm 包对应的官方地址下载（主站被墙时自动换微软的备用站，支持断点续传）。
 */

const CANDIDATES = [
  ["chrome-linux64", "chrome"],
  ["chrome-linux", "chrome"],
  ["chrome-headless-shell-linux64", "chrome-headless-shell"],
] as const;

/** 一个目录里有没有可执行的浏览器。 */
export function findBinaryIn(dir: string): string | null {
  for (const [sub, bin] of CANDIDATES) {
    const p = join(dir, sub, bin);
    if (existsSync(p)) return p;
  }
  return null;
}

function versionedDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => /^chromium(-headless_shell)?-\d+$/.test(d))
    .sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()))
    .map((d) => join(root, d));
}

export interface BrowserInfo {
  /** 可执行文件路径；null = 没找到。 */
  path: string | null;
  /** 从哪来的：手工指定 / 服务自带 / 机器上的 playwright 缓存。 */
  source: "env" | "bundled" | "system-cache" | null;
  /** 数据目录里那份装没装（界面据此决定按钮显示「安装」还是「已就绪」）。 */
  bundled: boolean;
}

export function findBrowser(dataDir: string): BrowserInfo {
  const env = process.env.PMFORGE_CHROMIUM;
  if (env !== undefined && env !== "" && existsSync(env))
    return { path: env, source: "env", bundled: false };

  const own = join(dataDir, "browsers");
  for (const dir of versionedDirs(own)) {
    const bin = findBinaryIn(dir);
    if (bin !== null) return { path: bin, source: "bundled", bundled: true };
  }
  for (const dir of versionedDirs(join(homedir(), ".cache", "ms-playwright"))) {
    const bin = findBinaryIn(dir);
    if (bin !== null)
      return { path: bin, source: "system-cache", bundled: false };
  }
  return { path: null, source: null, bundled: existsSync(own) };
}

const DOWNLOAD_HOSTS = [
  "https://playwright.download.prss.microsoft.com",
  "https://cdn.playwright.dev",
];

/**
 * 下载用哪个地址：官方主站国内常常连不上（实测超时），先走微软的备用站。
 * 返回的是 playwright 自己的安装脚本认的「主机前缀」形式。
 */
export function downloadHost(): string | undefined {
  return process.env.PMFORGE_BROWSER_HOST ?? DOWNLOAD_HOSTS[0];
}

export interface InstallResult {
  ok: boolean;
  path: string | null;
  /** 给人看的进度 / 失败原因，逐行。 */
  log: string[];
}

/** 在 playwright 的缓存里找一份可以复制过来的（含无头内核）。 */
async function copyFromCache(
  dataDir: string,
  log: (s: string) => void,
): Promise<string | null> {
  const cache = join(homedir(), ".cache", "ms-playwright");
  const target = join(dataDir, "browsers");
  for (const dir of versionedDirs(cache)) {
    const bin = findBinaryIn(dir);
    if (bin === null) continue;
    const name = basename(dir);
    log(`从本机缓存复制 ${name}…`);
    await mkdir(target, { recursive: true });
    await cp(dir, join(target, name), {
      recursive: true,
      errorOnExist: false,
      force: true,
    });
    const copied = findBinaryIn(join(target, name));
    if (copied !== null) {
      log(`已复制到 ${join(target, name)}`);
      return copied;
    }
  }
  return null;
}

/** 用 playwright 自带的安装脚本下载（支持指定主机、自动重试一次）。 */
function runInstaller(
  dataDir: string,
  host: string,
  log: (s: string) => void,
): Promise<boolean> {
  const cli = join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "node_modules",
    "playwright-core",
    "cli.js",
  );
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [cli, "install", "--only-shell", "chromium"],
      {
        env: {
          ...process.env,
          PLAYWRIGHT_BROWSERS_PATH: join(dataDir, "browsers"),
          PLAYWRIGHT_DOWNLOAD_HOST: host,
        },
      },
    );
    const relay = (chunk: Buffer): void => {
      const text = chunk.toString();
      const last = text
        .trim()
        .split("\n")
        .filter((l) => l.trim() !== "")
        .slice(-1)[0];
      if (last !== undefined) log(last.slice(0, 160));
    };
    child.stdout.on("data", relay);
    child.stderr.on("data", relay);
    child.on("error", (e) => {
      log(`启动安装脚本失败：${e.message}`);
      resolve(false);
    });
    child.on("close", (code) => {
      resolve(code === 0);
    });
  });
}

/**
 * 安装浏览器内核到数据目录。先复制本机缓存（快），没有再下载。
 * 下载慢是常态（实测主站连不上、备用站约 8 KB/s），所以界面必须能显示进度、能放弃。
 */
export async function installBrowser(
  dataDir: string,
  onLog: (line: string) => void = () => {
    /* 默认不输出 */
  },
): Promise<InstallResult> {
  const log = (s: string): void => {
    onLog(s);
  };
  const already = findBrowser(dataDir);
  if (already.path !== null && already.source === "bundled")
    return { ok: true, path: already.path, log: ["服务自带的内核已经就绪"] };

  const copied = await copyFromCache(dataDir, log);
  if (copied !== null)
    return { ok: true, path: copied, log: ["已就绪（从本机缓存复制）"] };

  log("本机缓存里没有可复制的内核，开始下载…");
  const hosts = [downloadHost(), ...DOWNLOAD_HOSTS].filter(
    (h): h is string => h !== undefined,
  );
  for (const host of [...new Set(hosts)]) {
    log(`下载源：${host}`);
    if (await runInstaller(dataDir, host, log)) {
      const found = findBrowser(dataDir);
      if (found.path !== null)
        return { ok: true, path: found.path, log: ["下载完成"] };
    }
  }
  return {
    ok: false,
    path: null,
    log: [
      "下载失败：官方下载站在这台机器上连不上或速度过慢。",
      "可以改用任一办法：",
      `1) 把已装好的 playwright 缓存放到 ${join(dataDir, "browsers")}；`,
      "2) 设置 PMFORGE_BROWSER_HOST 指向可用的镜像；",
      "3) 设置 PMFORGE_CHROMIUM 指向本机任意 Chrome / Chromium。",
    ],
  };
}

/** 内核大小（MB），给界面显示。 */
export function browserSizeMb(dataDir: string): number {
  const dir = join(dataDir, "browsers");
  const sum = (p: string): number => {
    try {
      const st = statSync(p);
      if (!st.isDirectory()) return st.size;
      return readdirSync(p).reduce((n, f) => n + sum(join(p, f)), 0);
    } catch {
      return 0;
    }
  };
  return Math.round(sum(dir) / 1024 / 1024);
}

/** 删除服务自带的内核（省磁盘 / 重装）。 */
export async function removeBrowser(dataDir: string): Promise<void> {
  await rm(join(dataDir, "browsers"), { recursive: true, force: true });
}
