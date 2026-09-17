# 业务插件协议与当前实现

业务插件是调用方维护的声明式业务能力包，Cordis 插件是 RunForge 自己维护的运行时代码，
二者不能混用。业务插件可以声明多文件 Skill、外部 MCP、tenant Secret key、非敏感配置和
标准运行资源，但不能携带装入 RunForge 服务进程的 JavaScript/Cordis 入口。

Issue 中的 v0.2 草案是协议基线；本文记录仓库当前已经实现的行为和尚未完成的边界。

## 部署目录

`RUNFORGE_BUSINESS_PLUGIN_ROOTS` 配置一个或多个只读根目录。目录必须按 tenant 隔离：

```text
<configured-root>/
  <tenantId>/
    <plugin-directory>/
      runforge.plugin.yaml
      skills/
        <skill-id>/
          SKILL.md
          scripts/
          references/
          assets/
```

RunForge 不拉取 Git、不接收压缩包，也不维护业务插件发布仓库。调用方或部署流水线负责把
完整目录原子地放到上述位置。管理页的“重新加载目录”才会切换当前索引，不会每个 run
扫描磁盘。

## Manifest

入口固定为 `runforge.plugin.yaml`：

```yaml
schemaVersion: 1
id: crm
version: 1.0.0
displayName: CRM 查询
description: 查询经过审核的 CRM 业务接口。

skills:
  - id: customer-query
    path: skills/customer-query

configSchema:
  type: object
  required: [endpoint]
  properties:
    endpoint: { type: string, minLength: 1 }

secrets:
  - key: crm.api-key
    required: true
    access: [backend]
    description: CRM MCP API Key

mcpServers:
  - id: crm
    urlConfigKey: endpoint
    bearerSecretKey: crm.api-key

resources: []
```

路径必须留在业务插件目录内，symlink、`..`、绝对路径、重复 ID、未声明 Secret 引用和
`dist/index.js` 服务端入口都会被拒绝。MCP 当前支持 `streamable-http`，URL 只允许
HTTP/HTTPS，并且 `url` 与 `urlConfigKey` 必须二选一。

## 配置和运行语义

- tenant owner/admin 和 system admin 可在管理页配置插件的非敏感 JSON 与 tenant Secret。
- Secret 只按 `tenant + key` 保存当前值；管理 API 只返回“是否已配置”，不回显明文。
- 空间必须显式选择业务插件；新部署插件不会自动进入已有空间。
- run 接纳时在已有 `runs.plugin_lock` 固定业务插件 ID、内容 hash 和非敏感 tenant 配置。
- Secret 不进入 `plugin_lock`。业务 MCP 在激活和实际调用前读取 tenant 当前值；值变化时
  run 级 MCP session 会关闭旧连接并按新连接签名重连。
- run 第一次启动时把整个插件目录复制到当前 workspace 的
  `.agents/business-plugins/<pluginId>/<hash>/plugin`。该目录受工具写保护，用于活动、等待
  和服务重启后的同一 run 继续使用原内容；它是 run 工作副本，不是发布仓库。
- 业务 Skill 加入现有渐进加载目录，使用 `skill_activate` 激活；业务 MCP 随插件整体进入
  当前空间，但仍使用 `mcp_activate` 渐进发现工具。
- MCP Client 按 run 隔离并在 run 完成、失败、取消或等待用户时释放，不按 server ID 在
  进程全局共享。

## 当前未完成

- `access: [workload]` 的长期 Secret 尚未接入 Workload SDK，因此包含这类声明的插件会在
  管理页显示“待配置”，不能被空间选择。
- `resources` 运行资源目前只完成 manifest 和 Cordis catalog 的声明链路，尚未
  接入按业务插件隔离的 Workload SDK 申请/释放；包含资源声明的插件同样不会进入空间可用
  目录。不能把现有 run 级全局 token 当作插件级授权临时替代。
- Secret 读取审计尚未持久化。实现 workload Secret 与资源租约时需要先确认相应数据库
  模型，再增加迁移。

以上限制会显式阻止插件进入空间，不会静默忽略资源或把 Secret 注入模型上下文。
