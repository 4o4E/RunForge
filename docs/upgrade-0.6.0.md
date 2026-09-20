# 升级到 0.6.0

0.6.0 把会话工作目录统一为 `/w/{spaceId}/{threadId}`。Docker 镜像中的 `/w` 指向
`/var/lib/runforge/workspaces`，继续使用原有的 `runforge-data` 持久卷。

## Docker Compose 升级步骤

1. 拉取并启动新镜像：

   ```bash
   docker compose -f deploy/compose.postgres.yml pull
   docker compose -f deploy/compose.postgres.yml up -d
   ```

   使用外部 PostgreSQL 时，把文件名替换为 `deploy/compose.external-postgres.yml`。

2. 使用系统管理员登录 `/sys-admin/settings/tools-sandbox`，把“工作区基础目录”改为
   `/w` 并保存。已有数据库会继续使用 `app_settings` 中保存的旧值，升级镜像不会覆盖
   管理员保存过的系统设置，因此这一步必须显式执行。

3. 关闭并重新打开升级前创建的 Shell session。新的 session 会绑定当前会话的
   `/w/{spaceId}/{threadId}` 目录。

4. 逐个打开需要继续使用的历史会话。旧的 `<workspaceRoot>/<threadId>` 目录会在首次访问时
   原子移动到 `<workspaceRoot>/<spaceId>/<threadId>`。Docker 中 `/w` 和
   `/var/lib/runforge/workspaces` 指向同一持久卷，这个操作不会跨卷复制文件。

5. 重新生成仍需使用的文件分享链接。0.6.0 的签名同时绑定 tenant、user、space 和 thread，
   旧版本生成的链接不会继续通过校验。

旧版 default 空间使用的 `<workspaceRoot>/tenants/<tenantId>/users/<userId>/workspace`
目录不参与自动迁移，升级过程不会删除这些文件。
