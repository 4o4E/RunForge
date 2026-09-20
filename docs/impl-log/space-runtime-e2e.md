# 空间运行端到端验收日志

> 日期：2026-09-16 · 状态：✅ 完成
> 对应 [空间与外部运行平台设计](../space-runtime-design.md) 阶段 9。

## 验收方式

新增 `pnpm --filter server verify:space-runtime`。脚本不启动前后端服务，直接使用正式的
Prisma Store、空间服务、外部 command 服务、executor、Artifact materializer 和
ProviderRunner，在真实 PostgreSQL 与临时文件目录上串起同一条业务链路。

上游 Provider 使用确定性 HTTP 模拟器，但请求仍经过正式 observing fetch、原始响应聚合、
Prisma invocation/attempt 和本地 JSONL trace。这样协议与隔离验收可重复，不受外网模型波动
影响；真实模型能力另由 Agent Core 5/5 验收覆盖。

每次运行创建独立验收 tenant、用户、空间、调用方、Token、thread、run 和文件，结束后删除
数据库验收数据及临时文件。报告写入
`workspace/space-runtime-verification/<timestamp>/report.md`，便于保留当次 ID 和计数证据。

## 同链路验收矩阵

- tenant 创建时同时产生空的系统资源授权记录和 default Web 空间；授权模型后 default Web thread/run 正常执行。
- 建立两个 external 空间和两个可信调用方，分别使用独立 UUID Token；两个外部 run 并发执行。
- 调用方 A/B 不能读取对方 run 或 Artifact；普通 member 只看到明确加入名单的 external
  空间和 thread，看不到 owner 的 default Web thread；owner 始终看到全部空间。
- `artifact.upload` 同键重放返回同一 Artifact；输入绑定后由 executor materialize 到 A 的
  thread workspace，B 不能读取。default 使用用户级 workspace，external 使用短
  `{workspaceBase}/{threadId}`，两者路径不同。
- `run.create` 同键重放只调度一次 executor；`delivery=next_step` 同键重放返回同一 input，
  持久化输入在 Provider 调用前进入消息和模型 wire body，并产生 `external_input_applied` 事件。
- run A 在空间配置 V1 接纳后把空间更新为 V2：运行 A 仍使用 V1 提示词和可信指令，后续
  append run 使用 V2，数据库 `space_config_version` 与各自 Provider wire body 同时验证。
- 数据库 event cursor 从 0 完整回放到 final，使用最后 cursor 续读返回空集。
- 每个验收 run 对应一个成功 invocation 和一个成功 attempt；URL 裸 `key` 已脱敏，请求头
  密钥不出现在数据库或 JSONL，本地 trace 行数与 attempt 数一致。
- 永久删除空间 B 后 Token、调用方和运行记录一并删除；空间 A 不受影响。

## 组合验收证据

单个脚本不重复实现所有故障竞态，而是与现有专项验收组合形成阶段 9 证据：

- 全仓 229/229 单测覆盖外部空间双重禁用 `ask_user`、Web external 只读、UUID Token
  WebSocket 鉴权、数据库 cursor 回放、越权拒绝和 Cordis 两个并发空间的插件/MCP 隔离。
- Prisma Store 验证覆盖 `RUN_ACTIVE`、同键并发幂等、不同键竞争、`next_step` 的终态竞态、
  取消、Store 重建后的恢复、Token 轮换/吊销和数据库约束。
- Agent Core 真实模型验收 5/5 通过；Provider 阶段对应 21 个 step、21 个 invocation 和
  21 个真实 HTTP attempt，证明真实 AI SDK 流式链路与工具循环可用。
- `verify:space-runtime` 当前验收结果为 4 个 run、4 个 invocation、4 个 attempt 和 4 行
  JSONL trace，验收退出后查询确认 `space-e2e-*` tenant/thread/space 均为 0 残留。

## 复杂度说明

验收脚本只编排现有服务，不复制业务判断，也不增加生产配置、API 或持久化实体。把它并入
已有 Prisma Store 验证会继续放大一个已经覆盖底层 CRUD/竞态的长脚本，并混淆“持久化单元
验证”和“跨模块业务链路验收”；因此保留独立命令和独立报告目录。
