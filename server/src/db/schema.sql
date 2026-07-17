-- Agent persistence schema (PostgreSQL)
-- Conversation hierarchy: thread → run → step → (messages, events)

CREATE TABLE IF NOT EXISTS threads (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  active_run_id TEXT,
  pinned_at   TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 会话列表状态：置顶只影响排序，归档只从默认列表隐藏，不删除历史数据。
-- active_run_id 指向当前查看/继续的分支叶子；旧分支保留但不进入后续上下文。
ALTER TABLE threads ADD COLUMN IF NOT EXISTS active_run_id TEXT;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;
ALTER TABLE threads ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;

-- One run = one user turn in a thread (input → agent works → output)
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | running | waiting_for_user | done | error | canceling | canceled
  input       TEXT NOT NULL,
  model_ref   TEXT,                              -- 本次 run 固定使用的 provider:model；为空时使用运行时默认模型
  output      TEXT,
  error       TEXT,
  goal_state  JSONB,                             -- structured goal anchor (intent/plan/decisions/next)
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Goal anchor (long-task design §3.2). Idempotent for existing DBs.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS goal_state JSONB;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS model_ref TEXT;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS parent_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL;

-- 旧库上线分支前是线性 run 列表；首次迁移时按时间顺序补父子关系。
WITH legacy_edges AS (
  SELECT
    r.id,
    lag(r.id) OVER (PARTITION BY r.thread_id ORDER BY r.created_at, r.id) AS previous_id
  FROM runs r
  JOIN threads t ON t.id = r.thread_id
  WHERE t.active_run_id IS NULL
)
UPDATE runs r
SET parent_run_id = e.previous_id
FROM legacy_edges e
WHERE r.id = e.id
  AND r.parent_run_id IS NULL
  AND e.previous_id IS NOT NULL;

-- 旧库没有分支指针时，把当前分支初始化为该 thread 最新 run，保持历史视图兼容。
UPDATE threads t
SET active_run_id = (
  SELECT r.id
  FROM runs r
  WHERE r.thread_id = t.id
  ORDER BY r.created_at DESC, r.id DESC
  LIMIT 1
)
WHERE t.active_run_id IS NULL
  AND EXISTS (SELECT 1 FROM runs r WHERE r.thread_id = t.id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'threads_active_run_id_fkey'
  ) THEN
    ALTER TABLE threads
      ADD CONSTRAINT threads_active_run_id_fkey
      FOREIGN KEY (active_run_id) REFERENCES runs(id) ON DELETE SET NULL;
  END IF;
END $$;

-- One step = one iteration of the agent loop (one LLM turn + its tool calls)
CREATE TABLE IF NOT EXISTS steps (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,                  -- 1-based step number within the run
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  thread_id   TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id     TEXT REFERENCES steps(id) ON DELETE CASCADE,  -- null for the initial user message
  role        TEXT NOT NULL,                     -- user | assistant | tool
  content     TEXT,                              -- ALWAYS the original; compaction never overwrites it
  tool_calls  JSONB,                             -- assistant tool call requests
  tool_call_id TEXT,                             -- for role=tool
  collapsed   TEXT,                              -- null | 'masked' | 'summarized' (context compaction, durable)
  summary_of  BIGINT[],                          -- summary message folds these original message ids
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Durable context compaction (long-task design §4). Idempotent so re-running
-- migrate() on an existing DB adds the column without touching data.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS collapsed TEXT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS summary_of BIGINT[];

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  step_id     TEXT REFERENCES steps(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL DEFAULT 0,        -- step index this event belongs to
  type        TEXT NOT NULL,                     -- step_start | reasoning | reasoning_timing | llm_delta | tool_call | tool_result | compaction | final | error
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_thread_parent ON runs(thread_id, parent_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_steps_run ON steps(run_id, idx);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_run ON messages(run_id, id);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, id);
CREATE INDEX IF NOT EXISTS idx_threads_created ON threads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_threads_sidebar ON threads(archived_at, pinned_at DESC, updated_at DESC, created_at DESC);

-- 只用于 UI 展示的会话提示，不进入 messages，也不会进入模型上下文。
CREATE TABLE IF NOT EXISTS thread_notices (
  id               BIGSERIAL PRIMARY KEY,
  thread_id        TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'info',
  message          TEXT NOT NULL,
  title            TEXT,
  linked_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
  linked_run_id    TEXT REFERENCES runs(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE thread_notices ADD COLUMN IF NOT EXISTS title TEXT;
CREATE INDEX IF NOT EXISTS idx_thread_notices_thread ON thread_notices(thread_id, created_at, id);

-- subagent run 是父 run 内部派发的独立子任务。v1 先记录 workflow stage、
-- task assignment、runtime profile 和最终输出，后续再扩展为可用工具的子 agent loop。
CREATE TABLE IF NOT EXISTS subagent_runs (
  id                 TEXT PRIMARY KEY,
  parent_run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  parent_step_id     TEXT REFERENCES steps(id) ON DELETE SET NULL,
  workflow_id        TEXT,
  stage_id           TEXT,
  runtime_profile_id TEXT,
  status             TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'error')),
  task_assignment    JSONB NOT NULL DEFAULT '{}'::jsonb,
  skill_names        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  output             TEXT,
  error              TEXT,
  usage              JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_run_id, created_at);
CREATE INDEX IF NOT EXISTS idx_subagent_runs_stage ON subagent_runs(parent_run_id, stage_id);

-- 应用配置表。env 只作为首次默认值/兜底,运行时配置从这里读取。
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 浏览器后台通知订阅。endpoint 由浏览器 Push Service 分配，keys 用于按 Web Push
-- 标准加密消息体；用户关闭权限或推送失效后只禁用，不硬删审计信息。
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint        TEXT PRIMARY KEY,
  p256dh          TEXT NOT NULL,
  auth            TEXT NOT NULL,
  expiration_time TIMESTAMPTZ,
  user_agent      TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_enabled ON push_subscriptions(enabled, updated_at DESC);

-- 数据源控制面。真实数据库管理凭证只允许存 secret 引用；本地开发可临时使用
-- admin_config.connectionUrl，生产环境应迁到 Vault/Akeyless/云 Secret Manager。
CREATE TABLE IF NOT EXISTS datasources (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('postgres', 'mysql', 'mongodb', 'hive')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  enabled       BOOLEAN NOT NULL DEFAULT true,
  connection    JSONB NOT NULL DEFAULT '{}'::jsonb,
  admin_config  JSONB NOT NULL DEFAULT '{}'::jsonb,
  pool_config   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_datasources_name ON datasources(name);

ALTER TABLE datasources ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;

-- 权限档位：例如 readonly / limited_write。账号池账号只绑定档位，不在 run
-- 开始时临时拼复杂授权，避免权限漂移。
CREATE TABLE IF NOT EXISTS datasource_permission_profiles (
  id            TEXT PRIMARY KEY,
  datasource_id TEXT NOT NULL REFERENCES datasources(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'readonly' CHECK (mode IN ('readonly', 'limited_write', 'custom')),
  template_role TEXT,
  grants        JSONB NOT NULL DEFAULT '{}'::jsonb,
  pool_config   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (datasource_id, name)
);

-- 账号池账号。账号长期存在，run 开始时重置登录凭证并租出；run 结束后锁定
-- 或改废密码，再回到 idle。
CREATE TABLE IF NOT EXISTS datasource_accounts (
  id             TEXT PRIMARY KEY,
  datasource_id  TEXT NOT NULL REFERENCES datasources(id) ON DELETE CASCADE,
  profile_id     TEXT NOT NULL REFERENCES datasource_permission_profiles(id) ON DELETE CASCADE,
  username       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'leased', 'cooling_down', 'disabled')),
  current_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  leased_until   TIMESTAMPTZ,
  last_lease_at  TIMESTAMPTZ,
  last_rotated_at TIMESTAMPTZ,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (datasource_id, username)
);

CREATE INDEX IF NOT EXISTS idx_datasource_accounts_pool ON datasource_accounts(datasource_id, profile_id, status);
CREATE INDEX IF NOT EXISTS idx_datasource_accounts_run ON datasource_accounts(current_run_id);

-- workload token 是 run 级别的代理凭证，只能换取本次 run 允许的数据源凭证。
-- 表里只存 hash，不保存明文 token。
CREATE TABLE IF NOT EXISTS workload_tokens (
  id                  TEXT PRIMARY KEY,
  token_hash          TEXT NOT NULL UNIQUE,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  skill_id            TEXT,
  allowed_datasources TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  expires_at          TIMESTAMPTZ NOT NULL,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workload_tokens_run ON workload_tokens(run_id);
CREATE INDEX IF NOT EXISTS idx_workload_tokens_expiry ON workload_tokens(expires_at);

-- 凭证租约。用于审计和回收：run 结束、token 过期或 lease 过期时都能兜底清理。
CREATE TABLE IF NOT EXISTS datasource_account_leases (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES datasource_accounts(id) ON DELETE CASCADE,
  datasource_id TEXT NOT NULL REFERENCES datasources(id) ON DELETE CASCADE,
  profile_id    TEXT NOT NULL REFERENCES datasource_permission_profiles(id) ON DELETE CASCADE,
  run_id        TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  token_id      TEXT REFERENCES workload_tokens(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'leased' CHECK (status IN ('leased', 'released', 'expired', 'failed')),
  leased_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  released_at   TIMESTAMPTZ,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_datasource_leases_run ON datasource_account_leases(run_id, status);
CREATE INDEX IF NOT EXISTS idx_datasource_leases_expiry ON datasource_account_leases(status, expires_at);

-- 托管 shell session。session 是 thread/workspace 级资源，可跨 run 复用；
-- command 是一次具体命令执行，可前台等待或后台运行。
CREATE TABLE IF NOT EXISTS shell_sessions (
  id              TEXT PRIMARY KEY,
  thread_id       TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  name            TEXT NOT NULL DEFAULT 'Default',
  owner           TEXT NOT NULL DEFAULT 'system' CHECK (owner IN ('agent', 'user', 'system')),
  workspace_root  TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  backend         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('opening', 'idle', 'busy', 'closing', 'closed', 'orphaned')),
  lease_actor     TEXT,
  lease_run_id    TEXT REFERENCES runs(id) ON DELETE SET NULL,
  config_snapshot JSONB,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE shell_sessions ADD COLUMN IF NOT EXISTS name TEXT;
UPDATE shell_sessions SET name = id WHERE name IS NULL;
ALTER TABLE shell_sessions ALTER COLUMN name SET NOT NULL;
ALTER TABLE shell_sessions ADD COLUMN IF NOT EXISTS owner TEXT NOT NULL DEFAULT 'agent';
UPDATE shell_sessions SET owner = 'agent' WHERE owner IS NULL OR owner NOT IN ('agent', 'user', 'system');
ALTER TABLE shell_sessions ALTER COLUMN owner SET DEFAULT 'agent';
ALTER TABLE shell_sessions ALTER COLUMN owner SET NOT NULL;
ALTER TABLE shell_sessions DROP CONSTRAINT IF EXISTS shell_sessions_owner_check;
ALTER TABLE shell_sessions ADD CONSTRAINT shell_sessions_owner_check CHECK (owner IN ('agent', 'user', 'system'));
ALTER TABLE shell_sessions ADD COLUMN IF NOT EXISTS config_snapshot JSONB;
ALTER TABLE shell_sessions ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
UPDATE shell_sessions SET status = 'idle', lease_actor = NULL, lease_run_id = NULL, updated_at = now() WHERE status = 'attached_by_user';
ALTER TABLE shell_sessions DROP CONSTRAINT IF EXISTS shell_sessions_status_check;
ALTER TABLE shell_sessions ADD CONSTRAINT shell_sessions_status_check CHECK (status IN ('opening', 'idle', 'busy', 'closing', 'closed', 'orphaned'));
ALTER TABLE shell_sessions DROP COLUMN IF EXISTS pinned;
ALTER TABLE shell_sessions DROP COLUMN IF EXISTS idle_expires_at;
ALTER TABLE shell_sessions ADD COLUMN IF NOT EXISTS cwd TEXT;
UPDATE shell_sessions SET cwd = workspace_root WHERE cwd IS NULL;
ALTER TABLE shell_sessions ALTER COLUMN cwd SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_shell_sessions_thread ON shell_sessions(thread_id, workspace_root, status);
CREATE INDEX IF NOT EXISTS idx_shell_sessions_active ON shell_sessions(thread_id, workspace_root, deleted_at);

CREATE TABLE IF NOT EXISTS shell_commands (
  id               TEXT PRIMARY KEY,
  session_id       TEXT NOT NULL REFERENCES shell_sessions(id) ON DELETE CASCADE,
  run_id           TEXT REFERENCES runs(id) ON DELETE SET NULL,
  step_id          TEXT REFERENCES steps(id) ON DELETE SET NULL,
  actor            TEXT NOT NULL DEFAULT 'agent' CHECK (actor IN ('agent', 'user', 'system')),
  command          TEXT NOT NULL,
  cwd              TEXT NOT NULL,
  wait_mode        TEXT NOT NULL DEFAULT 'foreground' CHECK (wait_mode IN ('foreground', 'background')),
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'killed', 'timed_out', 'orphaned')),
  attention        TEXT,
  host_pid         INTEGER,
  child_pid        INTEGER,
  exit_code        INTEGER,
  signal           TEXT,
  soft_timeout_ms  INTEGER,
  hard_timeout_ms  INTEGER,
  soft_timeout_at  TIMESTAMPTZ,
  hard_timeout_at  TIMESTAMPTZ,
  last_output_at   TIMESTAMPTZ,
  output_bytes     BIGINT NOT NULL DEFAULT 0,
  error            TEXT,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at         TIMESTAMPTZ,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shell_commands_session ON shell_commands(session_id, started_at);
CREATE INDEX IF NOT EXISTS idx_shell_commands_run ON shell_commands(run_id, status);
CREATE INDEX IF NOT EXISTS idx_shell_commands_status ON shell_commands(status, updated_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_shell_commands_one_running_per_session
  ON shell_commands(session_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS shell_command_logs (
  id          BIGSERIAL PRIMARY KEY,
  command_id  TEXT NOT NULL REFERENCES shell_commands(id) ON DELETE CASCADE,
  seq         BIGINT NOT NULL,
  stream      TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
  chunk       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (command_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_shell_command_logs_command ON shell_command_logs(command_id, seq);

CREATE TABLE IF NOT EXISTS shell_session_events (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL REFERENCES shell_sessions(id) ON DELETE CASCADE,
  actor       TEXT NOT NULL,
  kind        TEXT NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shell_session_events_session ON shell_session_events(session_id, id);

-- 多租户改造 Phase 1(docs/multi-tenancy-design.md §4)。本阶段只加身份层的表,
-- 不改动 threads/runs 等业务表(tenant_id 列、RLS 留给后续阶段,见文档 §5-§9)。
CREATE TABLE IF NOT EXISTS tenants (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,        -- 自描述格式 "scrypt:N:r:p:saltHex:hashHex"
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE TABLE IF NOT EXISTS system_admins (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- refresh token(交互登录续期)和 api token(自动化调用)复用同一张表,靠 kind 区分,
-- 风格与既有 workload_tokens 一致:只存 hash,不存明文。
CREATE TABLE IF NOT EXISTS auth_tokens (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('refresh', 'api')),
  token_hash    TEXT NOT NULL UNIQUE,
  label         TEXT,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, kind, revoked_at);
