#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="${ROOT_DIR}/.run"
LOG_DIR="${ROOT_DIR}/logs"
PID_FILE="${RUN_DIR}/runforge.pid"
LOG_FILE="${LOG_DIR}/runforge.log"
PNPM_BIN="${PNPM_BIN:-pnpm}"

info() {
  printf '%s\n' "$*"
}

fail() {
  printf '错误: %s\n' "$*" >&2
  exit 1
}

require_linux() {
  # 这里依赖 setsid 和按进程组停止，只面向 Linux 服务脚本。
  [[ "$(uname -s)" == "Linux" ]] || fail "当前脚本只支持 Linux 平台"
  command -v setsid >/dev/null 2>&1 || fail "未找到 setsid，无法创建独立进程组"
}

read_pid() {
  [[ -f "${PID_FILE}" ]] && tr -d '[:space:]' <"${PID_FILE}" || true
}

is_pid() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

is_running() {
  local pid="${1:-}"
  is_pid "${pid}" && kill -0 "${pid}" 2>/dev/null
}

require_pnpm() {
  command -v "${PNPM_BIN}" >/dev/null 2>&1 || fail "未找到 pnpm，请先安装 pnpm"
}

require_installed_deps() {
  # pnpm 会创建 node_modules/.pnpm；没有它通常表示还没执行 pnpm install。
  [[ -d "${ROOT_DIR}/node_modules/.pnpm" ]] || fail "未检测到 pnpm 依赖目录，请先在项目根目录执行 pnpm install"
}

start_app() {
  require_linux
  require_pnpm
  require_installed_deps

  mkdir -p "${RUN_DIR}" "${LOG_DIR}"

  local old_pid
  old_pid="$(read_pid)"
  if is_running "${old_pid}"; then
    info "RunForge 已在运行，PID: ${old_pid}"
    return 0
  fi
  [[ -n "${old_pid}" ]] && rm -f "${PID_FILE}"

  info "启动 RunForge，日志: ${LOG_FILE}"
  (
    cd "${ROOT_DIR}"
    exec setsid bash -c 'printf "%s\n" "$$" > "$1"; exec "$2" dev' bash "${PID_FILE}" "${PNPM_BIN}"
  ) >>"${LOG_FILE}" 2>&1 &

  local new_pid=""
  for _ in {1..20}; do
    new_pid="$(read_pid)"
    if is_running "${new_pid}"; then
      info "RunForge 已启动，PID: ${new_pid}"
      return 0
    fi
    sleep 0.2
  done

  rm -f "${PID_FILE}"
  fail "RunForge 启动失败，请查看日志: ${LOG_FILE}"
}

stop_app() {
  require_linux

  local pid
  pid="$(read_pid)"
  if [[ -z "${pid}" ]]; then
    info "RunForge 未运行"
    return 0
  fi
  is_pid "${pid}" || fail "PID 文件内容非法: ${PID_FILE}"

  if ! is_running "${pid}"; then
    rm -f "${PID_FILE}"
    info "RunForge 未运行，已清理过期 PID 文件"
    return 0
  fi

  info "停止 RunForge，PID: ${pid}"
  kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true

  for _ in {1..20}; do
    if ! is_running "${pid}"; then
      rm -f "${PID_FILE}"
      info "RunForge 已停止"
      return 0
    fi
    sleep 1
  done

  kill -KILL "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null || true
  rm -f "${PID_FILE}"
  info "RunForge 已强制停止"
}

restart_app() {
  stop_app
  start_app
}

case "${1:-}" in
  start)
    start_app
    ;;
  stop)
    stop_app
    ;;
  restart)
    restart_app
    ;;
  *)
    fail "用法: $0 {start|stop|restart}"
    ;;
esac
