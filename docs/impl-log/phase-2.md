# Phase 2 实施日志 · AI SDK Provider

> 日期：2026-06-11；最终修订：2026-09-18。

## 当前实现

后端只保留中立 `Provider.completeStream` 接口，Agent 循环、工具执行、WebSocket 事件和
PostgreSQL 状态继续由 RunForge 管理。所有模型调用固定使用上游流式协议；标题生成、上下文
摘要和连通性测试传入空的增量处理函数，并在调用结束后使用聚合结果。AI SDK 负责协议转换、
流式解析、reasoning 独立字段和工具调用组装。

系统 LLM 配置直接选择三种协议,系统管理员再按 provider 授权给租户：

- `openai-responses`：`@ai-sdk/openai` Responses API。
- `openai-chat`：`@ai-sdk/openai-compatible` Chat Completions API。
- `anthropic-messages`：`@ai-sdk/anthropic` Messages API。

`server/src/llm/providers/aiSdk.ts` 根据协议创建模型。工具注册不包含 `execute`，模型产生的
tool call 仍交给 `executor.ts` 执行。三套手写协议实现已经删除。

OpenAI Responses 和 OpenAI Chat 请求不填写输出 token 上限。Anthropic Messages 协议要求
请求包含 `max_tokens`，运行时使用模型目录中 models.dev 声明的最大输出长度；目录缺少该值
时立即拒绝创建 Provider。该字段不进入管理员配置。

AI SDK 每次调用固定 `maxRetries: 0`。RunForge `ProviderRunner` 负责重试，并为每次真实 HTTP
请求创建 `provider_attempts` 记录。自定义 observing fetch 能取得 AI SDK 最终序列化的请求和
上游原始响应流。

reasoning 只读取协议返回的独立字段。正文中的标签不参与 reasoning 提取。

## 模型能力

`pnpm model-catalog:update` 从 models.dev 的供应商无关模型目录生成
`server/src/llm/model-catalog.json`。脚本导入全部具有上下文长度的模型，并从 models.dev 的
供应商目录补充模型 ID 别名；供应商窗口限制不参与生成。输入类型中的 `pdf` 映射为
RunForge 的 `document`。`pnpm model-catalog:check` 用于检查本地文件是否对应当前数据源。

目录压缩阈值默认取上下文长度的 75%。管理员可以逐模型改成更低的人工阈值，例如将高成本
长上下文 GPT 模型设置为 200K；保存后不会被目录默认值覆盖。模型名称先匹配完整规范名称或
明确别名；带日期、量化、渠道等后缀时，按最长的已登记名称前缀匹配，保证具体变体优先于
基础型号。供应商 `/models` 接口只提供候选模型名称。

匹配成功时管理界面自动填写能力和来源；匹配失败时上下文窗口、压缩阈值与输入类型保持未
填写，管理员必须填写后才能保存。运行时不会生成统一上下文窗口、压缩阈值或输入类型默认值。

目录可以记录文本、图片、音频、视频和文档输入能力。每次模型请求前，运行时按当前 run 的
模型压缩阈值检查上下文；切换模型产生的新 run 在第一次请求前使用新模型阈值。

## 验证范围

- 中立消息到 AI SDK `ModelMessage` 的角色、图片、tool call 和 tool result 转换。
- OpenAI Responses 的 `store: false` 与 reasoning provider state 回放。
- 三种协议固定 `stream: true` 的请求体契约；OpenAI 不发送输出上限，Anthropic 发送目录中的
  `max_tokens`。
- 三种协议的类型检查、真实流式调用、工具调用和 Provider attempt 观测。
- 模型目录完整名称、明确别名、最长后缀匹配、未知模型待填写状态和资料来源校验。
