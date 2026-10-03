#!/usr/bin/env bash
set -Eeuo pipefail

: "${DATABASE_URL:?PostgreSQL 集成验证必须连接本次 CI 创建的临时数据库}"

pnpm db:migrate
pnpm --filter server exec tsx src/evals/preparePostgresVerification.ts
pnpm --filter server exec tsx src/evals/prismaStoreVerification.ts
pnpm --filter server exec tsx src/evals/spaceRuntimeVerification.ts
pnpm --filter server exec tsx src/evals/stepHistoryVerification.ts
pnpm --filter server exec node --import tsx src/evals/shellShutdownVerification.ts
