# PMForge MVP 架构选型草案

> 状态：讨论中，尚未最终拍板
> 日期：2026-07-30
> 候选：Orca 全量二开 / 新建本地优先 B/S

## 1. 产品架构前提

PMForge MVP 已确认五个一级区域：主工作区、任务区、文件区、Skill 区和 Work Item 区。主工作区以自然语言对话为核心，并通过按需标签页打开文件、PRD、Diff 和执行结果。

架构必须支持：

- 用户授权的真实本地文件和目录；
- 本地 Skill 发现与路由；
- 外部任务 Provider；
- Work Item 持久化；
- AI 流式对话和可替换 Agent；
- 后续受控文件写入和生命周期扩展；
- 未来桌面封装，但 MVP 不被桌面打包阻塞。

## 2. 方案 A：基于 Orca 全量二开

### 可直接获得的能力

- Electron 跨平台桌面外壳；
- 文件夹 Workspace、文件编辑和拖拽；
- Markdown、Monaco、Diff 和标签页；
- Terminal、PTY、CLI Agent 和多 Agent 支持；
- Linear、GitHub、GitLab 等集成基础；
- Skills、插件、CLI、SSH、远程运行和会话恢复；
- 成熟的本地文件、Git 和进程能力；
- MIT 许可证允许修改、分发和商业使用，但需保留版权与许可声明。

### 关键风险

- Orca 当前约 9743 个 TS/TSX 文件、126 万行，远超 PMForge MVP 所需范围；
- 近 14 天约 277 个提交，上游变化非常快；
- 核心领域围绕 Repo、Worktree、Terminal、并行 Coding Agent 和代码评审；
- PMForge 核心领域围绕自然语言产品工作、Work Item、PRD 和产品事实底座；
- Orca 的核心页面和状态与 worktree/repository/runtime 深度耦合，不能简单换皮；
- 直接删除无关功能会形成长期 fork，后续上游合并冲突大；
- 保留全部功能会让 PMForge 再次变成复杂 IDE，掩盖产品主线；
- Native Chat 仍带有实验性特征，不能假设它就是可直接复用的 PMForge 主工作区；
- 现有插件面板能扩展 Orca，但不足以替换其核心导航、任务模型和 Workspace 所有权。

### 适用条件

只有当 PMForge 决定本质上是“Orca 的产品经理发行版”，并愿意长期跟随 Orca 的桌面 IDE 架构、发布节奏和技术栈时，才适合全量二开。

## 3. 方案 B：新建本地优先 B/S

这里的 B/S 不是普通云端 SaaS，而是：

```text
Browser UI
    ↕ localhost HTTP / WebSocket
PMForge Local Core
    ├── Work Item Store
    ├── Conversation Runtime
    ├── File Boundary & Index
    ├── Skill Registry & Router
    ├── Task Provider Adapters
    ├── Agent Provider Adapters
    └── Audit / Permission
```

### 优势

- 领域模型从 Product、Work Item、Conversation、Fact Source、Skill 和 External Task 开始，避免继承 IDE 假设；
- 只实现 MVP 五区，不背负 Terminal、Worktree、SSH、移动端等无关复杂度；
- UI 与 Local Core 解耦，未来可复用到桌面壳、CLI 或团队版；
- 本地 Core 可以安全访问授权目录、SQLite、本地 Skills 和 Agent；
- 浏览器 UI 开发和调试成本低；
- 后续可用 Electron 或 Tauri 包装，而不改核心产品协议。

### 风险

- 文件编辑、Diff、拖拽、标签页和流式 Agent 都需要自行实现；
- 浏览器本身不能可靠获得任意本地绝对路径，目录选择需要本地 Core 辅助、手工配置路径或未来桌面壳；
- 本地服务需要处理身份、CSRF/Origin、端口暴露和文件路径授权；
- 若边界设计不好，仍可能演变成前一版 Next.js 单体。

### 关键约束

- B/S UI 不得直接持有文件系统权限；所有文件操作经过 Local Core；
- Local Core 只监听 loopback，校验 Origin，并使用短期本机会话令牌；
- UI、领域层、Provider 和基础设施层保持明确边界；
- 先定义协议和领域模型，再选择具体框架；
- MVP 不实现与五区无关的 IDE 能力。

## 4. 用户真实工作流补充

用户说明其日常产品工作本来就在 Orca 或 VS Code 中进行：

- 通过 Skill 使用产品方法；
- 将本地文件拖入 Agent 作为上下文；
- PRD 使用 Git 管理；
- 使用 Browser 和 Design Mode 检查产品界面；
- 使用开发 Agent 和 Worktree 制作可运行 Demo；
- 认可 Orca 当前主工作区和整体界面；
- 不要求 PMForge fork 持续合并 Orca 上游。

该信息改变架构权重。Orca 的 Repo、Worktree、Agent、Git 和 Browser 对该目标用户不是多余 IDE 能力，而是产品经理实际使用的生产工具。

## 5. 最终选择：本地优先 B/S + 选择性复用 Orca

用户最终选择不进行 Orca 全量硬分叉，采用 **新建本地优先 B/S，后续封装 Electron** 的路线。

Orca 作为只读参考和 MIT 代码来源，按组件选择性复用，不继承其整套领域和运行时：

```text
Browser UI
├── Workspace / Tabs / Conversation
├── Work Items / Tasks / Files / Skills
├── Markdown / Editor / Diff
└── Drag & Drop
        ↕ HTTP / WebSocket
PMForge Local Core
├── Conversation & Agent Runtime
├── Work Item Store
├── File Boundary / Search / Watch
├── Skill Registry & Router
├── Task Provider Adapters
├── Controlled Write
└── Permission / Audit

Future Electron Thin Shell
├── Native Window / Menu / Notification
├── Native Directory Picker / Drop
└── Local Core Lifecycle
```

### 选择性复用边界

- 可优先移植：Workspace Tabs、文件拖放、Markdown/Diff/编辑器交互、纯状态算法和无运行时依赖的 UI 组件；
- 需要解耦后再用：Native Chat、文件树、任务浏览等依赖 Orca Store 或 Preload API 的组件；
- 不直接复制：全局 Store、Worktree 生命周期、Terminal/PTY、SSH、Relay、Electron Preload 巨型接口及深度耦合主页面；
- 每个复制或改造项记录原仓库、基线 commit、原文件路径、修改说明和许可证；
- 发布包保留 Orca/Lovecast Inc. 的 MIT 版权声明，并维护 Third-Party Notices；
- PMForge 领域模型从 Product、Work Item、Conversation、Fact Source、Skill 和 External Task 独立建立。

## 6. 为什么不全量 fork

用户的真实工作流证明 Orca 的交互值得借鉴，但并不要求继承它的全部基础设施。选择性复用可以同时获得：

- 与 Orca 相近的成熟 Workspace 体验；
- PMForge 独立、清晰的领域模型；
- 先用 B/S 快速验证，再以薄 Electron 壳补足原生能力；
- 避免承担 126 万行代码、快速上游和深度 Worktree/Runtime 耦合。

## 7. 推荐实施顺序

```text
1. 定义 Browser UI ↔ Local Core 协议
2. 建立 Work Item / Conversation / Fact Source 最小模型
3. 建立五区壳和主对话
4. 逐个评估 Orca 可移植组件并登记来源
5. 完成文件/目录拖入和标签页
6. 完成 Skill 区与任务导入
7. 完成 PRD 生成、Diff 和写回闭环
8. 核心模型稳定后封装 Electron Thin Shell
```

## 8. 尚待技术设计确认

1. B/S 前端和 Local Core 的具体技术栈；
2. AI 对话采用 SDK/RPC 还是 CLI Agent 进程协议；
3. 浏览器阶段如何完成原生目录选择与外部文件拖放；
4. Orca 第一批拟移植组件及其依赖切割成本；
5. Electron 薄壳与 Local Core 的进程和更新模型。
