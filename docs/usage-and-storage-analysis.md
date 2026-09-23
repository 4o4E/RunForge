# 用量与存储分析

## 统计边界

用量分析由服务端统一聚合，前端只提交时间、租户、用户和空间筛选条件并展示结果。前端不得遍历会话或根据 `usage_update` 事件重新计算，以免遗漏归档会话、重试请求、子 Agent 和运行时能力调用。

Token 以 `provider_attempts.usage` 为事实来源，通过 `provider_invocations -> threads -> spaces/users/tenants` 确定归属。统计同时返回：

- 尝试 Token：所有有用量记录的 Provider attempt，包含失败与重试；
- 有效 Token：状态为 `success` 的 attempt；
- 缓存输入 Token：输入 Token 的子集，不再次加到总量；
- 无用量 attempt：Provider 没有返回用量时单独计数，不推测数值。

`runtime_capability_calls.usage` 不重复相加，因为运行时 LLM 同样经过 `ProviderRunner`，已经产生 Provider attempt。管理端模型探测等不属于 run 的调用当前不进入该分析。

## 存储采样

存储占用是时点值，不是文件操作流水。服务启动时立即扫描，之后每小时扫描一次；小时样本保留 30 天，日样本保留一年。同一时间桶再次扫描会替换该桶数据，不产生重复样本。

文件统计包括：

- thread 工作目录，按 tenant、thread 用户和 space 归属；
- 外部调用 artifact，按数据库记录的 caller、space、thread 归属；
- 租户业务插件当前版本和内容寻址历史快照；
- thread/run/message/event/step、Provider 观测等核心数据库记录的逻辑大小。

符号链接只计算链接本身，不跟随目标。业务插件共享快照只在租户插件目录计算一次，不会在每个 thread 中重复计入。数据库逻辑大小用于维度分析，不等同于 PostgreSQL 数据文件、索引、WAL 和空闲页的物理大小。Provider JSONL 故障日志、Office 缓存和 PostgreSQL 运维文件不具备稳定的 tenant/user/space 归属，不进入本接口。

## 权限与接口

- `GET /api/usage/aggregate`：租户用户默认只能读取本人，并且只包含当前身份真正可见的空间；外部空间的 execution user 不自动获得查看权限。owner/admin 使用 `scope=tenant` 后可读取本租户，并按用户和空间筛选。
- `GET /api/system/usage/aggregate`：系统管理员可跨租户筛选。
- `POST /api/system/usage/storage/refresh`：系统管理员立即触发一次全量存储扫描；并发请求复用正在执行的扫描。

时间范围最长一年。聚合响应一次返回筛选项、Token 总量与日序列、Token 各维度明细、最新存储快照与日历史，避免页面发起逐会话请求或自行合并口径。

## 文件隔离

分析功能不改变工作目录模型。所有会话继续使用 `/w/{spaceId}/{threadId}` 独立可写目录，不增加空间共享目录，也不允许会话自动读取同空间其他会话的文件。需要再次使用旧内容时，由新的 Chat 明确重新获取或重新上传。
