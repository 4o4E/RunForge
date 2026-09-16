-- 空间运行平台的数据骨架。迁移只追加结构，并把旧 thread 绑定到所属 tenant 的
-- default 空间；历史 thread/run/message/event 和 workspace 均不搬迁。

ALTER TABLE "runs"
  ADD COLUMN "external_input_open" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "input_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "plugin_lock" JSONB,
  ADD COLUMN "space_config_snapshot" JSONB,
  ADD COLUMN "space_config_version" INTEGER;

ALTER TABLE "runs"
  ADD CONSTRAINT "runs_input_version_check" CHECK (input_version >= 0),
  ADD CONSTRAINT "runs_space_config_version_check" CHECK (space_config_version IS NULL OR space_config_version > 0);

ALTER TABLE "tenants" ADD COLUMN "default_space_id" TEXT;

CREATE TABLE "spaces" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "execution_user_id" TEXT,
  "config" JSONB NOT NULL DEFAULT '{}',
  "config_version" INTEGER NOT NULL DEFAULT 1,
  "created_by_user_id" TEXT,
  "deleted_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "spaces_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "spaces_mode_check" CHECK (mode IN ('web', 'external')),
  CONSTRAINT "spaces_config_version_check" CHECK (config_version > 0)
);

CREATE UNIQUE INDEX "spaces_id_tenant_id_key" ON "spaces"("id", "tenant_id");
CREATE INDEX "idx_spaces_tenant" ON "spaces"("tenant_id", "deleted_at", "created_at");
CREATE INDEX "idx_spaces_execution_user" ON "spaces"("execution_user_id");

ALTER TABLE "spaces"
  ADD CONSTRAINT "spaces_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "spaces_execution_user_id_fkey"
    FOREIGN KEY ("execution_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "spaces_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- 旧 tenant 的 default space 也必须使用 sp_ + 雪花数值的 Base62 表达。迁移使用
-- 独立 worker 位，并把超过 4096 的序号进位到毫秒，保持同一批次内唯一。
CREATE OR REPLACE FUNCTION pg_temp.runforge_base62(value BIGINT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  alphabet CONSTANT TEXT := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  current_value BIGINT := value;
  encoded TEXT := '';
BEGIN
  IF current_value = 0 THEN
    RETURN '0';
  END IF;
  WHILE current_value > 0 LOOP
    encoded := substr(alphabet, (current_value % 62)::INTEGER + 1, 1) || encoded;
    current_value := current_value / 62;
  END LOOP;
  RETURN encoded;
END;
$$;

WITH migration_clock AS (
  SELECT floor(extract(epoch FROM (clock_timestamp() - TIMESTAMPTZ '2025-01-01 00:00:00+00')) * 1000)::BIGINT AS base_ms
), numbered_tenants AS (
  SELECT
    tenant.id AS tenant_id,
    row_number() OVER (ORDER BY tenant.created_at, tenant.id) - 1 AS ordinal,
    migration_clock.base_ms
  FROM "tenants" tenant
  CROSS JOIN migration_clock
), generated_spaces AS (
  SELECT
    tenant_id,
    'sp_' || pg_temp.runforge_base62(
      ((base_ms + (ordinal / 4096)) << 22)
      | (1023::BIGINT << 12)
      | (ordinal % 4096)
    ) AS space_id
  FROM numbered_tenants
)
INSERT INTO "spaces" ("id", "tenant_id", "mode", "name", "created_by_user_id")
SELECT
  generated.space_id,
  generated.tenant_id,
  'web',
  'Default',
  (
    SELECT owner_user.id
    FROM "users" owner_user
    WHERE owner_user.tenant_id = generated.tenant_id
      AND owner_user.role = 'owner'
      AND owner_user.status = 'active'
    ORDER BY owner_user.created_at, owner_user.id
    LIMIT 1
  )
FROM generated_spaces generated;

UPDATE "tenants" tenant
SET "default_space_id" = space.id
FROM "spaces" space
WHERE space.tenant_id = tenant.id
  AND space.mode = 'web'
  AND space.name = 'Default';

CREATE UNIQUE INDEX "tenants_default_space_id_key" ON "tenants"("default_space_id");

ALTER TABLE "tenants"
  ADD CONSTRAINT "tenants_default_space_id_id_fkey"
    FOREIGN KEY ("default_space_id", "id") REFERENCES "spaces"("id", "tenant_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 已有非 default tenant 从创建时模板语义开始拥有自己的配置行，不再依赖运行时
-- 回退。纯 UI 页面状态不是运行配置，不复制。
INSERT INTO "app_settings" ("tenant_id", "key", "value", "updated_at")
SELECT tenant.id, template.key, template.value, CURRENT_TIMESTAMP
FROM "tenants" tenant
JOIN "app_settings" template ON template.tenant_id = 'default'
WHERE tenant.id <> 'default'
  AND template.key NOT LIKE 'ui.%'
ON CONFLICT ("tenant_id", "key") DO NOTHING;

ALTER TABLE "threads"
  ADD COLUMN "executing_run_id" TEXT,
  ADD COLUMN "source_caller_id" TEXT,
  ADD COLUMN "source_ref" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "source_type" TEXT NOT NULL DEFAULT 'web',
  ADD COLUMN "space_id" TEXT;

UPDATE "threads" thread
SET "space_id" = tenant.default_space_id
FROM "tenants" tenant
WHERE tenant.id = thread.tenant_id;

ALTER TABLE "threads"
  ALTER COLUMN "space_id" SET NOT NULL,
  ADD CONSTRAINT "threads_source_type_check" CHECK (source_type IN ('web', 'external'));

CREATE UNIQUE INDEX "runs_id_thread_id_key" ON "runs"("id", "thread_id");
CREATE UNIQUE INDEX "threads_id_space_id_tenant_id_key" ON "threads"("id", "space_id", "tenant_id");
CREATE INDEX "idx_threads_space" ON "threads"("space_id", "updated_at" DESC);
CREATE INDEX "idx_threads_executing_run" ON "threads"("executing_run_id");

ALTER TABLE "threads"
  ADD CONSTRAINT "threads_space_id_tenant_id_fkey"
    FOREIGN KEY ("space_id", "tenant_id") REFERENCES "spaces"("id", "tenant_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- 旧版本允许同一 thread 留下多个非终态 run。迁移优先保留 active_run_id 指向的
-- run，否则保留最近更新的一条；其余标为 error，避免启动恢复再次并发执行。
WITH ranked_active_runs AS (
  SELECT
    run.id,
    row_number() OVER (
      PARTITION BY run.thread_id
      ORDER BY
        CASE WHEN run.id = thread.active_run_id THEN 0 ELSE 1 END,
        run.updated_at DESC,
        run.created_at DESC,
        run.id DESC
    ) AS position
  FROM "runs" run
  JOIN "threads" thread ON thread.id = run.thread_id
  WHERE run.status IN ('pending', 'running', 'waiting_for_user', 'canceling')
)
UPDATE "runs" run
SET
  status = 'error',
  error = COALESCE(run.error, '空间数据迁移时发现同一 thread 存在多个非终态 run，已停止重复 run。'),
  updated_at = CURRENT_TIMESTAMP
FROM ranked_active_runs ranked
WHERE run.id = ranked.id
  AND ranked.position > 1;

WITH current_active_run AS (
  SELECT
    run.id,
    run.thread_id,
    row_number() OVER (
      PARTITION BY run.thread_id
      ORDER BY
        CASE WHEN run.id = thread.active_run_id THEN 0 ELSE 1 END,
        run.updated_at DESC,
        run.created_at DESC,
        run.id DESC
    ) AS position
  FROM "runs" run
  JOIN "threads" thread ON thread.id = run.thread_id
  WHERE run.status IN ('pending', 'running', 'waiting_for_user', 'canceling')
)
UPDATE "threads" thread
SET "executing_run_id" = active_run.id
FROM current_active_run active_run
WHERE active_run.thread_id = thread.id
  AND active_run.position = 1;

ALTER TABLE "threads"
  ADD CONSTRAINT "threads_executing_run_id_fkey"
    FOREIGN KEY ("executing_run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE TABLE "external_callers" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "space_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "external_callers_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_callers_status_check" CHECK (status IN ('active', 'disabled'))
);

CREATE INDEX "idx_external_callers_space" ON "external_callers"("space_id", "status");
CREATE INDEX "idx_external_callers_tenant" ON "external_callers"("tenant_id", "status");

ALTER TABLE "external_callers"
  ADD CONSTRAINT "external_callers_space_id_tenant_id_fkey"
    FOREIGN KEY ("space_id", "tenant_id") REFERENCES "spaces"("id", "tenant_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "external_callers_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "threads"
  ADD CONSTRAINT "threads_source_caller_id_fkey"
    FOREIGN KEY ("source_caller_id") REFERENCES "external_callers"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE TABLE "external_requests" (
  "id" TEXT NOT NULL,
  "caller_id" TEXT NOT NULL,
  "operation" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'processing',
  "response" JSONB,
  "external_thread_ref" TEXT,
  "external_event_id" TEXT,
  "thread_id" TEXT,
  "run_id" TEXT,
  "error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "external_requests_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "external_requests_status_check" CHECK (status IN ('processing', 'succeeded', 'failed'))
);

CREATE UNIQUE INDEX "uq_external_requests_idempotency"
  ON "external_requests"("caller_id", "operation", "idempotency_key");
CREATE UNIQUE INDEX "uq_external_requests_thread_ref"
  ON "external_requests"("caller_id", "external_thread_ref");
CREATE UNIQUE INDEX "uq_external_requests_event_id"
  ON "external_requests"("caller_id", "external_event_id");
CREATE INDEX "idx_external_requests_run" ON "external_requests"("run_id", "created_at");
CREATE INDEX "idx_external_requests_thread" ON "external_requests"("thread_id", "created_at");

ALTER TABLE "external_requests"
  ADD CONSTRAINT "external_requests_caller_id_fkey"
    FOREIGN KEY ("caller_id") REFERENCES "external_callers"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "external_requests_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "external_requests_thread_id_fkey"
    FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE TABLE "external_tokens" (
  "id" TEXT NOT NULL,
  "caller_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL,
  "label" TEXT,
  "expires_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "last_used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "external_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "external_tokens_token_hash_key" ON "external_tokens"("token_hash");
CREATE INDEX "idx_external_tokens_caller" ON "external_tokens"("caller_id", "revoked_at", "expires_at");

ALTER TABLE "external_tokens"
  ADD CONSTRAINT "external_tokens_caller_id_fkey"
    FOREIGN KEY ("caller_id") REFERENCES "external_callers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE "run_inputs" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "caller_id" TEXT NOT NULL,
  "external_request_id" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "content" TEXT NOT NULL,
  "artifacts" JSONB NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_at" TIMESTAMPTZ(6),
  "canceled_at" TIMESTAMPTZ(6),

  CONSTRAINT "run_inputs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "run_inputs_version_check" CHECK (version > 0),
  CONSTRAINT "run_inputs_status_check" CHECK (status IN ('pending', 'applied', 'canceled'))
);

CREATE UNIQUE INDEX "run_inputs_external_request_id_key" ON "run_inputs"("external_request_id");
CREATE UNIQUE INDEX "run_inputs_run_id_version_key" ON "run_inputs"("run_id", "version");
CREATE INDEX "idx_run_inputs_pending" ON "run_inputs"("run_id", "status", "version");

ALTER TABLE "run_inputs"
  ADD CONSTRAINT "run_inputs_caller_id_fkey"
    FOREIGN KEY ("caller_id") REFERENCES "external_callers"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "run_inputs_external_request_id_fkey"
    FOREIGN KEY ("external_request_id") REFERENCES "external_requests"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "run_inputs_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE "artifacts" (
  "id" TEXT NOT NULL,
  "caller_id" TEXT NOT NULL,
  "space_id" TEXT NOT NULL,
  "thread_id" TEXT,
  "run_id" TEXT,
  "storage_key" TEXT NOT NULL,
  "original_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "size_bytes" BIGINT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'staged',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "materialized_at" TIMESTAMPTZ(6),

  CONSTRAINT "artifacts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "artifacts_size_bytes_check" CHECK (size_bytes >= 0),
  CONSTRAINT "artifacts_status_check" CHECK (status IN ('staged', 'materialized', 'deleted'))
);

CREATE UNIQUE INDEX "artifacts_storage_key_key" ON "artifacts"("storage_key");
CREATE INDEX "idx_artifacts_caller" ON "artifacts"("caller_id", "status", "created_at");
CREATE INDEX "idx_artifacts_scope" ON "artifacts"("space_id", "thread_id", "run_id");

ALTER TABLE "artifacts"
  ADD CONSTRAINT "artifacts_caller_id_fkey"
    FOREIGN KEY ("caller_id") REFERENCES "external_callers"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "artifacts_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "artifacts_space_id_fkey"
    FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "artifacts_thread_id_fkey"
    FOREIGN KEY ("thread_id") REFERENCES "threads"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

CREATE TABLE "plugin_deployments" (
  "id" TEXT NOT NULL,
  "plugin_id" TEXT NOT NULL,
  "version" TEXT NOT NULL,
  "content_hash" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "deployed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "plugin_deployments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "plugin_deployments_status_check" CHECK (status IN ('active', 'deleted'))
);

CREATE UNIQUE INDEX "plugin_deployments_plugin_id_version_content_hash_key"
  ON "plugin_deployments"("plugin_id", "version", "content_hash");
CREATE INDEX "idx_plugin_deployments_status" ON "plugin_deployments"("plugin_id", "status");

CREATE TABLE "provider_invocations" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "space_id" TEXT NOT NULL,
  "thread_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "step_id" TEXT,
  "purpose" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "logical_request" JSONB NOT NULL,
  "normalized_response" JSONB,
  "status" TEXT NOT NULL DEFAULT 'running',
  "error" TEXT,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMPTZ(6),

  CONSTRAINT "provider_invocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_invocations_status_check" CHECK (status IN ('running', 'success', 'error'))
);

CREATE INDEX "idx_provider_invocations_run" ON "provider_invocations"("run_id", "started_at");
CREATE INDEX "idx_provider_invocations_space" ON "provider_invocations"("tenant_id", "space_id", "started_at");

ALTER TABLE "provider_invocations"
  ADD CONSTRAINT "provider_invocations_run_id_thread_id_fkey"
    FOREIGN KEY ("run_id", "thread_id") REFERENCES "runs"("id", "thread_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_invocations_space_id_tenant_id_fkey"
    FOREIGN KEY ("space_id", "tenant_id") REFERENCES "spaces"("id", "tenant_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_invocations_step_id_fkey"
    FOREIGN KEY ("step_id") REFERENCES "steps"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "provider_invocations_thread_id_space_id_tenant_id_fkey"
    FOREIGN KEY ("thread_id", "space_id", "tenant_id") REFERENCES "threads"("id", "space_id", "tenant_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE "provider_attempts" (
  "id" TEXT NOT NULL,
  "invocation_id" TEXT NOT NULL,
  "attempt" INTEGER NOT NULL,
  "url" TEXT NOT NULL,
  "request_body" JSONB NOT NULL,
  "http_status" INTEGER,
  "provider_response_id" TEXT,
  "raw_stream" TEXT,
  "normalized_response" JSONB,
  "finish_reason" TEXT,
  "usage" JSONB,
  "status" TEXT NOT NULL DEFAULT 'running',
  "error" TEXT,
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "ended_at" TIMESTAMPTZ(6),

  CONSTRAINT "provider_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "provider_attempts_attempt_check" CHECK (attempt > 0),
  CONSTRAINT "provider_attempts_status_check" CHECK (status IN ('running', 'success', 'error'))
);

CREATE UNIQUE INDEX "provider_attempts_invocation_id_attempt_key"
  ON "provider_attempts"("invocation_id", "attempt");
CREATE INDEX "idx_provider_attempts_response_id" ON "provider_attempts"("provider_response_id");

ALTER TABLE "provider_attempts"
  ADD CONSTRAINT "provider_attempts_invocation_id_fkey"
    FOREIGN KEY ("invocation_id") REFERENCES "provider_invocations"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

CREATE TABLE "space_visible_users" (
  "space_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "space_visible_users_pkey" PRIMARY KEY ("space_id", "user_id")
);

CREATE UNIQUE INDEX "users_id_tenant_id_key" ON "users"("id", "tenant_id");
CREATE INDEX "idx_space_visible_users_user" ON "space_visible_users"("user_id", "space_id");

ALTER TABLE "space_visible_users"
  ADD CONSTRAINT "space_visible_users_space_id_tenant_id_fkey"
    FOREIGN KEY ("space_id", "tenant_id") REFERENCES "spaces"("id", "tenant_id")
    ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "space_visible_users_user_id_tenant_id_fkey"
    FOREIGN KEY ("user_id", "tenant_id") REFERENCES "users"("id", "tenant_id")
    ON DELETE CASCADE ON UPDATE NO ACTION;
