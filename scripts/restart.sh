#!/usr/bin/env bash
set -Eeuo pipefail

bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/runforge.sh" restart
