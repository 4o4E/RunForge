# 历史、观测与用量

## Purpose

约定权威历史、实时传输、诊断记录和任务用量。实现入口：`server/src/store/`、`server/src/llm/observability/`、`server/src/usage/`；解释见 `docs/long-task-design.md` 和 `docs/usage-and-storage-analysis.md`。

## Requirements

### Requirement: Step 权威历史

系统 SHALL 以 `steps.result` 保存完整模型响应，以 `steps.tool_results` 保存工具结果，以 `messages` 保存输入、摘要与顺序索引。请求快照 SHALL 仅用于观测，不参与历史正文或恢复构建。

#### Scenario: 管理员观测转换省略媒体
- **WHEN** 观测层对请求或响应生成脱敏表示
- **THEN** 不覆盖 step 原始聚合，普通聊天接口不返回管理员完整请求和空间配置

### Requirement: 实时与历史衔接

系统 SHALL 通过 WebSocket 推送实时增量，通过 HTTP 返回完成 step，并以持久化聚合替换同 step 的临时显示。历史顺序 SHALL 使用消息顺序索引，不依据 step 创建时间推断追加输入顺序。

#### Scenario: HTTP 与 WebSocket 订阅之间完成请求
- **WHEN** 一个 step 在历史读取后、实时订阅建立前完成
- **THEN** 订阅按完成索引补齐该 step，不漏掉或重复展示正文

### Requirement: Provider 调用观测

系统 SHALL 为逻辑调用建立 invocation，为实际 HTTP 请求建立 attempt；主任务、摘要、标题、子任务和运行资源代理通过统一入口观测。请求头与密钥 SHALL 不写入诊断记录。

#### Scenario: 未发布输出的请求发生可重试错误
- **WHEN** ProviderRunner 重试同一次逻辑调用
- **THEN** 每次真实 HTTP 请求拥有独立 attempt，不伪装为一次上游请求

### Requirement: 本地 Trace 与历史职责分离

系统 SHALL 按 run 和 UTC 自然日写入本地 JSONL trace，默认保留三十个自然日；trace 丢失不得被当作权威历史丢失，恢复不得读取 trace 推断运行状态。

#### Scenario: 旧 trace 已按保留策略清理
- **WHEN** 用户读取已完成任务历史
- **THEN** 从 PostgreSQL 的 step 和输入记录读取，不要求对应 trace 文件仍存在

### Requirement: 任务用量归属

系统 SHALL 将任务累计 Token 按 run 发起日的北京时间归属，包含主任务、子任务、失败、重试与压缩；正常续聊创建的新 run 分别计为任务，运行中追加输入不增加任务数量。

#### Scenario: 子任务跨日结束
- **WHEN** 子任务在主 run 发起日之后继续消耗 Token
- **THEN** 其用量仍归属于主 run 的发起日，不转移到子任务结束日

### Requirement: 输入缓存率

输入缓存率 SHALL 为所选任务缓存输入 Token 总和除以输入 Token 总和；没有输入时不可计算，不使用各任务缓存率的算术平均。

#### Scenario: 选择任务没有输入 Token
- **WHEN** 统计范围的输入 Token 总量为零
- **THEN** 展示不可计算状态，不报告虚构的缓存百分比
