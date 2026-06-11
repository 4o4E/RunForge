# 验收报告

## 开发思路

本轮开发优先验证 Agent 产品闭环，而不是提前做完整云平台：

- 优先实现上下文管理、完整 Agent 链路和用户交互体验。
- 优先采用最佳实践和主流方案，少自己造轮子，降低长期维护成本。
- 调度、多租户、鉴权、资源配额等平台级能力暂不实现，只保留清晰扩展边界。
- 对已经实现的能力按代码事实验收；对路线图能力只说明设计方向，不写成已完成。

后续如果实现平台化能力，计划按以下方向推进：

- 调度：拆分 gateway（网关）和 worker（工作进程），用 Redis Stream 做低延时、轻量级任务队列。
- 鉴权：为 thread、run、workspace、settings 等资源抽象唯一 resource URL，并围绕 resource URL 设计权限模型。
- 多租户：通过 tenant id 做数据库记录和 workspace 路径的轻量级隔离。

## 当前已完成

### Agent 编排与调度

- 使用 `thread -> run -> step` 组织一次用户任务。
- run 在当前 server 进程内异步执行，由 `executeRun` 串联 LLM 决策、工具调用、结果回填和最终完成。
- 任务必须调用 `finish_conversation` 才算完成，避免只输出文本就结束。
- 支持 `update_plan` 维护 Goal 锚点，降低长任务目标漂移。
- 支持取消 run、无进展检测、`ask_user` 暂停等待用户输入。
- 支持服务启动后恢复 `pending` / `running` run，并补齐中断前缺失的 tool result，保证 `tool_call` 与 `tool_result` 配对。

边界：当前还不是多 worker 调度系统，没有 lease（租约）、heartbeat（心跳）、任务抢占、失败重试和跨 worker 接管。

### LLM 集成与工具调用

- 默认 provider 是 `aisdk`，复用 Vercel AI SDK 处理协议、流式、重试和工具拼装。
- 旧的 `openai-responses`、`openai-chat`、`anthropic` 保留为兼容和回滚路径。
- 工具通过统一 registry 执行，内置 shell、文件读写/编辑、glob、grep、web fetch、web search、ask user、render UI、update plan、finish conversation。
- 工具结果以 tool message 回填，并保留 `toolCallId`，满足主流模型协议对工具调用配对的要求。
- reasoning（推理信息）只用于前端展示，不回填上下文。

边界：复杂工具参数校验仍较轻量；真实 provider 兼容性仍需要更多端到端样例覆盖。

### 上下文管理

- 通过 `LLM_CONTEXT_BUDGET` 和模型窗口推导保守预算。
- 支持 L1 observation masking（观测压缩）、L2 sliding window（滑动窗口）和 L3 anchored summary（锚定摘要）。
- 压缩只派生 LLM 视图，不删除原始 message；`messages.collapsed` 记录 masking / summarized 决策。
- 使用 provider usage 校准 token 估算。
- `TOOL_MAX_OUTPUT` 默认 40000 字符，单条工具结果始终截断并保留头尾内容。

边界：L3 摘要已有代码路径，但仍需要更多真实长任务压测来验证摘要质量。

### 沙箱与隔离基础

- 所有工具调用先经过 tool policy（工具策略）。
- 支持 `TOOL_ALLOW` / `TOOL_DENY`、路径围栏、shell 开关、网络开关和输出上限。
- shell 支持可选 bwrap（bubblewrap，Linux 用户态沙箱）后端；`auto` 模式在 bwrap 不可用时会回落宿主执行，强制隔离需要 `TOOL_SANDBOX_BACKEND=bwrap`。

边界：默认 `TOOL_SANDBOX=off`；当前没有 per-run workspace、CPU/内存/进程数/磁盘配额，也没有域名 allowlist。

### 前端与用户体验

- 前端通过 REST + WebSocket 展示 step、reasoning、tool call、tool result、final、error 等事件。
- 支持结构化 UI 输出，agent 可用 `render_ui` 生成可读的结果视图。
- 支持用户在 run 中途回答 `ask_user` 问题。

边界：subagent、常驻 shell、skill、memory 还没有实现。

## 后续未实现能力

- 独立调度系统：gateway / worker 拆分、Redis Stream 队列、lease、heartbeat、失败重试。
- per-run workspace：每个 run 独立工作区、artifact 索引和清理策略。
- 资源治理：CPU、内存、进程数、磁盘、网络 allowlist 和成本统计。
- 鉴权与多租户：resource URL 权限模型、tenant id 隔离、用户和项目权限。
- subagent 并行处理：主 agent 拆分子任务、并发执行、结果汇总和失败隔离。
- 常驻 shell：支持长耗时命令的持续观察、stdin 写入和增量输出。
- skill 系统：把业务流程、检查清单和项目经验文档化复用。
- memory 系统：跨对话沉淀用户习惯和任务处理经验，并支持可追溯更新。
