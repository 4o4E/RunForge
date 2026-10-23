# Agent 执行

## Purpose

约定单实例服务中会话、任务、模型请求和上下文的执行行为。实现入口：`server/src/agent/`、`server/src/llm/`；解释见 `docs/long-task-design.md` 和 `docs/subagent-memory-design.md`。

## Requirements

### Requirement: 会话内多轮执行

系统 SHALL 以 thread 组织多轮 run，以 step 保存一次模型请求及其工具结果；创建新 run 时加载当前会话分支的历史。当前运行由单个活动服务实例持有，不提供跨 worker 接管。

#### Scenario: 用户继续同一会话
- **WHEN** 用户在已有 thread 中提交新任务
- **THEN** 系统创建新的 run，并基于该分支历史构建模型上下文，不把整段 thread 计为一次任务

### Requirement: 模型协议与能力

系统 SHALL 支持 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages，并使用已保存的模型能力与空间模型授权。模型请求 SHALL 使用流式传输；缺少必需能力时明确失败。

#### Scenario: Anthropic 模型缺少输出长度
- **WHEN** 配置的 Anthropic 模型没有协议必需的最大输出长度
- **THEN** 系统拒绝创建 Provider，而不是猜测该值

#### Scenario: 模型已经发布部分输出
- **WHEN** 模型已发布正文、推理或工具增量后发生失败
- **THEN** 本次请求失败，不自动重试并重复已经发布的输出

### Requirement: 计划与任务完成

系统 SHALL 通过 `update_plan` 保存 Goal；没有待处理外部追加输入时，模型以正常 stop 返回非空最终正文且没有工具调用，系统 SHALL 保存正文并结束 run。Goal 收敛时 SHALL 保留真实的未完成或失败条目，不因计划状态追加模型请求。用户取消和执行错误 SHALL 与正常完成分别记录。

#### Scenario: 最终回复时仍有未完成计划
- **WHEN** 模型以正常 stop 返回非空最终正文且没有工具调用，计划仍包含未完成条目，也没有待处理外部追加输入
- **THEN** 系统保存最终正文，将 run 标记为 done，并在已结束的 Goal 中保留真实未完成状态

### Requirement: 上下文压缩保留权威原文

系统 SHALL 仅在派生模型视图中执行 L1 遮蔽、L3 摘要和 L2 窗口裁剪，保持工具调用与结果配对。持久化压缩选择 SHALL 位于 `runs.metadata.context.collapsed`，不得覆盖 step 原文或持久化删除窗口外历史。

#### Scenario: 压缩后恢复运行
- **WHEN** 服务恢复已经压缩的同一 run
- **THEN** 系统读取已保存的压缩选择及原始 step，不依赖 trace 重建历史

### Requirement: 中断恢复

系统 SHALL 在启动时恢复 pending/running 任务，将 canceling 任务收束为 canceled；缺失的工具结果 SHALL 明确记为中断，并紧接对应工具调用进入模型视图。

#### Scenario: 工具调用已保存但执行中断
- **WHEN** 服务重启后发现完整模型响应中的工具调用没有对应结果
- **THEN** 系统补齐明确的中断结果，不伪造执行成功，也不将结果插到后续用户输入之后

### Requirement: 按运行配置授权的异步子任务

系统 SHALL 允许主 Agent 异步派发子任务，保存输出与用量，并允许同一 thread 的后续运行读取结果。readonly/default profile SHALL 提供只读推理与读取、搜索工具；writer profile SHALL 按主 Agent 授权提供读写文件与 Shell 工具。子任务与主任务共享会话工作区，工具不得超出 profile 与主任务授权的交集。

#### Scenario: 主任务派发子任务
- **WHEN** `subagent_run` 接纳任务
- **THEN** 返回子任务标识，主任务可以继续其他工作，子任务结果和用量保存在所属运行关系中

#### Scenario: 只读子任务尝试写入文件
- **WHEN** readonly profile 的子任务请求 `file_write` 或 Shell 工具
- **THEN** 系统不执行该请求，只允许当前 profile 与主任务共同授权的读取和搜索能力

#### Scenario: 已授权的 writer 子任务修改文件
- **WHEN** writer profile 的子任务调用主任务已授权的文件写入或 Shell 工具
- **THEN** 系统在共享会话工作区和相同工具策略边界内执行，不额外创建独立子任务工作区
