---
name: database-access
description: 使用当前环境已有的数据库 CLI 连接数据库、探查 schema、执行只读 SQL、导出小样本数据。Use when the task needs database inspection, read-only querying, schema discovery, or datasource CLI access.
allowed-tools: datasource_list shell grep file_read file_write
metadata:
  my-agent.tool-scope: readonly
---

# Database Access

## Workflow

1. 先确认用户要访问哪个数据库、已有连接信息在哪里，以及是否只读。
2. 优先使用平台签发的 workload token 换取本次 run 的短期凭证，不要要求用户直接贴长期密码。
3. 用当前环境已有 CLI 连接数据库，先读元数据和少量样本，再写业务查询。
4. 查询默认只读；除非用户明确要求且权限允许，不要执行 `INSERT`、`UPDATE`、`DELETE`、`TRUNCATE`、`DROP`、`ALTER`。
5. 大结果必须用 `LIMIT`、聚合或导出文件控制体积，避免把整表内容塞进工具输出。
6. 如果需要更详细的 CLI 和凭证 SDK 模式，读取 `references/cli-patterns.md`。

## Connection Discovery

按这个顺序找连接方式：

1. 用户明确提供的连接串或 env 名称。
2. 系统 datasource 控制面：先调用 `datasource_list` 查看可用数据源、`DATASOURCE_ID` 和权限档位。
3. 平台 datasource 账号池：如果存在 `DB_WORKLOAD_TOKEN`，必须用它通过接口换取本次 run 可用的短期账号和凭证。
4. 当前 shell 环境中的 `DATABASE_URL`、`PG*`、`MYSQL*`、`MONGO*`、`HIVE*`、`DUCKDB*`。
5. 仓库内 `.env.example`、README、docs 中的本地开发库说明。

只展示脱敏后的连接信息；输出中不要回显密码、token 或完整含密连接串。

## Workload Token

当前平台的数据库访问模型是：run 只拿 `DB_WORKLOAD_TOKEN`，脚本用它调用 `/api/runtime/datasources/:id/credentials` 换取短期数据库账号密码。短期凭证由账号池生成，每次 run 都会刷新，所以不要跨 run 复用或缓存到仓库文件。

可复用 SDK：

- Python: `scripts/db_credential.py`
- PostgreSQL CLI wrapper: `scripts/psql_query.py`
- Node.js: `scripts/dbCredential.mjs`
- Shell: `scripts/db_credential.sh`

这些 SDK 默认从环境变量读取：

- `DB_WORKLOAD_TOKEN`：本次 run 的 workload token。
- `DATASOURCE_ID`：要访问的数据源 id。
- `DATASOURCE_PROFILE`：权限档位，默认 `readonly`。
- `MY_AGENT_RUNTIME_API_BASE`：运行时 API 根路径，默认 `http://localhost:8080/api/runtime`。

SDK 返回的凭证只在内存中使用；不要打印到最终回答、不要写入日志、不要保存到 workspace 文件。

PostgreSQL 查询优先使用 `scripts/psql_query.py`，它会在同一进程内换取短期凭证并调用 `psql`，不会把密码输出给模型。例如：

```bash
python3 "$SKILL_DIR/scripts/psql_query.py" --sql "select current_database(), current_user;"
```

如果必须用 shell 函数，应该在同一个 `bash -c` 里调用 `db_credential_json` 并立即传给 CLI，不要单独打印完整凭证 JSON。

## Query Rules

- 先查数据库名、schema、表、列、行数估计和时间范围。
- 查询业务数据时先写小样本 `LIMIT 20`。
- 用聚合回答统计问题，避免返回明细大表。
- 对可能慢的查询先加时间范围、索引列过滤或 `EXPLAIN`。
- 输出结论时同时说明数据范围、过滤条件和局限。

## CLI Patterns

常见命令、导出方式和只读检查见 `references/cli-patterns.md`。
