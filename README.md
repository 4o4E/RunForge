# my-agent

`my-agent` 是一个通用 AI Agent 平台原型：用户提交自然语言任务后，后端启动一个自主 agent，在受控工作区中调用 LLM 和工具，循环执行直到完成，并把过程和结果实时展示在 Web 控制台。

项目目标不是做某个垂直领域助手，而是验证一套可扩展的 Cloud Agent Platform（云端 Agent 运行平台）基础能力：

- Agent 编排：围绕 `thread -> run -> step` 组织多轮任务和执行步骤。
- LLM 集成：支持 AI SDK、OpenAI Responses、OpenAI Chat、Anthropic 和离线 mock。
- 工具调用：内置 shell、文件读写/编辑、glob/grep、web 获取/搜索、用户提问、结构化 UI 渲染等工具。
- 执行可观测：通过 REST/WebSocket 输出 step、reasoning、tool_call、tool_result、final 等事件。
- 持久化：使用 PostgreSQL 保存 thread、run、step、message、event 和运行配置。
- 隔离基础：提供工具策略层和可选 bwrap shell 沙箱，为后续云端隔离执行打基础。

当前实现是 Node.js/TypeScript 后端 + React/Vite 前端的单体原型。它已经能完成端到端 agent 执行闭环，并支持服务启动后恢复中断 run；但还不是完整多 worker 云平台，队列调度、跨 worker 接管、多租户鉴权、资源配额等平台能力仍在路线图中。

## 从 0 部署指南

前置条件：

- Node.js >= 20
- pnpm 11.x
- PostgreSQL，或直接使用 `docker compose up -d`
- Linux 环境如需强制 bwrap 沙箱，需要提前安装 bubblewrap（常见包名为 `bubblewrap`）

### 1. 安装依赖

```bash
pnpm install
```

### 2. 准备数据库

推荐本地从 0 部署时直接使用仓库内 PostgreSQL：

```bash
docker compose up -d
```

这种方式对应的连接串是：

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/my_agent
```

如果接入已有 PostgreSQL，也可以使用同类连接串：

```bash
DATABASE_URL=postgres://<user>:<password>@localhost:5432/my_agent
```

已有库需要提前创建好用户和数据库，例如：

```bash
createdb my_agent
```

迁移会创建这些表：`threads`、`runs`、`steps`、`messages`、`events`、`app_settings`。其中 `app_settings` 保存运行时工具配置；保存过设置后，数据库里的值会优先于 env 默认值。

### 3. 配置 `.env`

```bash
cp .env.example .env
```

`.env` 必须是标准 `KEY=value` 或 `# 注释`，不要出现 `2# ...` 这类非注释前缀，否则用 shell 加载环境变量时会报错。

最小可运行配置：

```bash
PORT=8080
DATABASE_URL=postgres://postgres:postgres@localhost:5432/my_agent

LLM_PROVIDER=aisdk
LLM_AISDK_FLAVOR=openai-compatible
LLM_REASONING_TAG=think
LLM_BASE_URL=https://tokenhub.tencentmaas.com/v1
LLM_API_KEY=<your-api-key>
LLM_MODEL=deepseek-v4-pro-202606
LLM_MAX_TOKENS=4096
LLM_TIMEOUT_MS=120000

AGENT_HARD_STEP_CAP=1000

TOOL_SANDBOX=enforce
TOOL_SANDBOX_BACKEND=bwrap
TOOL_WORKSPACE_ROOT=/absolute/path/to/my-agent/workspace
TOOL_NETWORK=disabled
TOOL_MAX_OUTPUT=40000
```

当前开发和真实链路调试主要使用 DeepSeek V4 Pro，也就是 `LLM_MODEL=deepseek-v4-pro-202606`。代码保留 OpenAI、Anthropic、mock 等 provider 兼容路径，但本轮没有针对其他模型做专门提示词、参数或行为调优。

注意：旧配置 `AGENT_MAX_STEPS` 已不是当前代码读取项，请使用 `AGENT_HARD_STEP_CAP`。`TOOL_MAX_OUTPUT` 当前建议为 `40000`；即使数据库里旧值是 `100000`，运行时也会被代码限制到 40000。

### 4. 初始化数据库

```bash
pnpm db:migrate
```

如需确认表已创建：

```bash
psql "$DATABASE_URL" -c "\dt"
```

首次启动后，服务会把 env 中的工具默认配置补进 `app_settings`。当前开发库里这些 key 已存在：`tools.sandbox`、`tools.sandboxBackend`、`tools.workspaceRoot`、`tools.network`、`tools.maxOutput` 等；保存过设置后，数据库值会覆盖 env 默认值。如果要复现当前开发机的强沙箱配置，可在前端设置页保存 `sandbox=enforce`、`sandboxBackend=bwrap`、`workspaceRoot=<repo>/workspace`，并按任务需要决定是否开启网络。

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
- 最终输出默认使用 Markdown/Mermaid/LaTeX；复杂报告可写入 HTML artifact，再调用 `finish_conversation` 完成。
- 数据库中能查到对应 run、step、message 和 event。
- 人为降低 `LLM_CONTEXT_BUDGET` 时，可以观察到 `compaction` 事件。

离线运行可用于验证 API 和事件流，不代表真实模型效果：

```bash
cd server
STORE=memory LLM_PROVIDER=mock node --import tsx src/index.ts
```

测试：

```bash
pnpm --filter server test
pnpm --filter server typecheck
```

## 文档导航

- [系统设计](docs/system-design.md)：总体架构、执行主线、对话模型、Provider、Store、API、数据模型。
- [长任务设计](docs/long-task-design.md)：Goal 锚点、上下文压缩、token 预算、取消与长任务验证链路。
- [工具沙箱设计](docs/tool-sandbox.md)：工具权限、bwrap 沙箱选型、读写范围与命令限制。
- [Skill 系统设计](docs/skill-system-design.md)：内置/用户 skill、bash 资源暴露、allowed-tools、激活生命周期和安全边界。
- [题面验收报告](docs/acceptance-report.md)：当前完成范围、未实现边界和后续平台化设计。
- [架构改造方案](docs/refactor-plan.md)：AI SDK、AI Elements、Streamdown、HTML artifact、可观测和沙箱路线。
- [实施日志](docs/impl-log/)：各阶段落地记录、验证结果和遗留事项。
- [.env.example](.env.example)：本地环境变量模板。

## 项目结构

```text
my-agent/
├── server/              # Node.js / TypeScript 后端
├── web/                 # React / Vite 前端控制台
├── docs/                # 设计文档与实施日志
├── scripts/             # Linux 启停脚本
├── workspace/           # 默认工作区
├── docker-compose.yml   # 本地 PostgreSQL
└── package.json         # pnpm workspace 根配置
```

## License

MIT
