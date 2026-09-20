-- AlterTable
ALTER TABLE "users" ADD COLUMN "is_bootstrap" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "system_admins" ADD COLUMN "is_bootstrap" BOOLEAN NOT NULL DEFAULT false;

-- 将已有部署中的引导账号固定标记下来。优先使用标准邮箱，兼容旧数据时选择最早创建的账号。
WITH bootstrap_user AS (
  SELECT u.id
  FROM "users" u
  JOIN "tenants" t ON t.id = u.tenant_id
  WHERE t.is_bootstrap
  ORDER BY (u.email = 'admin@local') DESC, (u.role = 'owner') DESC, u.created_at, u.id
  LIMIT 1
)
UPDATE "users"
SET "is_bootstrap" = true
WHERE id = (SELECT id FROM bootstrap_user);

WITH bootstrap_system_admin AS (
  SELECT id
  FROM "system_admins"
  ORDER BY (email = 'sysadmin@local') DESC, created_at, id
  LIMIT 1
)
UPDATE "system_admins"
SET "is_bootstrap" = true
WHERE id = (SELECT id FROM bootstrap_system_admin);

-- CreateIndex
CREATE UNIQUE INDEX "uq_users_bootstrap" ON "users"("is_bootstrap") WHERE (is_bootstrap);

-- CreateIndex
CREATE UNIQUE INDEX "uq_system_admins_bootstrap" ON "system_admins"("is_bootstrap") WHERE (is_bootstrap);

-- 已有软删除空间不再保留。
UPDATE "tenants" t
SET "default_space_id" = (
  SELECT s.id
  FROM "spaces" s
  WHERE s.tenant_id = t.id AND s.deleted_at IS NULL AND s.mode = 'web'
  ORDER BY s.created_at, s.id
  LIMIT 1
)
WHERE t.default_space_id IN (
  SELECT id FROM "spaces" WHERE deleted_at IS NOT NULL
);

ALTER TABLE "spaces" DROP CONSTRAINT "spaces_created_by_user_id_tenant_id_fkey";
ALTER TABLE "provider_invocations" DROP CONSTRAINT "provider_invocations_space_id_tenant_id_fkey";
ALTER TABLE "threads" DROP CONSTRAINT "threads_space_id_tenant_id_fkey";
ALTER TABLE "threads" DROP CONSTRAINT "threads_tenant_id_fkey";
ALTER TABLE "threads" DROP CONSTRAINT "threads_user_id_fkey";
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_tenant_id_fkey";
ALTER TABLE "datasources" DROP CONSTRAINT "datasources_tenant_id_fkey";
ALTER TABLE "push_subscriptions" DROP CONSTRAINT "push_subscriptions_tenant_id_fkey";
ALTER TABLE "push_subscriptions" DROP CONSTRAINT "push_subscriptions_user_id_fkey";
ALTER TABLE "runtime_capability_calls" DROP CONSTRAINT "runtime_capability_calls_tenant_id_fkey";
ALTER TABLE "shell_sessions" DROP CONSTRAINT "shell_sessions_tenant_id_fkey";
ALTER TABLE "subagent_runs" DROP CONSTRAINT "subagent_runs_tenant_id_fkey";
ALTER TABLE "workload_secret_access_logs" DROP CONSTRAINT "workload_secret_access_logs_tenant_id_fkey";

-- 删除软删除空间及其全部关联数据。
DELETE FROM "threads" WHERE "space_id" IN (SELECT "id" FROM "spaces" WHERE "deleted_at" IS NOT NULL);
DELETE FROM "spaces" WHERE "deleted_at" IS NOT NULL;

DROP INDEX "idx_spaces_tenant";
ALTER TABLE "spaces" DROP COLUMN "deleted_at";
CREATE INDEX "idx_spaces_tenant" ON "spaces"("tenant_id", "created_at");

ALTER TABLE "spaces" ADD CONSTRAINT "spaces_created_by_user_id_tenant_id_fkey"
  FOREIGN KEY ("created_by_user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "provider_invocations" ADD CONSTRAINT "provider_invocations_space_id_tenant_id_fkey"
  FOREIGN KEY ("space_id", "tenant_id") REFERENCES "spaces"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "threads" ADD CONSTRAINT "threads_space_id_tenant_id_fkey"
  FOREIGN KEY ("space_id", "tenant_id") REFERENCES "spaces"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "threads" ADD CONSTRAINT "threads_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "threads" ADD CONSTRAINT "threads_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "datasources" ADD CONSTRAINT "datasources_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "runtime_capability_calls" ADD CONSTRAINT "runtime_capability_calls_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "shell_sessions" ADD CONSTRAINT "shell_sessions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subagent_runs" ADD CONSTRAINT "subagent_runs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "workload_secret_access_logs" ADD CONSTRAINT "workload_secret_access_logs_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
