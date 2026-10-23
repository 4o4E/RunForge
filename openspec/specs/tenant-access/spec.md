# 身份与租户权限

## Purpose

约定系统管理员、租户角色、登录身份和资源作用域。实现入口：`server/src/auth/`、`server/src/api/auth.ts`、`server/src/api/authRoutes.ts`；解释见 `docs/multi-tenancy-design.md`。

## Requirements

### Requirement: 登录与令牌

系统 SHALL 使用租户账号登录、JWT access token、refresh token 与用户 API token。REST 身份 SHALL 通过 Bearer Header 传递，WebSocket 身份 SHALL 通过 `runforge-token.<base64url-token>` 子协议传递，不将登录 token 写入 URL。

#### Scenario: 租户或用户已禁用
- **WHEN** 已禁用租户或用户请求登录
- **THEN** 系统拒绝登录，不因凭证正确而绕过状态检查

#### Scenario: 旧部署配置静态 token
- **WHEN** 启动引导发现 `RUNFORGE_ACCESS_TOKEN`
- **THEN** 将其注册为引导 owner 的 API token，不把它作为所有用户共享的唯一鉴权方式

### Requirement: 系统资源与租户授权

系统 SHALL 由系统管理员配置模型供应商、运行时能力、MCP、工具策略与数据源，并以资源 ID 授权租户；租户配置不得复制或暴露系统 API 凭证。

#### Scenario: 租户读取可用模型
- **WHEN** 租户用户获取模型选项
- **THEN** 只返回该租户获准的供应商和模型，不返回其他租户配置或系统密钥

### Requirement: 会话与管理权限隔离

系统 SHALL 按当前数据库身份检查租户、用户、角色和资源作用域。Web 会话属于创建用户；系统管理员读取会话内容 SHALL 使用独立审计入口，不冒充租户用户。

#### Scenario: 跨租户访问会话
- **WHEN** 用户通过其他租户的 thread 标识请求会话
- **THEN** 系统不返回该会话内容

#### Scenario: 同空间的其他 Web 用户读取私人会话
- **WHEN** 用户可见某个 Web 空间，但会话属于其他用户
- **THEN** 空间可见性不授予该私人会话的读取或管理权限

### Requirement: 文件分享限定作用域

系统 SHALL 将分享签名绑定文件路径、tenant、user、space、thread 和过期时间；分享链接只允许指定文件的读取或预览。

#### Scenario: 分享链接用于其他文件或会话
- **WHEN** 请求修改签名中的文件路径或作用域
- **THEN** 签名验证失败，不授权目录浏览、设置修改或任务执行
