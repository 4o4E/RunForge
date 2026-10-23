# 运行 Skill 与 MCP

## Purpose

约定产品运行时的能力发现、激活和只读资源，与源码仓库的开发助手技能分开。实现入口：`server/src/skills/`、`server/src/mcp/`；解释见 `docs/skill-system-design.md`。

## Requirements

### Requirement: 受控资源发现

系统 SHALL 仅向运行提供内置资源与空间选中的业务插件资源。普通会话不得创建、修改或发布运行 Skill，源码仓库开发助手的 `.agents/skills` SHALL 不进入产品运行目录发现。

#### Scenario: 会话自行写入 SKILL.md
- **WHEN** 普通会话工作目录中出现自行创建的 Skill 文件
- **THEN** 系统不将其注册为可激活的运行 Skill

### Requirement: 运行级渐进激活

系统 SHALL 先提供 Skill/MCP 名称与描述，Skill 正文通过 `skill_activate` 加载，MCP 工具定义通过 `mcp_activate` 加载。激活只属于当前 run，恢复同一 run 从运行元数据恢复，新 run 重新激活。

#### Scenario: 下一轮新任务读取历史激活记录
- **WHEN** 同一 thread 创建新 run 且历史含 Skill/MCP 激活结果
- **THEN** 系统不把历史记录当作新 run 的授权或当前激活状态

### Requirement: 托管资源路径

系统 SHALL 在空间目录准备按内容版本保存的内置 Skill 与 SDK，通过受控相对链接向会话提供；文件工具仅允许读取当前运行授权的真实目标，写入 SHALL 不得进入托管资源。

#### Scenario: 普通文件链接指向会话外
- **WHEN** 文件工具读取用户创建的越界符号链接
- **THEN** 系统拒绝访问，不因受控运行资源也使用链接而授权普通链接

### Requirement: MCP 会话生命周期

MCP Client SHALL 按 run 隔离，运行完成、失败、取消或等待用户时释放。业务 MCP 连接与实际调用 SHALL 使用当前租户配置与 Secret。

#### Scenario: 业务 MCP 凭证更新
- **WHEN** 管理员更新当前租户的 MCP Secret
- **THEN** 后续连接或调用读取新值，不将密钥固定在历史运行配置副本中
