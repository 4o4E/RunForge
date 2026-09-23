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

- 空间托管资源 `/w/{spaceId}/.{skills,workflows,plugins,agents}`，按 space 归属并只扫描一次；
- thread 可写目录 `/w/{spaceId}/c/{threadId}`，按 tenant、thread 用户和 space 归属；
- 用户跨会话文件 `/u/{userId}`，按用户和所属 tenant 归属，`space_id` 为空，扫描时只计数一次；
- 尚未清理的旧会话目录 `/w/{spaceId}/{threadId}` 以及仍关联数据库会话的更早 `/w/{threadId}`，作为历史工作文件继续计入当前占用；已删除会话的空间内遗留目录归属空间，不再推断用户；
- 外部调用 artifact，按数据库记录的 caller、space、thread 归属；
- 租户业务插件当前版本和内容寻址历史快照；
- thread/run/message/event/step、Provider 观测等核心数据库记录的逻辑大小。

符号链接只计算链接本身，不跟随目标。会话对空间托管资源的链接只计入线程目录中的链接大小；实际资源由空间目录计数。租户业务插件当前版本和内容寻址历史快照仍只在租户插件目录计算一次，不会在每个 space 或 thread 中重复计入。数据库逻辑大小用于维度分析，不等同于 PostgreSQL 数据文件、索引、WAL 和空闲页的物理大小。Provider JSONL 故障日志、Office 缓存和 PostgreSQL 运维文件不具备稳定的 tenant/user/space 归属，不进入本接口。

## 权限与接口

- `GET /api/usage/aggregate`：租户用户默认只能读取本人，并且只包含当前身份真正可见的空间；外部空间的 execution user 不自动获得查看权限。owner/admin 使用 `scope=tenant` 后可读取本租户，并按用户和空间筛选。
- `GET /api/system/usage/aggregate`：系统管理员可跨租户筛选。
- `POST /api/system/usage/storage/refresh`：系统管理员立即触发一次全量存储扫描；并发请求复用正在执行的扫描。

时间范围最长一年。聚合响应一次返回筛选项、Token 总量与日序列、Token 各维度明细、最新存储快照与日历史，避免页面发起逐会话请求或自行合并口径。

## 文件隔离

服务端管理的 Skill、Workflow、业务插件和 Agent 资源存放在 `/w/{spaceId}/.{skills,workflows,plugins,agents}`，按空间管理且只读；业务插件目录引用插件版本快照。会话只在 `/w/{spaceId}/c/{threadId}` 拥有独立可写目录，并只挂接当前选中的托管资源。不同会话不能读取彼此文件。用户需要跨会话保存个人数据时，明确写入 `/u/{userId}`；新会话不会自动读取用户目录内容。文件接口和文件工具按真实路径检查读写权限；Shell 在隔离沙箱中只挂载当前会话、当前用户目录（如获准）与选中的资源。需要再次使用旧会话文件时，由新会话明确重新获取或重新上传。

切换到新布局时，存储采样同时统计尚未清理的旧会话目录，清理后当前占用才下降。生产清理只涉及旧会话工作目录，不删除数据库中的会话、消息、运行记录、Token 用量或历史存储样本；历史消息仍可查看，但引用旧文件的路径和分享链接会失效。迁移步骤与运行保护条件见[工作区存储迁移](workspace-storage-migration.md)。
