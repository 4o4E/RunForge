-- execution user 和 created_by 都只能引用空间所属 tenant 内的用户。
-- 前一条迁移已经在开发数据库执行，因此这里追加约束迁移，不改写历史 migration。

ALTER TABLE "spaces"
  DROP CONSTRAINT "spaces_execution_user_id_fkey",
  DROP CONSTRAINT "spaces_created_by_user_id_fkey";

ALTER TABLE "spaces"
  ADD CONSTRAINT "spaces_execution_user_id_tenant_id_fkey"
    FOREIGN KEY ("execution_user_id", "tenant_id") REFERENCES "users"("id", "tenant_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT "spaces_created_by_user_id_tenant_id_fkey"
    FOREIGN KEY ("created_by_user_id", "tenant_id") REFERENCES "users"("id", "tenant_id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;
