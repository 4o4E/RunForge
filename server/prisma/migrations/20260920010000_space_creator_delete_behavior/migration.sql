-- `created_by_user_id` 只用于审计。单列外键确保删除用户时只清空创建者，保留空间的 tenant 归属。
ALTER TABLE "spaces" DROP CONSTRAINT "spaces_created_by_user_id_tenant_id_fkey";

ALTER TABLE "spaces" ADD CONSTRAINT "spaces_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
