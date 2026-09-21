# RunForge

`RunForge` 是一个通用 AI Agent 平台原型：用户提交自然语言任务后，后端启动一个自主 agent，在受控工作区中调用 LLM 和工具，循环执行直到完成，并把过程和结果实时展示在 Web 控制台。

项目目标不是做某个垂直领域助手，而是验证一套可扩展的 Cloud Agent Platform（云端 Agent 运行平台）基础能力：

- Agent 编排：围绕 `thread -> run -> step` 组织多轮任务和执行步骤。
- LLM 集成：通过 AI SDK 支持 OpenAI Responses、OpenAI Chat Completions 和 Anthropic Messages 三种协议。
- 工具调用：原生工具默认加载；Skill 与 MCP 按 run 激活，另有 shell、文件读写、web、workflow、subagent 等能力。
- 执行可观测：通过 REST/WebSocket 输出 step、reasoning、tool_call、tool_result、subagent、shell、final 等事件。
- 持久化：使用 PostgreSQL 保存 thread、run、step、message、event、shell session、subagent run 和运行配置。
- 隔离基础：提供工具策略层和可选 bwrap shell 沙箱，为后续云端隔离执行打基础。

当前实现是 Node.js/TypeScript 后端 + React/Vite 前端的单实例通用 Agent 运行平台。它已经能完成端到端 Agent 执行闭环，并支持多租户身份与数据隔离、租户空间配置、外部调用入口、服务启动后恢复中断 run、托管 shell 长耗时命令、Skill 渐进加载和异步只读 subagent。队列调度、跨 worker 接管、per-run 工作区、资源配额和跨 thread memory 等多 worker 平台能力仍在路线图中。

## Docker 部署

发布镜像为 `ghcr.io/4o4e/runforge`。镜像同时包含 React 前端和 Node.js 后端，容器启动时会
先执行所有尚未应用的 Prisma migration，再启动 HTTP 和 WebSocket 服务。

使用自带 PostgreSQL 时，复制对应的密钥模板并替换所有 `replace-with-...` 值：

```bash
cp deploy/.env.postgres.example .env.docker
```

使用自带 PostgreSQL 的 Compose：

```bash
docker compose --env-file .env.docker -f deploy/compose.postgres.yml up -d
```

使用外部 PostgreSQL 时，复制只包含外部连接串和 RunForge 密钥的模板：

```bash
cp deploy/.env.external-postgres.example .env.docker
```

然后启动应用容器：

```bash
docker compose --env-file .env.docker -f deploy/compose.external-postgres.yml up -d
```

两套 Compose 都在 `http://localhost:8080` 提供 Web 控制台、REST API 和 WebSocket。
`.env.docker` 只保存当前 Compose 实际使用的数据库密钥、签名密钥和初始账号密码。LLM
Provider 在服务启动后由系统管理员写入系统设置,再授权给租户使用。镜像版本、端口、工具参数及外部服务地址直接在
对应 Compose 文件中修改。`runforge-workspaces`、`runforge-business-plugins` 和
`runforge-provider-traces` 分别保存会话文件、业务插件和 Provider 观测记录；自带 PostgreSQL
的版本额外使用 `runforge-postgres` 卷保存数据库。

业务插件可以直接写入 `runforge-business-plugins` 卷内的 `/app/business-plugins`，也可以在
Compose 中为该目录增加只读 bind mount。Office 转换服务地址也直接写入 Compose。

已有部署从合并数据目录切换到独立挂载时，参照
[工作区存储迁移](docs/workspace-storage-migration.md)。

发布流程接受 `v*.*.*` tag。它会构建 `linux/amd64` 镜像，推送版本标签与 `latest`，验证匿名
拉取，并创建带两套 Compose 和环境变量模板的 GitHub Release。

## 源代码部署

前置条件：

- Node.js >= 24
- pnpm 11.x
- PostgreSQL，或使用仓库内 Compose 单独启动开发数据库
- Linux 环境如需强制 bwrap 沙箱，需要提前安装 bubblewrap（常见包名为 `bubblewrap`）

### 1. 安装依赖

```bash
pnpm install
```

### 2. 准备数据库

推荐本地从 0 部署时直接使用仓库内 PostgreSQL：

```bash
docker compose up -d postgres
```

这种方式对应的连接串是：

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/runforge
```

如果接入已有 PostgreSQL，也可以使用同类连接串：

```bash
DATABASE_URL=postgres://<user>:<password>@localhost:5432/runforge
```

已有库需要提前创建好用户和数据库，例如：

```bash
createdb runforge
```

Prisma 7 migration 会创建核心执行表：`threads`、`runs`、`steps`、`messages`、`events`、`app_settings`，以及 `subagent_runs`、`shell_sessions`、`shell_commands`、`shell_command_logs`、`shell_session_events` 和数据源账号池相关表。`app_settings` 保存系统资源配置、租户资源授权和租户内业务插件配置。

### 3. 配置 `.env`

```bash
cp .env.example .env
```

`.env` 必须是标准 `KEY=value` 或 `# 注释`，不要出现 `2# ...` 这类非注释前缀，否则用 shell 加载环境变量时会报错。

最小可运行配置：

```bash
PORT=8080
RUNFORGE_ACCESS_TOKEN=<strong-access-token>
RUNFORGE_SHARE_SECRET=<strong-share-secret>
DATABASE_URL=postgres://postgres:postgres@localhost:5432/runforge

AGENT_HARD_STEP_CAP=1000

TOOL_SANDBOX=enforce
TOOL_SANDBOX_BACKEND=bwrap
TOOL_WORKSPACE_ROOT=/absolute/path/to/RunForge/workspace
TOOL_NETWORK=disabled
TOOL_MAX_OUTPUT=40000

# 可选: Office 文件预览。填 Gotenberg/LibreOffice 转换服务地址。
OFFICE_PREVIEW_CONVERTER_URL=http://127.0.0.1:3002
```

`RUNFORGE_ACCESS_TOKEN` 用来保护后端 `/api/**` 和 `/ws`，前端只通过 `Authorization: Bearer <token>` Header 发送，不放 Cookie，也不放 URL。`RUNFORGE_SHARE_SECRET` 用来生成文件分享签名；分享链接只允许访问同一个文件的读取/预览接口，不能浏览目录、访问设置或操作 agent。

Office 预览走后端转换：`doc/docx/ppt/pptx/xls/xlsx` 等文件先通过 `OFFICE_PREVIEW_CONVERTER_URL` 指向的 LibreOffice 转换服务生成 PDF，前端再用 PDF.js 只读渲染。RunForge 后端和转换服务在同一个 Docker 网络时，建议填服务名地址；如果转换服务单独绑定在宿主机端口，再填宿主机可访问地址。转换容器需要按部署环境挂载常用中英文字体，否则 LibreOffice 可能因字体替换产生版式偏移；字体目录或转换服务镜像变更后，递增 `OFFICE_PREVIEW_CACHE_VERSION` 可让旧 PDF 预览缓存自动失效。

服务启动后,系统管理员在 `/sys-admin/settings/*` 统一配置 LLM 供应商、运行时能力、MCP、Shell/沙箱和数据源,再到 `/sys-admin/tenant-access` 为租户授权可用的 LLM 供应商和数据源。`/sys-admin/tenants/:tenantId/*` 只管理该租户的用户、空间和业务插件。每个 LLM 供应商直接选择
`OpenAI Responses`、`OpenAI Chat Completions` 或 `Anthropic Messages` 协议。模型名称匹配本地
能力目录时会自动填写上下文窗口、输入类型和资料来源；未匹配时必须由管理员填写后才能保存。
LLM API Key 保存在系统资源配置中,租户授权和空间配置只保存资源 ID。

注意：旧配置 `AGENT_MAX_STEPS` 已不是当前代码读取项，请使用 `AGENT_HARD_STEP_CAP`。`TOOL_MAX_OUTPUT` 当前建议为 `40000`；即使数据库里旧值是 `100000`，运行时也会被代码限制到 40000。

### 4. 初始化数据库

```bash
pnpm db:migrate
```

上面的命令适用于全新数据库。若数据库已经由旧版 `schema.sql` 创建过完整表结构、但还没有
`_prisma_migrations` 记录，首次升级时应先把等价的 Prisma baseline 登记为已执行，再部署后续
migration：

```bash
pnpm --filter server db:baseline
pnpm db:migrate
```

`db:baseline` 只用于已有完整旧结构的数据库，不能用于空库，否则会登记成功但不会创建表。
可用 `pnpm --filter server db:status` 检查 migration 状态。

从 0.5.x 升级到 0.6.0 时还需要调整工作区基础目录，完整步骤见
[升级到 0.6.0](docs/upgrade-0.6.0.md)。

如需确认表已创建：

```bash
psql "$DATABASE_URL" -c "\dt"
```

首次启动后,服务会把工具策略默认配置补进系统 `app_settings`，包括 `tools.sandbox`、
`tools.sandboxBackend`、`tools.network` 和 `tools.maxOutput` 等。工作区基础目录只读取
`TOOL_WORKSPACE_ROOT`，不会写入数据库；所有空间统一派生为
`<TOOL_WORKSPACE_ROOT>/<spaceId>/<threadId>`。生产 Compose 直接把工作区卷挂载到 `/w`。

```bash
psql "$DATABASE_URL" -c "select key, value from app_settings order by key;"
```

### 5. 启动服务

开发模式：

```bash
pnpm dev
```

Linux 开发机也可用脚本管理前后端进程：

```bash
pnpm run start
pnpm run stop
pnpm run restart
```

访问入口：

- Web 控制台：`http://localhost:3000`
- 后端 API：`http://localhost:8080`
- WebSocket：`ws://localhost:8080/ws?runId=<id>`

### 6. 验证链路

推荐验收任务：

```text
读取当前仓库，找出 TODO 中仍未完成的事项，并结合 README 和 docs 生成一份简短验收报告。要求说明已完成、未完成和后续计划。
```

验收观察点：

- 前端能看到多轮 step、reasoning、tool_call、tool_result 和 final。
- 任务过程会使用文件读取、grep 或 shell 等工具。
- 长耗时命令可以走右侧 Shell 面板持续观察；适合拆分的只读检查可以由 subagent 后台执行并回收结果。
- 最终输出默认使用 Markdown/Mermaid/LaTeX；复杂报告可通过 shell 或文件写入工具生成 HTML artifact，计划收口后直接以最终汇报完成。
- 数据库中能查到对应 run、step、message 和 event。
- 人为降低 `LLM_CONTEXT_BUDGET` 时，可以观察到 `compaction` 事件。

测试：

```bash
pnpm --filter server test
pnpm --filter server typecheck
```

## 文档导航

- [系统设计](docs/system-design.md)：总体架构、执行主线、对话模型、Provider、Store、API、数据模型。
- [长任务设计](docs/long-task-design.md)：Goal 锚点、上下文压缩、token 预算、取消与长任务验证链路。
- [托管 Shell 资源设计](docs/background-shell-design.md)：shell session、前台/后台命令、轮询、接管和跨 run 生命周期。
- [工具沙箱设计](docs/tool-sandbox.md)：工具权限、bwrap 沙箱选型、读写范围与命令限制。
- [Skill 系统设计](docs/skill-system-design.md)：当前 skill 文件协议、内置/用户 skill、bash 资源暴露、run 级激活生命周期和安全边界。
- [Subagent 与 Gene Memory 设计](docs/subagent-memory-design.md)：当前 subagent v1 协作语义，以及后续 runtime profile、gene 读写、RAG 召回、经验提升和退化流程。
- [题面验收报告](docs/acceptance-report.md)：当前完成范围、未实现边界和后续平台化设计。
- [架构改造方案](docs/refactor-plan.md)：AI SDK、AI Elements、Streamdown、HTML artifact、可观测和沙箱路线。
- [实施日志](docs/impl-log/)：各阶段落地记录、验证结果和遗留事项。
- [.env.example](.env.example)：本地环境变量模板。

## 项目结构

```text
RunForge/
├── server/              # Node.js / TypeScript 后端
├── web/                 # React / Vite 前端控制台
├── docs/                # 设计文档与实施日志
├── deploy/              # 自带 PostgreSQL 与外部 PostgreSQL 的生产 Compose
├── docker/              # 容器启动脚本
├── scripts/             # Linux 启停脚本
├── workspace/           # 默认工作区
├── Dockerfile           # 前后端单镜像构建
├── docker-compose.yml   # 源代码开发使用的 PostgreSQL
└── package.json         # pnpm workspace 根配置
```

## License

MIT
