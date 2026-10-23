# 部署与验证

## Purpose

约定单实例部署、迁移入口与验证证据。实现入口：`Dockerfile`、`deploy/`、`docker/entrypoint.sh`、`scripts/ci/`；使用入口见 `README.md`。

## Requirements

### Requirement: 两种 PostgreSQL 部署方式

系统 SHALL 提供自带 PostgreSQL 和外部 PostgreSQL 两套 Compose，应用镜像包含前后端，默认使用 `ghcr.io/4o4e/runforge:latest`，并分别持久化工作区、用户文件、业务插件和 trace。

#### Scenario: 使用外部数据库部署
- **WHEN** 运维选择外部 PostgreSQL 模板
- **THEN** Compose 只启动应用，不要求创建第二个 PostgreSQL 服务或迁移原数据库目录

### Requirement: 迁移先于应用启动

镜像 SHALL 在启动 HTTP/WebSocket 前通过正式入口准备历史聚合并部署尚未执行的 Prisma migration。已执行 migration 不改写；旧完整结构的 baseline 登记不得用于空库。

#### Scenario: 数据库升级失败
- **WHEN** 迁移入口执行失败
- **THEN** 容器不继续启动应用服务，不以跳过迁移制造健康状态

### Requirement: 部署密钥与引导账号

部署 SHALL 配置数据库连接、JWT 签名密钥、分享签名密钥与引导账号密码；模型凭证通过系统资源管理配置，不提交到文档、源码或工作区记录。

#### Scenario: 首次配置系统模型
- **WHEN** 系统管理员保存模型供应商凭证
- **THEN** 租户与空间仅引用获准资源，不复制系统密钥到租户模型配置

### Requirement: 验证证据分层

交付 SHALL 区分单元、PostgreSQL 集成、容器部署、真实模型和浏览器验收。真实模型验证不得用固定响应替代，未执行项不得报告成功。

#### Scenario: 只有构建与单元测试通过
- **WHEN** 本轮没有运行实际浏览器或真实模型
- **THEN** 交付只报告已执行检查，不声称完整对话、供应商质量或部署实例已验收
