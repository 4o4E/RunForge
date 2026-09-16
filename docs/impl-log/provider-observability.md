# Provider 观测与统一重试实施日志

> 日期：2026-09-16 · 状态：✅ 完成
> 对应 [空间与外部运行平台设计](../space-runtime-design.md) §11、阶段 8。

## 目标和边界

RunForge 需要在保留现有 run/step/message/event 的基础上，回答一次逻辑模型调用实际产生了
几次上游 HTTP 请求、每次发送和收到什么，以及为什么重试。AI SDK 继续负责协议转换、
流解析和工具调用组装，但不负责重试或 RunForge 的审计状态。

本阶段只观测与 run 关联的模型调用：主 Agent、标题生成、上下文压缩摘要、subagent 和
run-scoped LLM capability。管理端模型列表探测和测试对话没有 run 归属，不写入 run 关联
观测表。mock provider 没有真实网络请求，只保存 invocation，不伪造 attempt。

## 实现

- `ProviderRunner` 在调用 adapter 前创建 `provider_invocations`，并根据租户 Provider 配置
  执行统一退避重试。
- AI SDK 固定 `maxRetries=0`；手写 OpenAI Responses、OpenAI Chat 和 Anthropic adapter
  固定内部重试为 0。所有 adapter 都可接收当前 attempt 的 observing fetch。
- observing fetch 从克隆的最终 `Request` 读取实际 URL 和序列化 body；请求头既不建模，
  也不写数据库或文件。URL 中的 API key、裸 `key`、token、secret、signature 等查询参数
  在持久化前替换为 `[REDACTED]`。
- 上游响应经透传 `TransformStream` 交给 adapter，同时聚合原始 JSON/SSE。Provider 返回后
  再保存标准化 content、reasoning、tool calls、finish reason 和 usage。
- attempt 保存 `http`、`transport`、`parse`、`runtime` 四类错误。HTTP 408/429/5xx 和传输
  中断可重试；流式内容一旦向 Agent runtime 发布，后续失败不重试，避免重复输出。
- 主 Agent 的可恢复流式失败继续写原有 `stream_retry` 诊断事件，不改变 Web 回放协议。
- 每个真实 attempt 另写一行
  `logs/provider-traces/provider-YYYY-MM-DD.jsonl`；清理器只删除 7 日窗口之外的匹配文件，
  不触碰数据库记录或目录内其他文件。

## 数据模型

- `provider_invocations`：tenant、space、thread、run、可选 step、purpose、provider、model、
  逻辑请求、最终标准化结果、状态和时间。
- `provider_attempts`：invocation 内序号、脱敏 URL、wire body、HTTP 状态、Provider ID、
  原始流、标准化结果、finish reason、usage、错误类型、错误和时间。
- 新 migration 为 `provider_attempts.error_kind` 增加字段和四值检查约束；attempt 序号继续
  使用既有 `(invocation_id, attempt)` 唯一约束。

## 验证证据

- 全仓 typecheck、229/229 单测和生产构建通过；Prisma migration status 为最新。
- ProviderRunner 定向用例覆盖 503 后重试、wire body 和原始响应保存、请求头不落库、
  发布部分流后不重试、JSON 解析错误分类，以及 7 日文件清理。
- Prisma Store 验证使用真实数据库创建 invocation/attempt，确认 Provider ID、URL 脱敏和
  请求头密钥不落库。
- Agent Core 真实模型验收 5/5 通过，共 21 个 step；数据库中对应 21 个 invocation 和
  21 个 attempt，逐 step 一一关联。每个 attempt 都有 HTTP 200、wire body、完整 SSE
  结束标记、标准化结果、usage、finish reason、Provider ID 和结束时间。
- 使用当前数据库内的 2 个实际 Provider 密钥扫描这 5 个 run 的逻辑请求、wire body、URL、
  原始流、标准化结果和本地 trace，所有位置命中数均为 0。
- 同一批运行生成 21 行 JSONL，与数据库 attempt 数一致。

## 成本和后续观察

为了满足完整复盘要求，原始响应在单次调用期间会在内存中聚合，并同时写入数据库和本地
JSONL。这里没有增加截断、采样、压缩或对象存储抽象：首版已确认单实例且暂不处理配额，
提前增加这些策略会改变“完整保存”契约。后续端到端容量验收需要继续观察长响应的峰值内存、
数据库增长和本地 7 日磁盘占用，再基于真实数据单独决策归档方案。
