# 系统设计

本文承接 README 中原有的详细设计内容，描述 `my-agent` 当前版本的系统结构、执行流程和主要模块边界。README 只保留项目入口和文档导航。

## 设计意图

`my-agent` 的目标是构建一个通用 AI Agent 平台原型：用户提交一段自然语言任务，平台启动一个自主 agent，在后端运行环境中调用 LLM 进行推理，调用工具读写文件、执行命令或访问网络，循环迭代直到任务完成，最后返回结果并保留完整过程。

项目参考 `corint-cognition` 的架构思想，但做了三点简化：

- 后端用 Node.js / TypeScript 实现。
- 数据库直接使用 PostgreSQL。
- 不拆分 gateway 和 runtime，当前版本是单体服务，Agent 执行循环在进程内运行。

这个取舍让原型更容易本地启动和迭代，但也意味着它还不是完整云端多 worker 平台。独立队列、worker 调度、多租户鉴权和资源配额属于后续平台化能力。

## 当前能力

- 通过 Agent 执行循环完成多步任务：计划、调用工具、观察结果、继续推进。
- 支持多 LLM provider：`aisdk`、`openai-responses`、`openai-chat`、`anthropic`、`mock`。
- 内置通用工具：shell、文件读写/编辑、glob、grep、web fetch、web search、ask user、render UI、update plan、finish conversation。
- LLM 请求支持超时、瞬态错误重试和流式输出。
- 暴露 REST API 和 WebSocket 事件流。
- 对话按 `thread -> run -> step` 组织并持久化到 PostgreSQL。
- 前端提供 React 聊天控制台，可查看 reasoning、工具调用、工具结果和最终输出。
- 支持上下文压缩、Goal 锚点、取消 run、服务启动恢复、工具输出截断和工具策略。

## 对话模型

核心层级是 `thread -> run -> step`。

- `thread`：一段会话，包含多轮 run，用于承载跨轮记忆。
- `run`：一轮用户输入触发的一次 Agent 执行，从输入到最终结果。
- `step`：run 内执行循环的一次迭代，通常包含一次 LLM 决策和若干工具调用。

每个 run 启动时会加载当前 thread 的历史消息，构造 LLM 上下文，因此 Agent 具备跨轮记忆。长任务中，历史消息会经过上下文压缩视图加载，避免无限增长导致模型上下文溢出。

## 架构概览

```text
React Web
  |
  | REST / WebSocket
  v
Server (Node.js / TypeScript 单体)
  |
  |-- API 层
  |     |-- REST: thread / run / settings / files
  |     `-- WebSocket: run 事件订阅
  |
  |-- Agent 执行循环
  |     |-- ContextManager: system prompt、Goal 锚点、历史消息、压缩视图
  |     |-- Provider 抽象: aisdk / openai-responses / openai-chat / anthropic / mock
  |     |-- Tool registry: 工具注册、策略检查、输出截断
  |     `-- Run bus: 进程内事件发布
  |
  |-- Store 抽象
  |     |-- PgStore: PostgreSQL 持久化
  |     `-- MemoryStore: 测试和离线运行
  |
  v
PostgreSQL
```

执行主线：

```text
Web 创建 thread
-> Web 在 thread 内启动 run
-> 后端创建 run 记录
-> executeRun 进程内异步执行
-> 每个 step 调用 LLM
-> LLM 请求工具时执行工具
-> 工具结果回填上下文
-> 事件经 WebSocket 实时推送并写入 events
-> Agent 调用 finish_conversation 后 run done
```

当前关键设计：

- run 在收到请求后由当前服务进程异步执行，没有独立队列和 worker。
- Provider 抽象隔离不同 LLM 协议，执行循环只依赖中立消息和工具类型。
- Store 抽象隔离 PostgreSQL，测试可以使用 MemoryStore。
- Tool registry 是工具调用统一入口，策略检查和输出截断都在这里执行。
- ContextManager 在每次 LLM 调用前检查 token 预算，必要时做 observation masking、L3 摘要或滑动窗口压缩。
- 服务启动时会恢复 `pending` / `running` run；`canceling` run 会收束为 `canceled`。

## 后端模块

`server/src/index.ts`

- Express 和 WebSocket 服务入口。
- 初始化 OpenTelemetry。
- 注册 `/api` 和 `/ws`。

`server/src/api/`

- `http.ts`：thread、run、取消、settings、files 等 REST API。
- `ws.ts`：按 runId 订阅事件流，支持历史事件回放后继续推送实时事件。

`server/src/agent/`

- `executor.ts`：Agent 主循环，负责 run 状态、step 创建、LLM 调用、工具调度、事件落库。
- `context.ts`：上下文管理，注入 system prompt、Goal 锚点、历史消息和当前用户输入。
- `compaction.ts`：上下文压缩纯函数，包括 token 估算、tool result masking、L3 摘要候选和滑动窗口。
- `goal.ts`：GoalState 初始化、更新和渲染。
- `recovery.ts`：服务启动恢复入口；恢复执行时由 `executor.ts` 补齐中断前缺失的工具结果提示。
- `bus.ts`：进程内事件 pub/sub。
- `types.ts`：AgentEvent、RunStatus 等类型。

`server/src/llm/`

- `types.ts`：中立消息、工具、usage、Provider 接口。
- `index.ts`：按 `LLM_PROVIDER` 创建 provider。
- `providers/aiSdk.ts`：默认 provider 路径，基于 AI SDK。
- `providers/openaiResponses.ts`、`openaiChat.ts`、`anthropic.ts`：手写旧 provider，仅作为兼容和回滚路径。
- `providers/mock.ts`：离线确定性 provider，用于测试和本地演示。

`server/src/tools/`

- `registry.ts`：工具注册表和统一执行入口。
- `policy.ts`：工具 allow/deny、路径围栏、shell 开关、网络开关、输出截断。
- `sandbox.ts`：shell 子进程执行后端，支持宿主执行和 bwrap。
- 具体工具：`shell`、`file_read`、`file_write`、`file_edit`、`glob`、`grep`、`web_fetch`、`web_search`、`ask_user`、`render_ui`、`update_plan`、`finish_conversation`。

`server/src/store/`

- `types.ts`：Store 接口。
- `pgStore.ts`：PostgreSQL 实现。
- `memoryStore.ts`：内存实现。
- `index.ts`：根据配置选择 store。

`server/src/db/`

- `schema.sql`：PostgreSQL schema。
- `migrate.ts`：幂等迁移入口。
- `pool.ts`：数据库连接池。

## 前端模块

`web/src/App.tsx`

- 顶层应用状态：会话选择、输入草稿、附件、运行状态、设置页、文件面板。
- 使用 AI SDK `useChat`，但传输层适配的是当前后端 REST + WebSocket 管线。

`web/src/transport/`

- `aiSdkChat.ts`：把后端 REST + WebSocket 事件适配为 AI SDK UI message stream。
- `legacy.ts`：当前后端协议的低层请求和事件流封装。

`web/src/components/`

- `Sidebar`：会话列表和入口导航。
- `ChatView`、`Conversation`、`Composer`：聊天主界面。
- `SettingsView`：工具策略、沙箱、网络和输出上限等运行时配置。
- `RemoteFilesPanel`：工作区文件浏览和预览。

`web/src/a2ui/`

- A2UI 可信组件 catalog 和渲染入口，用于展示 agent 生成的结构化 UI。

## Provider 设计

执行循环只依赖统一接口：

```typescript
Provider.complete(messages, tools) -> { content, reasoning, toolCalls, usage }
```

如果 provider 支持流式输出，还可以实现：

```typescript
Provider.completeStream(messages, tools, onDelta)
```

各 provider 负责把中立消息、工具定义和工具结果翻译成目标协议。

当前支持：

- `aisdk`：默认路径，基于 Vercel AI SDK，可选择 OpenAI、OpenAI-compatible、Anthropic flavor。
- `openai-responses`：手写 OpenAI Responses API provider，保留为回滚路径。
- `openai-chat`：手写 Chat Completions provider，可兼容部分 OpenAI-compatible 服务，保留为回滚路径。
- `anthropic`：手写 Anthropic Messages provider，保留为回滚路径。
- `mock`：离线 deterministic provider，不需要密钥和网络。

通过 `LLM_PROVIDER` 切换 provider。AI SDK flavor 通过 `LLM_AISDK_FLAVOR` 选择。

## 数据模型

PostgreSQL 以执行过程为核心建模：

- `threads`：会话容器，包含多轮 run。
- `runs`：一次用户任务执行，保存状态、输入、输出、错误和 `goal_state`。
- `steps`：run 内的每次 Agent 循环。
- `messages`：LLM 对话消息，保存原始内容、tool calls、tool call id 和压缩标记。
- `events`：前端可回放的执行事件流。
- `app_settings`：运行时工具配置，env 只作为初始默认值或兜底。

重要约束：

- `messages.content` 保留原始内容，压缩不覆盖原文。
- `messages.collapsed='masked'` 表示加载上下文时派生短占位符。
- `messages.collapsed='summarized'` 表示原消息已折叠进摘要消息，后续加载上下文时会跳过原消息。
- `events` 保存前端回放和审计所需事件。

## API 概览

Thread API：

- `POST /api/threads`：创建 thread。
- `GET /api/threads`：列出 thread。
- `GET /api/threads/:id`：获取 thread 详情和其 runs。
- `DELETE /api/threads/:id`：删除 thread 及相关 run 数据。

Run API：

- `POST /api/threads/:id/runs`：在指定 thread 内启动 run。
- `GET /api/runs/:id`：获取 run 详情和事件。
- `POST /api/runs/:id/cancel`：请求取消 run。

实时事件：

- `WS /ws?runId=<id>`：订阅指定 run 的事件流。连接后先回放历史事件，再推送新事件。

辅助 API：

- `/api/files`：工作区文件信息、文件读取和上传。
- `/api/settings`：读取和保存工具策略配置。

## 事件模型

`AgentEvent` 是前端实时渲染和回放的统一事件类型。

常见事件：

- `step_start`：新 step 开始。
- `reasoning`：模型 reasoning 流式片段或完整 reasoning。
- `reasoning_timing`：reasoning 计时信息。
- `llm_delta`：模型文本输出增量。
- `tool_call`：模型请求工具调用。
- `tool_result`：工具执行结果。
- `a2ui`：结构化 UI 消息。
- `compaction`：上下文压缩发生。
- `recovery`：服务重启或工具结果缺失修复后继续执行。
- `final`：run 正常完成。
- `error`：run 出错或取消。

## 工具策略与沙箱

工具调用统一经过 `registry.runTool`：

```text
LLM tool call
-> registry 查找工具
-> policy.check
-> tool.run
-> policy.capOutput
-> tool result 回填上下文和事件流
```

策略层能力：

- `TOOL_ALLOW` / `TOOL_DENY` 控制工具准入。
- `TOOL_SANDBOX=enforce` 时启用文件路径围栏、shell 开关和网络开关。
- `TOOL_WORKSPACE_ROOT` 定义受控工作区根目录。
- `SHELL_ENABLED` 控制 shell 工具是否可用。
- `SHELL_DENY` 阻止明显危险命令模式。
- `TOOL_NETWORK` 控制 web 工具和 shell 网络能力。
- `TOOL_MAX_OUTPUT` 限制单条工具结果长度，默认 40000 字符，且在任何沙箱模式下都生效。

shell 沙箱后端：

- `TOOL_SANDBOX_BACKEND=none`：宿主执行。
- `TOOL_SANDBOX_BACKEND=auto`：Linux 且 bwrap 可用时使用 bwrap，否则回落宿主执行并告警。
- `TOOL_SANDBOX_BACKEND=bwrap`：强制使用 bwrap，不可用则失败。

bwrap 模式会只读投射动态库和白名单命令，可写投射工作区，默认不共享网络命名空间。

## 当前边界

当前版本已完成核心闭环，但以下能力仍属于后续平台化工作：

- 独立任务队列和多 worker 横向扩展。
- run 级 lease、心跳和跨 worker 接管；当前只有单进程服务启动恢复。
- 多租户鉴权、用户隔离、项目隔离和审计权限。
- per-run 独立工作区生命周期管理。
- CPU、内存、进程数、磁盘和网络资源配额。
- subagent 并行处理、常驻 shell、skill 系统和 memory 系统。

相关设计和路线见：

- [长任务设计](long-task-design.md)
- [工具沙箱设计](tool-sandbox.md)
- [架构改造方案](refactor-plan.md)
