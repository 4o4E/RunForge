# 本地脚本

`brix local run ./task.mjs --session ID --args-file ./input.json` 在调用端执行可信 Node 模块。模块导出 `async function runInSession(brix)`；返回值写到 `output`，日志写 stderr。`brix.args` 是参数，`brix.sessionId` 是当前会话。没有 `--session` 时，`--url` 可指定临时会话的起始页。

| 用途 | 方法 |
|---|---|
| 导航和观察 | `goto(url, options)`、`snapshot(options)`、`read(op, selector?, name?)`（`url/title/content/text/count/attr`） |
| 操作 | `click(target, options)`、`fill(target, value)`、`type(target, value, options)`、`press(key)`、`select(target, value)`、`hover(target, options)`、`scroll(direction, amount)` |
| 等待 | `waitForSelector(selector, {state, timeout})`、`waitForUrl(pattern, {timeout})`、`waitForLoad(state, {timeout})` |
| 文件 | `upload(target, ...paths)`、`screenshot(path, options)`、`download(runId, name, path)` |
| 页面求值 | `evalInPage(source)`：在远端页面求值，不是远程脚本部署。 |

`click` 打开下载时传 `{expectDownload: true, saveAs: "result.txt"}`；用返回的 `runId`、`downloads[].name` 取回并核对。动作方法返回 HTTP 动作结果；`read`、`snapshot` 和 `evalInPage` 返回其中的值。

失败时看 `stage` 和 `dispatch`：`not_sent` 表示没有确认送出的页面修改；`sent_unconfirmed` 表示修改动作已返回，但脚本未验证最终结果；`unknown` 表示不知道修改是否发出。后两种先读同一会话，不重跑。该接口不是 Playwright `Page`，每步仍是独立 HTTP 请求。