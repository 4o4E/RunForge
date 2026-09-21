#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
staging_dir="${1:?需要提供输出目录}"
archive_url='https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-20-13-11/ffmpeg-n9.0.2-3-ga5923073bf-linux64-gpl-9.0.tar.xz'
archive_sha256='7569c7c00a421d4fb4636925a126e96e051bb5cdd0b0e0a91576ddfadddd9bff'
download_dir="$(mktemp -d)"
trap 'rm -rf "$download_dir"' EXIT
archive="$download_dir/ffmpeg.tar.xz"
curl --fail --location --retry 3 --output "$archive" "$archive_url"
printf '%s  %s\n' "$archive_sha256" "$archive" | sha256sum --check --status
tar -xJf "$archive" -C "$download_dir"
mkdir -p "$staging_dir/bin/linux-amd64"
for command_name in ffmpeg ffprobe; do
  source_path="$(find "$download_dir" -type f -name "$command_name" -perm -u+x -print -quit)"
  test -n "$source_path"
  file "$source_path" | grep -Eiq 'ELF .* executable'
  ldd_output="$(ldd "$source_path" 2>&1 || true)"
  if ! printf '%s\n' "$ldd_output" | grep -Eiq 'not a dynamic executable|statically linked'; then
    if printf '%s\n' "$ldd_output" | grep -Eiq 'lib(av|sw|postproc|x264|x265|vpx|aom|dav1d|opus|vorbis|mp3lame)'; then
      echo "$source_path 依赖外部音视频库，不能作为独立插件资源" >&2
      exit 1
    fi
  fi
  if printf '%s\n' "$ldd_output" | grep -Eiq 'not found'; then
    echo "$source_path 存在未满足的动态依赖" >&2
    exit 1
  fi
  cp -L "$source_path" "$staging_dir/bin/linux-amd64/$command_name"
  chmod 0755 "$staging_dir/bin/linux-amd64/$command_name"
done
cp "$root_dir/runforge.plugin.yaml" "$staging_dir/runforge.plugin.yaml"
cp -R "$root_dir/skills" "$staging_dir/skills"
chmod -R u+rwX,go+rX "$staging_dir/skills"
tar -C "$staging_dir" -czf "${staging_dir%/}.tgz" .
