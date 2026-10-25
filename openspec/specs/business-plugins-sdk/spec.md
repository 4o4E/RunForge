# 业务插件与 Workload SDK

## Purpose

约定租户业务插件的交付、运行锁和短期资源访问。实现入口：`server/src/businessPlugins/`、`packages/workload-sdk/`；完整字段与限制见 `docs/business-plugin-protocol.md`。

## Requirements

### Requirement: 声明式业务插件

业务插件 SHALL 以 `runforge.plugin.yaml` 声明 Skill、MCP、配置、Secret、资源与可执行文件，不携带装入 RunForge 服务进程的 JavaScript/Cordis 入口。

#### Scenario: 插件声明服务端入口或越界文件
- **WHEN** 导入包含服务端入口、路径穿越或不允许链接的插件包
- **THEN** 系统拒绝安装，不执行包内服务端代码

### Requirement: 视频能力与任务输出契约分离

视频业务 Skill SHALL 提供平台资料获取及通用媒体处理方法，分析目标、处理范围、执行顺序、静默条件和最终回复格式由空间与可信任务提示词决定，不在共享视频 Skill 或下载脚本中强制统一的自动报告流程。

#### Scenario: 普通群聊分析 B 站视频
- **WHEN** 普通群聊任务使用 B 站视频 Skill 获取当前问题所需的资料
- **THEN** Agent 按群聊提示词组织回复，不因激活该 Skill 而被要求返回固定 JSON 报告

#### Scenario: QQ 原生视频与其他来源媒体
- **WHEN** 任务已经通过 QQ 附件能力、其他平台能力或实际媒体直链取得视频文件
- **THEN** Agent 使用通用音视频 Skill 按需探测、转写或抽帧，不将文件交给 B 站链接解析器；视觉问题不以存在有效语音转写为前提

#### Scenario: 自动视频报告
- **WHEN** 自动分析调用方通过可信任务提示词要求音轨优先、按档位处理并返回结构化结果
- **THEN** Agent 遵循该任务的处理顺序与 JSON 契约，共享视频 Skill 不覆盖这些任务要求


### Requirement: 管理导入与正式打包

系统 SHALL 支持租户管理员或系统管理员导入 ZIP/TGZ/tar.gz，并先在暂存目录校验后原子安装。仓库正式打包 SHALL 通过 `pnpm package:business-plugin` 验证实际包可导入，输出至 `build/business-plugins/<id>-<version>.zip`。

#### Scenario: 更新已有插件
- **WHEN** 管理员导入相同 ID 的有效新包
- **THEN** 替换当前目录并更新索引，保留相同 ID 的非敏感配置和 tenant Secret

### Requirement: 运行锁与依赖顺序

系统 SHALL 在接纳 run 时锁定插件 ID、内容 hash、顺序和非敏感配置；运行恢复使用不可变快照。必需依赖 SHALL 先于依赖方激活，同名命令按空间顺序采用第一个声明。

#### Scenario: 活动运行期间更新插件
- **WHEN** 管理员安装插件新版本
- **THEN** 已有运行继续读取锁定快照，新运行使用空间当前选中的插件内容

### Requirement: 统一运行资源令牌

可信脚本 SHALL 通过当前 run 的 `WORKLOAD_TOKEN` 与 Workload SDK 读取 Secret 或申请获准资源，不通过调用参数选择 tenant、space 或插件身份。运行令牌不得写入共享 Skill/SDK 文件。

#### Scenario: 运行等待后恢复
- **WHEN** 任务进入等待用户并随后恢复执行
- **THEN** 系统撤销等待前令牌并在恢复时轮换，不按 Skill 单独补签令牌

### Requirement: Secret 与租约释放

Secret 读取 SHALL 按 tenant 与 key 查找当前值，并与审计在同一事务提交；审计失败不得返回明文。运行终止或等待时 SHALL 撤销令牌并释放数据库租约。

#### Scenario: Secret 审计写入失败
- **WHEN** SDK 请求读取 Secret，但审计事务失败
- **THEN** 请求失败，不返回 Secret 明文
