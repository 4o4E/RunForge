# Phase 6 实施日志 · 沙箱 / 权限强化(工具策略层)

> 对应 [refactor-plan.md](../refactor-plan.md) §6 Phase 6。
> 日期:2026-06-11 · 状态:✅ 完成(进程内策略层;容器级隔离作后续)

## 目标

为"安全调系统能力"建立**可信边界**:每次工具调用都经过统一的策略检查点
——allow/deny、文件系统路径围栏、shell 启停 + 命令黑名单、网络启停 + host
白名单、输出体积上限。参考 data-permission / tool-policy 思路。

## 设计抉择

- 产品定位是"运行在 OS 上的通用 Agent",**默认强约束会削弱其本职**,故路径围栏/
  shell/web 门禁为 **opt-in**(`TOOL_SANDBOX=enforce`)。`deny`/`allow` 与输出上限
  在任何模式下都生效。默认 `off` 完全保持现有行为,可一键切 `enforce`,符合计划
  "先小范围试点 / 优先级随暴露面提升 / 可回退"。
- 策略落在**唯一调用入口** `registry.runTool`,与各工具实现解耦;工具文件零改动。
- 容器级隔离(E2B / microsandbox / Docker)是更重的互补项,作为后续;本层进程内、
  零依赖、恒在调用路径上,可与未来隔离叠加。

## 改动

新增:

- [server/src/tools/policy.ts](../../server/src/tools/policy.ts)
  - 每工具安全元数据 `META`(kind: fs-read/fs-write/exec/net/safe + 路径/URL 参数键)。
  - `isWithin(root, target)`:健壮的路径围栏判断(`..` 逃逸、绝对路径越界均拒绝)。
  - `createPolicy(cfg)` → `{ check, capOutput }`:
    1. deny/allow(任何模式);2. enforce 下 fs 路径围栏;3. exec 启停 + 命令黑名单;
    4. net 启停 + host 白名单(含子域);`capOutput` 恒裁剪超限结果。
- [server/src/tools/policy.test.ts](../../server/src/tools/policy.test.ts) —— 8 个单测
  (围栏、deny/allow、shell 黑名单/禁用、web 白名单/禁用、输出裁剪)。

修改:

- [server/src/tools/registry.ts](../../server/src/tools/registry.ts) —— `runTool`
  先过 `policy.check`,拒绝则返回 `Blocked by tool policy: <reason>`;放行结果过
  `policy.capOutput`。
- [server/src/config.ts](../../server/src/config.ts) —— 新增 `tools` 策略配置块;
  `patterns()` 按逗号/换行切分(允许含空格的正则);`list()` 用于无空格的名字/host。
- [server/src/index.ts](../../server/src/index.ts) —— 启动日志打印 sandbox 状态。
- [.env.example](../../.env.example) —— 当时新增工具 allow/deny 与沙箱环境变量文档；
  当前主 agent 已改为原生工具默认加载，allow/deny 配置和“工具准入”页面已移除，保留 Shell/沙箱、网络与输出上限。

## 验收

- `typecheck`:通过。
- `npm test`:31/31 通过(新增 8 个 policy 单测;既有工具/执行器单测不变即过——
  策略在 `runTool` 层,`tool.run` 直调路径不受影响,故未破坏现状)。
- **集成冒烟(enforce 模式,经 `runTool`)**:
  - 工作区内 `file_read package.json` → 返回内容(放行)。
  - 越界 `file_read ../.env` → `Blocked by tool policy: path '../.env' is outside the workspace`。
  - 破坏性 `shell rm -rf /` → `Blocked by tool policy: command blocked by denylist`。
  - 普通 `shell echo` → 正常执行。

## 后续

- **容器级隔离**:在进程策略之上接 E2B / microsandbox / Docker,把 shell/file 执行
  放进受限沙箱(资源配额、文件系统视图、网络命名空间),策略层负责"准入",隔离层
  负责"爆炸半径"。
- 可把策略决策作为属性写到 Phase 4 的 `execute_tool` span(blocked/allowed + reason),
  便于审计。
