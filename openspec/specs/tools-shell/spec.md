# 工具与 Shell

## Purpose

约定工具执行边界、Linux 只读保护与托管命令。实现入口：`server/src/tools/`、`server/src/shell/`；解释见 `docs/tool-sandbox.md`、`docs/background-shell-design.md`。

## Requirements

### Requirement: 统一工具策略与输出限制

系统 SHALL 在工具入口执行适用策略并限制单条输出；`TOOL_MAX_OUTPUT` 的运行时上限 SHALL 为 40000 字符，关闭附加工具策略不得关闭输出限制。

#### Scenario: 工具返回过长正文
- **WHEN** 工具结果超过当前输出上限
- **THEN** 系统截断并明确保留范围，不将被省略内容声称为已完整返回

### Requirement: Linux 运行资源只读

Linux Shell SHALL 始终使用 bwrap 只读挂载运行资源的逻辑入口与真实目标；缺失或不可用时明确失败。资源物化 SHALL 保留原文件权限，不能以修改权限或命令字符串猜测替代只读挂载。

#### Scenario: 容器范围访问运行插件
- **WHEN** 管理员选择容器范围访问且 Shell 尝试写入插件、Skill 或 SDK
- **THEN** 只读挂载阻止写入，同时保留该模式原有的容器目录和网络可见范围

#### Scenario: bwrap 不可用
- **WHEN** Linux 环境无法建立所需 bwrap 运行环境
- **THEN** Shell 执行明确失败，不直接改用宿主执行

### Requirement: 访问范围与附加策略独立

系统 SHALL 独立配置容器范围访问、完整会话隔离与 `TOOL_SANDBOX=off/enforce`。完整会话隔离 SHALL 仅提供当前会话、获准用户目录与当前运行资源，并按网络开关控制网络。

#### Scenario: 关闭附加工具策略
- **WHEN** `TOOL_SANDBOX` 设置为 off
- **THEN** 既有 Shell 访问范围和托管资源只读保护保持不变

### Requirement: 托管命令生命周期

系统 SHALL 保存 thread 级 Shell session、命令状态和日志，支持前台执行、后台启动、观察与终止。后台命令接纳后 SHALL 立即返回标识，UI/API 的观察不等同于进程已完成。

#### Scenario: 后台命令仍在输出
- **WHEN** 用户在 Shell 面板观察一个运行中的命令
- **THEN** 返回即时状态与当前日志，不将有输出或模型请求结束当作命令终态

### Requirement: 包管理镜像源按新命令生效

系统 SHALL 允许管理员配置 Python 与 Node 包管理镜像源，后续启动命令使用新配置，已经运行的进程保持原环境。

#### Scenario: 运行期间修改 npm 镜像
- **WHEN** 管理员保存新的 Node 包管理镜像地址
- **THEN** 新命令获得新地址，已启动命令不被重新启动或改写环境
