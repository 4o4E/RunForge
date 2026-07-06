# pnpm 与 Linux 启停脚本实施记录

## 目标

- 将根依赖编排从 npm workspaces 切换为 pnpm workspace。
- 提供 Linux 平台可直接使用的 `start` / `stop` / `restart` 脚本。
- 同步 README，避免安装、迁移、开发、测试命令仍指向 npm。

## 阶段 1：配置与脚本

- 根 `package.json` 去掉 npm `workspaces` 字段，改用 `pnpm-workspace.yaml` 声明 `server` 和 `web` 包。
- 根脚本统一改为 `pnpm --filter` 调用，避免 npm workspace 参数继续留在入口命令里。
- 根 `package.json` 声明 `packageManager: pnpm@11.5.3`。
- `pnpm-workspace.yaml` 显式允许 `esbuild` / `protobufjs` 执行安装期构建脚本，避免 pnpm 11 的供应链保护在可预期依赖上阻断安装。
- 当前锁文件中的 `@ai-sdk/react@3.0.203`、`@types/node@25.9.3`、`ai@6.0.201` 仍处于 pnpm minimum release age 策略窗口内，`pnpm-workspace.yaml` 保留对应例外，否则 `pnpm install --frozen-lockfile` 会失败。
- 新增 `scripts/runforge.sh` 作为共享实现，`scripts/start.sh` / `stop.sh` / `restart.sh` 作为稳定入口。
- 启动脚本使用 Linux `setsid` 建立独立进程组，停止脚本按进程组发送信号，确保后端、前端和 `concurrently` 一起退出。
- `.run/` 保存 PID，`logs/` 保存运行日志，并加入 `.gitignore`。

## 阶段 2：文档同步

- README 的安装、迁移、开发、测试命令从 npm 改为 pnpm。
- README 新增 Linux 启停脚本说明，标明 PID 与日志位置。
- restart 文档使用 `pnpm run restart`，避免 `pnpm restart` 触发 pnpm 兼容 npm 的 `stop -> restart -> start` 生命周期语义。
