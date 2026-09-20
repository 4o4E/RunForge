#!/usr/bin/env bash
set -Eeuo pipefail

root="${1:?必须提供生产部署目录}"
modules="${root}/node_modules"

# Node.js 运行时不会读取类型声明和 source map，发布镜像不携带这些开发文件。
find "${modules}" -type f \( \
  -name '*.map' -o \
  -name '*.d.ts' -o \
  -name '*.d.mts' -o \
  -name '*.d.cts' \
\) -delete

# RunForge 只使用 PostgreSQL，保留对应的 Prisma 查询编译器。
find "${modules}" -type f -name 'query_compiler_*' ! -name '*postgresql*' -delete

find "${modules}" -depth -type d -empty -delete
