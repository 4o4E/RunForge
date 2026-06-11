# my-agent

一个**通用 AI Agent** 平台：Node.js / TypeScript 后端 + React Web 控制台。

参考 [corint-cognition](../corint-cognition) 的架构思想，但做了三点简化：

- **后端用 Node/TypeScript 替代 Rust**
- **数据库直接用 PostgreSQL**（不再支持 SQLite）
- **不区分 gateway 与 runtime**，合并为单体服务（Agent 执行循环在进程内直接运行）

目标是一个**领域无关**的通用 Agent，而非金融风控特化版本。

---

## 系统能做什么

- 通过一个 **Agent 执行循环**（plan → 调用工具 → 观察 → 继续）完成多步任务
- 支持**多 LLM provider**，默认使用 **OpenAI Responses API（新协议）**，也支持 OpenAI Chat Completions、Anthropic Messages，以及离线 mock
- 内置一套**通用工具集**：shell（Windows 自动走 PowerShell）、文件读写/编辑、glob/grep、web 抓取/搜索、向用户提问
- LLM 请求**超时 + 瞬态错误（503/429/超时）自动重试退避**，避免上游网关临时不可用导致 run 卡死
- 暴露 **REST + WebSocket API**：创建 run、流式输出执行过程、查询历史
- 对话按 **thread → run → step** 三级组织，并持久化到 **PostgreSQL**
- 提供一个 **React 聊天控制台**：发起对话、按 step 实时查看 Agent 的思考与工具调用
- **流式输出**（SSE）+ 前端 **Markdown 渲染**：内容与「思考」过程逐字实时呈现
- **深色 / 浅色模式**切换（跟随系统，可手动切换并持久化）

---

## 对话模型：thread → run → step

| 层级 | 含义 |
|------|------|
| **thread** | 一段会话，包含多轮（多个 run），提供多轮记忆 |
| **run** | 一轮：一次用户输入 → Agent 工作 → 产出最终回复 |
| **step** | run 内执行循环的一次迭代：一次 LLM 决策 + 其触发的工具调用 |

每个 run 启动时会加载所在 thread 的历史消息作为上下文，因此 Agent 具备跨轮记忆。

---

## 架构

```
┌──────────────┐     REST / WebSocket      ┌──────────────────────────────┐
│  React Web   │ ◀───────────────────────▶ │           Server             │
│  聊天控制台   │                            │  (Node + TypeScript 单体)     │
└──────────────┘                            │                              │
                                            │  ┌────────────────────────┐  │
                                            │  │  API 层 (REST + WS)     │  │
                                            │  └───────────┬────────────┘  │
                                            │              │               │
                                            │  ┌───────────▼────────────┐  │
                                            │  │  Agent 执行循环 (run)    │  │
                                            │  │   ├─ Provider 抽象       │  │
                                            │  │   │   ├ openai-responses │  │
                                            │  │   │   ├ openai-chat      │  │
                                            │  │   │   ├ anthropic        │  │
                                            │  │   │   └ mock             │  │
                                            │  │   ├─ 工具注册表/调度      │  │
                                            │  │   └─ 上下文 (thread 记忆) │  │
                                            │  └───────────┬────────────┘  │
                                            │              │               │
                                            │  ┌───────────▼────────────┐  │
                                            │  │  Store (接口)           │  │
                                            │  │   ├ PgStore (默认)      │  │
                                            │  │   └ MemoryStore (离线)   │  │
                                            │  └─────────────────────────┘  │
                                            └──────────────┬───────────────┘
                                                           │
                                                   ┌───────▼────────┐
                                                   │  PostgreSQL    │
                                                   └────────────────┘
```

**执行主线**：
`Web → 创建 thread → 在 thread 内启动 run → 执行循环（每个 step: LLM ⇄ 工具）→ 事件经 WebSocket 实时推送 → thread/run/step/消息/事件落库`

关键设计：
- **无独立队列与 worker**：run 在收到请求后于进程内异步执行，事件实时推送并持久化。
- **Provider 抽象**：执行循环只依赖中立的 `Provider` 接口与中立消息类型，各 provider 负责翻译到自己的协议。
- **Store 抽象**：执行循环依赖 `Store` 接口而非直连 PG，因此可用内存实现做单测与离线运行。

---

## 目录结构

```text
my-agent/
├── server/                     # Node + TypeScript 后端（单体）
│   ├── src/
│   │   ├── index.ts            # 入口：Express + WebSocket
│   │   ├── config.ts           # 环境变量 / 配置
│   │   ├── db/                 # pool.ts / schema.sql / migrate.ts
│   │   ├── llm/
│   │   │   ├── types.ts        # 中立类型 + Provider 接口
│   │   │   ├── index.ts        # provider 工厂（按 LLM_PROVIDER 选择）
│   │   │   ├── providers/
│   │   │   │   ├── openaiResponses.ts  # OpenAI Responses API（新协议，默认）
│   │   │   │   ├── openaiChat.ts       # OpenAI 兼容 Chat Completions
│   │   │   │   ├── anthropic.ts        # Anthropic Messages API
│   │   │   │   └── mock.ts             # 离线确定性 provider
│   │   │   └── providers.test.ts       # provider 协议映射单测
│   │   ├── agent/
│   │   │   ├── executor.ts     # 执行循环（thread/run/step + 依赖注入）
│   │   │   ├── context.ts      # 上下文（system + thread 历史 + 新输入）
│   │   │   ├── bus.ts          # 进程内事件 pub/sub（驱动 WS）
│   │   │   ├── types.ts        # AgentEvent / RunStatus
│   │   │   └── executor.test.ts        # 执行循环单测（内存 store + 脚本 provider）
│   │   ├── tools/
│   │   │   ├── registry.ts     # 工具注册表
│   │   │   ├── types.ts        # 工具接口
│   │   │   ├── shell/fileRead/fileWrite/fileEdit/glob/grep/webFetch/webSearch/askUser.ts
│   │   │   └── tools.test.ts            # 工具单测
│   │   ├── store/
│   │   │   ├── types.ts        # Store 接口
│   │   │   ├── pgStore.ts      # PostgreSQL 实现
│   │   │   ├── memoryStore.ts  # 内存实现（测试/离线）
│   │   │   └── index.ts        # 按 STORE 选择实现
│   │   └── api/
│   │       ├── http.ts         # REST（threads / runs）
│   │       └── ws.ts           # WebSocket 流式推送
│   ├── package.json
│   └── tsconfig.json
│
├── web/                        # React + Vite + Tailwind 聊天控制台
│   ├── src/
│   │   ├── main.tsx / App.tsx / api.ts
│   │   └── components/         # Sidebar / ChatView / MessageList / Composer
│   ├── tailwind.config.js / postcss.config.js
│   ├── index.html / vite.config.ts / package.json
│
├── docker-compose.yml          # 本地 PostgreSQL
├── .env.example
├── package.json                # npm workspaces 根
└── README.md
```

---

## 技术栈

| 层 | 技术 |
|----|------|
| 后端运行时 | Node.js ≥ 20, TypeScript |
| HTTP / WS | Express + `ws` |
| 数据库 | PostgreSQL（`pg` 驱动） |
| LLM | 多 provider：OpenAI Responses（新协议，默认）/ OpenAI Chat / Anthropic / mock |
| 前端 | React 18 + Vite + TypeScript + Tailwind CSS（深色模式）+ react-markdown |
| 测试 | `node --test`（Node 内置，零额外依赖） |
| 工具编排 | npm workspaces |

---

## 多 Provider 设计

执行循环只面向中立接口 `Provider.complete(messages, tools) → { content, toolCalls }`，
provider 负责在自己的协议间双向翻译。各 provider 都导出**纯映射函数**（如 `buildResponsesRequest` /
`parseResponsesOutput`），便于单测且不触网。

| Provider | 协议 | 说明 |
|----------|------|------|
| `openai-responses` | `POST /v1/responses` | OpenAI 新协议（默认）。工具定义扁平化，工具调用以 `function_call` 输出项返回，结果以 `function_call_output` 回填 |
| `openai-chat` | `POST /v1/chat/completions` | 兼容 DeepSeek / Moonshot / vLLM / Ollama 等 |
| `anthropic` | `POST /v1/messages` | system 顶层字段；`tool_use` / `tool_result` 内容块 |
| `mock` | — | 离线确定性 provider，用于测试与本地演示，无需密钥 |

通过 `LLM_PROVIDER` 切换。

---

## 数据模型（PostgreSQL）

| 表 | 用途 |
|----|------|
| `threads` | 会话（多轮容器） |
| `runs` | 一轮执行（属于 thread；状态 / 输入 / 输出） |
| `steps` | run 内一次循环迭代（属于 run；`idx` 为步号） |
| `messages` | 对话消息（thread / run / step 关联；role、content、tool_calls） |
| `events` | 执行事件流（step_start / llm_delta / tool_call / tool_result / final / error），供前端实时与回放 |

---

## 快速开始

### 前置条件

- Node.js ≥ 20
- PostgreSQL（本地实例或 `docker compose up -d`）

### 1. 安装依赖

```bash
npm install
```

### 2. 启动 PostgreSQL

```bash
docker compose up -d
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 填入 LLM_PROVIDER / LLM_API_KEY / LLM_MODEL 和 DATABASE_URL
```

### 4. 初始化数据库

```bash
npm run db:migrate
```

### 5. 启动开发环境（后端 + 前端）

```bash
npm run dev
```

- Web 控制台：`http://localhost:3000`
- 后端 API：`http://localhost:8080`
- WebSocket：`ws://localhost:8080/ws?runId=<id>`

---

## 离线运行（无需 PG / 密钥）

用内存 store + mock provider，可零依赖把整条链路跑起来：

```bash
cd server
STORE=memory LLM_PROVIDER=mock node --import tsx src/index.ts
```

mock 约定：输入以 `glob <pattern>` 或 `shell <cmd>` 开头会调用对应工具，否则直接回显。

---

## 测试

```bash
npm test -w server      # node:test：工具 / provider 协议映射 / 执行循环
npm run typecheck -w server
```

执行循环测试使用 `MemoryStore` + 脚本化 provider，**不依赖 PG 或网络**。

---

## API 速览

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/threads` | 创建 thread，body: `{ "title?": "..." }` |
| `GET` | `/api/threads` | 列出 thread |
| `GET` | `/api/threads/:id` | thread 详情（含其 runs） |
| `POST` | `/api/threads/:id/runs` | 在 thread 内启动一个 run，body: `{ "input": "..." }` |
| `GET` | `/api/runs/:id` | run 详情（run + 按 step 分组的 events） |
| `WS` | `/ws?runId=:id` | 订阅指定 run 的实时事件流（先回放历史再推流） |

---

## 环境变量

| 变量 | 说明 | 默认 |
|------|------|------|
| `PORT` | 后端端口 | `8080` |
| `DATABASE_URL` | PostgreSQL 连接串 | `postgres://postgres:postgres@localhost:5432/my_agent` |
| `STORE` | `pg`（默认）或 `memory`（离线/测试） | `pg` |
| `LLM_PROVIDER` | `openai-responses` / `openai-chat` / `anthropic` / `mock` | `openai-responses` |
| `LLM_BASE_URL` | provider 接口地址 | `https://api.openai.com/v1` |
| `LLM_API_KEY` | 密钥 | — |
| `LLM_MODEL` | 模型名 | `gpt-4o-mini` |
| `LLM_MAX_TOKENS` | 最大输出 token | `4096` |
| `LLM_TIMEOUT_MS` | 单次 LLM 请求超时 | `120000` |
| `LLM_MAX_RETRIES` | 瞬态失败（超时 / 429 / 5xx）重试次数 | `2` |
| `LLM_STREAM` | 是否启用 SSE 流式输出（openai-chat） | `true` |
| `AGENT_MAX_STEPS` | 单次 run 最大循环步数 | `25` |

---

## 路线图

- [x] 多 provider（OpenAI Responses / Chat / Anthropic / mock）
- [x] thread / run / step 对话模型
- [x] 单元测试（工具 / provider 映射 / 执行循环 / 流式拼装）
- [x] LLM 流式增量（SSE，token 级 `llm_delta` / `reasoning`）
- [x] 前端 Markdown 渲染 + 深色模式
- [ ] 鉴权与用户管理（JWT、角色）
- [ ] 数据权限 / 工具策略层
- [ ] 数据库探查与 SQL 工具
- [ ] 技能（Skill）系统 / 定时任务（Cron）
- [ ] IM 接入（Telegram / 飞书 / 钉钉等）
- [ ] 多 worker 横向扩展（引入队列）

---

## License

MIT
