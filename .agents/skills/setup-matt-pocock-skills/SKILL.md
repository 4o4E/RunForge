---
name: setup-matt-pocock-skills
description: "核对或维护 RunForge 项目工程技能的 GitHub 工作项、分流标签和 OpenSpec 文档配置。"
disable-model-invocation: true
---

# 项目工程技能配置

本项目配置已建立；读取现有配置后维护，不按通用仓库模板重新生成文档布局。

1. 读取 `AGENTS.md`、`docs/agents/README.md`、`docs/agents/issue-tracker.md`、`docs/agents/triage-labels.md`、`docs/agents/domain.md` 与 `openspec/config.yaml`。
2. 核对项目技能是否位于 `.agents/skills`、来源锁是否指向 `4o4E/skills`，官方 OpenSpec 技能是否可发现。
3. 保持领域术语在 `GLOSSARY.md`，规格、架构决定与任务在 OpenSpec 的既定位置；setup 模板引用现有配置，不另建独立决定文档或第二份规格。
4. 问题跟踪使用 `4o4E/RunForge` GitHub Issues；分流角色从项目标签配置读取。只有用户要求更换工作方式时才提出不同配置，不因包数量重新划分领域。
5. 确需改变业务或架构时，先在 OpenSpec 变更写出具体计划并取得用户确认；远程工作项或标签操作需要授权。
6. 验证实际技能发现、OpenSpec 列表、项目上下文指令输出和严格校验；报告观察到的结果，不声称已部署产品。

完成标准：技能消费者实际读取同一套项目配置，所有规格和决定读写路径继续使用 OpenSpec，未覆盖用户现场或修改全局安装。
