import type { FileStore } from "../files/store.js";

/**
 * 目录采集：把文件模块里的一棵目录读成一段「给模型看的事实」。
 *
 * ## 为什么由服务端采集，而不是让 AI 自己去翻
 *
 * 3200 的对话会话**没有文件工具**（`pi/runtime.ts` 里 `noTools: "all"`，白名单只放 skill）。
 * 这不是疏漏，是边界：一旦给 agent 开 read/bash，files/paths.ts 那套软链与越界闸就被绕过了。
 * 所以事实由这里摘出来喂进提示词——附带好处是扫描面、字节上限、到底读了哪些文件都写得死，
 * 出了错能复查，不用去猜模型当时翻了什么。
 *
 * ## 不假设仓库是「标准的」
 *
 * 有 `product.yaml` 就吃它，没有就只靠目录结构 + README。所以采集分两层：
 * - **骨架**：有界的目录树（深度、每层条数、总条数都有上限）
 * - **说明文件正文**：路径上遇到的 README / *.yaml / *.json / *.toml，每份截断后原样附上
 *
 * 两层都给，模型自己判断哪层可信。只有目录名时它也能工作，只是描述会糙一些。
 */

/** 树的最大深度。3 层够看出「产线 / 产品 / 产品内分类」，再深都是文档明细。 */
const MAX_DEPTH = 3;
/** 单个目录最多列多少条。超了只报总数，不逐条列——长尾对判断产品边界没有帮助。 */
const MAX_ENTRIES_PER_DIR = 40;
/** 整棵树最多多少个节点。 */
const MAX_NODES = 600;
/** 说明文件最多读几份。 */
const MAX_DOC_FILES = 10;
/** 单份说明文件最多取多少字符。 */
const MAX_DOC_CHARS = 3000;
/** 骨架（目录树）的字符上限。 */
const MAX_OUTLINE_CHARS = 20_000;
/** 所有说明文件加起来的上限（字符，不是字节；中文一个字 3 字节）。 */
const MAX_DOC_TOTAL = 12_000;

/** 哪些文件算「说明文件」——它们描述这个目录是什么，正文值得原样喂进去。 */
function isDocFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("readme")) return true;
  return (
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".json") ||
    lower.endsWith(".toml")
  );
}

/**
 * 依赖与构建产物目录：列名字、不展开。
 *
 * 它们动辄几万个文件，又全是第三方或机器生成的，对判断「这个产品做了什么」毫无帮助，
 * 却会把节点预算吃光。隐藏目录（`.next`、`.venv`…）已被文件模块过滤，这里只管非隐藏的。
 */
const NOISE_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  "dist",
  "coverage",
  "__pycache__",
  "target",
  "site-packages",
]);

export function isNoiseDir(name: string): boolean {
  return NOISE_DIRS.has(name.toLowerCase());
}

const join = (parent: string, name: string): string =>
  parent === "/" ? `/${name}` : `${parent}/${name}`;

/* ── 凭据防线 ────────────────────────────────────────────────────────
 *
 * 这是**本地优先产品的信任根基**，不是合规摆设：采集到的正文会被拼进提示词发给
 * 远端 provider，并落进会话库长期留存。用户刚把真实代码仓传进来，一次「分析功能架构」
 * 就可能把仓库根部的密钥明文发出去。
 *
 * 已有的一道防线是文件模块的隐藏文件过滤（`store.ts` 的 visibleChildren 过滤
 * 以点开头的名字），它挡掉了 `.env` / `.git/config` / `.npmrc` / `.aws/` 这批。
 * **但非隐藏的那批挡不住**，而真实仓库里带凭据的恰恰多在这一批。
 *
 * 所以这里加两道：按文件名拒绝、按正文特征拒绝。命中只报文件名、不报正文——
 * 「这个文件存在」本身对判断架构是有用的，泄的是内容。
 */

/** 按名字就该拒的。都是真实项目里常见、且确实装凭据的。 */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /^docker-compose(\.[\w-]+)?\.ya?ml$/i, // environment: 里的库密码与第三方 key
  /^application(-[\w-]+)?\.ya?ml$/i, // Spring：datasource 口令、JWT secret
  /^appsettings(\.[\w-]+)?\.json$/i, // .NET：连接串
  /^local\.settings\.json$/i, // Azure Functions
  /^(service-?account|credentials|client_secret.*)\.json$/i, // GCP：PEM 私钥明文
  /^auth\.json$/i, // Composer registry token
  /postman_collection\.json$/i, // 导出的 collection 常带 Bearer token
  /^values(-[\w-]+)?\.ya?ml$/i, // Helm：base64 口令 == 明文
  /^secrets?\.ya?ml$/i,
  /^wrangler\.toml$/i,
  /^vercel\.json$/i,
  /^group_vars$/i,
];

/** 正文特征。名字没命中但内容像凭据的，照样只报文件名。 */
const SECRET_CONTENT_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/, // GitHub token
  /\bsk-[A-Za-z0-9]{20,}/, // OpenAI 风格
  /["']?(password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)["']?\s*[:=]\s*["'][^"'\s]{6,}/i,
];

export interface SkippedDoc {
  path: string;
  /** 为什么跳过——界面上要能说清，否则用户以为是漏读了。 */
  reason: "名称疑似凭据文件" | "正文疑似含凭据";
}

export function secretByName(name: string): boolean {
  return SECRET_NAME_PATTERNS.some((re) => re.test(name));
}
export function secretByContent(text: string): boolean {
  return SECRET_CONTENT_PATTERNS.some((re) => re.test(text));
}

export interface ScanResult {
  /** 采集的根路径（文件模块里的路径）。 */
  root: string;
  /** 目录树，每行形如 `  - 01-products/`。 */
  outline: string;
  /** 说明文件正文，已截断。 */
  docs: { path: string; content: string; truncated: boolean }[];
  /** 因疑似含凭据而**只报名字不报正文**的。要如实报给用户，不能静默。 */
  skipped: SkippedDoc[];
  /** 为了让人能复查：实际走了多少目录、树是不是被上限截过。 */
  stats: { dirs: number; nodes: number; truncated: boolean };
}

/**
 * 采集一棵目录。
 *
 * `onlyFolders` 给「识别产线与产品」用——那一步只关心目录骨架，列出几百个
 * PRD 文件名既费 token 又把真正的信号淹掉。比对产出物时要看文件名，置 false。
 */
export async function scanFolder(
  files: FileStore,
  root: string,
  options: { onlyFolders?: boolean; maxDepth?: number } = {},
): Promise<ScanResult> {
  const onlyFolders = options.onlyFolders ?? false;
  const maxDepth = options.maxDepth ?? MAX_DEPTH;
  const lines: string[] = [];
  const docPaths: { path: string; depth: number }[] = [];
  const stats = { dirs: 0, nodes: 0, truncated: false };

  /*
   * **广度优先选点，深度优先渲染。**
   *
   * 原来是纯深度优先 + 全局 600 节点上限：第一个顶层目录（往往是 `apps/`）一路钻到底，
   * 把预算吃光，后面的 `server/`、`infra/`、`deploy/` 连名字都出不来。真实仓库
   * 上实测：600 个节点全耗在 `apps/` 里，最后一截还是 `apps/docs/node_modules`
   * 下的 `@types/*`——模型据此判断「没看到代码目录树」，wiki 里代码相关章全被打成 uncertain。
   *
   * 现在先按层铺开：根下每个目录都至少露出名字，预算从浅往深花；渲染时再按树形缩进输出，
   * 读起来和原来一样。
   */
  /** 每个已列出目录的子项。`folder` 有值表示这一行是可展开的子目录。 */
  const children = new Map<string, { text: string; folder?: string }[]>();
  let frontier: string[] = [root];
  for (let depth = 0; frontier.length > 0; depth += 1) {
    if (depth > maxDepth) {
      // 深度超限也算截断：被砍掉的那一层不代表不存在。
      stats.truncated = true;
      break;
    }
    const next: string[] = [];
    for (const path of frontier) {
      if (stats.nodes >= MAX_NODES) {
        stats.truncated = true;
        break;
      }
      const { entries } = await files.list(path);
      stats.dirs += 1;
      /*
       * **说明文件先从全量里登记，再做条数截断。**
       *
       * files.list 把文件夹排在全部文件前面。若只在截断后的 shown 里登记，
       * 子目录数 ≥ 40 时同层的 product.yaml / README.md 会整个丢掉——
       * 恰恰是最需要靠声明文件判边界的大目录。
       */
      for (const entry of entries) {
        if (entry.kind !== "folder" && isDocFile(entry.name))
          docPaths.push({ path: join(path, entry.name), depth });
      }
      const shown = entries.slice(0, MAX_ENTRIES_PER_DIR);
      if (entries.length > shown.length) stats.truncated = true;
      const own: { text: string; folder?: string }[] = [];
      children.set(path, own);
      /** 预算在本目录中途用完时，停在第几条。没停就是 shown 全部走完。 */
      let reached = shown.length;
      for (const [i, entry] of shown.entries()) {
        if (stats.nodes >= MAX_NODES) {
          stats.truncated = true;
          reached = i;
          break;
        }
        const child = join(path, entry.name);
        if (entry.kind === "folder") {
          stats.nodes += 1;
          if (isNoiseDir(entry.name)) {
            // 名字照列（「有依赖目录」本身是事实），但不展开——里面是别人的代码。
            own.push({ text: `- ${entry.name}/（依赖或构建产物，未展开）` });
            continue;
          }
          own.push({ text: `- ${entry.name}/`, folder: child });
          next.push(child);
          continue;
        }
        if (onlyFolders && !isDocFile(entry.name)) continue;
        stats.nodes += 1;
        own.push({ text: `- ${entry.name}` });
      }
      const hidden = entries.length - reached;
      if (hidden > 0)
        own.push({ text: `  …（本目录还有 ${String(hidden)} 条未列出）` });
    }
    frontier = next;
  }

  /** 按树形渲染：每个目录的子项紧跟在它下面，缩进表示层级。 */
  const render = (path: string, depth: number): void => {
    const own = children.get(path);
    if (!own) return;
    const indent = "  ".repeat(depth);
    for (const item of own) {
      lines.push(`${indent}${item.text}`);
      if (item.folder !== undefined) render(item.folder, depth + 1);
    }
  };
  render(root, 0);

  /*
   * 骨架的字符上限。原本只有深度与条数两道闸：600 节点 × 文件名最长 255 字节
   * ≈ 150 KB outline，足够把提示词撑爆。这是第三道。
   */
  let outline = lines.join("\n");
  if (outline.length > MAX_OUTLINE_CHARS) {
    outline = `${outline.slice(0, MAX_OUTLINE_CHARS)}\n…（目录树过长，已截断）`;
    stats.truncated = true;
  }

  const docs: ScanResult["docs"] = [];
  const skipped: SkippedDoc[] = [];
  let budget = MAX_DOC_TOTAL;
  /**
   * **浅的先读**。根上的 `product.yaml`、每个产品目录的 README 才是判断产品边界的信号；
   * `_archive/legacy-.../README.md` 这种深处的说明不应该把预算吃掉。按目录序遍历的话，
   * 先遭遇的恰好是深处那些（深度优先），所以这里必须重排。
   */
  const ordered = [...docPaths].sort(
    (a, b) => a.depth - b.depth || a.path.localeCompare(b.path),
  );
  for (const { path } of ordered.slice(0, MAX_DOC_FILES)) {
    if (budget <= 0) break;
    const name = path.slice(path.lastIndexOf("/") + 1);
    // 第一道：按名字。连读都不读——读进内存再丢弃没有意义，而且日志里会留痕。
    if (secretByName(name)) {
      skipped.push({ path, reason: "名称疑似凭据文件" });
      continue;
    }
    const item = await files.item(path, { content: true }).catch(() => null);
    const raw = item?.content;
    if (typeof raw !== "string" || raw.trim() === "") continue;
    // 第二道：按正文特征。名字看着无辜但内容像凭据的（随手放的 config.json 之类）。
    if (secretByContent(raw)) {
      skipped.push({ path, reason: "正文疑似含凭据" });
      continue;
    }
    const limit = Math.min(MAX_DOC_CHARS, budget);
    const content = raw.slice(0, limit);
    budget -= content.length;
    docs.push({ path, content, truncated: content.length < raw.length });
  }

  return { root, outline, docs, stats, skipped };
}

/** 把采集结果渲染成提示词里的「事实」段。模型只看这一段，不看别的。 */
export function renderScan(scan: ScanResult): string {
  const parts = [
    `<目录事实 根="${scan.root}">`,
    scan.outline === "" ? "（这个目录是空的）" : scan.outline,
  ];
  if (scan.stats.truncated)
    parts.push(
      "（注意：目录过大，上面的树已被截断——没列出的部分不代表不存在，不要据此断言「缺少某某」）",
    );
  parts.push("</目录事实>");
  for (const doc of scan.docs) {
    parts.push(
      "",
      `<说明文件 路径="${doc.path}"${doc.truncated ? ' 截断="是"' : ""}>`,
      doc.content,
      "</说明文件>",
    );
  }
  if (scan.skipped.length > 0) {
    // 只给名字不给正文：文件存在这件事对判断架构有用，泄的是内容。
    // 也要明说「不是不存在」，否则模型会把它当缺失。
    parts.push(
      "",
      '<未读取的文件 原因="疑似含凭据，只给文件名不给正文">',
      ...scan.skipped.map((d) => `- ${d.path}（${d.reason}）`),
      "（这些文件是存在的，只是没把正文给你。不要据此判断「缺少配置」。）",
      "</未读取的文件>",
    );
  }
  return parts.join("\n");
}

/* ── 参考资料：目录或单个文件 ─────────────────────────────────────── */

/** 单个参考文件最多取多少字符。比说明文件宽——它就是用户特意挂上来的那份。 */
const MAX_REF_FILE_CHARS = 8000;

/**
 * 采集一条参考资料。目录走 scanFolder；文件就把它当一份说明文件读进来。
 * 判别靠先试 item()：item 只认文件，指到目录上会抛错，再退到 list。
 */
export async function scanRef(
  files: FileStore,
  path: string,
  options: { maxDepth?: number } = {},
): Promise<ScanResult> {
  const item = await files.item(path, { content: true }).catch(() => null);
  if (item === null) return scanFolder(files, path, options);
  const name = path.slice(path.lastIndexOf("/") + 1);
  const empty = { dirs: 0, nodes: 1, truncated: false };
  const base = { root: path, outline: `- ${name}`, stats: empty };
  if (secretByName(name))
    return {
      ...base,
      docs: [],
      skipped: [{ path, reason: "名称疑似凭据文件" }],
    };
  const raw = item.content;
  if (typeof raw !== "string" || raw.trim() === "")
    return { ...base, docs: [], skipped: [] };
  if (secretByContent(raw))
    return {
      ...base,
      docs: [],
      skipped: [{ path, reason: "正文疑似含凭据" }],
    };
  const content = raw.slice(0, MAX_REF_FILE_CHARS);
  return {
    ...base,
    docs: [{ path, content, truncated: content.length < raw.length }],
    skipped: [],
  };
}

/* ── 单章精读：按这一章指定的路径读源文件正文 ───────────────────────
 *
 * 目录树只能告诉模型「有个 ent/schema 目录」，告诉不了它表里有哪些字段。
 * 写「数据模型」「接口清单」这类章节必须看到源文件本身，否则只能看着目录名猜。
 * 但整库读不起（RouteHub 387 MB），所以只读**这一章**指定的那几条路径，
 * 并且每份、总量都封顶。
 */

/** 精读时认哪些扩展名为「值得读的文本」。图片、二进制、锁文件一律不读。 */
const FOCUS_EXTENSIONS: ReadonlySet<string> = new Set([
  "md", "mdx", "txt",
  "go", "ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "svelte",
  "py", "java", "kt", "rs", "rb", "php", "cs", "swift", "scala",
  "sql", "proto", "graphql", "gql", "prisma",
  "yaml", "yml", "json", "toml", "ini", "sh",
]); // prettier-ignore

/** 机器生成、体积大又没有信息量的。 */
const FOCUS_SKIP_NAMES: readonly RegExp[] = [
  /^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|go\.sum|cargo\.lock|poetry\.lock)$/i,
  /\.min\.(js|css)$/i,
  /\.d\.ts$/i,
  /(^|[._-])generated?([._-]|$)/i,
  /\.pb\.go$/i,
];

/** 名字里带这些词的先读：它们最能回答「有哪些表 / 哪些接口 / 怎么路由」。 */
const FOCUS_PRIORITY =
  /readme|schema|model|entity|route|router|handler|controller|api|migration|service|types?\b|config/i;

/** 测试文件排到最后：有信息量（能看出行为），但不该先于实现占预算。 */
const FOCUS_TEST = /(_test\.go|\.test\.[jt]sx?|\.spec\.[jt]sx?|^test_.*\.py)$/i;

/** 单份源文件最多取多少字符。 */
const MAX_FOCUS_FILE_CHARS = 6000;
/** 一章最多读几份源文件。 */
const MAX_FOCUS_FILES = 30;
/** 一章精读的正文总量上限（字符）。约合 2–4 万 token。 */
const MAX_FOCUS_TOTAL = 80_000;
/** 在一个精读目录里最多往下几层找文件。 */
const MAX_FOCUS_DEPTH = 3;
/** 找文件时最多列多少个目录。防一个指到仓库根的路径把整库走一遍。 */
const MAX_FOCUS_DIRS = 200;

export interface FocusResult {
  /** 实际读到的路径（目录或文件），各自的局部目录树。 */
  scans: ScanResult[];
  /** 读到的源文件正文。 */
  files: { path: string; content: string; truncated: boolean }[];
  skipped: SkippedDoc[];
  /** 指定了但读不到的路径（被删、改名）。要如实报，不能静默。 */
  missing: string[];
  /** 候选文件比预算多时，没读的份数。 */
  unread: number;
}

function focusCandidate(name: string): boolean {
  const ext = name.includes(".")
    ? name.slice(name.lastIndexOf(".") + 1).toLowerCase()
    : "";
  if (!FOCUS_EXTENSIONS.has(ext)) return false;
  return !FOCUS_SKIP_NAMES.some((re) => re.test(name));
}

/** 越小越先读：名字带关键词的、浅的、非测试的在前。 */
function focusRank(path: string, depth: number): number {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    (FOCUS_TEST.test(name) ? 100 : 0) +
    (FOCUS_PRIORITY.test(name) ? 0 : 10) +
    depth
  );
}

/** 在一个目录里按层找候选源文件。 */
async function focusFilesIn(
  files: FileStore,
  root: string,
): Promise<{ path: string; depth: number }[]> {
  const found: { path: string; depth: number }[] = [];
  let frontier = [root];
  let listed = 0;
  for (
    let depth = 0;
    depth <= MAX_FOCUS_DEPTH && frontier.length > 0;
    depth += 1
  ) {
    const next: string[] = [];
    for (const dir of frontier) {
      if (listed >= MAX_FOCUS_DIRS) return found;
      listed += 1;
      const { entries } = await files
        .list(dir)
        .catch(() => ({ entries: [] as const }));
      for (const entry of entries) {
        const child = join(dir, entry.name);
        if (entry.kind === "folder") {
          if (!isNoiseDir(entry.name)) next.push(child);
        } else if (focusCandidate(entry.name)) {
          found.push({ path: child, depth });
        }
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * 读一章的精读路径。
 *
 * 顺序：用户/AI **直接点名的文件**最先读，再按排名读目录里找到的文件；
 * 预算花完就停，并报出还有几份没读——让模型知道「没读到」不等于「不存在」。
 */
export async function readFocus(
  files: FileStore,
  paths: readonly string[],
): Promise<FocusResult> {
  const scans: ScanResult[] = [];
  const named: string[] = [];
  const found: { path: string; depth: number }[] = [];
  const missing: string[] = [];

  for (const path of paths) {
    const item = await files.item(path).catch(() => null);
    if (item !== null) {
      named.push(path);
      continue;
    }
    const scan = await scanFolder(files, path, {
      maxDepth: MAX_FOCUS_DEPTH,
    }).catch(() => null);
    if (scan === null) {
      missing.push(path);
      continue;
    }
    scans.push(scan);
    found.push(...(await focusFilesIn(files, path)));
  }

  const ordered = [
    ...named,
    ...found
      .sort(
        (a, b) =>
          focusRank(a.path, a.depth) - focusRank(b.path, b.depth) ||
          a.path.localeCompare(b.path),
      )
      .map((f) => f.path),
  ];
  const queue = [...new Set(ordered)];

  const out: FocusResult["files"] = [];
  const skipped: SkippedDoc[] = [];
  let budget = MAX_FOCUS_TOTAL;
  let index = 0;
  for (; index < queue.length; index += 1) {
    if (out.length >= MAX_FOCUS_FILES || budget <= 0) break;
    const path = queue[index] ?? "";
    const name = path.slice(path.lastIndexOf("/") + 1);
    if (secretByName(name)) {
      skipped.push({ path, reason: "名称疑似凭据文件" });
      continue;
    }
    const item = await files.item(path, { content: true }).catch(() => null);
    const raw = item?.content;
    if (typeof raw !== "string" || raw.trim() === "") continue;
    if (secretByContent(raw)) {
      skipped.push({ path, reason: "正文疑似含凭据" });
      continue;
    }
    const content = raw.slice(0, Math.min(MAX_FOCUS_FILE_CHARS, budget));
    budget -= content.length;
    out.push({ path, content, truncated: content.length < raw.length });
  }

  return {
    scans,
    files: out,
    skipped,
    missing,
    unread: queue.length - index,
  };
}

/** 渲染成提示词段。外层标签与 <目录事实> 区分开，让模型知道这是本章的重点。 */
export function renderFocus(focus: FocusResult): string {
  const parts: string[] = [];
  for (const scan of focus.scans)
    parts.push(renderScan(scan).replace("<目录事实", "<本章目录"));
  for (const file of focus.files) {
    const ext = file.path.includes(".")
      ? file.path.slice(file.path.lastIndexOf(".") + 1)
      : "";
    parts.push(
      "",
      `<源文件 路径="${file.path}"${file.truncated ? ' 截断="是"' : ""}>`,
      // 四个反引号：源文件里本身就可能有 ``` 围栏（Markdown 文档、注释里的示例）。
      `\`\`\`\`${ext}`,
      file.content,
      "````",
      "</源文件>",
    );
  }
  if (focus.unread > 0)
    parts.push(
      "",
      `（本章精读路径下还有 ${String(focus.unread)} 份文件因篇幅上限没有读——没读到不代表不存在，不要据此断言「没有」。）`,
    );
  if (focus.skipped.length > 0)
    parts.push(
      "",
      '<未读取的文件 原因="疑似含凭据，只给文件名不给正文">',
      ...focus.skipped.map((d) => `- ${d.path}（${d.reason}）`),
      "</未读取的文件>",
    );
  if (focus.missing.length > 0)
    parts.push(
      "",
      "<读不到的精读路径>",
      ...focus.missing.map((p) => `- ${p}`),
      "（这些路径被指定为本章资料，但现在读不到——可能被删或改名。正文里要说明这部分没能核实。）",
      "</读不到的精读路径>",
    );
  return parts.join("\n");
}
