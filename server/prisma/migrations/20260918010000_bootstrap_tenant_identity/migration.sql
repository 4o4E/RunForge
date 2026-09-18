-- DropForeignKey
ALTER TABLE "app_settings" DROP CONSTRAINT "app_settings_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "auth_tokens" DROP CONSTRAINT "auth_tokens_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "datasources" DROP CONSTRAINT "datasources_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "external_callers" DROP CONSTRAINT "external_callers_space_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "external_callers" DROP CONSTRAINT "external_callers_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "provider_invocations" DROP CONSTRAINT "provider_invocations_space_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "provider_invocations" DROP CONSTRAINT "provider_invocations_thread_id_space_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "push_subscriptions" DROP CONSTRAINT "push_subscriptions_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "runtime_capability_calls" DROP CONSTRAINT "runtime_capability_calls_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "shell_sessions" DROP CONSTRAINT "shell_sessions_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "space_visible_users" DROP CONSTRAINT "space_visible_users_space_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "space_visible_users" DROP CONSTRAINT "space_visible_users_user_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "spaces" DROP CONSTRAINT "spaces_created_by_user_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "spaces" DROP CONSTRAINT "spaces_execution_user_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "spaces" DROP CONSTRAINT "spaces_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "subagent_runs" DROP CONSTRAINT "subagent_runs_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_default_space_id_id_fkey";

-- DropForeignKey
ALTER TABLE "threads" DROP CONSTRAINT "threads_space_id_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "threads" DROP CONSTRAINT "threads_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "users" DROP CONSTRAINT "users_tenant_id_fkey";

-- DropForeignKey
ALTER TABLE "workload_secret_access_logs" DROP CONSTRAINT "workload_secret_access_logs_tenant_id_fkey";

-- AlterTable
ALTER TABLE "app_settings" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "datasources" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "push_subscriptions" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "shell_sessions" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "subagent_runs" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN "is_bootstrap" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "threads" ALTER COLUMN "tenant_id" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "uq_tenants_bootstrap" ON "tenants"("is_bootstrap") WHERE (is_bootstrap);

-- AddForeignKey
ALTER TABLE "app_settings" ADD CONSTRAINT "app_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "datasources" ADD CONSTRAINT "datasources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_callers" ADD CONSTRAINT "external_callers_space_id_tenant_id_fkey" FOREIGN KEY ("space_id", "tenant_id") REFERENCES "spaces"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_callers" ADD CONSTRAINT "external_callers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_invocations" ADD CONSTRAINT "provider_invocations_space_id_tenant_id_fkey" FOREIGN KEY ("space_id", "tenant_id") REFERENCES "spaces"("id", "tenant_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "provider_invocations" ADD CONSTRAINT "provider_invocations_thread_id_space_id_tenant_id_fkey" FOREIGN KEY ("thread_id", "space_id", "tenant_id") REFERENCES "threads"("id", "space_id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_execution_user_id_tenant_id_fkey" FOREIGN KEY ("execution_user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "spaces" ADD CONSTRAINT "spaces_created_by_user_id_tenant_id_fkey" FOREIGN KEY ("created_by_user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_visible_users" ADD CONSTRAINT "space_visible_users_space_id_tenant_id_fkey" FOREIGN KEY ("space_id", "tenant_id") REFERENCES "spaces"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_visible_users" ADD CONSTRAINT "space_visible_users_user_id_tenant_id_fkey" FOREIGN KEY ("user_id", "tenant_id") REFERENCES "users"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "runtime_capability_calls" ADD CONSTRAINT "runtime_capability_calls_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shell_sessions" ADD CONSTRAINT "shell_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subagent_runs" ADD CONSTRAINT "subagent_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_default_space_id_id_fkey" FOREIGN KEY ("default_space_id", "id") REFERENCES "spaces"("id", "tenant_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_space_id_tenant_id_fkey" FOREIGN KEY ("space_id", "tenant_id") REFERENCES "spaces"("id", "tenant_id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "threads" ADD CONSTRAINT "threads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workload_secret_access_logs" ADD CONSTRAINT "workload_secret_access_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
