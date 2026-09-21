#!/usr/bin/env bash
set -Eeuo pipefail

# Docker 28.5.0 依赖 moby/profiles seccomp v0.1.0；固定源码提交，避免上游 main
# 变化后生成的生产规则与当前 Docker 版本不一致。
readonly source_url='https://raw.githubusercontent.com/moby/profiles/c936cc7b4074219137bc0bee45670f5e4618d462/seccomp/default.json'
readonly output_path="${1:-./runforge-bwrap-seccomp.json}"
temporary_path="$(mktemp)"
trap 'rm -f "$temporary_path"' EXIT

curl --fail --silent --show-error --location "$source_url" |
  jq '.syscalls = ([{
    "names": ["clone", "clone3", "unshare", "mount", "umount2", "pivot_root", "setns"],
    "action": "SCMP_ACT_ALLOW",
    "args": [],
    "comment": "RunForge bwrap namespace setup",
    "includes": {},
    "excludes": {}
  }] + .syscalls)' >"$temporary_path"

jq --exit-status '
  .defaultAction == "SCMP_ACT_ERRNO"
  and any(.syscalls[]; .comment == "RunForge bwrap namespace setup")
' "$temporary_path" >/dev/null
install -m 0644 "$temporary_path" "$output_path"
