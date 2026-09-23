# RunForge 容器内 bwrap

RunForge 使用 `bwrap` 为各会话建立独立工作目录视图。Ubuntu 24.04 默认通过 AppArmor
限制非特权 user namespace，Docker 默认 seccomp 也会阻止 `bwrap` 建立嵌套 namespace，
因此生产宿主机必须同时安装本目录中的 AppArmor 和 seccomp 配置。

## 安装

在 Ubuntu 宿主机执行：

```bash
sudo install -d -m 0755 /etc/apparmor.d /opt/runforge/security
sudo install -m 0644 runforge-bwrap.apparmor /etc/apparmor.d/runforge-bwrap
sudo apparmor_parser -r -W /etc/apparmor.d/runforge-bwrap
sudo install -m 0644 runforge-bwrap-seccomp.json \
  /opt/runforge/security/runforge-bwrap-seccomp.json
```

确认 AppArmor 配置已经加载：

```bash
sudo aa-status | grep runforge-bwrap
```

## Compose

在 `runforge` 服务下配置：

```yaml
security_opt:
  - apparmor=runforge-bwrap
  - seccomp=/opt/runforge/security/runforge-bwrap-seccomp.json
  - systempaths=unconfined
```

Docker 默认会在容器 `/proc` 下创建锁定的覆盖挂载；Linux 6.8 会因此拒绝 `bwrap`
在新的 PID namespace 中挂载独立 `/proc`。`systempaths=unconfined` 只取消外层容器的这些
OCI 覆盖挂载；AppArmor、专用 seccomp、已丢弃的 capability 和内层 bwrap 仍然生效。
不能改成把外层 `/proc` 直接绑定进会话，否则会话能够看到 RunForge 容器中的其他进程。

然后重建服务：

```bash
cd /opt/runforge
sudo docker compose up -d --force-recreate runforge
sudo docker compose ps runforge
sudo docker compose logs --tail=100 runforge
```

RunForge 启动日志必须显示 `Tool sandbox: enforce` 和 `shell: bwrap`。在系统设置中保存
`enforce + bwrap` 并关闭容器直通执行后，新建一个执行 `pwd` 的任务；工具调用成功且路径位于
`/w/<spaceId>/c/<threadId>` 才表示实际会话沙箱验收完成。容器健康只证明服务启动，不证明
`bwrap` 可执行。

仓库中的 `generate-runforge-bwrap-seccomp.sh` 只用于维护已纳入版本控制的 seccomp 文件，
生产安装不在启动时下载规则。更新 Docker 大版本时，应按新版本依赖的
`moby/profiles/seccomp` 版本重新生成并验证，不能继续沿用未知版本的默认 seccomp 基线。
