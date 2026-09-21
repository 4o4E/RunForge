#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
staging_dir="${1:?需要提供输出目录}"
mkdir -p "$staging_dir/bin/linux-amd64"
cp "$root_dir/runforge.plugin.yaml" "$staging_dir/runforge.plugin.yaml"
cp "$root_dir/README.md" "$staging_dir/README.md"
cp -R "$root_dir/skills" "$staging_dir/skills"
cp "$root_dir/bin/linux-amd64/BBDown" "$staging_dir/bin/linux-amd64/BBDown"
chmod -R u+rwX,go+rX "$staging_dir/skills"
chmod 0755 "$staging_dir/bin/linux-amd64/BBDown"
tar -C "$staging_dir" -czf "${staging_dir%/}.tgz" .
