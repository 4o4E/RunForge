#!/usr/bin/env bash

# 用 workload token 换取本次 run 的短期数据库凭证。
# 用法：source ./db_credential.sh && db_credential_json

db_credential_json() {
  local datasource_id="${1:-${DATASOURCE_ID:-}}"
  local profile="${2:-${DATASOURCE_PROFILE:-readonly}}"
  local api_base="${RUNFORGE_RUNTIME_API_BASE:-${MY_AGENT_RUNTIME_API_BASE:-http://localhost:8080/api/runtime}}"

  if [ -z "$datasource_id" ]; then
    echo "missing DATASOURCE_ID" >&2
    return 2
  fi
  if [ -z "${DB_WORKLOAD_TOKEN:-}" ]; then
    echo "missing DB_WORKLOAD_TOKEN" >&2
    return 2
  fi

  curl -fsS -X POST "${api_base%/}/datasources/$datasource_id/credentials" \
    -H "Authorization: Bearer $DB_WORKLOAD_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    -d "{\"profile\":\"$profile\"}"
}

db_redact_credential_json() {
  # 调试用途：从 stdin 读取凭证 JSON，移除 password 和 connection 后输出。
  python -c 'import json,sys; data=json.load(sys.stdin); data.pop("password", None); data.pop("connection", None); print(json.dumps(data, ensure_ascii=False))'
}
