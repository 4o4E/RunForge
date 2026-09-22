# 互联网检索与核验业务插件

该插件连接 Exa 官方 Streamable HTTP MCP。租户管理员配置 `exa.api-key` 后，空间选择该插件；
Agent 只有在激活 Skill 和 MCP 后才会加载远端工具定义。

插件没有把 `agent_run` 加入工具目录。RunForge 主 Agent 已负责规划，普通搜索、正文读取和高级
筛选足以完成日常核验，也能避免在外部服务中再次启动一层研究 Agent。
