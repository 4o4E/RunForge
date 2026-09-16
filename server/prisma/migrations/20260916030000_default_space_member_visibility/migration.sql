-- 既有 member 升级后仍应能看到并继续使用所属 tenant 的 default 空间。
-- 后续新用户继续由空间管理员显式加入可见名单，不建立自动授权触发器。
INSERT INTO "space_visible_users" ("space_id", "user_id", "tenant_id")
SELECT tenant."default_space_id", app_user."id", app_user."tenant_id"
FROM "users" app_user
JOIN "tenants" tenant ON tenant."id" = app_user."tenant_id"
WHERE app_user."role" = 'member'
  AND tenant."default_space_id" IS NOT NULL
ON CONFLICT ("space_id", "user_id") DO NOTHING;
