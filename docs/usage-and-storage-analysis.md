# 用量与存储分析

## 统计边界

用量分析由服务端统一聚合，前端只提交时间、租户、用户和空间筛选条件并展示结果。前端不得遍历会话或根据 `usage_update` 事件重新计算，以免遗漏归档会话、重试请求、子 Agent 和运行时能力调用。

Token 以 `provider_attempts.usage` 为事实来源，通过 `provider_invocations -> threads -> spaces/users/tenants` 确定归属。统计同时返回：

- 尝试 Token：所有有用量记录的 Provider attempt，包含失败与重试；
- 有效 Token：状态为 `success` 的 attempt；
- 缓存输入 Token：输入 Token 的子集，不再次加到总量；
- 无用量 attempt：Provider 没有返回用量时单独计数，不推测数值。

`runtime_capability_calls.usage` 不重复相加，因为运行时 LLM 同样经过 `ProviderRunner`，已经产生 Provider attempt。管理端模型探测等不属于 run 的调用当前不进入该分析。

## 按任务发起日归集 Token

响应的 `tasks.totals` 与 `tasks.daily` 按每次发起的运行计数，与原有 `tokens` 的实际请求消耗日口径分开：

- 任务集合为 `created_at` 位于 `[from, to)` 且不早于所属 thread 创建时间的 run，按同一 tenant、thread 用户、space 及可见空间集合筛选。正常续聊创建的新 run 分别计数；失败、取消、运行中以及没有 Provider 调用的任务都计入 `taskCount`。运行中的补充输入属于原 run。分支复制的历史检查点保留原创建日期，早于新会话创建，不计为新发起任务。
- 每个任务汇总 `provider_invocations.run_id` 对应的全部真实 Provider attempts，包括主 Agent、子 Agent、上下文压缩、失败与重试；只要求 attempt 的 `started_at < to`，不按 `from` 裁剪该任务生命周期，也不重复相加其他表保存的汇总用量。跨日调用仍归入所属任务的发起日。
- `daily[].date` 为该 run 的 `created_at` 所属 `Asia/Shanghai` 自然日；序列只返回有任务的日期，零用量任务所在日期仍返回。原 `tokens.daily` 按 attempt 发生的上海日期统计，二者可以不同。
- `inputTokens`、`outputTokens`、`cachedInputTokens` 只累加已记录字段，缺失视为零，不推测 Provider 未报告的用量；`totalTokens = inputTokens + outputTokens`，缓存输入是输入的子集，不重复加总。
- `averageTokens = totalTokens / taskCount`；`maxTokens`、`minTokens` 为逐任务总量的最大值与最小值，零用量任务参与平均值及极值。整体平均值按全部任务计算，不对每日平均值再平均。
- `cacheRate = cachedInputTokens / inputTokens`，整体和每日均按输入总量加权；无输入时为 `null`。没有任务时 `totals` 的其余字段均为有限数值 `0`，`daily` 为空。

真实 PostgreSQL 回归入口为 `server/src/usage/service.integration.test.ts`，由 `scripts/ci/postgres-integration.sh` 自动执行。手动验证使用已迁移的隔离数据库，通过显式设置 `DATABASE_URL` 执行 `pnpm --filter server exec tsx --test src/usage/service.integration.test.ts`；测试建立独立随机租户并清理，不启动服务、不调用模型，也不接入 `STORE=memory` 单元测试脚本。

## 存储采样

存储占用是时点值，不是文件操作流水。服务启动时立即扫描，之后每小时扫描一次；小时样本保留 30 天，日样本保留一年。同一时间桶再次扫描会替换该桶数据，不产生重复样本。

文件统计包括：

- 空间托管资源 `/w/{spaceId}/.{skills,plugins,agents}`，按 space 归属并只扫描一次；
- thread 可写目录 `/w/{spaceId}/c/{threadId}`，按 tenant、thread 用户和 space 归属；
- 用户跨会话文件 `/u/{userId}`，按用户和所属 tenant 归属，`space_id` 为空，扫描时只计数一次；
- 尚未清理的旧会话目录 `/w/{spaceId}/{threadId}` 以及仍关联数据库会话的更早 `/w/{threadId}`，作为历史工作文件继续计入当前占用；已删除会话的空间内遗留目录归属空间，不再推断用户；
- 外部调用 artifact，按数据库记录的 caller、space、thread 归属；
- 租户业务插件当前版本和内容寻址历史快照；
- thread/run/message/step、Provider 观测等核心数据库记录的逻辑大小。

符号链接只计算链接本身，不跟随目标。会话对空间托管资源的链接只计入线程目录中的链接大小；实际资源由空间目录计数。租户业务插件当前版本和内容寻址历史快照仍只在租户插件目录计算一次，不会在每个 space 或 thread 中重复计入。数据库逻辑大小用于维度分析，不等同于 PostgreSQL 数据文件、索引、WAL 和空闲页的物理大小。Provider JSONL 故障日志、Office 缓存和 PostgreSQL 运维文件不具备稳定的 tenant/user/space 归属，不进入本接口。

## 权限与接口

- `GET /api/usage/aggregate`：租户用户默认只能读取本人，并且只包含当前身份真正可见的空间；外部空间的 execution user 不自动获得查看权限。owner/admin 使用 `scope=tenant` 后可读取本租户，并按用户和空间筛选。
- `GET /api/system/usage/aggregate`：系统管理员可跨租户筛选。
- `POST /api/system/usage/storage/refresh`：系统管理员立即触发一次全量存储扫描；并发请求复用正在执行的扫描。

时间范围最长一年。聚合响应一次返回筛选项、Token 总量与日序列、按任务发起日归集的 Token 总量与日序列、Token 各维度明细、最新存储快照与日历史，避免页面发起逐会话请求或自行合并口径。

## 文件隔离

服务端管理的 Skill、业务插件和 Agent 资源存放在 `/w/{spaceId}/.{skills,plugins,agents}`，按空间管理且只读；业务插件目录引用插件版本快照。会话只在 `/w/{spaceId}/c/{threadId}` 拥有独立可写目录，并只挂接当前选中的托管资源。不同会话不能读取彼此文件。用户需要跨会话保存个人数据时，明确写入 `/u/{userId}`；新会话不会自动读取用户目录内容。文件接口和文件工具按真实路径检查读写权限；Shell 在隔离沙箱中只挂载当前会话、当前用户目录（如获准）与选中的资源。需要再次使用旧会话文件时，由新会话明确重新获取或重新上传。

切换到新布局时，存储采样同时统计尚未清理的旧会话目录，清理后当前占用才下降。生产清理只涉及旧会话工作目录，不删除数据库中的会话、消息、运行记录、Token 用量或历史存储样本；历史消息仍可查看，但引用旧文件的路径和分享链接会失效。迁移步骤与运行保护条件见[工作区存储迁移](workspace-storage-migration.md)。

## 图表展示

用量页采用 Apache ECharts，按需引入柱形图、折线图及必要组件；图表跟随深浅主题，通过容器尺寸观察器自适应宽度，并在卸载时销毁实例。原生悬浮提示显示输入、输出、缓存输入、有效与尝试 Token、尝试次数及缺失用量次数。图例可切换序列，日期滑块可缩放范围。

- 每日 Token 按实际模型请求日展示，与按任务发起日归集的累计用量分别展示。模型柱形图包含全部供应商与模型，数量较多时使用纵向缩放条；精确明细表保留全部项目。
- 存储历史同时显示逻辑大小和磁盘分配，缺少日样本时保留空值和断点，不补零、不跨缺样连线；分类柱形图与明细表保留精确字节、文件及符号链接数量。时间以北京时间显示，提示中的历史时间为服务端返回的采样桶起点。
- 空间任务页使用响应 `tasks`，提供 30 / 84 / 365 天任务发起日期范围、累计 Token 与任务数、每日任务累计量、每任务平均 / 最大 / 最小及输入缓存率。日期刻度取自响应 `filters.from/to`，使用北京时间，不依赖浏览器时区；无任务日显示任务数和总量为零，每任务统计留空；无输入日缓存率显示不可用。总平均直接取服务端全部任务加权结果。统计截止时刻单独显示，运行中任务的累计用量会随后续请求增长。
