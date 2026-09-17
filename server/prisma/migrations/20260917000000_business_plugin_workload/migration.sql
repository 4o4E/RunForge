CREATE TABLE "workload_secret_access_logs" (
  "id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "step_id" TEXT,
  "token_id" TEXT NOT NULL,
  "accessor" TEXT NOT NULL,
  "secret_key" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "error_code" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "workload_secret_access_logs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workload_secret_access_logs_accessor_check"
    CHECK ("accessor" IN ('backend', 'workload')),
  CONSTRAINT "workload_secret_access_logs_status_check"
    CHECK ("status" IN ('success', 'denied', 'error'))
);

CREATE INDEX "idx_workload_secret_access_tenant"
  ON "workload_secret_access_logs"("tenant_id", "created_at" DESC);
CREATE INDEX "idx_workload_secret_access_run"
  ON "workload_secret_access_logs"("run_id", "created_at" DESC);
CREATE INDEX "idx_workload_secret_access_key"
  ON "workload_secret_access_logs"("secret_key", "created_at" DESC);

ALTER TABLE "workload_secret_access_logs"
  ADD CONSTRAINT "workload_secret_access_logs_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "workload_secret_access_logs_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "runs"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  ADD CONSTRAINT "workload_secret_access_logs_step_id_fkey"
    FOREIGN KEY ("step_id") REFERENCES "steps"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
  ADD CONSTRAINT "workload_secret_access_logs_token_id_fkey"
    FOREIGN KEY ("token_id") REFERENCES "workload_tokens"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- 该表对应已明确否决的 RunForge 自管业务插件产物库，且现有代码从未使用。
DROP TABLE "plugin_deployments";
