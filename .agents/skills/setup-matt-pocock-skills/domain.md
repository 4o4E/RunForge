# RunForge 领域文档配置

本项目的读取和写入规则以仓库 `docs/agents/domain.md` 为准。维护设置时编辑该文件，不从通用模板生成新的文档布局。

- 领域术语：根目录 `GLOSSARY.md`。
- 当前行为：`openspec/specs/<capability>/spec.md`。
- 变更目标、架构决定、任务：`openspec/changes/<change>/` 下的 proposal、design、tasks。
- 完成后的决定：同一变更的归档 `design.md`。

架构决定由 OpenSpec 承担；setup 仅维护项目入口引用，不复制其正文。
