# 数据源账号池设计

目标：脚本只持有本次 run 的统一 `workload token`，用它按需获取 tenant Secret、数据库
短期只读账号和 LLM 代理等系统资源，不接触数据库长期管理凭证。

## 当前实现

- `workload token` 每次 run 签发，表里只保存 hash。
- 同一 run 同时只有一个活动 token；显式轮换会撤销旧 token，等待用户期间也视为失效，
  恢复执行后重新签发。
- 同一 run 的业务 Skill 共用该 token，不存在插件级 token；插件 Secret 声明是配置元数据，
  不是 key 级授权名单。
- 数据源按 `datasource + permission profile` 维护账号池。
- 一个池账号同一时间只租给一个 run。
- 租出前重置密码；回收时锁定账号或改废密码。
- 池子没有 idle 账号时，在 `maxPoolSize` 内动态扩容。
- 后台 reconciler 会回收过期租约和已结束 run 的租约。
- 当前已实现 PostgreSQL 账号管理适配器；MySQL、MongoDB、Hive 已预留类型，适配器后续补。
- run 终态或进入等待时主动撤销 token、释放租约；reconciler 只作异常退出兜底。

## API 流程

创建数据源：

```bash
curl -X POST http://localhost:8080/api/datasources \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "sales-pg",
    "type": "postgres",
    "connection": {
      "host": "db.example.com",
      "port": 5432,
      "database": "sales"
    },
    "adminConfig": {
      "connectionUrl": "postgres://agent_admin:***@db.example.com:5432/sales"
    },
    "poolConfig": {
      "maxPoolSize": 20,
      "leaseTtlSeconds": 1800
    }
  }'
```

创建权限档位：

```bash
curl -X POST http://localhost:8080/api/datasources/<datasource_id>/profiles \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "readonly",
    "mode": "readonly",
    "templateRole": "sales_readonly"
  }'
```

正常执行时 RunForge 会在 run 启动时自动签发唯一的活动 workload token，并注入运行环境；
不会按 Skill 或业务插件分别签发，也不对租户用户或外部调用方暴露 token 签发接口。

容器脚本换取短期数据库凭证：

```bash
curl -X POST http://localhost:8080/api/runtime/datasources/<datasource_id>/credentials \
  -H "Authorization: Bearer $WORKLOAD_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{ "profile": "readonly" }'
```

脚本用返回的 `username/password/host/port/database` 调原生 CLI：

```bash
psql "postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
```

run 完成、失败、取消或进入等待时，由 executor 在服务端直接撤销 token 并释放租约；调用方
不负责手工释放。

## PostgreSQL 业务方准备

业务方不要给平台 root/superuser。建议提供一个受限管理账号，只能管理 agent 池账号，并准备模板角色：

```sql
CREATE ROLE sales_readonly;
GRANT CONNECT ON DATABASE sales TO sales_readonly;
GRANT USAGE ON SCHEMA public TO sales_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO sales_readonly;

CREATE ROLE agent_admin CREATEROLE LOGIN PASSWORD '...';
GRANT sales_readonly TO agent_admin WITH ADMIN OPTION;
```

生产环境还应限制业务库入口 IP，只允许平台固定出口访问。

## 边界

- 这不是数据库协议代理；脚本拿到的是短期数据库凭证。
- 凭证仍可能在 run 内被脚本泄露，所以必须叠加短 TTL、最小权限、固定出口 IP 和日志脱敏。
- 表/列/行权限最终应由数据库原生权限兜底，平台账号池只负责租赁、改密、审计和回收。
- Hive 场景不建议按 run 创建用户，后续应接 Ranger/Knox/Kerberos 体系。
