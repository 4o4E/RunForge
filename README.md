# RunForge

RunForge 是面向 Web 用户和外部应用的通用 AI Agent 运行平台。用户提交任务后，Agent 在受控会话工作区中调用模型和工具，完成多步执行；控制台实时展示过程、文件和结果，并保存可恢复的任务历史。

平台以 `tenant → space → thread → run → step` 组织身份、配置、会话和执行：

- **多租户与空间**：账号登录、角色权限、系统资源授权，Web 对话空间与外部应用空间分别管理。
- **模型接入**：通过 AI SDK 支持 OpenAI Responses、OpenAI Chat Completions、Anthropic Messages；按空间选择模型与上下文预算。
- **长任务执行**：计划、上下文压缩、取消、服务重启恢复，以及托管 Shell 和异步子任务。
- **能力扩展**：原生文件、Shell 与 Web 工具，按运行激活 Skill/MCP，通过租户业务插件和 Workload SDK 接入业务能力。
- **文件与多模态**：会话文件管理、图片、PDF、Office、音频和视频读取，以及 Markdown、Mermaid、LaTeX 和 HTML 文件预览。
- **运行记录**：REST/WebSocket 实时输出，PostgreSQL 保存任务与 step 聚合，按运行保存本地 trace，提供 Token 与存储用量分析。
- **Linux Shell 保护**：使用 bwrap 保护只读运行资源，管理员可以选择容器范围访问或完整会话隔离。

当前采用 Node.js/TypeScript 后端、React/Vite 前端和 PostgreSQL，部署为单个活动服务实例。多 worker 调度、跨实例接管、每次运行独立工作区、CPU/内存/磁盘配额和跨会话 Gene Memory 尚未实现。本文与 [OpenSpec](openspec/README.md) 描述当前源码，不代表本机或生产实例已经更新；发布内容以 [GitHub Release](https://github.com/4o4E/RunForge/releases) 为准。

## 界面展示

截图取自本机运行实例，文件预览使用已有示例文件，账号信息已隐藏。点击图片可查看原图。

### 对话与文件预览

在同一页面查看任务过程、模型回复、工作区文件和文档预览，无需离开对话切换文件查看工具。

[![RunForge 对话、任务过程与 Markdown 文件预览](docs/images/conversation-files.png)](docs/images/conversation-files.png)

### 空间与业务插件

按空间管理 Web 对话或外部运行模式、执行用户、默认模型和已启用的业务插件。

[![RunForge 空间管理与业务插件概览](docs/images/space-management.png)](docs/images/space-management.png)

### 用量分析

按时间、用户和空间筛选模型用量，查看有效 Token、尝试 Token、缓存输入与每日变化。

[![RunForge 模型用量汇总与每日 Token 图表](docs/images/usage-analytics.png)](docs/images/usage-analytics.png)

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
`.env.docker` 保存当前 Compose 使用的数据库密钥、签名密钥和初始账号密码；需要平台音频转写时，
还可按模板配置 OpenAI 兼容转写服务的地址、模型和密钥。LLM Provider 在服务启动后由系统管理员
写入系统设置，再授权给租户使用。镜像版本、端口、工具参数及其他外部服务地址直接在对应 Compose
文件中修改。`runforge-workspaces`、`runforge-user-files`、`runforge-business-plugins` 和
`runforge-traces` 分别保存会话文件、用户跨会话文件、业务插件和按 run 分隔的本地 trace；自带 PostgreSQL
的版本额外使用 `runforge-postgres` 卷保存数据库。

已有部署的 `runforge-provider-traces` 卷保留原有日志，升级不会自动搬移或删除该卷。
升级后的日志写入 `runforge-traces`；旧日志文件不参与历史对话展示和任务恢复。

业务插件可以直接写入 `runforge-business-plugins` 卷内的 `/app/business-plugins`，也可以在
Compose 中为该目录增加只读 bind mount。Office 转换服务地址也直接写入 Compose。

已有部署从合并数据目录切换到独立挂载时，参照
[工作区存储迁移](docs/workspace-storage-migration.md)。

发布流程接受 `v*.*.*` tag。它会构建 `linux/amd64` 镜像，推送版本标签与 `latest`，验证匿名
拉取，并创建带两套 Compose 和环境变量模板的 GitHub Release。

## 首次使用

1. 打开部署地址，选择租户，使用引导 owner 账号 `admin@local` 登录。系统管理员入口为 `/sys-admin`，账号为 `sysadmin@local`；两者初始密码分别由部署模板中的引导密码配置指定。
2. 系统管理员在“系统设置”配置模型供应商、协议、模型能力和凭证，再在“租户授权”中授予租户可用模型与数据源。
3. 租户管理员在“空间”中设置可见成员、允许模型、默认模型、提示词和业务插件。普通用户进入有权限的 Web 空间后创建对话、发送任务。
4. 对话页面查看实时输出、计划和资源面板；文件面板用于上传、下载与预览，Shell 面板用于观察托管命令，子任务面板用于查看异步结果。
5. 外部应用使用 external 空间，由管理员选择执行用户并签发调用方 Token；接入协议见[空间与外部运行](docs/space-runtime-design.md#5-外部协议)。Web 可见成员只能查看内容，租户管理员另可管理共享对话状态。

首次启动后及时修改初始密码。对外提供服务时使用 HTTPS/WSS，并避免访问日志记录外部调用方秘密入口。身份、租户权限、Shell 访问范围分别承担不同边界；容器范围访问不等于完整会话隔离。

## 源代码部署

前置条件：

- Node.js >= 24
- pnpm 11.x
- PostgreSQL，或使用仓库内 Compose 单独启动开发数据库
- Linux 执行 Shell 必须安装 bubblewrap（常见包名为 `bubblewrap`），并允许创建所需 namespace；容器安全配置见 [部署说明](deploy/security/README.md)。

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

Prisma 7 migration 会创建核心执行表：`threads`、`runs`、`steps`、`messages`、`app_settings`，以及 `subagent_runs`、`shell_sessions`、`shell_commands`、`shell_command_logs`、`shell_session_events` 和数据源账号池相关表。`steps.result` 保存一次模型请求完成后的聚合输出；原始流式事件只写本地 trace。`app_settings` 保存系统资源配置、租户资源授权和租户内业务插件配置。

### 3. 配置 `.env`

```bash
cp .env.example .env
```

`.env` 必须是标准 `KEY=value` 或 `# 注释`，不要出现 `2# ...` 这类非注释前缀，否则用 shell 加载环境变量时会报错。

最小可运行配置：

```bash
PORT=8080
RUNFORGE_JWT_SECRET=<strong-jwt-signing-secret>
RUNFORGE_BOOTSTRAP_ADMIN_PASSWORD=<strong-owner-password>
RUNFORGE_BOOTSTRAP_SYSADMIN_PASSWORD=<strong-system-admin-password>
RUNFORGE_SHARE_SECRET=<strong-share-secret>
DATABASE_URL=postgres://postgres:postgres@localhost:5432/runforge

AGENT_HARD_STEP_CAP=1000

TOOL_SANDBOX=enforce
TOOL_SANDBOX_BACKEND=bwrap
SHELL_USE_HOST_PATH=false
TOOL_WORKSPACE_ROOT=/absolute/path/to/RunForge/workspace
TOOL_NETWORK=disabled
TOOL_MAX_OUTPUT=40000

# 可选: Office 文件预览。填 Gotenberg/LibreOffice 转换服务地址。
OFFICE_PREVIEW_CONVERTER_URL=http://127.0.0.1:3002
```

Web 用户登录后使用 JWT access token 和 refresh token；脚本可以使用用户 API token。REST 通过 `Authorization: Bearer <token>` 传递身份，WebSocket 使用 `Sec-WebSocket-Protocol` 中的 `runforge-token.<base64url-token>`，不把登录 token 放入 URL。`RUNFORGE_ACCESS_TOKEN` 仅用于旧部署在启动时注册引导 owner 的 API token，全新部署不需要配置。`RUNFORGE_SHARE_SECRET` 用于文件分享签名；签名链接仅授权指定作用域内的同一文件读取或预览，不授权目录浏览、设置或任务执行。

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

升级到 step 聚合存储前，先备份数据库并停止旧版服务，避免迁移期间继续写入事件。
使用 `pnpm db:migrate` 或镜像启动入口执行升级：入口会先从旧消息、事件和 Provider
响应聚合历史 step 与运行元数据，校验归档后再删除旧事件表和原始流字段。
不要绕过入口直接执行 Prisma migration，否则无法在删除旧表前保存迁移所需的数据。

从 0.5.x 升级到 0.6.0 时还需要调整工作区基础目录，完整步骤见
[升级到 0.6.0](docs/upgrade-0.6.0.md)。

如需确认表已创建：

```bash
psql "$DATABASE_URL" -c "\dt"
```

首次启动后,服务会把工具策略默认配置补进系统 `app_settings`，包括 `tools.sandbox`、
`tools.sandboxBackend`、`tools.network` 和 `tools.maxOutput` 等。工作区基础目录只读取
`TOOL_WORKSPACE_ROOT`，不会写入数据库；所有空间统一派生为
`<TOOL_WORKSPACE_ROOT>/<spaceId>/c/<threadId>`。生产 Compose 把会话工作区挂载到 `/w`，
把用户跨会话文件单独挂载到 `/u`；用户文件路径为 `/u/<userId>`，不从旧目录迁移。

系统管理员在 `/sys-admin/settings/tools-sandbox` 独立配置工具策略与 Shell 访问范围，并维护 Python（pip / uv）与 Node（npm / pnpm）镜像源。默认使用清华 PyPI 镜像和 npmmirror；保存后随后启动的命令立即使用新值，已运行进程不变。两种 Linux 访问范围都通过 bwrap 保护插件、Skill 和 SDK；缺失或不可用时明确失败。完整边界及图片多模态输入限制见 [工具沙箱设计](docs/tool-sandbox.md)。

配置可能包含凭证，不要把完整 `app_settings` 查询结果写入日志或交付资料。通过管理页面检查已保存配置。

### 5. 启动服务

在已安装 Linux 工具依赖的环境中，先构建再启动后端：

```bash
pnpm build
pnpm start:server
```

另开终端执行 `pnpm dev:web`，启动带 API/WebSocket 代理的 Vite 开发页面。后端运行时从仓库根目录 `.env` 加载配置。需要由后端直接提供已构建前端时，在启动后端前把 `RUNFORGE_WEB_DIST` 设置为 `web/dist` 的绝对路径，此时使用后端端口访问统一页面。

当前工作站使用 Docker 开发容器；准备条件、构建与启停方式只记录在不入库的 `AGENTS.local.md`。生产环境使用 `deploy/` 下的 Compose；`pnpm` 不负责容器启停。

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
- 最终输出默认使用 Markdown/Mermaid/LaTeX；复杂报告可通过 shell 或文件写入工具生成 HTML artifact。最终回复结束运行时，计划继续保留真实未完成或失败状态。
- 数据库中能查到对应 run、完整 step 聚合和消息顺序索引；原始事件在 trace 文件中查看。
- 人为降低 `LLM_CONTEXT_BUDGET` 时，可以观察到 `compaction` 事件。

测试：

```bash
pnpm --filter server test
pnpm typecheck
```

PostgreSQL 集成、真实模型和浏览器验收的环境条件与覆盖范围见 [CI 与真实验收分层](docs/testing/ci-and-verification.md)。数据库验证使用专用测试库；真实模型验收会产生费用。单元测试成功不代表真实模型、浏览器或已部署实例验收成功。

## 开发规范与项目级 skills

- [OpenSpec 入口](openspec/README.md)：现有行为规格、变更提案、架构决定、实施任务与归档。
- [开发技能配置](docs/agents/README.md)：来自 `4o4E/skills` 的项目级工程技能、GitHub Issues 与 OpenSpec 的职责，以及更新方式。
- [领域术语](GLOSSARY.md)：会话、任务、空间与用量的统一名称。

开发助手的 skills 保存在源码仓库 `.agents/skills/`；它们服务于 RunForge 的开发过程。运行中的 Agent 只使用平台内置和空间选中的业务 Skill，不扫描源码仓库的开发技能目录。

## 文档导航

- [系统设计](docs/system-design.md)：总体架构、执行主线、对话模型、Provider、Store、API、数据模型。
- [长任务设计](docs/long-task-design.md)：Goal 锚点、上下文压缩、token 预算、取消与长任务验证链路。
- [托管 Shell 资源设计](docs/background-shell-design.md)：shell session、前台/后台命令、轮询、接管和跨 run 生命周期。
- [工具沙箱设计](docs/tool-sandbox.md)：工具权限、bwrap 沙箱选型、读写范围与命令限制。
- [Skill 系统设计](docs/skill-system-design.md)：当前 Skill 文件协议、空间只读资源、运行级激活生命周期和安全边界。
- [Subagent 与 Gene Memory 设计](docs/subagent-memory-design.md)：当前 runtime profile、工具授权与共享工作区，以及后续 gene 读写、RAG 召回、经验提升和退化设计。
- [能力与验收边界](docs/acceptance-report.md)：当前源码能力、尚未实现的范围与验证入口。
- [架构改造方案](docs/refactor-plan.md)：早期方案，当前行为以 OpenSpec 和现行专题为准。
- [实施日志](docs/impl-log/)：各阶段实施记录和验证证据，不替代现行规格。
- [.env.example](.env.example)：本地环境变量模板。

## 项目结构

| 路径 | 职责 |
| --- | --- |
| `server/` | Node.js/TypeScript 后端、Prisma migration、内置 Skill |
| `web/` | React/Vite 控制台 |
| `packages/contracts/` | 前后端共享契约 |
| `packages/workload-sdk/` | 运行中可信脚本使用的资源 SDK |
| `plugins/business/` | 仓库维护的业务插件源码 |
| `openspec/` | 行为规格、变更方案与架构决定 |
| `.agents/skills/` | 开发助手使用的项目级 skills |
| `docs/` | 使用、协议、架构说明与验证指南 |
| `deploy/`、`docker/` | 生产 Compose、安全配置和镜像入口 |
| `scripts/` | CI 与容器验证脚本 |
| `workspace/` | 非生产配置下的默认会话文件根目录 |
| `docker-compose.yml` | 源代码开发使用的 PostgreSQL |

## License

MIT
