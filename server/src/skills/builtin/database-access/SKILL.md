---
name: database-access
description: 使用当前环境已有的数据库 CLI 连接数据库、探查 schema、执行只读 SQL、导出小样本数据。Use when the task needs database inspection, read-only querying, schema discovery, or datasource CLI access.
metadata:
  runforge.tool-scope: readonly
---

# Database Access

## 操作步骤

1. 先确认用户要访问哪个数据库、已有连接信息在哪里，以及是否只读。
2. 优先使用平台签发的 WORKLOAD_TOKEN 换取本次 run 的短期凭证，不要要求用户直接贴长期密码。
3. 用当前环境已有 CLI 连接数据库，先读元数据和少量样本，再写业务查询。
4. 查询默认只读；除非用户明确要求且权限允许，不要执行 `INSERT`、`UPDATE`、`DELETE`、`TRUNCATE`、`DROP`、`ALTER`。
5. 大结果必须用 `LIMIT`、聚合或导出文件控制体积，避免把整表内容塞进工具输出。
6. 如果需要更详细的 CLI 和凭证 SDK 模式，读取 `references/cli-patterns.md`。

## Connection Discovery

按这个顺序找连接方式：

1. 如果存在 `WORKLOAD_TOKEN`，调用 `scripts/datasource-list.mjs`，通过统一 Workload SDK 查看本次 run 可以访问的数据源和只读权限档位。
2. 用户明确提供的连接串或环境变量名称。
3. 当前 shell 环境中的 `DATABASE_URL`、`PG*`、`MYSQL*`、`MONGO*`、`HIVE*`、`DUCKDB*`。
4. 仓库内 `.env.example`、README、docs 中的本地开发库说明。

只展示脱敏后的连接信息；输出中不要回显密码、token 或完整含密连接串。

## Workload Token

当前平台的数据库访问模型是：run 只拿 `WORKLOAD_TOKEN`，脚本通过 `RUNFORGE_WORKLOAD_SDK` 指向的统一 SDK 列出数据源并换取短期数据库账号密码。短期凭证由账号池生成，每次 run 都会刷新，所以不要跨 run 复用或缓存到仓库文件。不要自行请求运行时 HTTP 接口。

可复用 SDK：

- 数据源目录：`scripts/datasource-list.mjs`
- 凭据 SDK 辅助模块：`scripts/dbCredential.mjs`
- PostgreSQL 查询：`scripts/psql-query.mjs`

这些 SDK 默认从环境变量读取：

- `RUNFORGE_WORKLOAD_SDK`：平台为本次 run 物化的统一 SDK 入口。
- `WORKLOAD_TOKEN`：本次 run 的 workload token，由 SDK 读取。
- `DATASOURCE_ID`：要访问的数据源 id。
- `DATASOURCE_PROFILE`：权限档位，默认 `readonly`。
- `RUNFORGE_RUNTIME_API_BASE`：运行时 API 根路径，由 SDK 读取。

SDK 返回的凭证只在内存中使用；不要打印到最终回答、不要写入日志、不要保存到 workspace 文件。
PostgreSQL 查询使用 `scripts/psql-query.mjs`，它会在同一进程内通过 SDK 换取短期凭证并调用 `psql`，不会把密码输出给模型。例如：

```bash
node "$SKILL_DIR/scripts/psql-query.mjs" --sql "select current_database(), current_user;"
```

## Query Rules

- 先查数据库名、schema、表、列、行数估计和时间范围。
- 查询业务数据时先写小样本 `LIMIT 20`。
- 用聚合回答统计问题，避免返回明细大表。
- 对可能慢的查询先加时间范围、索引列过滤或 `EXPLAIN`。
- 输出结论时同时说明数据范围、过滤条件和局限。

## CLI Patterns

常见命令、导出方式和只读检查见 `references/cli-patterns.md`。
