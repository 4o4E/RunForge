#!/usr/bin/env bash
set -Eeuo pipefail

required=(
  DATABASE_URL
  RUNFORGE_JWT_SECRET
  RUNFORGE_SHARE_SECRET
  RUNFORGE_BOOTSTRAP_ADMIN_PASSWORD
  RUNFORGE_BOOTSTRAP_SYSADMIN_PASSWORD
)

for name in "${required[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    printf '缺少容器环境变量：%s\n' "${name}" >&2
    exit 1
  fi
done

cd /app/server
./node_modules/.bin/prisma migrate deploy
exec node dist/index.js
