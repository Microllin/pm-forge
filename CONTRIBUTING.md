# 参与贡献

感谢愿意一起打磨 PMForge。这份文档说明怎么跑起来、怎么提交、以及哪些红线不能碰。

## 开发流程

1. Fork 本仓库并从 `main` 切出分支：

   ```bash
   git checkout -b feat/your-feature
   ```

   分支前缀与提交类型保持一致：`feat/`、`fix/`、`chore/`、`docs/`。

2. 安装依赖并启动：

   ```bash
   pnpm install
   pnpm dev
   ```

3. 改动完成后跑一遍全量检查：

   ```bash
   pnpm check
   ```

   这条命令依次执行格式检查、代码检查、类型检查、单元测试与构建，全部通过才算完成。

4. 提交并发起 Pull Request，描述里写清楚「改了什么、为什么改、怎么验证的」。

## 提交规范

遵循 [Conventional Commits](https://www.conventionalcommits.org/)，提交信息用中文。

```text
type(scope): 中文摘要（一句话说明做了什么）

- 变更点 1（具体说明）
- 变更点 2
```

- **type**：`feat` 新功能 · `fix` 修复 · `chore` 构建/工具/配置 · `docs` 文档 · `style` 格式 · `refactor` 重构 · `test` 测试 · `perf` 性能 · `ci` 流水线
- **scope**：模块名，英文小写，如 `(chat)`、`(portal)`、`(scrapers)`；全仓库级变更可省略
- **摘要**：中文，一行，不超过 72 字符

## 代码规范

### 通用

- TypeScript 严格模式，ESLint 开启 `strictTypeChecked`，**零警告**
- Prettier 统一格式，提交前 `pnpm format`
- 新增模块时在模块入口的注释里写清职责、边界与对外接口

### 服务端

- 路由统一在 `apps/chat/server/app.ts` 装配，业务逻辑放各自模块
- 数据库迁移写在 `db.ts` 的 `MIGRATIONS` 数组里，**只增不改**：已发布的迁移不允许回头修改
- 文件访问必须走 `files/paths.ts` 的越界检查，不要自己拼路径
- AI 取依据统一走 `evidence/`，不要绕过它直接读文件

### 前端

- 样式用 `web/src/styles.css` 中的设计 token，不要写死颜色值
- 交互组件优先复用 `web/src/ui/` 下已有的实现（原生 `select` 等被测试拦截）
- 本地 UI 状态用 `useState`，服务端状态用 TanStack Query，不引入全局状态库

### 测试

- 测试与实现同目录，命名 `*.test.ts` / `*.test.tsx`
- 修 bug 时先补一个能复现的用例，再改实现
- 涉及安全边界的改动（鉴权、路径、跨站）必须有对应用例

## 安全红线

以下内容**绝不提交**：

- API Key、Token、Webhook 密钥
- `.env` 及任何真实配置文件
- 生产数据库、运行期数据（`data/`、`*.db`）
- 他人的个人信息、真实内网地址

提交前请检查 diff：

```bash
git diff --cached | grep -iE "api[_-]?key|token|secret|password"
```

发现安全问题请不要公开提 Issue，直接通过仓库主页的联系方式私下告知。

## 提交 Pull Request 之前

- [ ] `pnpm check` 全部通过
- [ ] diff 中没有密钥或运行期数据
- [ ] 新增功能补了测试
- [ ] 改动了模块行为时同步更新了相关代码注释与 `docs/` 下的说明
