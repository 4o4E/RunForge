# AGENTS.md — 项目约定与工作流

> 本文件每次对话自动加载，记录跨会话的工程约定。本地开发环境相关的细节（端口、
> 数据库口令、重启命令等）放在 `AGENTS.local.md`（不入库），在文末通过 `@` 引入。

## 项目结构

- `server/` — Node/TypeScript 后端（agent 主循环、LLM provider、工具、PG 持久化）
- `web/` — React/Vite 前端（对话渲染 + Markdown/Mermaid/LaTeX + HTML artifact 预览）
- `docs/` — 方案文档；`docs/impl-log/` 为分阶段实施记录

核心设计文档：

- [docs/long-task-design.md](docs/long-task-design.md) — 长任务支持：去 maxSteps、Goal 锚点、
  **上下文压缩级联 + 落库**。改动 agent 循环 / 压缩 / 上下文前先读它。

## 改动 agent 循环 / 压缩后的标准验证链路（restart → converse → analyze）

只跑单元测试不够——压缩、token 预算、工具上限这些只有在**真实长任务**里才暴露。
每次改了 [server/src/agent/](server/src/agent/)（executor / context / compaction）或工具输出、
存储层后，按这条链路验证：

1. **测试 + 构建**：`pnpm --filter server typecheck && pnpm --filter server test`
2. **迁移**（改了 `server/prisma/schema.prisma` 或新增 migration 时必做，且必须先于重启）：
   `pnpm db:migrate`
   - migration 只追加、不改写已执行文件。漏迁移会让新代码查询不存在的列直接报错。
   - 从旧 `schema.sql` 升级且表结构已存在的数据库，只在首次切换 Prisma 时执行一次
     `pnpm --filter server db:baseline`；全新数据库禁止跳过 baseline migration。
3. **重启前后端**：停掉旧进程再 `pnpm dev`（旧进程是旧代码，不重启等于没改）。
   - 具体停/起命令见 `AGENTS.local.md`。
4. **跑一个有代表性的对话**：短任务（< ~90k tokens 上下文）不会触发压缩；要验证压缩
   需要长任务（读大项目、多轮工具）。
5. **从数据库分析这次 run**（前端看不到的指标在库里）：确认
   - run `status`（done / error / canceled）与 `error`
   - 事件里是否有 `compaction`，其 `estBefore/estAfter/masked/dropped`
   - `messages` 的总量、最大单条工具结果（应 ≤ `TOOL_MAX_OUTPUT`）、`collapsed` 计数
   - DB 查询的具体做法见 `AGENTS.local.md`。

判定标准：长任务应**压着 token 预算跑完**，而不是撞窗口崩溃；单条工具结果不得超过
`TOOL_MAX_OUTPUT`；masking 决策应持久化到 `messages.collapsed`（重启不丢、不重算）。

## 工程约定

- **提交**：Conventional Commits（`feat(server): …` / `fix(web): …`）。提交前 `pnpm test` 必须全绿。
- **提交时机**：仅在用户明确要求时提交/推送。
- **前端组件**：能用组件库的控件一律用组件库，优先复用 `web/src/components/ui/` 已有 shadcn 组件；缺少组件时按 shadcn/Radix 官方模式补本地封装，不要手写外观相似但行为自造的替代组件。
- **压缩不变式**（改压缩务必守住，见设计文档 §6）：
  - `tool_call ↔ tool_result` 配对永不破坏；
  - `messages.content` 永远是原始内容，压缩只派生视图、从不覆盖/删除；
  - 滑动窗口 drop 仅内存安全阀、不落库（落库会真丢数据）。

## 对话规范

- 始终使用中文和用户交互，始终使用中文编写代码中的注释
- 说话简练，但是不丢失细节
- 对特殊概念始终解释说明，特别是一些外部带进来的英文概念

@AGENTS.local.md
