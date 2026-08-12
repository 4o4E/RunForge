#!/usr/bin/env python3
"""用 WORKLOAD_TOKEN 换取本次 run 的短期凭证。"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any


DEFAULT_API_BASE = "http://localhost:8080/api/runtime"
DEFAULT_CAPABILITY_API_BASE = "http://localhost:8080/api/runtime-capabilities"


def _required(value: str | None, name: str) -> str:
    """读取必需配置，缺失时给出明确错误。"""
    if value and value.strip():
        return value.strip()
    raise RuntimeError(f"missing required environment variable: {name}")


def _runtime_headers(token: str) -> dict[str, str]:
    """构造运行时请求头；step id 只用于后端审计。"""
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    step_id = os.environ.get("RUNFORGE_STEP_ID")
    if step_id:
        headers["X-RunForge-Step-Id"] = step_id
    return headers


def get_datasource_credential(
    datasource_id: str | None = None,
    profile: str | None = None,
    token: str | None = None,
    api_base: str | None = None,
) -> dict[str, Any]:
    """返回短期数据库凭证；调用方负责避免打印或落盘。"""
    datasource_id = datasource_id or os.environ.get("DATASOURCE_ID")
    profile = profile or os.environ.get("DATASOURCE_PROFILE", "readonly")
    token = token or os.environ.get("WORKLOAD_TOKEN")
    api_base = (
        api_base
        or os.environ.get("RUNFORGE_RUNTIME_API_BASE")
        or os.environ.get("MY_AGENT_RUNTIME_API_BASE")
        or DEFAULT_API_BASE
    ).rstrip("/")

    datasource_id = _required(datasource_id, "DATASOURCE_ID")
    token = _required(token, "WORKLOAD_TOKEN")
    payload = json.dumps({"profile": profile}).encode("utf-8")
    request = urllib.request.Request(
        f"{api_base}/datasources/{datasource_id}/credentials",
        data=payload,
        method="POST",
        headers=_runtime_headers(token),
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"credential request failed: HTTP {err.code} {body}") from err


acquire_datasource_credential = get_datasource_credential


def _capability_api_base(api_base: str | None = None) -> str:
    """返回 runtime-capabilities 根路径，兼容只注入 RUNFORGE_RUNTIME_API_BASE 的旧环境。"""
    explicit = api_base or os.environ.get("RUNFORGE_RUNTIME_CAPABILITIES_API_BASE")
    if explicit:
        return explicit.rstrip("/")
    runtime_base = os.environ.get("RUNFORGE_RUNTIME_API_BASE") or os.environ.get("MY_AGENT_RUNTIME_API_BASE")
    if runtime_base and runtime_base.rstrip("/").endswith("/api/runtime"):
        return runtime_base.rstrip("/")[:-len("/api/runtime")] + "/api/runtime-capabilities"
    return DEFAULT_CAPABILITY_API_BASE


def get_runtime_capability_credential(
    capability: str,
    token: str | None = None,
    api_base: str | None = None,
) -> dict[str, Any]:
    """换取内部能力代理配置；不会返回上游真实 API key。"""
    token = _required(token or os.environ.get("WORKLOAD_TOKEN"), "WORKLOAD_TOKEN")
    payload = json.dumps({"capability": capability}).encode("utf-8")
    request = urllib.request.Request(
        f"{_capability_api_base(api_base)}/credentials",
        data=payload,
        method="POST",
        headers=_runtime_headers(token),
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"runtime capability credential request failed: HTTP {err.code} {body}") from err


def main() -> None:
    parser = argparse.ArgumentParser(description="Fetch a short-lived datasource credential for this run.")
    parser.add_argument("--datasource-id", default=None)
    parser.add_argument("--profile", default=None)
    parser.add_argument("--api-base", default=None)
    parser.add_argument("--print-json", action="store_true", help="调试用途：把凭证 JSON 输出到 stdout，注意不要写入日志")
    args = parser.parse_args()

    credential = get_datasource_credential(args.datasource_id, args.profile, api_base=args.api_base)
    if args.print_json:
        json.dump(credential, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    else:
        safe = {k: v for k, v in credential.items() if k not in {"password", "connection"}}
        json.dump(safe, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
