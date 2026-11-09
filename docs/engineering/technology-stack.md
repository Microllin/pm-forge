# PMForge MVP 技术栈建议

> 状态：技术选型草案，实施前需要做兼容性 Spike
> 日期：2026-07-30
> 原则：主流、现代、稳定、可维护；不使用停止支持的旧版本，也不为追新采用未经生态验证的预览版本。

## 1. 版本策略

PMForge 不采用“所有依赖永远 latest”的方式。推荐：

- 运行时使用当前活跃 LTS；
- 框架使用当前稳定大版本；
- 禁止 alpha、beta、RC 进入生产基线，除非有不可替代能力；
- lockfile 提交 Git，生产构建可复现；
- 依赖版本使用明确范围，重大版本单独评审；
- 每月处理 patch/minor，每季度评估 major；
- Electron/Chromium、文件系统、Markdown 渲染和依赖供应链安全更新优先；
- 使用 Renovate 或 Dependabot 提交升级 PR，但不自动合并重大升级。

截至选型时核对到的当前版本包括：React 19.2.8、Vite 8.2.1、TypeScript 7.0.2、Electron 43.3.0、Fastify 5.11.2、Drizzle ORM 0.45.2、TanStack Query 5.101.4、Zustand 5.0.14、Zod 4.4.3、Vitest 4.1.10、Playwright 1.62.1。

版本号只作为选型时间点记录。正式实施时以兼容性 Spike 验证后的精确 lockfile 为准。

## 2. 推荐总体架构

```text
apps/web                  React Browser UI
        ↕ REST + WebSocket
apps/core                 Fastify Local Core
        ↕
packages/domain           纯领域模型和规则
packages/contracts        Zod API / Event Schema
packages/providers        Task / Skill / Agent Provider interfaces
packages/ui               PMForge UI primitives + Orca-adapted components

future/apps/desktop       Electron Thin Shell
```

使用 pnpm workspace 管理 Monorepo。MVP 不引入微服务、Kubernetes、消息队列和分布式数据库。

## 3. Browser UI

| 领域         | 选择                                     | 原因                                                                   |
| ------------ | ---------------------------------------- | ---------------------------------------------------------------------- |
| UI 框架      | React 19                                 | 主流、生态完整，与 Orca 可移植 UI 同源                                 |
| 构建         | Vite 8                                   | 适合本地应用和未来 Electron，避免 Next.js 服务端模型与 Local Core 重叠 |
| 语言         | TypeScript 当前稳定版                    | 端到端类型和重构能力；实施前验证 TS 7 生态兼容性                       |
| 服务端状态   | TanStack Query 5                         | 缓存、请求生命周期和失效管理成熟                                       |
| 本地 UI 状态 | Zustand 5                                | 轻量；只保存视图状态，不成为领域事实源                                 |
| 路由         | TanStack Router 或 React Router          | Spike 后择一；优先类型安全和 Electron hash/history 兼容                |
| 样式         | Tailwind CSS 4 + Radix/shadcn primitives | 可维护 token、无障碍基础和快速一致 UI                                  |
| 编辑器       | Monaco Editor                            | 代码、Markdown、JSON 和 Diff 能力成熟                                  |
| Markdown     | react-markdown + remark/rehype 白名单    | 生态成熟；默认禁用不可信原始 HTML                                      |
| 拖放         | 浏览器原生 DnD + dnd-kit（仅复杂排序）   | 文件路径拖放尽量不引入额外抽象                                         |

原则：

- React 组件不直接访问文件系统、SQLite、密钥或 Agent 进程；
- TanStack Query 管服务端事实，Zustand 只管标签页、选择和布局等 UI 状态；
- 不建立 Orca 式巨型全局 Store；
- 从 Orca 移植的组件必须先切断 Store、Preload 和 Runtime 依赖。

## 4. Local Core

| 领域     | 选择                        | 原因                                                                         |
| -------- | --------------------------- | ---------------------------------------------------------------------------- |
| 运行时   | Node.js 24 LTS              | 活跃 LTS、生态和原生模块兼容性更稳，不使用 Node Current 作为产品基线         |
| HTTP     | Fastify 5                   | 性能、Schema、插件边界和测试能力成熟，适合独立 Local Core                    |
| API      | REST + WebSocket            | REST 处理资源操作，WebSocket 处理 AI 流、事件和运行状态；未来桌面/CLI 可复用 |
| 契约     | Zod 4 + OpenAPI 生成        | 前后端共享验证；外部 Provider 边界仍做运行时校验                             |
| 日志     | Pino                        | Fastify 原生日志体系，支持结构化审计和脱敏                                   |
| 进程调用 | spawn/execFile，shell=false | Agent 与工具使用参数数组，禁止拼接 shell 命令                                |

不推荐 Next.js 同时承担 UI 和 Local Core。它适合 Web 产品，但 PMForge 的核心是本地文件、长连接、Agent 子进程和未来 Electron；独立 Core 边界更清晰。

## 5. 数据与文件

| 领域         | 选择                               | 原因                                                      |
| ------------ | ---------------------------------- | --------------------------------------------------------- |
| 元数据数据库 | SQLite                             | 本地优先、单文件、事务成熟、备份简单                      |
| ORM/迁移     | Drizzle ORM + 显式 SQL migration   | 类型安全，同时保留可审查迁移                              |
| 驱动         | better-sqlite3                     | 本地单用户场景简单稳定；Electron 阶段重新验证原生模块打包 |
| 正式文档     | 用户原始文件系统                   | 不复制为 PMForge 专有正文                                 |
| 搜索         | MVP 使用受控文件扫描 + SQLite FTS5 | 先避免引入独立向量数据库；语义检索按真实需求增加          |
| 文件监听     | chokidar 或 @parcel/watcher        | Spike 比较跨平台、Electron 打包和大目录表现后选择         |
| 内容指纹     | SHA-256                            | 检测外部修改、引用版本和乐观写入冲突                      |

## 6. AI、Skill 与 Provider

Core 只依赖稳定接口：

```text
AgentProvider
TaskProvider
SkillProvider
FactSourceProvider
```

MVP 首个 Agent Provider 可以接 Pi SDK/RPC，但领域模型不得依赖 Pi 私有类型。后续可接 Claude Code、Codex、Orca CLI 或其他 Agent。

AI 事件使用统一事件协议：

```text
message.delta
message.completed
tool.requested
tool.started
tool.completed
approval.required
run.failed
run.completed
```

Skill 以本地文件为来源，由 Core 解析和路由。Skill 选择与执行权限分开：路由到 Skill 不等于授权其所有工具动作。

## 7. 未来 Electron

Electron 43 当前为稳定版本，但 MVP B/S 阶段不立即依赖 Electron。封装时采用薄壳：

- 启停 Local Core；
- 原生目录选择与文件拖放；
- 窗口、菜单、快捷键和通知；
- 安全更新和自动更新；
- 不在 Electron Main/Preload 重写 Work Item 和 Provider 业务逻辑。

启用 contextIsolation 和 sandbox；关闭 nodeIntegration；使用窄 IPC，不复制 Orca 的巨型 Preload 接口。

## 8. 工程质量

| 领域          | 选择                                                                          |
| ------------- | ----------------------------------------------------------------------------- |
| 单元/组件测试 | Vitest 4 + Testing Library                                                    |
| 端到端测试    | Playwright 1.62                                                               |
| Lint          | ESLint 9（或兼容性 Spike 后采用 Oxlint + ESLint type-aware 补充）             |
| 格式化        | Prettier 或 Oxfmt，二选一并全仓统一                                           |
| API 测试      | Fastify inject + 合约测试                                                     |
| 数据库测试    | 临时 SQLite 数据库 + 真实 migration                                           |
| 架构守卫      | dependency-cruiser/ESLint boundaries 或自定义检查，禁止 UI 反向依赖 Core 实现 |

CI 至少执行：format check、lint、typecheck、unit、integration、build、dependency audit 和 license notice check。

## 9. Orca 代码复用治理

- 建立 `THIRD_PARTY_NOTICES.md`；
- 建立 `docs/engineering/orca-adoption-log.md`；
- 固定评估基线 commit；
- 每个移植项记录原路径、许可证、修改说明和依赖切割；
- 优先复制纯函数和小组件，不复制巨型页面；
- 先为原行为建立测试，再替换为 PMForge Contract；
- 不使用“复制后以后再清理依赖”的策略。

## 10. 实施前兼容性 Spike

正式编码前用最小样例验证：

1. Node 24 + TypeScript 当前稳定版 + Vite + React；
2. Fastify + Zod/OpenAPI 契约；
3. SQLite/Drizzle migration；
4. 浏览器到 Core 的 AI WebSocket 流；
5. 文件和目录路径拖放；
6. Monaco Markdown/Diff；
7. 从 Orca 移植一个最小 Tab 组件；
8. Electron 薄壳启动同一 Web UI 和 Local Core（只验证，不纳入 MVP 功能）。

若 TypeScript 7 或 Vite 8 与关键库存在兼容问题，回退到上一受支持稳定大版本，而不是用补丁绕过生态问题。
