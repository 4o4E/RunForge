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
- 任务以最终汇报自然完成；已有 plan 时必须先收口所有条目并进入 `reporting` 阶段，避免未完成计划被误标 done。
- 支持 `update_plan` 维护 Goal 锚点，降低长任务目标漂移。
- 支持取消 run、无进展检测、`ask_user` 暂停等待用户输入。
- 支持服务启动后恢复 `pending` / `running` run，并补齐中断前缺失的 tool result，保证 `tool_call` 与 `tool_result` 配对。

边界：当前还不是多 worker 调度系统，没有 lease（租约）、heartbeat（心跳）、任务抢占、失败重试和跨 worker 接管。

### LLM 集成与工具调用

- 默认 provider 是 `aisdk`，复用 Vercel AI SDK 处理协议、流式、重试和工具拼装。
- 旧的 `openai-responses`、`openai-chat`、`anthropic` 保留为兼容和回滚路径。
- 工具通过统一 registry 执行，内置 shell、托管 shell、文件读写/编辑、glob、grep、web fetch、web search、ask user、update plan、skill、workflow、subagent 和数据源访问。
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
- 支持托管 shell session：命令可以前台等待或后台运行，后续通过 `shell_poll` 观察、`shell_kill` 终止，并在右侧 Shell 面板持续展示输出。
- shell session 和命令日志会落库，用户也可以在 UI 中打开、关闭、重命名、执行命令和标记输出给 LLM 参考。

边界：默认 `TOOL_SANDBOX=off`；当前没有 per-run workspace、CPU/内存/进程数/磁盘配额，也没有域名 allowlist。托管 shell 仍依赖当前 server 进程和本机后端，尚未支持远程 worker 接管。

### Skill、Workflow 与 Subagent

- 支持 skill 文件协议：内置 skill 从 `server/src/skills/builtin` 物化到 `.agents/skills`，用户 skill 从 `.skills` 读取。
- 初始上下文只注入 skill 名称和描述；需要正文时通过 `skill_activate` 按需加载，并记录 `skill_activated` 事件。
- 支持 `allowed-tools` 缩小激活 skill 后可见工具集合，不能放大全局工具策略。
- 支持 workflow 文件协议：内置 workflow 从 `server/src/workflows/builtin` 物化，LLM 可用 `workflow_list` 和 `workflow_read` 选择稳定流程。
- 支持异步只读 subagent：主 agent 通过 `subagent_run` 创建子任务，立即拿到 `subagentRunId`，后续通过 `subagent_poll` / `subagent_list` 回收结果。
- subagent 输出和 usage 写入 `subagent_runs`，并产生 `subagent_started`、`subagent_finished` 或 `subagent_failed` 事件；前端右侧资源栏可以查看 subagent。

边界：subagent v1 只做异步只读推理，不直接调用工具或改文件；没有独立沙箱、独立资源配额、超时回收 worker 和跨进程恢复。skill 还没有远程安装、签名校验、前端管理面和 per-skill 资源配额。

### 前端与用户体验

- 前端通过 REST + WebSocket 展示 step、reasoning、tool call、tool result、final、error 等事件。
- 支持 Markdown/Mermaid/LaTeX 输出；复杂报告可通过 shell 或文件写入工具生成 HTML artifact 并在文件面板预览。
- 支持用户在 run 中途回答 `ask_user` 问题。
- 支持右侧资源栏查看文件、托管 shell 和 subagent；shell 事件使用 thread 级 WebSocket 单独刷新。

边界：跨 thread memory / gene 系统还没有实现；当前连续性主要来自 thread 内历史消息、压缩摘要和显式资源面板。

## 后续未实现能力

- 独立调度系统：gateway / worker 拆分、Redis Stream 队列、lease、heartbeat、失败重试。
- per-run workspace：每个 run 独立工作区、artifact 索引和清理策略。
- 资源治理：CPU、内存、进程数、磁盘、网络 allowlist 和成本统计。
- 鉴权与多租户：resource URL 权限模型、tenant id 隔离、用户和项目权限。
- subagent 平台化：独立工具执行、独立沙箱、超时回收、跨 worker 恢复和更强的失败隔离。
- 托管 shell 平台化：Docker/E2B/远程 worker 后端、run 级资源配额和更完整的 stdin/PTY 交互。
- skill 平台化：远程安装、签名校验、前端管理面、per-skill 权限 profile 和资源配额。
- memory 系统：跨对话沉淀用户习惯和任务处理经验，并支持可追溯更新。
