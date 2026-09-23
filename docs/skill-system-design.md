# Skill 与 Workflow 运行资源

## 职责与权限

Skill 是包含 `SKILL.md`、可选引用资料、素材和脚本的目录；Workflow 是包含 `WORKFLOW.md` 的阶段流程目录。初始模型上下文只列出可用资源的名称和说明，Skill 正文经 `skill_activate` 按需加载，Workflow 正文经 `workflow_read` 按需加载。二者都不承担工具授权；文件、Shell、网络和业务能力仍由运行配置与服务端工具边界控制。

普通用户的会话不能创建、修改或发布 Skill、Workflow。内置资源由服务代码维护；业务 Skill 随租户业务插件安装，由空间配置选用。管理员在对话中创建并发布资源的能力尚未实现，需要与业务插件发布流程和 RunForge Token 权限一同设计。

## 存储与装配

每个空间有独立的只读托管资源目录：

- `/w/<spaceId>/.skills/builtin/<name>/<sourceHash>`：按内置源文件版本命名，目录中保存过滤维护注释后的 Skill。
- `/w/<spaceId>/.workflows/builtin/<name>/<sourceHash>`：按内置源文件版本命名，目录中保存过滤维护注释后的 Workflow。
- `/w/<spaceId>/.plugins/<pluginId>/<contentHash>`：指向租户业务插件不可变快照的相对符号链接；插件实体只在租户快照目录保存一次。
- `/w/<spaceId>/.agents/runforge-workload-sdk/<contentHash>`：RunForge 维护的零依赖 SDK 入口，不保存运行 Token。

会话资源唯一可写目录为 `/w/<spaceId>/c/<threadId>`；用户跨会话文件另存放在 `/u/<userId>`，不用于 Skill 或 Workflow 发现。运行准备时，服务端在会话的 `.agents/skills`、`.agents/workflows`、`.agents/runforge-workload-sdk` 和 `plugins` 下建立受控相对链接。会话本身不保存这些资源的实体副本，也不扫描会话内自建的 `.skills` 或 `.workflows`。服务端只向模型列出本次运行实际选中的资源。

内置资源和 SDK 按内容版本准备，先写入临时目录，成功后一次性发布；已有版本不重复复制。会话入口只保留当前版本链接。业务插件由 `runs.plugin_lock` 固定插件 ID 和内容哈希；新运行使用空间配置选中的版本，已有运行恢复时仍读取锁定的快照，不通过可变的“当前版本”链接切换。

## 读取与执行边界

文件工具以当前会话目录为起点，检查每一段真实路径。普通会话文件中的符号链接不能越过会话边界；服务端创建的托管链接只有在真实目标属于本次运行的 Skill、Workflow、SDK 或锁定插件白名单时才能读取。写入只能落在会话普通文件中，托管目录及其链接一律只读。

Web 文件接口只展示和读写会话普通文件，不把托管资源当作用户文件，也不跟随用户文件中的符号链接。Shell 的沙箱只挂载当前会话工作目录、本次运行选中的资源内容版本和锁定插件快照；不挂载同空间其他会话目录。业务 Skill 附属脚本仍遵守 Shell 命令、网络和输出限制。

`WORKLOAD_TOKEN` 仅在每次运行的环境变量中注入，不能写入空间共享文件。Skill 或插件中的脚本通过 SDK 使用该令牌申请获准的短期资源；资源权限不由文件目录位置推断。

## 模型上下文和历史

Skill 激活信息只在当前运行有效，当前运行的后续模型请求持续保留其入口说明；新运行需要重新激活。历史消息可能含旧资源路径或旧激活结果，不能把它们视为当前运行权限。Workflow 的列表与读取每次按当前空间资源重新解析。

旧会话工作目录可以清理后在新路径重新创建；数据库中的消息、运行记录和 Token 用量不随文件清理而改写。历史消息指向已经清理的文件时，路径不再可用。
