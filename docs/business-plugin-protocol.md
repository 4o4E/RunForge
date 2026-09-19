# 业务插件协议与当前实现

业务插件是调用方维护的声明式业务能力包，Cordis 插件是 RunForge 自己维护的运行时代码，
二者不能混用。业务插件可以声明多文件 Skill、外部 MCP、tenant Secret key、非敏感配置和
标准运行资源，但不能携带装入 RunForge 服务进程的 JavaScript/Cordis 入口。

Issue 中的 v0.2 草案是协议基线；本文记录仓库当前已经实现的行为和尚未完成的边界。

## 部署与导入

`RUNFORGE_BUSINESS_PLUGIN_ROOTS` 配置一个或多个根目录。目录必须按 tenant 隔离：

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

业务插件有两种交付方式：

- 调用方或部署流水线把完整目录原子地放到上述位置，再由管理员执行“重新加载目录”。
- tenant owner/admin 或 system admin 在业务插件管理页手动导入 ZIP、TGZ 或 `.tar.gz`。

手动导入使用第一个配置根目录；未配置环境变量时使用仓库下的 `business-plugins`。压缩包
可以直接以 `runforge.plugin.yaml` 为根，也可以只包含一个顶层插件目录。RunForge 会先在
临时目录解压和校验，再按 manifest ID 安装；ID 已存在时原子替换当前目录并重新加载索引，
tenant 非敏感配置和 Secret 继续按相同插件 ID 保留。压缩包限制为 50 MiB，解压后限制为
200 MiB、10000 个条目和 32 层目录；路径穿越、符号链接、硬链接和特殊文件都会被拒绝。

RunForge 不拉取 Git，也不建设业务插件发布仓库。活动 run 在首次启动时保存的工作副本继续
使用原内容；更新后的内容只供之后接纳的新 run 使用。

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
    description: CRM MCP API Key

mcpServers:
  - id: crm
    urlConfigKey: endpoint
    bearerSecretKey: crm.api-key

resources:
  - type: database.readonly
```

路径必须留在业务插件目录内，symlink、`..`、绝对路径、重复 ID、未声明 Secret 引用和
`dist/index.js` 服务端入口都会被拒绝。MCP 当前支持 `streamable-http`，URL 只允许
HTTP/HTTPS，并且 `url` 与 `urlConfigKey` 必须二选一。

## 配置和运行语义

- tenant owner/admin 和 system admin 可在管理页配置插件的非敏感 JSON 与 tenant Secret。
- 管理页根据 `configSchema` 生成字段编辑器，展示字段名称、说明、必填状态和可选值；管理员
  通过字段控件完成配置。普通配置用于 MCP 地址、项目编号和功能选项等非敏感参数。
- Secret 只按 `tenant + key` 保存当前值；管理 API 只返回“是否已配置”，不回显明文。
- `key` 是 Secret 的稳定名称，例如 `crm.api-key`。声明用于管理页生成配置项、必填检查和
  文档说明，不是插件级权限名单。
- 空间必须显式选择业务插件；新部署插件不会自动进入已有空间。
- run 接纳时在已有 `runs.plugin_lock` 固定业务插件 ID、内容 hash 和非敏感 tenant 配置。
- Secret 不进入 `plugin_lock`。业务 MCP 在激活和实际调用前读取 tenant 当前值；值变化时
  run 级 MCP session 会关闭旧连接并按新连接签名重连。
- run 第一次启动时把整个插件目录复制到当前 workspace 的
  `.agents/business-plugins/<pluginId>/<hash>/plugin`。该目录受工具写保护，用于活动、等待
  和服务重启后的同一 run 继续使用原内容；它是 run 工作副本，不是发布仓库。
- 业务 Skill 加入现有渐进加载目录，使用 `skill_activate` 激活；业务 MCP 随插件整体进入
  当前空间，但仍使用 `mcp_activate` 渐进发现工具。
- 管理页可以展开查看每个 Skill 的名称、描述和 `SKILL.md` 入口正文。每个 MCP 会显示其
  Manifest 定义；管理员展开 MCP 时，RunForge 使用当前租户配置建立独立连接，读取真实工具
  目录和输入 Schema，随后释放连接。MCP 连接失败只影响该项预览。
- MCP Client 按 run 隔离并在 run 完成、失败、取消或等待用户时释放，不按 server ID 在
  进程全局共享。
- 每个 run 沿用一个 `WORKLOAD_TOKEN` 作为统一系统资源凭证。Skill 脚本通过
  `@runforge/workload-sdk` 的 `secrets.get(key)`、`resources.acquire("database.readonly")`
  和 `resources.acquire("llm.proxy")` 获取资源；SDK 不接受 tenant、space 或插件 ID。同一
  run 同时只有一个活动 token，等待后恢复执行时轮换，不按 Skill 或插件补签。
- RunForge 会把 SDK 入口复制到当前 workspace 的 `.agents/runforge-workload-sdk/index.mjs`，
  并通过 `RUNFORGE_WORKLOAD_SDK` 暴露路径，因此调用方维护的业务插件不需要在部署目录中
  安装 RunForge 依赖。该目录与 Skill、业务插件运行副本一样受工具写保护。
- Secret SDK 根据 `WORKLOAD_TOKEN` 反查 run 和 tenant，再按 key 读取当前值。一个 run 中
  的可信脚本共享同一 token；插件声明不限制某个脚本只能读取自己的 key。
- `database.readonly` 映射现有数据源账号池，只签发只读权限档位；`llm.proxy` 映射现有
  runtime capability 代理。空间必须授权插件声明所需的系统资源，否则配置保存失败。
- Secret 每次成功、缺失或异常读取都写入 `workload_secret_access_logs`，记录 tenant、run、
  step、token、调用路径和 key，不保存 Secret 值。读取和审计在同一事务提交，审计失败不
  返回明文。
- run 完成、失败、取消或进入等待时主动撤销 token 并释放数据库租约；后台 reconciler
  只处理异常退出等兜底场景。

## 当前未完成

- 首版 SDK 提供 ESM/Node 客户端和稳定 HTTP 协议；其他语言客户端按真实业务插件需要再补，
  不提前维护没有调用方的包装库。
- 标准资源目前只有 `database.readonly` 和 `llm.proxy`。新增类型必须先证明可跨业务复用，
  再由 RunForge 增加对应的 Cordis 运行资源实现。
