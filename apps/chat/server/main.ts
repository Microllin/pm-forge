import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { createApp } from "./app.js";
import { createAgentStore, defaultAgentTargets } from "./agents.js";
import { RESTART_EXIT_CODE, loadConfig } from "./config.js";
import { openDb } from "./db.js";
import { CODE_ROOT_NAME } from "./files/paths.js";
import { STAGING_DIRS } from "./staging/paths.js";
import { createFileStore, openFilesIndex } from "./files/store.js";
import { createKeyStore } from "./model-config.js";
import { piRoutes } from "./pi/upgrade-routes.js";
import { piPaths } from "./pi/runtime.js";
import { createSkillStore, defaultSkillTargets } from "./skills.js";
import { allSkills, promptCost } from "./pi/skills.js";
import { seedBuiltinAgents } from "./agent-team/builtin.js";

/**
 * 服务入口。由 supervisor 拉起（见 supervisor.ts），不要直接 node 它——
 * 升级 pi 后的重启依赖 supervisor。
 */
const config = loadConfig();
/*
 * 数据目录只给自己的账户用。
 *
 * 里面是全部产品文档、代码库、测试环境截图、对话库与密码哈希。默认按 umask 建出来是
 * 755/644，同机其他用户（同事的 SSH 账号、CI 账号）`cat` 一下就能全拿走。keys/ 与 envs/
 * 一直是 700/600，根目录反而没设。存量目录不会重建，所以这里无条件收紧一次。
 */
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
try {
  chmodSync(config.dataDir, 0o700);
} catch {
  // 某些挂载不支持权限位：加固失败不阻断启动。
}
const db = openDb(join(config.dataDir, "chat.db"));
const paths = piPaths(config.dataDir);
// 首批内置智能体只播一次：之后用户改了删了都以用户为准（见 agent-team/builtin.ts）。
seedBuiltinAgents(db, paths.agentsDir);

/*
 * 文件模块：文件放在 {数据目录}/files，索引在 files.db（可随时删掉重建）。
 * 根目录取真实路径——数据目录若经过软链（如 macOS 的 /tmp），不解析的话
 * 「路径上不许有软链」这条安全规则会把根目录自己拒掉。
 */
mkdirSync(join(config.dataDir, "files"), { recursive: true });
/*
 * 「事实底座」下的两个入口共用这一个库：「文件」从根起，「代码」从 CODE_ROOT 起。
 * 这里把那个目录先建出来——否则第一次点「代码」会看到「文件夹不存在」。
 *
 * 为什么不另起一个 FileStore：用户明说「先上传吧，后续托管还是上传我们统一考虑」。
 * 为一个明确会变的安排铺第二套存储 + 第二个索引库 + 第二套路由，不划算。
 */
mkdirSync(join(config.dataDir, "files", CODE_ROOT_NAME), { recursive: true });
/*
 * 临时区：AI 产出先落这里，人确认后才进正式位置。
 * 先把各来源的子目录建好——否则在文件库里点开临时区会看到「文件夹不存在」。
 */
for (const dir of Object.values(STAGING_DIRS))
  mkdirSync(join(config.dataDir, "files", ...dir.split("/").filter(Boolean)), {
    recursive: true,
  });
const filesIndex = openFilesIndex(join(config.dataDir, "files.db"));
const files = createFileStore(
  realpathSync(join(config.dataDir, "files")),
  filesIndex,
  { uploadLimit: config.fileUploadLimit },
);

/** 由 supervisor 拉起时它会设这个变量；没有它就没人接手重启。 */
const supervised = process.env.PMFORGE_CHAT_SUPERVISED === "1";

const shutdown = (code = 0): void => {
  runner.disposeAll();
  void app.close().then(() => {
    db.close();
    filesIndex.close();
    process.exit(code);
  });
};

const { app, runner } = createApp({
  db,
  paths,
  keys: createKeyStore(config.dataDir),
  // 外部系统（Linear）的 Key 单独一个目录：和模型 Key 混放会被列成模型服务商。
  // 不读环境变量——PMFORGE_CHAT_KEY_* 是模型 Key 的约定。
  integrationKeys: createKeyStore(join(config.dataDir, "integrations"), {}),
  files,
  // AI 看测试环境的只读浏览：账号密码存这个数据目录下的 envs/（文件 600）。
  browse: { dataDir: config.dataDir },
  skills: createSkillStore({
    dir: paths.skillsDir,
    targetDirs: defaultSkillTargets(),
    promptBytes: () => promptCost(paths.skillsDir).perSkill,
  }),
  skillsPromptBytes: () => promptCost(paths.skillsDir).total,
  agents: createAgentStore({
    dir: paths.agentsDir,
    targetDirs: defaultAgentTargets(),
    // 执行体点名的 skill 在不在库里，用同一个扫描器判，免得两套发现规则对不上。
    knownSkills: () => allSkills(paths.skillsDir).map((s) => s.name),
  }),
  security: {
    port: config.port,
    webPort: config.webPort,
    extraOrigins: config.extraOrigins,
    bindHost: config.host,
  },
  registerPiRoutes: piRoutes({
    requestRestart: () => {
      if (!supervised) return false;
      // 稍等再退：让升级结果那一帧先送到浏览器。
      setTimeout(() => {
        shutdown(RESTART_EXIT_CODE);
      }, 500);
      return true;
    },
  }),
  logger: true,
});
process.on("SIGTERM", () => {
  shutdown();
});
process.on("SIGINT", () => {
  shutdown();
});

await app.listen({ host: config.host, port: config.port });
app.log.info({ dataDir: config.dataDir }, "对话服务已启动");
// 启动时对齐一次索引（在服务停着时用 Finder 改过的东西）。失败不影响服务：列目录时仍会逐层对齐。
void files
  .reindex()
  .then((count) => {
    app.log.info({ count }, "文件索引已重建");
  })
  .catch((error: unknown) => {
    app.log.error(error, "文件索引重建失败");
  });
