# Brix Google Lens

业务插件读取 RunForge 已经物化到当前工作目录的图片，通过 Brix HTTP API 执行服务端
`google-lens` 脚本。插件不依赖 Brix MCP，也不会让模型把图片编码放进工具参数。

插件保存一份规范脚本。每次调用先读取 Brix 脚本目录：脚本存在时直接使用；只有明确返回
HTTP 404 时才把插件内脚本保存到 Brix。鉴权失败、网络失败和其他 HTTP 错误都会直接终止，
不会覆盖服务端现有脚本。

需要为租户配置 `brix.base-url` 与 `brix.token` 两个 Secret，并在图片出处空间选择本插件。
空间只需开放 `skill_activate` 与 `shell`。

图片出处空间的提示词模板只负责固定能力路由，具体业务要求由外部可信提示词传入：

```text
先激活 business:brix-google-lens/google-lens，并使用它处理本次图片。

{{external.trustedPrompt}}
```
