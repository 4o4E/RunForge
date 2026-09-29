---
name: brix-browser
description: 使用 Brix 执行通用浏览器操作、调用受控服务端脚本并取回下载产物；Google Lens 是其中一项内置能力。
---

只在任务需要真实浏览器时使用 Brix。通用浏览器任务使用同一个 session 连续操作：

```text
node <root>/scripts/brix.mjs session-open [初始 URL]
node <root>/scripts/brix.mjs action <sessionId> '<JSON>'
node <root>/scripts/brix.mjs session-trace <sessionId>
node <root>/scripts/brix.mjs session-close <sessionId>
```

`action` 的 JSON 直接对应 Brix 原语。常用操作是 `navigate`、`snapshot`、`click`、`fill`、
`type`、`press`、`select`、`hover`、`scroll`、`waitForSelector`、`waitForLoad`、
`waitForUrl`、`text`、`attr`、`count`、`content`、`url`、`title`、`cookies` 和 `eval`。
先执行 `snapshot` 取得带 `[ref=eN]` 的页面结构，再用 ref 点击或填写。变更类操作需要紧接新快照时，
在 JSON 中传入 `"returnSnapshot":true`。任务结束后必须关闭 session。

本地文件上传和截图不要把 base64 放入命令参数：

```text
node <root>/scripts/brix.mjs upload <sessionId> <target> <本地文件>
node <root>/scripts/brix.mjs screenshot <sessionId> <本地输出路径> [fullPage]
```

执行服务端脚本及读取产物：

```text
node <root>/scripts/brix.mjs script-list
node <root>/scripts/brix.mjs script-run <脚本名> '<args JSON>'
node <root>/scripts/brix.mjs session-script-run <sessionId> <脚本名> '<args JSON>'
node <root>/scripts/brix.mjs run-files <runId>
node <root>/scripts/brix.mjs run-file-get <runId> <文件名> <本地输出路径>
```

图片出处任务使用便捷入口：

`node <root>/scripts/lens.mjs <图片路径>`

该入口会在 Brix 缺少 `google-lens` 时保存插件附带的脚本，然后临时创建 session 并在执行后关闭。
输出包含 `runId`、`output` 和 `downloads`，Lens 结果位于 `output`。业务结论及最终输出格式遵循外部可信
提示词，不把 Google AI 概览单独作为可靠证据。
