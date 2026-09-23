-- 存储占用是时点值，不是文件操作流水。小时样本保留近期变化，日样本保留长期趋势；
-- tenant/user/space 维度均来自数据库归属，不能从目录名称猜测用户身份。
CREATE TABLE "storage_usage_samples" (
  "id" BIGSERIAL PRIMARY KEY,
  "period" TEXT NOT NULL,
  "period_start" TIMESTAMPTZ NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "user_id" TEXT,
  "space_id" TEXT,
  "category" TEXT NOT NULL,
  "logical_bytes" BIGINT NOT NULL DEFAULT 0,
  "allocated_bytes" BIGINT NOT NULL DEFAULT 0,
  "file_count" BIGINT NOT NULL DEFAULT 0,
  "symlink_count" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "storage_usage_samples_period_check" CHECK ("period" IN ('hour', 'day')),
  CONSTRAINT "storage_usage_samples_tenant_fk" FOREIGN KEY ("tenant_id")
    REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "storage_usage_samples_user_fk" FOREIGN KEY ("user_id", "tenant_id")
    REFERENCES "users"("id", "tenant_id") ON DELETE CASCADE,
  CONSTRAINT "storage_usage_samples_space_fk" FOREIGN KEY ("space_id", "tenant_id")
    REFERENCES "spaces"("id", "tenant_id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "uq_storage_usage_samples_bucket"
  ON "storage_usage_samples" (
    "period",
    "period_start",
    "tenant_id",
    COALESCE("user_id", ''),
    COALESCE("space_id", ''),
    "category"
  );
CREATE INDEX "idx_storage_usage_samples_period"
  ON "storage_usage_samples"("period", "period_start" DESC);
CREATE INDEX "idx_storage_usage_samples_tenant"
  ON "storage_usage_samples"("tenant_id", "period_start" DESC);
CREATE INDEX "idx_storage_usage_samples_user"
  ON "storage_usage_samples"("tenant_id", "user_id", "period_start" DESC);
CREATE INDEX "idx_storage_usage_samples_space"
  ON "storage_usage_samples"("tenant_id", "space_id", "period_start" DESC);
