# Agent 核心边界：社区方案与自研运行时

本文说明 `RunForge` agent 核心中哪些能力交给社区方案，哪些能力必须由项目自己维护。

目标不是把 agent runtime 整体换成某个框架，而是把通用、低差异化、社区会持续优化的部分交给成熟库；同时保留 `RunForge` 作为可观测 Agent 运行平台原型的核心边界。

## 一句话原则

社区方案负责协议适配、通用消息裁剪和生态接入；RunForge 负责 `thread -> run -> step` 执行状态、事件回放、工具权限、shell 生命周期、数据库凭证和压缩持久化不变式。

换句话说：能被替换成库而不影响产品语义的部分尽量外包；一旦涉及执行链、审计、恢复、安全和用户可见状态，就留在 RunForge runtime 内。

## 当前社区方案

### Vercel AI SDK / AI SDK

用途：

- 统一模型调用入口，当前默认 provider 是 `aisdk`。
- 负责 OpenAI、OpenAI-compatible、Anthropic 等模型协议适配。
- 负责 `generateText`、`streamText`、流式增量、usage 和 tool call 拼装。
- 负责把 RunForge 的中立 `LlmMessage`、`LlmTool` 映射到模型可接受的消息和工具定义。

RunForge 仍然自己负责：

- 不使用 AI SDK 的 tool `execute` 自动执行能力；模型只产出 tool call，实际工具执行仍由 `executor.ts` 调度。
- 不把 run 生命周期交给 AI SDK；`running / waiting_for_user / done / error / canceled` 仍由 RunForge store 维护。
- 不把前端事件协议交给 AI SDK；WebSocket 事件、历史回放和 step 展示仍按 RunForge 的 `AgentEvent` 生成。

原因：

AI SDK 很适合屏蔽模型协议差异，但 RunForge 的价值在“可观测执行过程”和“可恢复状态链”，这部分不能被 provider 层吞掉。

相关文件：

- [server/src/llm/providers/aiSdk.ts](../server/src/llm/providers/aiSdk.ts)
- [server/src/llm/index.ts](../server/src/llm/index.ts)
- [server/src/llm/types.ts](../server/src/llm/types.ts)

### MCP SDK

MCP 是 Model Context Protocol，中文可以理解为“模型上下文协议”：它把外部服务暴露成标准工具列表和工具调用接口。

用途：

- 使用 `@modelcontextprotocol/sdk` 连接远程 MCP server。
- 使用 `StreamableHTTPClientTransport` 处理远程 HTTP MCP 连接。
- 调用 `listTools` 获取外部工具定义。
- 调用 `callTool` 执行外部 MCP 工具。

RunForge 仍然自己负责：

- 把 MCP 工具映射成 `mcp__serverId__toolName`，避免和内置工具重名。
- 按 settings 中的 server allowlist 控制哪些 MCP 工具暴露给模型。
- 对 MCP 结果做文本化、二进制落盘、图片 Markdown 链接和输出长度截断。
- MCP 工具调用仍要经过 RunForge 的工具策略入口。

原因：

MCP SDK 解决协议和传输问题，但工具命名空间、权限策略、工作区落盘和前端可见结果是 RunForge 自己的产品边界。

相关文件：

- [server/src/mcp/client.ts](../server/src/mcp/client.ts)
- [server/src/tools/registry.ts](../server/src/tools/registry.ts)
- [server/src/tools/policy.ts](../server/src/tools/policy.ts)

### LangChain Core

用途：

- 引入 `@langchain/core/messages` 的消息类型和 `trimMessages`。
- 新增 `AGENT_CONTEXT_STRATEGY=langchain-trim` 可选策略。
- 在 `langchain-trim` 策略里，把普通历史消息裁剪交给 LangChain 的消息抽象和裁剪函数。

RunForge 仍然自己负责：

- 默认策略仍是 `current`，保持原有 L1 mask、L3 摘要、L2 内存窗口行为。
- LangChain 策略只接管普通历史裁剪，不接管 tool result masking、摘要落库、Goal 锚点和 DB collapsed 标记。
- LangChain 裁剪后必须回到 RunForge 的 `repairToolPairs` 安全边界，确保不会留下孤儿 tool result，也不会留下缺少 tool result 的 assistant tool call。
- 社区库不能直接接触 store；它只处理 `ContextCompactor` 输入里的工作消息视图。

原因：

普通裁剪和 token-aware trim 是社区库更适合持续优化的部分；但 RunForge 的压缩不是纯 token 优化，还要保证执行历史可回放、压缩决策可落库、provider 消息结构合法。

相关文件：

- [server/src/agent/contextCompactor.ts](../server/src/agent/contextCompactor.ts)
- [server/src/agent/context.ts](../server/src/agent/context.ts)
- [server/src/agent/compaction.ts](../server/src/agent/compaction.ts)
- [server/src/agent/compaction.test.ts](../server/src/agent/compaction.test.ts)

### OpenTelemetry

用途：

- 提供标准 tracing 能力。
- AI SDK provider 可把 GenAI 相关 span 输出到 OpenTelemetry。

RunForge 仍然自己负责：

- 业务事件仍写入 `events` 表，并通过 WebSocket 推送给前端。
- OpenTelemetry 是观测补充，不是 RunForge 前端回放的 source of truth。

原因：

OpenTelemetry 面向工程观测，RunForge 的 `events` 面向用户可见执行过程，两者目的不同。

相关文件：

- [server/src/telemetry.ts](../server/src/telemetry.ts)
- [server/src/agent/executor.ts](../server/src/agent/executor.ts)

## 当前自研部分

### Agent 主循环

自研范围：

- `executeRun` 主循环。
- `thread -> run -> step` 生命周期。
- run 状态切换。
- 每 step 的 LLM 调用、工具调用、工具结果回填。
- 用户取消、等待用户、无进展检测和 hard step cap。
- final 输出和 plan 收口。

为什么自研：

这是 RunForge 的执行链主语义。换成社区 agent 框架后，前端事件、DB 状态、工具调度和恢复逻辑都会被框架生命周期影响，反而会削弱平台原型的可控性。

相关文件：

- [server/src/agent/executor.ts](../server/src/agent/executor.ts)
- [server/src/agent/types.ts](../server/src/agent/types.ts)
- [server/src/store/types.ts](../server/src/store/types.ts)

### 上下文管理和压缩不变式

自研范围：

- `ContextManager` 持有工作消息列表和对应 DB id。
- `ContextCompactor` 策略接口。
- `current` 默认策略。
- L1 tool result masking。
- L3 锚定摘要。
- L2 内存滑动窗口。
- `messages.collapsed` 和 `summary_of` 持久化语义。

社区接入点：

- `langchain-trim` 只作为一个 `ContextCompactor` 策略实现。
- 后续如果 AI SDK 或 LangChain 提供更合适的裁剪能力，只替换策略实现，不改 executor、store 和事件协议。

必须保持的不变式：

- `tool_call` 和 `tool_result` 配对永不破坏。
- `messages.content` 保存原始内容，压缩只派生模型视图。
- masking 决策可以落库，滑动窗口 drop 只在内存发生。
- summary message 可落库，并回填到工作上下文。
- Goal system message 永远在前置 system 区，不被裁剪策略丢掉。
- 社区策略不能直接写 DB，也不能决定 run 状态。

相关文件：

- [server/src/agent/context.ts](../server/src/agent/context.ts)
- [server/src/agent/contextCompactor.ts](../server/src/agent/contextCompactor.ts)
- [server/src/agent/compaction.ts](../server/src/agent/compaction.ts)
- [server/src/store/pgStore.ts](../server/src/store/pgStore.ts)
- [server/src/store/messageView.ts](../server/src/store/messageView.ts)

### 工具注册和权限策略

自研范围：

- 内置工具 registry。
- tool allowlist / denylist。
- workspace 路径围栏。
- shell 开关、网络开关、输出长度上限。
- 数据库访问 guard。
- skill / workflow / subagent 的特殊调度入口。

为什么自研：

工具权限是 OS agent 的安全边界。社区框架可以提供工具抽象，但不能替代 RunForge 对本机文件、shell、数据源和用户可见 artifact 的控制。

相关文件：

- [server/src/tools/registry.ts](../server/src/tools/registry.ts)
- [server/src/tools/policy.ts](../server/src/tools/policy.ts)
- [server/src/tools/databaseAccessGuard.ts](../server/src/tools/databaseAccessGuard.ts)

### 托管 shell 生命周期

自研范围：

- thread 级 shell session。
- 前台/后台命令。
- shell 日志增量。
- 用户观察、轮询、终止和接管。
- run 取消时的命令清理。

为什么自研：

通用 agent 框架通常只抽象“一次工具调用”，但 RunForge 需要把 shell 当成长生命周期资源，供 agent 和用户共同观察。

相关文件：

- [server/src/shell/manager.ts](../server/src/shell/manager.ts)
- [server/src/tools/managedShell.ts](../server/src/tools/managedShell.ts)
- [server/src/api/ws.ts](../server/src/api/ws.ts)

### 持久化和事件回放

自研范围：

- PostgreSQL schema。
- Store 抽象。
- `messages` 原文保留和压缩视图。
- `events` 作为前端回放 source of truth。
- branch / fork / active run 历史视图。

为什么自研：

RunForge 要展示“agent 做过什么”，不是只拿到最终答案。社区框架的 checkpoint 或 memory 可以参考，但不能替代当前 DB 事件链。

相关文件：

- [server/src/store/pgStore.ts](../server/src/store/pgStore.ts)
- [server/src/store/messageView.ts](../server/src/store/messageView.ts)
- [server/src/db/schema.sql](../server/src/db/schema.sql)

### 数据源短期凭证

自研范围：

- run 级 workload token。
- 数据源账号池。
- 短期凭证租约。
- database-access skill 的 helper 脚本使用约束。

为什么自研：

这是 RunForge 面向真实企业数据源时的安全控制面，不属于通用 agent 框架的默认职责。

相关文件：

- [server/src/datasources/accountPool.ts](../server/src/datasources/accountPool.ts)
- [server/src/tools/databaseAccessGuard.ts](../server/src/tools/databaseAccessGuard.ts)
- [server/src/skills/builtin/database-access/SKILL.md](../server/src/skills/builtin/database-access/SKILL.md)

## 上下文策略边界

当前配置：

```bash
AGENT_CONTEXT_STRATEGY=current
AGENT_CONTEXT_STRATEGY=langchain-trim
```

`current` 是默认策略：

- 保持 RunForge 原有压缩级联。
- L1：mask 旧工具结果和旧 assistant 大参数。
- L3：必要时调用当前 provider 生成锚定摘要。
- L2：仍超预算时做内存滑动窗口。

`langchain-trim` 是可选策略：

- 先保留 RunForge 的 L1 和 L3 语义。
- 如果仍超预算，把普通历史裁剪交给 LangChain `trimMessages`。
- 裁剪后回到 RunForge 的 tool pair 修复边界。
- 不改变 DB 原文，不直接落库，不改变 run 状态。

判断一个新上下文能力应放在哪里：

- 如果只是“怎么更好地按 token 预算保留消息”，优先放进 `ContextCompactor` 策略，允许使用社区库。
- 如果涉及“哪些消息应落库为 collapsed / summarized”，必须由 RunForge 决定。
- 如果涉及“前端如何回放执行过程”，必须由 RunForge 的 events 决定。
- 如果涉及“工具是否允许执行”，必须由 RunForge 的 tool policy 决定。

## 不采用整体框架替换的原因

LangGraph、Mastra、Temporal、Inngest、Trigger.dev 等方案可以在未来用于部分能力，但当前不整体替换 agent core。

原因：

- RunForge 已有稳定的 `thread -> run -> step -> messages -> events` 数据模型。
- 前端依赖细粒度事件展示 reasoning、工具调用、工具结果和 final。
- shell、workspace、数据源凭证、MCP artifact 落盘都有项目特定语义。
- 个人项目优先降低维护成本，但不能把项目最有区分度的 runtime 边界抹掉。

可以后续评估的接入方式：

- 用 durable workflow 平台承载后台长任务调度，但不替代 `events` 和 `messages`。
- 用更成熟的 memory 服务承载跨 thread 长期偏好和事实，但不替代当前 thread 历史。
- 用社区 summarization middleware 替换某个 `ContextCompactor` 策略，但不直接写 store。

## 维护规则

修改 agent 核心时遵守：

- 新增社区库前，先说明它替代的是哪一层，不要泛泛说“改用框架”。
- 社区库只能接入明确 adapter，不能从 executor 里散落调用。
- 默认行为必须尽量保持 `current` 可回滚。
- 所有策略必须有测试覆盖 tool pair、Goal 锚点、原文不变和 collapsed id。
- 修改 `server/src/agent/`、context 或 store 后，按 [AGENTS.md](../AGENTS.md) 要求跑长任务验证链路；至少要跑 server typecheck 和相关单测。

## 当前验证入口

新增和已有验证包括：

- [server/src/agent/compaction.test.ts](../server/src/agent/compaction.test.ts) 覆盖压缩纯函数、默认策略和 `langchain-trim` 策略。
- [server/src/agent/persistence.test.ts](../server/src/agent/persistence.test.ts) 覆盖 collapsed 持久化和 model view 还原。
- [server/src/evals/agentCoreVerification.ts](../server/src/evals/agentCoreVerification.ts) 提供 agent core 端到端验收脚本，覆盖工具组合、计划收口、压缩和配对等核心链路。

