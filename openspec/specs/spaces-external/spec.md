# 空间与外部接入

## Purpose

约定空间配置、运行配置副本、外部调用方与共享对话权限。实现入口：`server/src/spaces/`、`server/src/external/`、`server/src/api/spaces.ts`；完整协议见 `docs/space-runtime-design.md`。

## Requirements

### Requirement: 空间配置与运行副本

系统 SHALL 支持 web 和 external 两种空间模式，并在每次接纳 run 时保存完整有效配置副本。恢复同一 run SHALL 使用其副本，新 run 使用最新空间配置。

#### Scenario: 运行期间修改模型或提示词
- **WHEN** 管理员保存空间新配置
- **THEN** 已接纳运行保留原配置，新接纳运行使用新版本

### Requirement: 提示词模板与默认模型

系统 SHALL 保存完整提示词模板，拒绝未知或格式错误的占位符；默认模型必须属于空间允许且租户当前可用的模型集合。

#### Scenario: 取消允许列表中的默认模型
- **WHEN** 管理员移除当前默认模型且未重新选择
- **THEN** 系统拒绝保存，不自动替换成其他模型

### Requirement: 外部运行身份

external 空间 SHALL 从本租户 active 用户中选择执行用户；thread 创建时固定执行用户，调用方不得覆盖该身份。

#### Scenario: 修改空间执行用户
- **WHEN** 管理员为 external 空间选择新的执行用户
- **THEN** 之后创建的 thread 使用新身份，已有 thread 保留原执行归属

### Requirement: 外部调用方入口

系统 SHALL 通过调用方 Token 识别 tenant、space 和调用权限，保存 Token hash，并支持过期、吊销与轮换。外部协议 SHALL 提供 `run.create`、`run.append`、`run.get`、`run.cancel`、`artifact.upload` 和 `artifact.get`。

#### Scenario: 已吊销调用方访问
- **WHEN** 调用方使用已吊销或过期 Token 请求外部操作
- **THEN** 系统拒绝该请求，不从请求体接受替代租户、空间或执行用户

### Requirement: 外部共享对话的内容与管理权限

external 对话在 Web 中 SHALL 保持消息、文件和执行只读；租户 owner/admin SHALL 可以置顶、重命名、归档、恢复和永久删除，普通可见成员不具备这些管理权限。

#### Scenario: 普通成员查看共享任务
- **WHEN** 空间可见名单中的普通成员打开 external 对话
- **THEN** 可以查看任务内容，但不能发送、回答、取消、分叉或修改共享对话状态

#### Scenario: 管理员删除共享对话
- **WHEN** 租户管理员按归档与停止运行约束永久删除 external 对话
- **THEN** 删除对所有查看者生效，并清理对应数据库记录、外部产物和会话目录，不跟随共享资源链接
