# 工作区存储迁移

工作区根目录由实例环境变量 `TOOL_WORKSPACE_ROOT` 配置。生产 Compose 使用 `/w`，并把工作区、
业务插件和 Provider 观测记录分开挂载。数据库中的历史 `tools.workspaceRoot` 记录会被忽略，
不需要修改数据库。

新工作区按空间和会话分层：

- `/w/<spaceId>/.skills`、`.workflows`、`.plugins`、`.agents` 保存空间托管资源。服务端负责准备，
  会话只读访问；`.plugins` 引用空间选用的业务插件版本快照。
- `/w/<spaceId>/c/<threadId>` 是会话唯一的可写目录。运行时只挂接该会话选中的托管资源，
  不挂接同空间的其他会话目录。
- 工具、文件接口和 Shell 均按真实路径检查权限。符号链接不允许绕过目录权限；存储扫描只统计
  链接本身，不跟随链接目标。

会话工作区迁移只调整 `/w` 内部目录。用户跨会话文件独立使用 `/u/<userId>` 持久卷，
不搬动本机旧工作目录或历史会话文件。生产使用宿主目录绑定 `/u` 时，启动前应创建该目录并确保容器内运行用户可写；不能让非 root 服务直接使用 Docker 自动创建的 root 所有目录。

## 历史会话目录

旧版会话目录位于 `/w/<spaceId>/<threadId>`；更早的目录还可能位于 `/w/<threadId>`。生产迁移清理旧会话目录前，先确认没有运行中的
RunForge 任务或 Shell 命令；存在未结束任务时暂停清理，等待任务结束后再继续。清理仅删除旧
会话工作文件，不改动数据库中的会话、消息、运行记录、Token 用量和存储历史样本。旧消息仍可
查看，但引用已清理文件的路径及分享链接将失效。重新打开会话后使用新目录和新的 Shell 会话。

停止 RunForge 服务后，在相同工作区挂载和数据库连接配置下执行维护脚本。默认只预览数据库中
以 `th_` 命名的旧会话目录，包括数据库记录已删除后的遗留目录；确认清单后加 `--apply` 才删除。脚本发现未结束的 run、subagent 或
Shell 命令时会拒绝删除，不会修改这些数据库状态。

```bash
pnpm --filter server clean:legacy-thread-workspaces
pnpm --filter server clean:legacy-thread-workspaces --apply
```

使用发布镜像时，服务停止后在部署 Compose 所在目录运行同一脚本；一次性容器复用服务的数据库环境和工作区挂载，不启动 HTTP 服务：

```bash
docker compose run --rm --no-deps --entrypoint node runforge dist/maintenance/cleanLegacyThreadWorkspaces.js
docker compose run --rm --no-deps --entrypoint node runforge dist/maintenance/cleanLegacyThreadWorkspaces.js --apply
```

执行第二条命令前检查预览数量和活动任务数。迁移时仅停止 RunForge 服务，不删除数据库和持久卷，也不执行 `down --volumes`。

旧版 default 空间使用的
`<workspaceRoot>/tenants/<tenantId>/users/<userId>/workspace` 不属于旧会话目录，本次迁移不清理。
空间托管资源应按空间放入 `/w/<spaceId>/.skills`、`.workflows`、`.plugins`、`.agents`，不要放入
会话目录。

工作区路径变化后需要重新生成文件分享链接。新存储采样同时计入尚未清理的旧会话目录，清理后
当前占用才下降；已经保存的历史存储样本保留原值。
