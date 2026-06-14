#!/usr/bin/env python3
"""用短期凭证执行 psql 查询，避免把密码打印到工具输出。"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

from db_credential import acquire_datasource_credential


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a read-only PostgreSQL query with a leased datasource credential.")
    parser.add_argument("--sql", help="要执行的 SQL；和 --file 二选一")
    parser.add_argument("--file", help="读取 SQL 的文件路径；和 --sql 二选一")
    parser.add_argument("--psql", default=os.environ.get("PSQL_BIN", "psql"))
    args = parser.parse_args()

    if bool(args.sql) == bool(args.file):
        raise SystemExit("必须且只能提供 --sql 或 --file")

    sql = args.sql if args.sql else Path(args.file).read_text(encoding="utf-8")
    credential = acquire_datasource_credential()
    env = {
        **os.environ,
        "PGPASSWORD": str(credential["password"]),
    }
    cmd = [
        args.psql,
        "-h",
        str(credential.get("host") or credential["connection"].get("host")),
        "-p",
        str(credential.get("port") or credential["connection"].get("port") or 5432),
        "-U",
        str(credential["username"]),
        "-d",
        str(credential.get("database") or credential["connection"].get("database")),
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
    ]
    completed = subprocess.run(cmd, env=env, check=False, text=True)
    return completed.returncode


if __name__ == "__main__":
    sys.exit(main())
