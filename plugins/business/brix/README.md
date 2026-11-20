# Brix 浏览器自动化

Agent 在 shell 里执行 `brix --help`，用 `brix-browser` Skill 操作浏览器、查询或更新共享经验、读写本地文件，以及调用已部署的脚本。命令与独立运行的 Brix 共用实现，不依赖 MCP，也不需要把 base64 放进模型工具参数。

图片溯源使用 `brix remote run google-lens --image ./input.png`。切换前须确认目标 Brix 已部署 `google-lens`；脚本缺失会报错，不会由 RunForge 自动上传。

CLI 和 Skill 由 Brix 仓库维护；更新时从 Brix 运行 `node scripts/sync-runforge-skill.mjs <RunForge 工作区>`。

租户需要配置 `brix.base-url` 与 `brix.token` 两个 Secret。需要浏览器的空间选择本插件，
并开放 `skill_activate` 与 `shell`。具体业务要求由外部可信提示词传入，无需写入空间的通用提示词。
