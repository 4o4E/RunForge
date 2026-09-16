# 空间与外部运行平台设计

> 状态：已确认设计基线。
>
> 本文合并此前 Issue 正文及后续 review 决策，作为空间、Cordis 插件、外部调用、
> 权限、workspace、恢复和观测的单一执行基线。此前评论中与本文冲突的 `next_run`、
> 内存 `next_step` 和“Provider 观测已经完整存在”等描述不再适用。

## 1. 目标与首版边界

RunForge 要从仅服务 Web 对话的 Agent 应用，演进为可由多个可信应用接入的通用 Agent
运行平台。核心只认识 tenant、space、thread、run、调用方、能力和事件，不包含任何接入
应用专属的身份字段、消息协议或业务提示词。

首版边界已经确定：

- 单个 RunForge 活动实例，不建设多 worker、分布式队列或跨实例接管。
- 外部调用方和服务端 Cordis 插件均为可信代码；模型不能安装、升级或热改插件。
- 不部署 DSH，也不复用 DSH 的 Agent loop、配置文件或容器。
- 暂不实现 CPU、内存、磁盘配额、计费和套餐。
- 继续复用现有 `thread -> run -> step`、Agent loop、上下文压缩、Store、工具、skill、
  MCP、Web 页面和重启恢复能力。
- 保持压缩不变式：`messages.content` 不覆盖，`tool_call` 与 `tool_result` 不拆对，内存
  drop 不落库。

## 2. 核心模型

### 2.1 Tenant 与 Space

space 归属于 tenant，是一套可动态更新的运行配置和权限边界。space 没有独立 owner。

空间至少有两种模式：

- `web`：由 Web 用户创建和继续对话，保留 `ask_user`。
- `external`：由外部调用方创建和操作任务，Web 只读，不提供 `ask_user`。

空间配置包含：

- 基础系统提示词和可信调用方提示词策略。
- 模型、模型参数和上下文预算。
- 允许使用的 Cordis 插件、skill、MCP、工具和运行时能力。
- 页面展示模式、外部调用权限和 `next_step` 策略。
- workspace 模式和附件策略。

空间配置直接更新并递增 `config_version`，thread 不固定空间配置版本。每个 run 在创建事务
中保存当时的完整有效配置副本；run 进入任何非终态后，重启恢复、回答、继续生成都使用该
副本。下一次新 run 自动读取空间的最新配置。

### 2.2 Default Space

创建 tenant 时，在同一个事务中完成：

1. 创建 tenant 和首个 owner。
2. 从系统模板复制该 tenant 的独立配置。
3. 创建 Web 空间，并把它写入 tenant 的 `default_space_id`。

default 空间不可删除、不可重命名，但可以更新配置。非默认 tenant 缺少配置时不再运行时
回退到 `default` tenant；模板变化也不自动影响已经创建的 tenant。

旧 thread 只回填到所属 tenant 的 default 空间。thread、run、step、message、event 和现有
用户级 workspace 均不搬迁、不复制。

### 2.3 Execution User

外部空间必须从本 tenant 的 active 用户中选择 `execution_user_id`。它只用于兼容现有
`tenantId + userId` 执行 scope、凭证和资源归属，不产生空间所有权或管理权限。

- Web 空间没有统一 execution user；每个 Web thread 仍归创建它的真实用户。
- 外部调用方不能指定、覆盖或冒充 execution user。
- 外部 thread 创建时复制空间当前的 `execution_user_id` 到 thread，之后不可修改。
- 修改空间 execution user 只影响之后创建的新 thread。
- execution user 被 disabled 后，空间不能创建新 thread；已有 thread 不能创建新 run，但
  已经运行的 run 可以使用既有配置副本完成或恢复。

执行归属与查看授权必须分开：执行路径使用 thread 的归属用户；Web 只读查看先检查空间
管理角色或可见用户名单，再走专用只读 Store 查询，不能把查看者冒充成 execution user。

## 3. 标识与 URL

### 3.1 Web

tenant 由登录身份确定，不出现在 URL。`spaceId` 和 `threadId` 延续雪花 ID + Base62，分别
使用 `sp_`、`th_` 前缀。

- `/`：统一用户入口和会话列表。
- `/{spaceId}`：空间入口和新建对话。
- `/{spaceId}/{threadId}`：具体对话。

不增加 `/s` 或 `/chat`。后端必须校验 space 属于当前 tenant、thread 属于 URL 中的
space；不匹配统一按不存在处理。`/api`、`/settings`、`/admin`、`/sys-admin` 等保留路径
优先于动态 ID 路由。

### 3.2 外部入口

外部 HTTP 和后端给外部应用推送事件的 WebSocket 共用一个秘密 URL：

```text
POST /api/external/{uuidToken}
WS   /api/external/{uuidToken}
```

URL 只包含 UUID Token 这一个动态段，不加入 tenant、space、thread 或 run ID。服务端通过
Token hash 反查 caller、tenant、space 和权限。

- Token 与公开的 `sp_` ID 分开，只保存 hash，明文仅创建时返回。
- 支持过期、吊销、轮换、最后使用时间和审计。
- 一个空间可给不同调用方签发多个 Token。
- 只允许 HTTPS/WSS；网关、访问日志和 APM 必须隐藏秘密路径段。

## 4. 权限和可见性

- tenant owner/admin 都是空间管理员；system admin 通过独立系统控制面管理任意 tenant 的
  空间，但不能冒充租户用户。
- `created_by` 仅用于审计，不产生所有权。
- tenant owner/admin 始终可见本 tenant 的所有空间。
- 普通用户只有出现在空间可见用户列表中时才能看到该空间；空列表表示仅管理员可见。
- 用户被 disabled 时即使仍在名单中也不能访问，恢复后原授权继续生效。
- 外部空间在 Web 中始终只读。Web 用户不能创建、追加、继续、回答、取消、分支或修改
  外部任务；这些限制必须由 API 强制，而不是只隐藏按钮。
- system admin 查看内容必须走独立、留痕的审计路径，不能进入普通用户会话列表。

普通空间删除采用软删除：设置 `deleted_at`，保留 thread、run、文件、事件和审计。删除时
吊销该空间全部外部 Token，并禁止创建或追加任务。default 空间不能删除。恢复空间时恢复
原可见名单，但不恢复已吊销 Token。

## 5. 外部协议

### 5.1 Command 协议

外部 HTTP 请求体用 `operation` 区分操作，首版至少支持：

- `run.create`
- `run.append`
- `run.get`
- `run.cancel`
- `artifact.upload`
- `artifact.get`

请求保存通用来源信息，例如应用 ID、外部会话引用、触发引用、关联引用和外部事件 ID，
不加入特定消息平台字段。可信调用方指令使用独立字段，并受空间配置控制；普通 input 不能
伪装成 system message。

操作语义固定为：

- `run.create`：创建新 thread 和首个 run。
- `run.append`：向已有 thread 创建下一 run；如果指定 `delivery=next_step`，则改为向当前
  活动 run 持久化待注入输入。
- `run.get`：读取 caller 有权访问的 run、状态和结果。
- `run.cancel`：取消 caller 有权操作的活动 run。
- `artifact.upload/get`：上传或读取当前 caller/space 的附件资源。

所有写操作都携带幂等键。唯一范围为 caller + operation + idempotency key，并保存规范化
请求 hash；同键同请求返回原回执，同键不同请求返回幂等冲突。外部会话引用和外部事件 ID
另设 caller 范围内的唯一约束，避免协议重放制造重复 thread 或输入。

### 5.2 Caller 自己维护后续队列

RunForge 不维护 `next_run` 队列，也不增加 `queued` run 状态。一个 thread 同时只能有一个
活动 run：

- `threads.active_run_id` 继续表示当前对话分支叶子，不复用为执行锁。
- thread 新增独立的 `executing_run_id` 状态槽，表示当前唯一的非终态 run。
- 创建 run 时使用 Prisma 短事务：先创建 pending run，再执行条件更新
  `executing_run_id IS NULL -> 新 run ID`；更新数量为 0 时回滚并返回冲突。
- run 终态事务只在 `executing_run_id` 仍等于当前 run 时清空，避免旧 run 清掉新 run。
- 已有活动 run 时返回 `RUN_ACTIVE`，同时返回当前 run ID 和状态。
- `RUN_ACTIVE` 不消费幂等键；调用方等待终态后可以使用同一键重试。
- 不使用长事务、显式行锁或轮询等待 run 完成。

两个并发请求使用相同幂等键时只创建一个 run；使用不同键时只能一个成功，另一个得到
`RUN_ACTIVE`。

### 5.3 可靠的 `next_step`

`delivery=next_step` 是当前 run 内的特殊追加，不是后续 run 队列。只在空间策略允许、目标
run 仍为活动状态且属于当前 caller 时接受。

追加内容不能只保存在内存中。新增持久化的 `run_inputs`：

- 接纳事务同时写入外部幂等请求和 `run_inputs(status='pending')`，成功后才能返回已接受。
- 接纳事务对 run 的输入版本做条件更新，只有仍允许接收外部输入的活动 run 才能成功；
  与终态收口竞争时由数据库条件更新决定唯一顺序。
- executor 在一个完整 step 结束后、下一次 LLM provider 调用前，按确定顺序读取 pending
  输入，在同一事务中写入 user message 并标记 `applied`。
- 如果模型本轮准备结束 run，先用条件更新关闭外部输入接纳，再读取 pending 输入；有输入
  时恢复接纳并继续下一 step，没有输入时才进入终态。
- 服务重启后，恢复逻辑重新加载 pending 输入，不会发生“请求已确认但内容丢失”。
- 取消 run 时未应用输入标记为 `canceled`，保留审计。

这一设计替代此前“不新增注入表、进程退出允许丢失”的方案。

### 5.4 外部空间不支持 `ask_user`

- 外部空间发给模型的工具 schema 不包含 `ask_user`。
- 工具执行入口再次按 space mode 拒绝调用，不能只依赖提示词或 schema 隐藏。
- 外部空间系统规则要求信息不足时采用合理假设，或在最终结果说明缺失信息，不进入
  `waiting_for_user`。
- Web 空间继续保留现有 `ask_user` 和回答流程。

### 5.5 WebSocket

外部 SDK 建立 WebSocket 后发送订阅消息，run ID 和 cursor 不放在 URL：

```json
{
  "type": "subscribe",
  "runId": "ru_xxx",
  "cursor": 123
}
```

cursor 使用数据库 `events.id`。重连时先回放 cursor 之后的已持久化事件，再接收后端实时
推送。Web JWT WebSocket 与外部 UUID Token WebSocket 是两套鉴权入口，不能混用。

## 6. 附件与 Artifact

外部调用方不提交宿主机路径。附件先通过 `artifact.upload` 上传，获得无路径语义的
artifact ID；`run.create` 或 `run.append` 只引用 artifact ID。

- artifact 归属于 caller 和 space，可在 thread 创建前暂存。
- 请求接纳时校验归属、状态、大小、MIME 和数量限制。
- materialize 时由服务端选择安全文件名并写入目标 thread workspace。
- 同一 artifact 默认只能 materialize 到其 caller/space 下的 thread。
- 上传和 materialize 都必须支持幂等；软删除空间后禁止新 materialize。
- 数据库保存元数据和归属，文件内容继续使用受控文件存储，不把大文件写入 JSONB。

Web 现有文件上传接口保持不变；外部 artifact 契约是其上层资源协议，不接受任意 path。

## 7. Workspace

- default 空间继续使用现有按 tenant + user 派生的统一用户级 workspace，不迁移旧文件。
- 其他空间的新 thread 使用 `{workspaceBase}/{threadId}`。
- 调用方不能提交或修改真实 workspace 路径。
- thread 创建后不能迁移到其他 space。
- 文件 API、shell、Office 预览、artifact 和签名分享都先从数据库校验 thread 归属，再由
  服务端计算路径。
- 文件工具路径围栏和 bwrap 只挂载当前执行 workspace。
- 空间允许的 skill/workflow/plugin 由空间配置装配，不从其他 thread 的工作目录发现。

## 8. Cordis 插件和能力注册

Cordis 只负责业务插件的服务依赖和生命周期，不替换 Agent loop、Store、模型调用和事件
状态机。接入方式为：

```text
进程 Cordis 根上下文
  -> space config version 上下文
    -> run 子上下文
```

- 实施时精确固定 Cordis 版本，并通过 RunForge adapter 隔离上游 API 变化。
- 插件声明 ID、版本、配置 schema、必需/可选服务和贡献能力。
- 保存空间配置和接纳 run 时解析缺失依赖、循环和冲突，失败时拒绝启动。
- run 固定插件版本与内容 hash；非终态 run 所需旧版本在完成前不能卸载。
- run 子上下文结束时释放监听器、定时器、MCP 连接和其他资源。
- 不允许通过修改进程全局 skill 目录或 MCP 客户端列表切换空间能力。
- 工具/MCP 权限既限制发送给模型的 schema，也在实际执行入口检查。

内置运行能力继续使用强类型 ID，例如 `llm`、`image`、`video`、
`datasource.credentials`。Cordis 插件贡献的业务能力使用 namespaced string ID，例如
`plugin-id.capability-id`，由动态 registry 校验。不能因为新增插件能力而修改 RunForge 核心
固定枚举。

## 9. Secret

长期 LLM、MCP、数据源和插件 secret 继续保存在 tenant 配置数据库，不通过外部 SDK 传递。

- run 配置副本只保存 secret version/ref，不复制明文。
- 更新 secret 时创建新版本；已经接纳的 run 继续引用旧版本，新 run 使用新版本。
- 服务端可信插件通过内部 `SecretService` 获取当前 run 已授权 secret。
- 脚本通过 run-scoped `WORKLOAD_TOKEN` 换取短期能力凭证或内部代理端点。
- secret 解析同时校验 tenant、space、run、插件和 capability。
- 记录读取审计，但不记录 secret 明文。
- secret 不进入模型上下文、工具 schema、工具参数、Provider 请求 body、事件或普通日志。

## 10. Store 和访问边界

现有 Store 把资源归属和查看权限都压在 `{tenantId, userId}` 中。空间改造后拆成：

- `ExecutionScope`：运行时内部使用，从 thread 的 tenant/user 归属推导。
- `ActorContext`：HTTP/WebSocket 当前调用者身份，包括 tenant user、system admin、external
  caller、workload token。
- `SpaceAccessService`：统一判断管理、只读查看、外部操作和审计权限。

普通读写 Store 继续自行过滤归属，不依赖调用方“已经检查过”。外部空间 Web 只读需要新增
按 tenant + space 查询的专用方法，并且只能在 `SpaceAccessService` 授权后调用；不能把
管理员或可见用户伪装成 execution user。

新的空间代码不能在 API handler 中直接使用数据库 pool。业务查询通过 Store/repository，
事务和原生约束集中在持久化层，为 Prisma 迁移保留边界。

## 11. Provider 观测：现有内容与缺口

当前数据库已经保存：

- run 的 input、output、status 和 error。
- step 边界。
- 实际进入 RunForge 上下文的 message、tool call 和 tool result。
- 后端给 Web 前端推送并落库的 `llm_delta`、reasoning、工具和 final/error 事件。

这些记录可以回答“某个 run/step 在 RunForge 内发生了什么”，但不能完整回答“上游 LLM API
每一次 HTTP attempt 实际收到了什么”：

- AI SDK 会把中立 message、tool schema 和 provider options 翻译成供应商 wire body；
  messages 表保存的是翻译前的逻辑内容。
- AI SDK 内部重试时，一个 step 可能产生多个 HTTP attempt；当前 steps/events 没有 attempt
  ID，也无法区分各次请求。
- 当前没有保存最终序列化后的请求 body、Provider response/request ID 和每个 attempt 的
  状态。
- `llm_delta` 是后端给 Web 前端推送的运行事件，不等同于 LLM API 发给后端的某一次原始
  流，也不能区分重试前后的流。
- OpenTelemetry 是外部 trace，不是本项目数据库中的可追溯记录。

因此在现有 run/step/message/event 之上新增两层 Provider 记录：

- `provider_invocations`：一次逻辑模型调用，关联 tenant、space、thread、run、step、调用
  用途、provider、model、逻辑请求和最终标准化聚合结果。调用用途至少区分主 Agent、
  标题、压缩摘要和 subagent。
- `provider_attempts`：一次由 RunForge 发起的真实 HTTP attempt，保存最终 URL、实际请求
  body、开始/结束时间、HTTP 状态、Provider response ID、原始流聚合、标准化响应、
  finish reason、usage、错误和关联 invocation；不保存请求头。

AI SDK 的 OpenAI、OpenAI-compatible、Anthropic provider 都支持注入自定义 `fetch`。
AI SDK 在这里仅负责协议转换、流解析和工具调用组装，不拥有 RunForge 的重试、审计和
状态语义：

1. AI SDK provider 设置 `maxRetries=0`，禁用 SDK 内部重试。
2. RunForge 的 `ProviderRunner` 在创建 invocation 后，根据统一重试策略显式创建和执行每个
   attempt。
3. 每个 attempt 使用绑定当前 attempt ID 的 observing fetch。AI SDK 完成协议转换后，
   observing fetch 从克隆的 Request 读取最终 body，不消费真正发往上游的请求流。
4. observing fetch 原样发送请求，并以透传式 stream tap 记录 LLM API 返回给后端的原始流；
   tap 不改写数据、不提前消费响应，也不把请求头写入数据库或文件日志。
5. attempt 保存 HTTP 状态、Provider response ID、原始流聚合、解析错误、传输错误和耗时。
6. AI SDK 返回后，ProviderRunner 保存标准化的 content、reasoning、tool calls、finish reason
   和 usage，并决定成功、失败或创建下一次 attempt。
7. 流式请求只有在尚未向 Agent runtime 发布任何增量时才允许自动重试；已经发布部分流后
   的失败作为当前 attempt 和 invocation 失败处理，避免重复输出。

手写兼容 provider 在已有 wire body 构造点接入同一个 ProviderRunner/observer。所有重试都
由 RunForge 统一控制，不能让某个 SDK 或 provider adapter 在观测边界之外自行重试。
现有 messages/events 继续承担上下文原文和前端回放，不重复替代。

本地文件继续记录 LLM API 流式 trace 和运行控制日志，保留 7 天；数据库 invocation/
attempt 记录不由该清理任务删除。

## 12. Prisma 实施顺序

项目已确认后续迁移到 Prisma，但当前代码仍使用 `pg`、`schema.sql` 和分散的原生查询。
空间功能会新增多张表、事务、外键和并发约束，如果先按现有 SQL 全量实现再迁移，
会产生一次明显的重复改造。

已确认 Prisma 是空间数据库改造的前置阶段：

1. Cordis 隔离原型先行，不依赖数据库迁移。
2. 原型通过后先完成 Prisma baseline、生成客户端和 Store 持久化边界迁移。
3. 空间新表和后续业务查询直接基于 Prisma 实现，不再新增散落的 `pool.query()`。

本需求当前不依赖手写部分唯一索引或显式行锁：

- default space 由 tenant 的 `default_space_id` 关系表达，不使用 `is_default=true` 的部分
  唯一索引作为唯一性来源。
- 一个 thread 一个活动 run 由独立 `executing_run_id` 状态槽和条件更新表达。
- 外部幂等键、Token hash、可见用户等使用 Prisma 普通 `@unique` 或复合 `@@unique`。
- 并发创建和终态清理由 Prisma 事务内的条件 `updateMany` 实现 CAS，不调用
  `SELECT ... FOR UPDATE`。

只有后续出现 Prisma schema 确实不能表达、且不能用状态槽/CAS 正确建模的数据库约束时，
才单独评审原生 SQL migration；它不再是空间改造的默认前提。

## 13. 数据改动清单

具体字段名可以在实现时随 Prisma schema 调整，但职责和约束固定：

1. `spaces`
   - tenant 归属、模式、名称、execution user、配置、配置版本、软删除。
   - tenant 通过 `default_space_id` 指向唯一 default 空间。
2. `space_visible_users`
   - 普通用户可见名单；管理员不需要写入。
3. `external_callers` 与 `external_tokens`
   - 调用方身份、space grant、Token hash、过期、吊销、轮换和审计。
4. `threads`
   - 增加 `space_id`、通用来源、不可变 execution user/workspace 归属和
     `executing_run_id` 状态槽。
5. `runs`
   - 增加完整空间配置副本、`config_version`、插件 lock、来源引用、外部输入接纳状态和
     输入版本。
6. `external_requests`
   - 幂等键、请求 hash、operation、状态和稳定回执。
7. `run_inputs`
   - `next_step` 待注入内容及 pending/applied/canceled 状态。
8. `artifacts`
   - 外部附件和产物的 caller/space/thread/run 归属、存储 key、MIME、大小和状态。
9. `provider_invocations` 与 `provider_attempts`
   - 逻辑模型调用和真实 HTTP attempt 的完整关联。
10. `plugin_deployments` 或等价 registry
    - 已部署插件的版本、hash、manifest 和可恢复状态。

迁移只追加新 migration，不改写已经执行的旧迁移。旧 thread 回填 default space 时不移动
历史内容或 workspace。

## 14. 分阶段开发计划

### 阶段 0：Cordis 隔离原型

- 固定版本并建立 adapter。
- 两个并发空间加载不同插件和 MCP。
- 验证依赖解析、配置隔离、动态能力注册、旧版本恢复和 dispose 清理。
- 不改 Agent loop 和数据库业务状态。

### 阶段 1：Prisma 基础

- baseline 现有数据库，保留数据和已有 ID。
- 明确 Prisma schema、CAS 事务和 Store/repository 迁移边界。
- 先迁移空间改造会触及的 thread/run/message/event/settings/auth 查询。

### 阶段 2：空间与身份数据模型

- 增加空间、可见用户、caller/Token、幂等、run input、artifact、插件 registry 和 Provider
  观测实体。
- 创建 default 空间并回填旧 thread。
- 实现 execution user、软删除和一个 thread 一个活动 run 的数据库约束。

### 阶段 3：配置、权限和内部能力

- 实现 tenant 模板复制、空间配置校验和 run 快照。
- 实现 `SpaceAccessService`，拆开执行归属与查看权限。
- 实现 Cordis 插件依赖解析、动态能力 registry、SecretService 和 workload token 授权。

### 阶段 4：外部 HTTP、Artifact 与 WebSocket

- 实现 UUID Token 单入口和 command 协议。
- 实现幂等回执、`RUN_ACTIVE`、artifact 上传/materialize。
- 实现基于数据库 event cursor 的外部 WebSocket 回放和实时推送。

### 阶段 5：运行时装配与恢复

- 从 run 快照装配提示词、模型、预算、插件、skill、MCP 和工具。
- 外部空间双重禁用 `ask_user`。
- 实现持久化 `next_step`，覆盖终态竞态、取消和重启恢复。
- 保持上下文压缩和消息原文不变式。

### 阶段 6：Workspace 与文件能力

- default 空间保持用户级 workspace。
- 其他空间使用 `{workspaceBase}/{threadId}`。
- 文件、shell、预览、artifact 和分享统一走 thread 归属校验。

### 阶段 7：Web 页面

- 统一入口下增加空间选择和来源展示。
- 使用 `/{spaceId}`、`/{spaceId}/{threadId}`。
- 外部空间只读；增加空间配置、用户可见名单、execution user、软删除和 Token 管理。

### 阶段 8：Provider 观测和本地 trace

- 实现 RunForge 自己的 ProviderRunner 重试状态机，并关闭 SDK 内部重试。
- 接入 observing fetch、流式 tap 和手写 provider observer。
- 保存逻辑请求、invocation/attempt、wire body、原始流聚合和标准化响应，不保存请求头。
- 实现本地 trace、运行日志和 7 天清理。

### 阶段 9：端到端验收与文档更新

- default Web 空间和两个不同外部模拟应用并发验收。
- 验证权限、配置副本、execution user、插件/MCP/文件隔离和软删除。
- 验证 `RUN_ACTIVE`、幂等并发、可靠 `next_step`、取消和重启恢复。
- 验证外部空间不出现 `ask_user`。
- 验证 WebSocket cursor、artifact、Provider attempt 和 7 天 trace。
- 更新系统设计、多租户设计、外部协议和运维文档。

## 15. 验收重点

- 旧 thread 仅增加 default space 归属，历史内容和用户级 workspace 不变。
- tenant owner/admin 始终可见空间，普通用户严格按名单可见。
- 外部 caller 与 Web viewer 权限不串用，外部空间 Web 始终只读。
- 不同 space 的提示词、插件、skill、MCP、工具、secret、文件和上下文不串用。
- 空间配置更新不影响已经接纳的 run，新 run 使用新配置。
- execution user 变更不迁移旧 thread；disabled 后的行为符合第 2.3 节。
- 缺依赖、循环、冲突或旧插件版本缺失时，在运行前明确失败。
- 同一 thread 不产生两个活动 run；幂等重试不重复创建或重复副作用。
- 已确认的 `next_step` 在服务重启后不丢失、不重复应用。
- Provider 记录能够回答每个 step 实际产生了几次 LLM API 请求、每次发送了什么 wire
  body、收到哪些原始流、标准化结果是什么以及 RunForge 为什么重试。
- 本地 trace 超过 7 天被清理，数据库审计记录不受影响。

## 16. 改动点与对应决策索引

1. 新增 space：使用 `sp_` 雪花 ID，tenant 隐含在登录身份中。
2. Web 路由：使用 `/{spaceId}` 和 `/{spaceId}/{threadId}`，不增加资源名单路径。
3. default space：tenant 创建时复制模板并创建；不可删除、不可重命名。
4. 旧 thread：只回填 default space，不迁移对话内容、ID 或用户级 workspace。
5. 空间配置更新：直接更新；run 创建时保存副本，thread 不固定旧版本。
6. 外部执行身份：空间选择 execution user，thread 创建后固化，调用方不能冒充。
7. 查看权限：管理员始终可见，普通用户使用明确名单；外部空间 Web 只读。
8. 空间删除：普通空间软删除并吊销 Token，default 空间禁止删除。
9. 外部鉴权：单一 UUID 秘密 URL，Token hash 落库，不在 URL 增加 tenant/space/run。
10. 外部 HTTP：单端点 command 协议，写操作强制幂等。
11. 外部 WebSocket：同一 UUID URL upgrade，订阅消息携带 run ID 和数据库 cursor。
12. 后续 run：caller 自己排队；服务端不维护 `next_run`，活动冲突返回 `RUN_ACTIVE`。
13. `next_step`：使用持久化 `run_inputs`，支持幂等、终态竞态和重启恢复。
14. 外部问答：外部空间从 schema 和执行入口双重禁用 `ask_user`。
15. Artifact：外部输入只引用 artifact ID，不接收宿主机路径。
16. Workspace：default 保留用户级目录，其他空间使用 `{workspaceBase}/{threadId}`。
17. Cordis：仅负责可信业务插件依赖和生命周期，不建立第二套 Agent runtime。
18. 动态能力：内置能力保持强类型，插件能力使用 registry 管理 namespaced ID。
19. Secret：长期 secret 留在数据库，run 保存版本引用，内部 SDK 发放受控能力。
20. Store 权限：拆开执行归属和查看授权，禁止通过冒充 execution user 读取。
21. Provider 观测：保留现有 run/step/message/event，由 RunForge ProviderRunner 控制重试，
    invocation/attempt 完整记录逻辑请求、wire body、原始流和标准化响应。
22. 部署：首版单实例、可信应用，不做多 worker、配额和计费。
23. Prisma：在 Cordis 原型后、空间数据模型前完成 baseline；唯一性和并发优先使用 Prisma
    约束、状态槽和 CAS，不预设依赖手写 SQL 或显式行锁。
