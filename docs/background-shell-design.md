# 托管 Shell 资源设计

> 目标：把所有 shell 都建模成需要主动管理的运行资源。LLM 先创建或复用 `shell_session`，
> 再执行命令；命令可以前台等待完成，也可以后台运行。用户和 LLM 共享可观察、可审计、可恢复的 shell 交互记录。

## 1. 结论

- **所有 shell 都走托管资源。** 不再把 `shell(command)` 当一次性黑盒；先有 `shell_session`，
  再有 `shell_exec` 产生的 `shell_command`。
- **bwrap 可作为隔离后端，不是任务调度器。** 它负责构造受限进程树；session/command 生命周期由
  后端 `ShellManager` 管。
- **命令可前台也可后台。** `shell_exec(wait=foreground)` 等待完成或超时；`wait=background`
  立即返回 `commandId`，后续用 `poll/kill` 管理。
- **LLM 只观察，不保活。** 定时、超时、进程回收由后端 `ShellManager` 做；LLM 通过工具轮询状态并决策下一步。
- **日志不进入完整上下文。** 全量 stdout/stderr 落库或落文件；返回给 LLM 的只有增量、tail 和摘要。
- **旧 `shell` 仅作兼容层。** 迁移期可把它实现成“自动创建临时 session + 前台 exec”；新能力要求显式
  open/reuse session。

## 2. 当前逻辑与问题

当前 `shell` 工具路径：

1. `server/src/tools/shell.ts` 接收 `command + timeout_ms`。
2. `server/src/tools/sandbox.ts` 选择宿主 shell 或 bwrap。
3. `execFileAsync(...)` 等命令结束后一次性返回 stdout/stderr。

问题：

- 每次 shell 没有显式资源身份，cwd、环境、长进程和用户操作无法统一管理。
- 长命令会占住当前 step，LLM 不能并行分析或继续调用其他工具。
- 超时只得到失败文本，用户无法选择继续等或直接中断。
- 输出在一次 tool result 内返回，容易污染上下文，即使有 `TOOL_MAX_OUTPUT` 也会浪费窗口。
- `cmd &` 不是正确方案：进程归属、日志、退出码、取消和沙箱退出语义都不可控。

## 3. 产品参考抽象

- E2B：`run(background=true)` 返回 command handle，支持 `connect/list/stdin/kill`。
- Claude Code：后台 PTY job 与 Bash sandbox 分层；权限先判定，OS 沙箱约束子进程。
- Codex / Copilot cloud agent / Cursor / Devin：任务拥有独立环境，用户能看日志、状态、diff、测试证据，并可中断错误操作。

落到本项目：实现**本地 bwrap/host 托管 shell 后端**，接口按 E2B 风格设计，未来可替换为 Docker/E2B。

## 4. 核心模型

三层生命周期：

- `run`：用户一次任务，已有 `runs` 表和取消状态。
- `shell_session`：托管 shell，会话绑定 `thread + workspace`，可跨 run 复用。
- `shell_command`：一次命令执行，例如 `pwd` 或 `git clone ...`。
- `process`：该命令对应的宿主 bwrap 进程及其沙箱内子进程树。

session 状态：

```text
opening -> idle | busy | closing | closed | orphaned
```

command 状态：

```text
queued -> running -> succeeded | failed | killed | timed_out | orphaned
```

超时分两层：

- `soft_timeout_ms`：到点后不强杀，发事件并让 LLM/用户选择继续或终止。
- `hard_timeout_ms`：兜底强杀，避免无人值守任务长期占资源。

软超时不是阻塞点。用户没看到时，命令继续运行；到硬超时仍无人处理才终止。需要用户确认的场景用
`ask_user` 事件提示，但 watchdog 仍按硬超时兜底，不能无限挂起。

## 5. 工具接口

新工具以 session 为入口：

- `shell_session_open(name?)`
  - 创建托管 shell；默认绑定当前 thread 和 workspace。名称只是展示名，LLM 仍通过 id 交互。
- `shell_session_reuse(sessionId?)`
  - 复用现有 session；不传时返回当前 thread 下推荐 session。
- `shell_session_list()`
  - 列出当前 thread/workspace 可见 shell 以及最近命令。
- `shell_exec(sessionId, command, wait?, timeout_ms?, soft_timeout_ms?, hard_timeout_ms?)`
  - `wait=foreground`：等待命令完成或超时，返回 exit code 和 tail。
  - `wait=background`：立即返回 `commandId`，命令继续运行。
  - session 会记住 `cwd`；切目录用 `cd`，不要给每次命令单独传 cwd。
  - 默认超时：短任务 10 分钟软超时、30 分钟硬超时；可按命令类型和用户配置覆盖。
- `shell_poll(commandId | sessionId, sinceSeq?)`
  - 返回 command/session 状态、运行时长、退出码、增量输出、tail、`nextPollMs`。
- `shell_kill(commandId, signal?)`
  - 默认先 `SIGTERM`，超时后 `SIGKILL`。
- `shell_session_close(sessionId)`
  - 关闭 session；有运行中 command 时必须显式 `force=true`。

工具返回给 LLM 的文本必须短：最多包含最近 N 行、退出码、下一步建议；完整日志通过前端或下载查看。

兼容策略：

- 旧 `shell(command)` 工具保留一段时间，内部等价于 `open temp session -> exec foreground -> close`。
- 新提示词要求 LLM 使用托管 shell；涉及长任务、交互、跨 run 连续性时禁止使用旧 `shell`。

## 6. 后端实现

新增模块：

- `server/src/tools/managedShell.ts`：工具定义。
- `server/src/tools/managedShell.ts`：托管 shell 工具定义。
- `server/src/shell/manager.ts`：session/command 生命周期、日志写入、软/硬超时和进程终止。
- `server/src/shell/bus.ts`：thread 级 shell 事件推送，驱动右侧 Shell 面板刷新。
- `server/src/tools/sandbox.ts`：复用 host/bwrap 后端选择、挂载、网络和环境变量逻辑。

bwrap 启动方式：

- 用 `spawn(...)` 执行 command，不再用 `execFileAsync`。
- 复用现有 `buildBwrapArgs` 的挂载、网络和环境变量逻辑。
- 保留 `--new-session` 和 `--die-with-parent`，终止时杀 bwrap 进程组。
- `TOOL_NETWORK=enabled` 时才 `--share-net`，否则后台 `git clone` 应明确失败。

超时与回收：

- 输出到达时记录日志、输出字节数和 `last_output_at`。
- 到软超时：写 `shell_command_timeout` 事件，不杀进程。
- 到硬超时：kill 进程树，command 状态置 `timed_out`，session 回到 `idle` 或 `orphaned`。
- run 取消：默认只 kill 该 run 启动的 foreground/background command；shell 记录保留，可继续恢复使用。

## 7. 存储设计

新增表：

```sql
CREATE TABLE shell_sessions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  cwd TEXT NOT NULL,
  backend TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_actor TEXT,
  lease_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  config_snapshot JSONB,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shell_commands (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES shell_sessions(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  step_id TEXT REFERENCES steps(id) ON DELETE SET NULL,
  actor TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL,
  wait_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  attention TEXT,
  host_pid INTEGER,
  child_pid INTEGER,
  exit_code INTEGER,
  signal TEXT,
  soft_timeout_ms INTEGER,
  hard_timeout_ms INTEGER,
  soft_timeout_at TIMESTAMPTZ,
  hard_timeout_at TIMESTAMPTZ,
  last_output_at TIMESTAMPTZ,
  output_bytes BIGINT NOT NULL DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE shell_command_logs (
  id BIGSERIAL PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES shell_commands(id) ON DELETE CASCADE,
  seq BIGINT NOT NULL,
  stream TEXT NOT NULL,
  chunk TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (command_id, seq)
);

CREATE TABLE shell_session_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES shell_sessions(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

事件新增：

- `shell_session_opened`
- `shell_session_closed`
- `shell_command_started`
- `shell_command_output`
- `shell_command_timeout`
- `shell_command_attention`
- `shell_command_finished`
- `shell_command_killed`
- `shell_lease_changed`

前端实时展示优先读事件；历史详情从 `shell_command_logs` 分页读取。

## 8. 前端体验

- thread 右侧提供 Shell 面板，展示当前可用 session、lease 持有者和最近命令。
- Shell 面板默认用常规终端样式展示：prompt、连续输出、退出状态；内部日志仍按 seq 落库。
- 工具卡展示 command 状态：运行中、耗时、输出速率、退出码、最近 100 行。
- 运行中 command 提供刷新、终止操作；终止调用后端 kill API，不依赖 LLM。
- 详情面板分页读取完整 stdout/stderr，支持按 stream 过滤和下载日志。
- 超过软超时后展示明确选择：继续等待 10 分钟或终止。
- 用户在 Shell 面板执行的命令也写入 `shell_commands(actor='user')`，LLM 后续能看到摘要和完整审计。
- 用户没打开页面时，WebSocket 事件已落库；下次打开 run/thread 时从历史事件和日志表恢复 session/command 卡片。
- 不把后台日志混进普通 assistant 文本；按 step 归属展示。

手动终止流程：

1. 用户点击终止，前端调用 `POST /api/shell-commands/:id/kill`。
2. 后端把 `attention` 置为 `user_requested_kill`，先发 `SIGTERM`。
3. 进程 5 秒内未退出则发 `SIGKILL`。
4. command 状态置 `killed`，写 `shell_command_killed` 事件，并把结果推给 LLM 可见的下一次 `poll`。

## 9. TUI 兼容

TUI（terminal user interface，终端图形界面）不能靠普通 stdout/stderr pipe 完整兼容。原因是它依赖：

- 伪终端 PTY：程序需要 `isatty=true`，否则会拒绝启动或降级。
- 终端尺寸：需要 rows/cols 和 resize 信号。
- 原始输入：方向键、Ctrl+C、Alt 组合键不是普通字符串输入。
- ANSI 控制序列：光标移动、清屏、alternate screen、颜色都要由终端模拟器解释。

因此分两种模式：

- `mode=command`：当前默认模式，适合 `git clone`、`npm install`、测试、构建、大文件操作。输出按日志落库，前端渲染成 cmd 风格。
- `mode=pty`：TUI/交互模式。后端用 `node-pty` 或等价 PTY backend 启动 shell/bwrap，前端用 xterm.js 渲染，WebSocket 传输原始字节。

PTY 模式需要新增：

- `shell_session_open(mode='pty', rows, cols)`
- `shell_stdin(sessionId, data)` 写入 PTY
- `shell_resize(sessionId, rows, cols)` 同步窗口尺寸
- 原始 transcript 日志：保留 raw bytes，同时派生给 LLM 的短摘要
- 输入锁：同一个 shell 同时只能有一个 running/queued command

安全边界不变：PTY 只是 I/O 形态，命令仍走同一套 tool policy 和 bwrap/host 后端。

## 10. 安全边界

- 后台 shell 仍走 `createPolicy(settings)`，不能绕过工具 allow/deny。
- bwrap 只约束 shell 子进程；进程内 file tools 仍靠应用层路径策略。
- `shellUseHostPath=true` 时无法获得 bwrap 文件隔离，应在 UI/事件里显式标注。
- shell command 默认不继承后端密钥；数据库 CLI 仍必须走 workload token。
- 输出继续走脱敏和大小限制；完整日志也要做 secret redaction。
- 用户和 LLM 共享同一个 shell 时必须有命令写入锁；同一时刻只能一个 actor 启动命令。
- 跨 run session 默认只在同一 thread/workspace 可见；跨 thread 复用必须用户显式选择。

## 11. 分阶段

阶段 1：托管 shell 基础

- `shell_session_open/reuse/list/close`
- `shell_exec(wait=foreground|background)`、`shell_poll`、`shell_kill`
- host + bwrap 后端，旧 `shell` 作为兼容包装
- DB 表、事件、run cancel 对 command 的级联 kill
- 前端 Shell 面板 + command 卡片展示状态和 tail

阶段 2：交互标记与手动命令

- 用户命令写入 `shell_commands(actor='user')`，LLM 可观察但不能伪造用户输入
- 用户可把某一次 command 交互标记为输入附件，提交给 LLM
- PTY 模式、xterm 前端、`shell_stdin` 留作未来交互终端能力

阶段 3：环境后端抽象

- `ShellBackend` 扩展为 `EnvironmentProvider`
- 支持 Docker/E2B/远程 worker
- 服务重启后 reconnect 或标记 orphaned 的统一策略

阶段 4：资源配额

- cgroup/systemd-run/ulimit 控制 CPU、内存、进程数、磁盘。
- 网络从开关升级为代理 allowlist。

## 12. 验收

- `git clone` 大仓库：`shell_exec(wait=background)` 立即返回，LLM 可继续下一 step，`poll` 能看到增量输出。
- 普通短命令：`shell_exec(wait=foreground)` 等价于原同步 shell，但有 session/command 审计。
- 软超时：任务仍运行，前端和事件提示用户选择。
- 硬超时：任务被杀，状态为 `timed_out`，退出信息可追踪。
- run cancel：该 run 启动的 running command 被级联终止；shell 记录保留。
- bwrap enforce：工作区外不可见，网络 disabled 时 clone 失败，enabled 时按预期执行。
- 日志大于 `TOOL_MAX_OUTPUT`：LLM 只收到 tail，完整日志可分页查看。
- 用户打开历史 run：仍能看到 session、command 最终状态和完整日志。

## 13. 共享 Shell 与跨 run 生命周期

共享 shell 是默认模型的一部分，但要用命令级写入锁防止用户和 LLM 同时写入：

- 生命周期绑定 `thread + workspace`，不是单个 run；Default shell 由系统创建且不可删除。
- shell 是常驻会话记录，真实进程按 command 启动；没有运行中进程时资源可自动释放。
- 新 run 可通过 shell id 继续使用已有 shell，后端用保存的 `cwd/config_snapshot` 恢复执行环境。
- 同一个 shell 同时只能有一个 running/queued command；用户要介入时可先终止错误 command。
- 用户执行的命令写入 `shell_commands(actor='user')`，LLM 不自动读取全部历史。
- 用户可标记某一次 shell 交互为输入附件，发送时转成结构化文本给 LLM。
- 所有输入和输出都写 `shell_session_events`，审计时能区分用户输入和 LLM 输入。
- 共享终端输出视为不可信观察，不直接当系统指令；LLM 只能把它作为 tool result 使用。

对应工具和 API：

- `shell_session_open/reuse/list/close`
- `shell_poll(sessionId)`
- `PATCH /api/shell-sessions/:id`：用户改名自己创建的 shell；`Default` 不能改名。
- `POST /api/shell-commands/:id/mark`

取舍：跨 run shell 能显著改善长任务连续性，但也增加误操作风险。默认应只对同一 thread 和同一 workspace 开放，
跨 thread 复用必须用户显式选择。
