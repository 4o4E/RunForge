#!/usr/bin/env bash

# 用 WORKLOAD_TOKEN 换取本次 run 的短期凭证。
# 用法：source ./db_credential.sh && db_credential_json

db_credential_json() {
  local datasource_id="${1:-${DATASOURCE_ID:-}}"
  local profile="${2:-${DATASOURCE_PROFILE:-readonly}}"
  local api_base="${RUNFORGE_RUNTIME_API_BASE:-${MY_AGENT_RUNTIME_API_BASE:-http://localhost:8080/api/runtime}}"
  local step_headers=()
  if [ -n "${RUNFORGE_STEP_ID:-}" ]; then
    step_headers=(-H "X-RunForge-Step-Id: $RUNFORGE_STEP_ID")
  fi

  if [ -z "$datasource_id" ]; then
    echo "missing DATASOURCE_ID" >&2
    return 2
  fi
  if [ -z "${WORKLOAD_TOKEN:-}" ]; then
    echo "missing WORKLOAD_TOKEN" >&2
    return 2
  fi

  curl -fsS -X POST "${api_base%/}/datasources/$datasource_id/credentials" \
    -H "Authorization: Bearer $WORKLOAD_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    "${step_headers[@]}" \
    -d "{\"profile\":\"$profile\"}"
}

get_datasource_credential_json() {
  db_credential_json "$@"
}

runtime_capability_credential_json() {
  local capability="${1:-}"
  local runtime_base="${RUNFORGE_RUNTIME_API_BASE:-${MY_AGENT_RUNTIME_API_BASE:-http://localhost:8080/api/runtime}}"
  local api_base="${RUNFORGE_RUNTIME_CAPABILITIES_API_BASE:-${runtime_base%/api/runtime}/api/runtime-capabilities}"
  local step_headers=()
  if [ -n "${RUNFORGE_STEP_ID:-}" ]; then
    step_headers=(-H "X-RunForge-Step-Id: $RUNFORGE_STEP_ID")
  fi

  if [ -z "$capability" ]; then
    echo "missing capability" >&2
    return 2
  fi
  if [ -z "${WORKLOAD_TOKEN:-}" ]; then
    echo "missing WORKLOAD_TOKEN" >&2
    return 2
  fi

  curl -fsS -X POST "${api_base%/}/credentials" \
    -H "Authorization: Bearer $WORKLOAD_TOKEN" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json" \
    "${step_headers[@]}" \
    -d "{\"capability\":\"$capability\"}"
}

db_redact_credential_json() {
  # 调试用途：从 stdin 读取凭证 JSON，移除 password 和 connection 后输出。
  python -c 'import json,sys; data=json.load(sys.stdin); data.pop("password", None); data.pop("connection", None); print(json.dumps(data, ensure_ascii=False))'
}
