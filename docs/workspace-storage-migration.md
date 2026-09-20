# 工作区存储迁移

工作区根目录由实例环境变量 `TOOL_WORKSPACE_ROOT` 配置。生产 Compose 使用 `/w`，并把会话
工作区、业务插件和 Provider 观测记录分开挂载。数据库中的历史 `tools.workspaceRoot` 记录
会被忽略，不需要修改数据库。

## 已使用宿主机目录的部署

先停止 RunForge 容器。假设原配置为：

```yaml
volumes:
  - ./data:/var/lib/runforge
```

目录内容保持原位，把挂载改为：

```yaml
environment:
  TOOL_WORKSPACE_ROOT: /w
  RUNFORGE_PROVIDER_TRACE_DIR: /app/provider-traces
  RUNFORGE_BUSINESS_PLUGIN_ROOTS: /app/business-plugins
volumes:
  - ./data/workspaces:/w
  - ./data/business-plugins:/app/business-plugins
  - ./data/provider-traces:/app/provider-traces
```

如果原来已经把工作区单独映射到 `/var/lib/runforge/workspaces`，只需把该挂载的容器目标改成
`/w`。重新启动后，关闭并重新打开升级前创建的 Shell session。

## 历史会话目录

旧的 `<workspaceRoot>/<threadId>` 目录会在历史会话首次访问时移动到
`/w/<spaceId>/<threadId>`。旧版 default 空间使用的
`<workspaceRoot>/tenants/<tenantId>/users/<userId>/workspace` 不会自动迁移或删除。

工作区路径变化后需要重新生成文件分享链接。
