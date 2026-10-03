# CI 与真实验收分层

## 每次拉取请求和分支推送

`.github/workflows/ci.yml` 执行两类验证：

- 构建与单元测试：`pnpm build` 检查并构建 contracts、workload SDK、server 和 web；随后 `pnpm test:ci` 直接运行 workload SDK、server 和 web 的单元测试，不重复构建已准备好的包。开发者本机仍可运行 `pnpm test`，该命令会自行构建测试依赖并生成 Prisma Client。`pnpm build` 已执行所有包的 TypeScript 编译，因此 CI 不再重复运行耗时相同的 `pnpm typecheck`。
- PostgreSQL 集成：使用本次作业创建的 PostgreSQL 16 临时数据库执行迁移和启动引导，再运行真实 PostgreSQL HTTP 用例 `api/system.postgres.test.ts`、`verify:prisma-store`、`verify:space-runtime`、`verify:step-history` 和 `verify:shell-shutdown`。

数据库集成会调用真实 `PgStore`、Prisma、迁移和应用服务，不使用本机历史数据，也不连接生产或开发数据库。`prismaStoreVerification` 与 `spaceRuntimeVerification` 中的 provider fetch 响应是本地确定性协议输入，用于验证请求适配、数据库持久化和服务边界；它们不是实际模型调用，也不代表模型质量、供应商连通性或完整浏览器链路通过。`stepHistoryVerification` 不调用模型，直接使用真实 PostgreSQL 检验 step 权威数据、上下文观测隔离、祖先工具恢复、消息索引、跨租户隔离及 fork 元数据。

在本机复跑 PostgreSQL 集成验证时，先连接专用测试数据库，并从仓库根目录执行：

```bash
pnpm --filter @runforge/contracts build
pnpm --filter @runforge/workload-sdk build
pnpm --filter server prisma:generate
bash scripts/ci/postgres-integration.sh
```

`DATABASE_URL` 必须指向一次性测试数据库。验证脚本会创建并清理自己生成的租户和 thread；不要将个人历史数据或生产数据库用于该命令。

## 关键业务覆盖

| 关键业务 | 自动化覆盖入口 | 覆盖边界 |
| --- | --- | --- |
| 租户、身份与权限 | `server` 的 `auth`、`tenants`、`authRoutes`、`api/system.test.ts` 单元测试；`api/system.postgres.test.ts`、`verify:prisma-store` PostgreSQL 集成 | 系统设置与租户授权用真实 PgStore、真实 HTTP 路由和系统数据源目录验证；PG 同时验证实际关系约束与存储行为 |
| 空间配置与隔离 | `spaces/config`、`spaces/access` 单元测试；`verify:prisma-store`、`verify:space-runtime` | 空间设置使用确定性协议响应；不代表真实供应商调用 |
| 业务插件 | `businessPlugins/registry`、`api/businessPluginImport` 单元测试 | 校验协议、导入和清理边界，不启动真实浏览器 |
| Workload SDK | `packages/workload-sdk` 的 `test:unit` | Node 单元测试，不调用外部服务 |
| 外部 next_step | `external/service` 单元测试；`verify:space-runtime` PostgreSQL 集成 | 集成 provider 使用本地协议响应，仅验证输入接收和持久化 |
| 附件与文件路径 | `fileRead.media`、`fileSearch.pathSecurity`、workspace 单元测试 | 需要真实 `ffmpeg` 与 `ripgrep`；快速 CI 会显式安装系统依赖 |
| Agent 工具与压缩 | `executor`、`compaction` 单元测试；step-history PostgreSQL 集成 | 纯逻辑与真实存储分层覆盖；真实模型行为另行验收 |
| Step 历史与恢复 | `api/historyReplay`、Web history adapter 单元测试；`verify:step-history` PostgreSQL 集成 | 覆盖游标选择、step 权威正文、祖先工具结果恢复、fork 和上下文隔离 |
| Trace 写入与保留 | `observability/runTrace.test.ts`；PostgreSQL 集成中的 provider attempt 检查 | 真实文件与进程验证自动重试、全局容量、超限告警、部分写入恢复、跨日保留和 SIGTERM 排空；部分写入使用 Linux `util-linux` 的 `prlimit`，不调用模型 |
| Shell 正常关闭 | `verify:shell-shutdown` PostgreSQL/真实进程集成 | 启动、输出、终止和 trace 收口都使用真实本机子进程，不调用外部模型 |

普通 CI 不伪造真实模型、浏览器或供应商成功。涉及完整 WebSocket 与浏览器交互时执行真实界面验收；纯消息游标、历史转换和 step 归属则由单元与 PostgreSQL 测试覆盖。

## 发布镜像

容器发布工作流先调用同一个 `ci.yml` 验证，再构建镜像并运行 `scripts/verify-container.sh`。容器验证覆盖自带 PostgreSQL 与外部 PostgreSQL 的启动、健康接口和静态页面入口；它不运行浏览器，也不执行真实模型对话。

## 真实模型与浏览器验收

`pnpm --filter server verify:agent-core` 使用数据库中配置的真实系统模型供应商，会产生外部模型费用并依赖有效凭证。它不属于每次拉取请求的必跑项。执行前需要在隔离测试环境配置供应商协议、API 地址、模型名称、模型能力参数和 API 凭证；凭证仅通过运行时安全配置提供，不写入 Git、测试报告或固定测试文件。未运行该验证时，CI 只表明代码、单元测试和 PostgreSQL 集成项目通过，不代表真实模型验证通过。

完整浏览器交互需要实际启动应用、实际浏览器和真实模型服务；普通单元测试不启动浏览器，CI 也不以 fixture、拦截请求或假模型结果冒充此链路。修改涉及的用户界面或模型交互时，另行执行真实环境验收并记录实际结果。未来如加入手动 live workflow，必须明确要求安全保存的供应商配置；凭证缺失时应直接失败并说明缺少配置，不能跳过后报告全链路通过。
