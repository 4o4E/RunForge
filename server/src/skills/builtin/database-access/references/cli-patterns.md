# Database CLI Patterns

## PostgreSQL

连接：

```bash
psql "$DATABASE_URL"
psql "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
```

常用只读探查：

```sql
SELECT current_database(), current_user;
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name;

SELECT table_schema, table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
ORDER BY table_schema, table_name, ordinal_position;
```

导出小结果：

```bash
psql "$DATABASE_URL" -c "\copy (SELECT * FROM public.orders LIMIT 1000) TO '/tmp/orders_sample.csv' CSV HEADER"
```

## MySQL

连接：

```bash
mysql -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME"
```

常用只读探查：

```sql
SELECT DATABASE(), CURRENT_USER();
SHOW TABLES;
DESCRIBE orders;
SELECT COUNT(*) FROM orders;
SELECT * FROM orders LIMIT 20;
```

## SQLite

连接：

```bash
sqlite3 path/to/db.sqlite
```

常用只读探查：

```sql
.tables
.schema orders
SELECT COUNT(*) FROM orders;
SELECT * FROM orders LIMIT 20;
```

## DuckDB

DuckDB 既可以直接查 `.duckdb` 文件，也适合临时读取 CSV/Parquet：

```bash
duckdb data.duckdb
duckdb -c "SELECT * FROM read_csv_auto('data.csv') LIMIT 20"
duckdb -c "SELECT count(*) FROM read_parquet('events/*.parquet')"
```

## MongoDB

连接：

```bash
mongosh "$MONGO_URL"
```

只读探查：

```javascript
db.getCollectionNames()
db.orders.findOne()
db.orders.countDocuments({})
db.orders.find({}).limit(20)
```

## Hive

如果环境提供 Hive CLI 或 Beeline：

```bash
beeline -u "$HIVE_JDBC_URL" -n "$HIVE_USER" -p "$HIVE_PASSWORD"
```

只读探查：

```sql
SHOW DATABASES;
SHOW TABLES;
DESCRIBE formatted orders;
SELECT * FROM orders LIMIT 20;
```

## Platform Workload Token

如果当前 run 提供 `DB_WORKLOAD_TOKEN`，先通过平台接口换短期凭证，再用原生 CLI。每个 run 的 token 和短期凭证都会刷新，旧 run 的凭证不能复用。

需要的环境变量：

```bash
export DB_WORKLOAD_TOKEN="..."
export DATASOURCE_ID="ds_xxx"
export DATASOURCE_PROFILE="readonly"
export RUNFORGE_RUNTIME_API_BASE="http://localhost:8080/api/runtime"
```

直接调用接口：

```bash
curl -s -X POST "$RUNFORGE_RUNTIME_API_BASE/datasources/$DATASOURCE_ID/credentials" \
  -H "Authorization: Bearer $DB_WORKLOAD_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"profile\":\"${DATASOURCE_PROFILE:-readonly}\"}"
```

返回的 `username/password/host/port/database` 只用于本次 run，不写入仓库文件，不放进最终回答。

## SDK Files

Python:

```python
from db_credential import acquire_datasource_credential

credential = acquire_datasource_credential()
# 把 credential 立即传给数据库驱动或 CLI；不要 print 密码。
```

PostgreSQL CLI wrapper:

```bash
python3 /path/to/skill/scripts/psql_query.py --sql "select current_database(), current_user;"
```

这个 wrapper 会在同一进程内换取短期凭证并调用 `psql`，不要先单独打印完整凭证 JSON。

Node.js:

```javascript
import { acquireDatasourceCredential } from './dbCredential.mjs';

const credential = await acquireDatasourceCredential();
// 把 credential 立即传给数据库驱动或 CLI；不要 console.log 密码。
```

Shell:

```bash
source ./db_credential.sh
credential_json="$(db_credential_json)"
# 只在必要时传给后续命令；不要把 credential_json 写入日志。
```

## Safety Checks

- 默认只读；破坏性 SQL 必须用户明确要求。
- 所有明细查询加 `LIMIT`。
- 聚合优先于全量导出。
- 导出文件写到 workspace 的普通输出目录，不写入 skill 目录。
- 结果里脱敏 token、密码、私钥和完整连接串。
