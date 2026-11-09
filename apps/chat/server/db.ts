import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import Database from "better-sqlite3";

import { ENV_MIGRATION } from "./evidence/live/envs.js";

/**
 * SQLite。存会话元信息、pi 会话条目的**原文**，以及产品模块的产品线 / 产品。
 *
 * 条目原样存：恢复时整段交回 pi 的
 * SessionManager.inMemory，id / parentId / context_edit / compaction 的语义全由
 * pi 自己负责。这里不解析条目结构——一旦解析，pi 换条目格式时这里就得跟着改。
 */

export type Db = Database.Database;

export const IN_MEMORY = ":memory:";

/** 迁移按序号追加，**只增不改**：改已发布的迁移会让老库与新库结构不一致。 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    -- pi 会话头（type: "session"）原文。恢复时排在条目最前面交回 pi。
    header      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE entries (
    session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq         INTEGER NOT NULL,
    entry_id    TEXT NOT NULL,
    payload     TEXT NOT NULL,
    PRIMARY KEY (session_id, seq),
    UNIQUE (session_id, entry_id)
  );
  CREATE TABLE settings (
    key    TEXT PRIMARY KEY,
    value  TEXT NOT NULL
  );
  `,
  /*
   * 产品模块（一级菜单「产品」）：产品线 / 产品两层两张表。
   * - 名称唯一交给数据库（COLLATE NOCASE）：产品线全局唯一，产品在所属产品线内唯一。
   *   不先查后写——并发下会漏。
   * - products.line_id 是 RESTRICT：删产品线不连带删产品，必须先移走或删掉。
   * - sort_order：新建追加到末尾；第一阶段不做拖拽排序，列先留好。
   */
  `
  CREATE TABLE product_lines (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE products (
    id          TEXT PRIMARY KEY,
    line_id     TEXT NOT NULL REFERENCES product_lines(id) ON DELETE RESTRICT,
    name        TEXT NOT NULL COLLATE NOCASE,
    description TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (line_id, name)
  );
  CREATE INDEX products_line_order_idx ON products(line_id, sort_order);
  `,

  /**
   * 生命周期规范（产品菜单下的二级页「生命周期规范」）：模板库。
   *
   * 三张表、层级交给外键，和 product_lines/products 同一个口径——**不回到通用树**。
   * 老版本（apps/core/src/lifecycle-schema.ts）把这张层级表写死在 TS 里
   * （`MethodologyTemplateId = "full" | "lite"`，注释还写着「刻意不支持新增层」），
   * 唯一编辑入口是设置页改一坨 JSON。这里把它变成一等公民的数据：能建、能改、能复制。
   *
   * - builtin：只决定「能不能恢复出厂内容」，**不决定能不能改**。出厂模板照样可编辑。
   * - stages.code：L0.1 这类代号，模板内唯一；自定义阶段可以随便起（如「Roadmap」）。
   * - artifacts.checkpoints / file_hints：为「让 AI 读文件比对」留的两个字段。
   *   没有它们，AI 只能靠产出物名字猜有没有；有了它们，答案才能是
   *   「有，但第 2 点没答」而不是「有/没有」。
   * - products.template_id 是 RESTRICT：删模板时若还有产品在用，先解绑。
   *   与「删产品线要先移走产品」同一条取舍——连带删除太容易误伤。
   */
  `
  CREATE TABLE lifecycle_templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    builtin     INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE lifecycle_stages (
    id          TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES lifecycle_templates(id) ON DELETE CASCADE,
    code        TEXT NOT NULL COLLATE NOCASE,
    label       TEXT NOT NULL,
    question    TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (template_id, code)
  );
  CREATE INDEX lifecycle_stages_order_idx ON lifecycle_stages(template_id, sort_order);
  CREATE TABLE lifecycle_artifacts (
    id          TEXT PRIMARY KEY,
    stage_id    TEXT NOT NULL REFERENCES lifecycle_stages(id) ON DELETE CASCADE,
    name        TEXT NOT NULL COLLATE NOCASE,
    required    INTEGER NOT NULL DEFAULT 1,
    guide       TEXT NOT NULL DEFAULT '',
    checkpoints TEXT NOT NULL DEFAULT '',
    file_hints  TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (stage_id, name)
  );
  CREATE INDEX lifecycle_artifacts_order_idx ON lifecycle_artifacts(stage_id, sort_order);
  ALTER TABLE products ADD COLUMN template_id TEXT
    REFERENCES lifecycle_templates(id) ON DELETE RESTRICT;
  `,

  /**
   * AI 分析：把产品线 / 产品挂到一个文件夹上，并记下产出物比对结果。
   *
   * - `folder_path`：**文件模块里的路径**（如 `/docs/products/model-hub`），
   *   不是本机绝对路径——绝对路径等于绕开了 files/paths.ts 那套软链与越界闸。
   *   不加外键（文件不在这个库里），路径失效由读取时报错，不静默清掉。
   * - `sessions.task`：这条会话是不是一次 AI 分析，是哪种。普通对话为 NULL。
   *   分析就跑在真对话里（用户要看得见过程、还能追问），所以不另建一张表，
   *   只给会话打一个标记 + 存它的入参。
   * - `product_checks`：**只存最近一次**（product_id 做主键）。重跑就覆盖；
   *   要看 AI 当时怎么判的，顺着 session_id 点回那条对话。
   */
  `
  ALTER TABLE product_lines ADD COLUMN folder_path TEXT;
  ALTER TABLE products      ADD COLUMN folder_path TEXT;
  ALTER TABLE sessions      ADD COLUMN task TEXT;
  CREATE TABLE product_checks (
    product_id  TEXT PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    template_id TEXT NOT NULL REFERENCES lifecycle_templates(id) ON DELETE CASCADE,
    session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    folder_path TEXT NOT NULL,
    summary     TEXT NOT NULL,
    findings    TEXT NOT NULL,
    checked_at  INTEGER NOT NULL
  );
  `,

  /**
   * 产品功能架构树：一级 / 二级 / 三级…功能，由 AI 读代码分析出来。
   *
   * - `code_path`：产品绑的**代码**目录（事实底座 → 代码入口里的路径）。
   *   与 `folder_path`（文档目录）分开：一个给「产出物比对」读，一个给「功能架构」读。
   * - `parent_id` 为 NULL = 一级功能。CASCADE：删父连带整支（子功能脱离父没有意义）。
   * - `source`：ai / manual。**重新分析一支时要能说清「会覆掉你手改过的哪几个」**，
   *   没这一栏就只能笼统地警告「会覆盖」。
   * - `evidence`：代码证据（文件 / 目录指针），一行一条。没它就无法复查
   *   「AI 凭什么说这是一个功能」，也无法把「向下拆一层」的扫描面收窄到这一支。
   *
   * 重名约束用**部分唯一索引**而不是 UNIQUE(product_id, parent_id, name)：
   * SQLite 里 NULL 不参与唯一性比较，那样写的话一级功能（parent_id IS NULL）
   * 根本管不住重名。分成两条带 WHERE 的索引才是真的约束。
   */
  `
  ALTER TABLE products ADD COLUMN code_path TEXT;
  CREATE TABLE feature_nodes (
    id          TEXT PRIMARY KEY,
    product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    parent_id   TEXT REFERENCES feature_nodes(id) ON DELETE CASCADE,
    name        TEXT NOT NULL COLLATE NOCASE,
    duty        TEXT NOT NULL DEFAULT '',
    evidence    TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'ai',
    session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX feature_root_name_idx
    ON feature_nodes(product_id, name) WHERE parent_id IS NULL;
  CREATE UNIQUE INDEX feature_child_name_idx
    ON feature_nodes(parent_id, name) WHERE parent_id IS NOT NULL;
  CREATE INDEX feature_tree_idx ON feature_nodes(product_id, parent_id, sort_order);
  `,

  /*
   * 6. 产品 wiki。一个产品一本，章节成树（最多两层：章 / 节）。
   *
   * 两处刻意的设计：
   *
   * - **显示编号不入库。**「01 产品快照」里的 01 由 sort_order 算出来。
   *   存死的话插一章要连带改后面全部，而「改一行要连带改 N 行」正是数据不一致的来源。
   * - **重名约束用两条带 WHERE 的部分索引**，和 feature_nodes 同一个道理：
   *   SQLite 里 NULL 不参与唯一性，UNIQUE(product_id, parent_id, title)
   *   根本管不住顶层章重名。
   *
   * brief 是「这一章写什么」，在生成目录那一步就定下来，
   * 之后逐页成文时它是输入——所以它不是摘要（事后写的），是提纲（事前写的）。
   */
  `
  CREATE TABLE wiki_pages (
    id          TEXT PRIMARY KEY,
    product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    parent_id   TEXT REFERENCES wiki_pages(id) ON DELETE CASCADE,
    title       TEXT NOT NULL COLLATE NOCASE,
    brief       TEXT NOT NULL DEFAULT '',
    content     TEXT NOT NULL DEFAULT '',
    source      TEXT NOT NULL DEFAULT 'manual',
    session_id  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX wiki_root_title_idx
    ON wiki_pages(product_id, title) WHERE parent_id IS NULL;
  CREATE UNIQUE INDEX wiki_child_title_idx
    ON wiki_pages(parent_id, title) WHERE parent_id IS NOT NULL;
  CREATE INDEX wiki_tree_idx ON wiki_pages(product_id, parent_id, sort_order);
  `,

  /*
   * 7. Wiki 的事实源加两样东西，都是一行一条路径（与 feature_nodes.evidence 同一写法）。
   *
   * - `products.ref_paths`：**参考资料**。文档目录只能绑一个，而一个产品的手册、
   *   产品线能力地图常常在它外面（`docs/user-guide`、`01-products/xxx-能力地图.md`）。
   *   把文档目录往上提一层又会把别的产品的材料一起卷进来，所以另开一栏，可以是目录也可以是单个文件。
   * - `wiki_pages.sources`：**这一章要精读的路径**。规划目录时由 AI 指定、人可以改。
   *   写正文时按它收窄扫描面并读源代码正文——没有它，每一章看到的都是同一份浅层目录树，
   *   「数据模型」「接口清单」只能看着目录名猜。
   */
  `
  ALTER TABLE products   ADD COLUMN ref_paths TEXT NOT NULL DEFAULT '';
  ALTER TABLE wiki_pages ADD COLUMN sources   TEXT NOT NULL DEFAULT '';
  `,

  /*
   * 8. 全局 AI 补齐（global-fill.ts）。
   *
   * 一次补齐 = 一条 run；它拆成很多 job（比对、写一份产出物、规划 wiki 目录、写一页 wiki），
   * 每个 job 开一条真对话；job 产出的东西进 drafts——**先落在临时区（/临时区/AI补齐），人看过再挪进正式位置**。
   * job 落库而不是只放内存：开发时服务会热重启，补齐页要能看见跑到哪一步、哪些失败了。
   */
  `
  CREATE TABLE fill_runs (
    id          TEXT PRIMARY KEY,
    status      TEXT NOT NULL,
    folder      TEXT NOT NULL,
    note        TEXT NOT NULL DEFAULT '',
    created_at  INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE TABLE fill_jobs (
    id           TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES fill_runs(id) ON DELETE CASCADE,
    product_id   TEXT NOT NULL,
    product_name TEXT NOT NULL,
    kind         TEXT NOT NULL,
    label        TEXT NOT NULL,
    payload      TEXT NOT NULL DEFAULT '{}',
    status       TEXT NOT NULL,
    session_id   TEXT,
    error        TEXT,
    seq          INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX fill_jobs_run_idx ON fill_jobs(run_id, seq);
  CREATE TABLE fill_drafts (
    id           TEXT PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES fill_runs(id) ON DELETE CASCADE,
    product_id   TEXT NOT NULL,
    product_name TEXT NOT NULL,
    kind         TEXT NOT NULL,
    title        TEXT NOT NULL,
    draft_path   TEXT NOT NULL,
    target_path  TEXT,
    page_id      TEXT,
    session_id   TEXT,
    status       TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX fill_drafts_run_idx ON fill_drafts(run_id, created_at);
  `,

  /*
   * 9. 售前材料库（一级菜单「售前」）：库 → 材料槽位 → 版本。
   *
   * - **槽位是模板条目**（「这个产品应该有一份白皮书」），版本是实际做出的一版一版；
   *   没有现行版的槽位就是缺口。
   * - `product_id` **不加外键**：产品被删后这本库要留着（材料是真金白银做出来的），
   *   只在界面上标「产品已移除」。CASCADE 会让删一个产品连着毁掉一整本售前库。
   * - 唯一约束 `presales_libs(product_id)`：一个产品只有一本库。SQLite 里 NULL
   *   不参与唯一性比较，所以公司级库（product_id IS NULL）不限本数——那正是想要的。
   * - `presales_versions_current_idx` 是**部分唯一索引**：每个槽位最多一条
   *   status='current'。「唯一现行版」这条规矩靠它兜底，不靠界面自觉。
   * - `file_path` 是「事实底座」里的路径（`/售前/<库 id>/<文件名>`），
   *   不是本机绝对路径——上传与下载都走 files 那套路径闸。
   */
  `
  CREATE TABLE presales_libs (
    id          TEXT PRIMARY KEY,
    product_id  TEXT,
    name        TEXT NOT NULL,
    summary     TEXT NOT NULL DEFAULT '',
    status      TEXT NOT NULL DEFAULT 'active',
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX presales_libs_product_idx
    ON presales_libs(product_id) WHERE product_id IS NOT NULL;
  CREATE TABLE presales_slots (
    id          TEXT PRIMARY KEY,
    lib_id      TEXT NOT NULL REFERENCES presales_libs(id) ON DELETE CASCADE,
    item_key    TEXT NOT NULL,
    stage       TEXT NOT NULL,
    title       TEXT NOT NULL,
    priority    INTEGER NOT NULL DEFAULT 0,
    audience    TEXT NOT NULL DEFAULT 'external',
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (lib_id, item_key)
  );
  CREATE INDEX presales_slots_lib_idx ON presales_slots(lib_id, sort_order);
  CREATE TABLE presales_versions (
    id          TEXT PRIMARY KEY,
    slot_id     TEXT NOT NULL REFERENCES presales_slots(id) ON DELETE CASCADE,
    version     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'draft',
    released_at TEXT,
    note        TEXT NOT NULL DEFAULT '',
    file_path   TEXT,
    file_name   TEXT,
    file_size   INTEGER,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX presales_versions_slot_idx ON presales_versions(slot_id, created_at);
  CREATE UNIQUE INDEX presales_versions_current_idx
    ON presales_versions(slot_id) WHERE status = 'current';
  `,

  /*
   * 10. 售前材料的「AI 识别」候选（presales-import.ts）。
   *
   * 用户选一个大文件夹，模型从里面挑出每类材料该用哪一份、哪一版最新的；
   * 结果先落这里，人在界面上逐条改判、勾选，确认后才建版本。
   *
   * - `alternates` 存 JSON 字符串（备选文件的路径与理由）：整存整取，
   *   从不按其中某一条查询，拆表只会多一次 join。
   * - `status`：pending 待确认 / accepted 已入库 / rejected 已忽略。
   *   已入库的留着不删，方便回看「上次导了什么」。
   * - `version_id` 指向确认后建出来的版本；候选被删时版本不受影响（它是真数据）。
   */
  `
  CREATE TABLE presales_import_candidates (
    id               TEXT PRIMARY KEY,
    lib_id           TEXT NOT NULL REFERENCES presales_libs(id) ON DELETE CASCADE,
    slot_id          TEXT NOT NULL REFERENCES presales_slots(id) ON DELETE CASCADE,
    file_path        TEXT NOT NULL,
    file_name        TEXT NOT NULL,
    file_size        INTEGER NOT NULL DEFAULT 0,
    file_modified_at INTEGER NOT NULL DEFAULT 0,
    confidence       TEXT NOT NULL DEFAULT 'low',
    reason           TEXT NOT NULL DEFAULT '',
    alternates       TEXT NOT NULL DEFAULT '[]',
    status           TEXT NOT NULL DEFAULT 'pending',
    version_id       TEXT,
    created_at       INTEGER NOT NULL
  );
  CREATE INDEX presales_candidates_lib_idx
    ON presales_import_candidates(lib_id, status, created_at);
  `,

  /*
   * 11. 售前模板（一级菜单「售前材料」→「售前模板」）：模板 → 阶段 → 材料。
   *
   * 与生命周期规范同一形状但分开存：两者的条目字段不同（售前材料有「对内 / 对外」），
   * 绑定对象也不同（这里绑售前库，那里绑产品）。硬塞进一张表就得处处按种类过滤。
   *
   * - `builtin_key`：出厂模板的稳定标识（product / company）。恢复出厂按它找种子，
   *   不按名字——名字用户可以改。
   * - `presales_libs.template_id`：SET NULL。模板删了库还在，只是「补齐模板」没有来源。
   * - 旧的槽位阶段是固定枚举（contact / discovery / …），这里映射成模板阶段代号
   *   S1–S5，否则老库在新的阶段筛选里全部对不上。
   */
  `
  CREATE TABLE presales_templates (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    builtin_key TEXT,
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE presales_template_stages (
    id          TEXT PRIMARY KEY,
    template_id TEXT NOT NULL REFERENCES presales_templates(id) ON DELETE CASCADE,
    code        TEXT NOT NULL COLLATE NOCASE,
    label       TEXT NOT NULL,
    question    TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (template_id, code)
  );
  CREATE TABLE presales_template_items (
    id          TEXT PRIMARY KEY,
    stage_id    TEXT NOT NULL REFERENCES presales_template_stages(id) ON DELETE CASCADE,
    name        TEXT NOT NULL COLLATE NOCASE,
    required    INTEGER NOT NULL DEFAULT 1,
    audience    TEXT NOT NULL DEFAULT 'external',
    guide       TEXT NOT NULL DEFAULT '',
    checkpoints TEXT NOT NULL DEFAULT '',
    file_hints  TEXT NOT NULL DEFAULT '',
    sort_order  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (stage_id, name)
  );
  ALTER TABLE presales_libs ADD COLUMN template_id TEXT
    REFERENCES presales_templates(id) ON DELETE SET NULL;
  `,

  /*
   * 12. 售前槽位跟上模板：带上检查要点与文件线索，阶段代号改成模板那一套。
   *
   * 单独一条而不是并进 11：11 已经在早先启动的服务上跑过一遍了，改它不会重跑，
   * 于是「本地能跑、已有库炸」——这正是这次踩到的坑。迁移只增不改。
   */
  `
  ALTER TABLE presales_slots ADD COLUMN guide       TEXT NOT NULL DEFAULT '';
  ALTER TABLE presales_slots ADD COLUMN checkpoints TEXT NOT NULL DEFAULT '';
  ALTER TABLE presales_slots ADD COLUMN file_hints  TEXT NOT NULL DEFAULT '';
  UPDATE presales_slots SET stage = CASE stage
    WHEN 'contact'   THEN 'S1'
    WHEN 'discovery' THEN 'S2'
    WHEN 'proposal'  THEN 'S3'
    WHEN 'handover'  THEN 'S4'
    WHEN 'internal'  THEN 'S5'
    ELSE stage END;
  `,

  /*
   * 13. 模板条目带上别名。
   *
   * 补模板按名称去重，而同一类材料在不同产品线上叫法不同（「需求摸底表」/「需求调研表」）。
   * 没有别名，老库一补模板就会多出一份重复材料。别名一行一个，与检查要点同一存法。
   */
  `
  ALTER TABLE presales_template_items ADD COLUMN aliases TEXT NOT NULL DEFAULT '';
  `,

  /*
   * 14. 会话绑定所属产品与依据范围（平台规范：事实依据）。
   *
   * 会话原来不带「这是哪个产品的对话」——AI 因此无从知道该读哪批文件，只能靠
   * 用户在话里描述。product_id 补上这层归属，依据定位器据它算依据库。
   *
   * evidence_scope 是使用者手选的依据范围（JSON 数组，文件库路径）；NULL = 整个
   * 依据库。存会话上而不是每次现填：同一段对话后续每一轮都按它来。
   *
   * 不做外键：产品被删时旧对话仍要能打开看，依据库自然变空即可。
   */
  `
  ALTER TABLE sessions ADD COLUMN product_id     TEXT;
  ALTER TABLE sessions ADD COLUMN evidence_scope TEXT;
  `,

  /*
   * 15. 售前材料条目对上模板条目（presales.ts 的 resolveLinks）。
   *
   * 原来条目只在建库 / 补齐时按名字从模板**抄一份**，之后两边再无关系：模板改了说明、
   * 检查要点，库里看不到；条目是不是模板里那一项，也只能靠名字猜。
   *
   * 取值：NULL = 自动（按名称 / 别名对号，对上就写回 id）；'-' = 人明确标成「模板外」；
   * 其余 = 模板条目 id。**不做外键**：恢复出厂会删掉重建全部条目（id 全变），外键
   * SET NULL 之后照样要按名字重新对号——悬空的 id 在读取时当 NULL 处理，一条路径就够了。
   */
  `
  ALTER TABLE presales_slots ADD COLUMN template_item_id TEXT;
  `,

  /*
   * 16. 售前材料的 AI 审阅与体系复盘（presales-review.ts）。
   *
   * 一张任务表装三种活：ledger（抽一份材料的口径台账）、cross（跨材料比对）、
   * review（一份材料的修订清单）。单份审阅 run_id 为空；体系复盘的任务挂在 run 下，
   * 按「台账 → 比对 → 逐份修订」分批生出来。
   *
   * - `result` 存 JSON：模型结果 + 人对每一条的取舍（采纳 / 驳回）。整存整取。
   * - `version_id` 是审阅时的那一版：材料换了版本，旧的审阅结果仍对应旧文件。
   * - `applied_version_id` 指向按采纳条目生成的修订稿（草稿版本）。
   */
  `
  CREATE TABLE presales_ai_runs (
    id          TEXT PRIMARY KEY,
    lib_id      TEXT NOT NULL REFERENCES presales_libs(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX presales_ai_runs_lib_idx ON presales_ai_runs(lib_id, created_at);
  CREATE TABLE presales_ai_jobs (
    id                 TEXT PRIMARY KEY,
    lib_id             TEXT NOT NULL REFERENCES presales_libs(id) ON DELETE CASCADE,
    run_id             TEXT REFERENCES presales_ai_runs(id) ON DELETE CASCADE,
    kind               TEXT NOT NULL,
    slot_id            TEXT REFERENCES presales_slots(id) ON DELETE CASCADE,
    version_id         TEXT,
    session_id         TEXT,
    status             TEXT NOT NULL,
    error              TEXT,
    result             TEXT,
    applied_version_id TEXT,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER NOT NULL
  );
  CREATE INDEX presales_ai_jobs_lib_idx ON presales_ai_jobs(lib_id, created_at);
  CREATE INDEX presales_ai_jobs_run_idx ON presales_ai_jobs(run_id, kind);
  `,
  /*
   * 售前助手（见 presales-agent.ts）：
   * - `agent_session_id`：这本库的专属助手会话。一库一条，删了会话下次打开再建。
   * - `auto_review`：巡检开关——上传 / 替换可审阅的文件后自动发起 AI 审阅。默认开。
   */
  `
  ALTER TABLE presales_libs ADD COLUMN agent_session_id TEXT;
  ALTER TABLE presales_libs ADD COLUMN auto_review INTEGER NOT NULL DEFAULT 1;
  `,
  /*
   * 登录（见 auth.ts）。现在只有一个账户，表按多账户搭，以后做账户体系往上加：
   * - `users.username` 不区分大小写唯一；
   * - `auth_sessions` 只存登录凭证的 sha256，库泄了也拿不到能用的凭证；
   *   删用户时连带删它的登录。
   */
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  CREATE TABLE auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
  `,
  /*
   * 测试环境登记（只读浏览工具用，见 browse/envs.ts）。账号密码不在这里，
   * 单独存数据目录 envs/（文件 600）。
   */
  ENV_MIGRATION,
  /*
   * 任务与需求（一级菜单「任务与需求」，见 work-items.ts）。
   * - kind：request = 用户需求（手记，类似备忘录）；task = 内部任务（可手建，也可从 Linear 等导入）。
   * - source + external_id 唯一：同一条外部 issue 重复同步只更新，不重复插入。
   * - 外部来的字段（标题、描述、状态…）每次同步覆盖；本地字段（产品、对话）同步不碰。
   * - session_id：最近一次「开始对话」建的会话。会话被删后它悬空，列表查询时按存在性置空。
   */
  `
  CREATE TABLE work_items (
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL CHECK (kind IN ('request', 'task')),
    source           TEXT NOT NULL DEFAULT 'manual',
    external_id      TEXT,
    external_key     TEXT,
    url              TEXT,
    title            TEXT NOT NULL,
    description      TEXT NOT NULL DEFAULT '',
    status           TEXT NOT NULL DEFAULT 'todo'
                     CHECK (status IN ('todo', 'doing', 'done', 'canceled')),
    external_status  TEXT,
    priority         INTEGER NOT NULL DEFAULT 0,
    requester        TEXT NOT NULL DEFAULT '',
    assignee         TEXT NOT NULL DEFAULT '',
    labels           TEXT NOT NULL DEFAULT '[]',
    team             TEXT NOT NULL DEFAULT '',
    product_id       TEXT REFERENCES products(id) ON DELETE SET NULL,
    session_id       TEXT,
    external_updated_at INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    UNIQUE (source, external_id)
  );
  CREATE INDEX work_items_kind_idx ON work_items(kind, updated_at);
  `,
];

export function openDb(path: string): Db {
  return openSqlite(path, MIGRATIONS);
}

/**
 * 打开一个 SQLite 文件并跑完它的迁移。chat.db 与 files.db（文件模块的索引）
 * 各有一套迁移，共用这段打开逻辑（WAL、外键开关、迁移登记）。
 */
export function openSqlite(path: string, migrations: readonly string[]): Db {
  if (path !== IN_MEMORY) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    tighten(path);
  }
  const db = new Database(path);
  if (path !== IN_MEMORY) db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db, migrations);
  return db;
}

/**
 * 把库文件收紧到只有本人可读写。
 *
 * 库里是密码哈希、会话凭证哈希和全部业务数据；原来按默认 umask 建出来是 644，
 * 同机其他用户 `cat` 一下就能拿到。`keys/`、`envs/` 一直是 700/600，这两个库对不上。
 * 存量文件也要处理（已有环境不会重建），所以打开时补一次 chmod，而不是只在创建时设。
 * 失败不阻断启动：文件系统不支持权限位（某些挂载）时，宁可让服务起来。
 */
function tighten(path: string): void {
  for (const target of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      if (existsSync(target)) chmodSync(target, 0o600);
    } catch {
      // 忽略：权限收紧是加固，不是启动前提。
    }
  }
}

function migrate(db: Db, migrations: readonly string[]): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY)",
  );
  const row = db
    .prepare<[], { v: number | null }>(
      "SELECT MAX(version) AS v FROM _migrations",
    )
    .get();
  const current = row?.v ?? 0;
  for (let i = current; i < migrations.length; i += 1) {
    const sql = migrations[i] ?? "";
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (version) VALUES (?)").run(i + 1);
    })();
  }
}
