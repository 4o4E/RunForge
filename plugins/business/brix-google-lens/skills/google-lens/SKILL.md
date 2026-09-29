---
name: google-lens
description: 使用 Brix 服务端 Google Lens 脚本查询当前任务本地图片的匹配页面、视觉匹配结果和 AI 概览。
---

处理图片出处任务时，从输入中的 `[[file:...]]` 找到本次图片在工作目录中的相对路径，然后执行：

`node <root>/scripts/lens.mjs <图片路径>`

脚本输出一个 JSON 对象，包含 `pages`、`visualMatches`、`aiOverview`、`finalUrl` 和
`durationMs`。业务结论及最终输出格式完全遵循外部可信提示词，不把 Google AI 概览单独作为
可靠证据，不使用模型视觉猜测代替脚本调用。

每项任务只处理输入指定的图片。脚本会自行检查 Brix 服务端是否存在 `google-lens`，缺失时
保存插件附带的规范脚本，并负责创建与关闭浏览器会话。
