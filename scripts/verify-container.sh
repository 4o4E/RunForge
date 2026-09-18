#!/usr/bin/env bash
set -Eeuo pipefail

POSTGRES_USER=runforge
POSTGRES_PASSWORD=runforge-ci-password
POSTGRES_DB=runforge
RUNFORGE_JWT_SECRET=runforge-ci-jwt-secret-with-more-than-32-characters
RUNFORGE_SHARE_SECRET=runforge-ci-share-secret-with-more-than-32-characters
RUNFORGE_BOOTSTRAP_ADMIN_PASSWORD=runforge-ci-admin-password
RUNFORGE_BOOTSTRAP_SYSADMIN_PASSWORD=runforge-ci-sysadmin-password
export POSTGRES_PASSWORD
export RUNFORGE_JWT_SECRET RUNFORGE_SHARE_SECRET
export RUNFORGE_BOOTSTRAP_ADMIN_PASSWORD RUNFORGE_BOOTSTRAP_SYSADMIN_PASSWORD
export DATABASE_URL="postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@host.docker.internal:55432/${POSTGRES_DB}"

POSTGRES_COMPOSE=(
  docker compose
  --project-name runforge-ci-postgres
  -f deploy/compose.postgres.yml
  -f deploy/compose.ci.yml
)
EXTERNAL_COMPOSE=(
  docker compose
  --project-name runforge-ci-external
  -f deploy/compose.external-postgres.yml
  -f deploy/compose.ci.yml
)

cleanup() {
  "${POSTGRES_COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  "${EXTERNAL_COMPOSE[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
  docker rm --force runforge-ci-external-postgres >/dev/null 2>&1 || true
}

finish() {
  local status="$?"
  if [[ "${status}" -ne 0 ]]; then
    "${POSTGRES_COMPOSE[@]}" logs --no-color || true
    "${EXTERNAL_COMPOSE[@]}" logs --no-color || true
    docker logs runforge-ci-external-postgres || true
  fi
  cleanup
  exit "${status}"
}
trap finish EXIT

wait_http() {
  local url="$1"
  for _ in {1..90}; do
    if curl --fail --silent "${url}/health" | grep --quiet '"ok":true'; then
      curl --fail --silent "${url}/" | grep --quiet 'id="root"'
      return 0
    fi
    sleep 2
  done
  return 1
}

"${POSTGRES_COMPOSE[@]}" config --quiet
"${POSTGRES_COMPOSE[@]}" up --detach
wait_http http://127.0.0.1:8080
"${POSTGRES_COMPOSE[@]}" down --volumes

docker run --detach \
  --name runforge-ci-external-postgres \
  --publish 55432:5432 \
  --env POSTGRES_USER="${POSTGRES_USER}" \
  --env POSTGRES_PASSWORD="${POSTGRES_PASSWORD}" \
  --env POSTGRES_DB="${POSTGRES_DB}" \
  postgres:16-bookworm

for _ in {1..60}; do
  if docker exec runforge-ci-external-postgres pg_isready --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" >/dev/null; then
    break
  fi
  sleep 1
done
docker exec runforge-ci-external-postgres pg_isready --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}"

"${EXTERNAL_COMPOSE[@]}" config --quiet
"${EXTERNAL_COMPOSE[@]}" up --detach
wait_http http://127.0.0.1:8080
