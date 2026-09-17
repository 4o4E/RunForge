# Phase 2 实施日志 · AI SDK Provider

> 日期：2026-06-11；最终修订：2026-09-18。

## 当前实现

后端保留中立 `Provider.complete` / `Provider.completeStream` 接口，Agent 循环、工具执行、
WebSocket 事件和 PostgreSQL 状态继续由 RunForge 管理。AI SDK 负责协议转换、流式解析、
reasoning 独立字段和工具调用组装。

租户 LLM 配置直接选择三种协议：

- `openai-responses`：`@ai-sdk/openai` Responses API。
- `openai-chat`：`@ai-sdk/openai-compatible` Chat Completions API。
- `anthropic-messages`：`@ai-sdk/anthropic` Messages API。

`server/src/llm/providers/aiSdk.ts` 根据协议创建模型。工具注册不包含 `execute`，模型产生的
tool call 仍交给 `executor.ts` 执行。三套手写协议实现已经删除。

AI SDK 每次调用固定 `maxRetries: 0`。RunForge `ProviderRunner` 负责重试，并为每次真实 HTTP
请求创建 `provider_attempts` 记录。自定义 observing fetch 能取得 AI SDK 最终序列化的请求和
上游原始响应流。

reasoning 只读取协议返回的独立字段。正文中的标签不参与 reasoning 提取。

## 模型能力

`server/src/llm/model-catalog.json` 由开发人员维护上下文窗口、输入类型和官方资料来源。
模型名称只允许完整规范名称或目录中明确声明的别名匹配。供应商 `/models` 接口只提供候选
模型名称。

匹配成功时管理界面自动填写能力和来源；匹配失败时上下文窗口与输入类型保持未填写，管理员
必须填写后才能保存。运行时不会生成统一上下文窗口或纯文本输入的默认值。

目录可以记录文本、图片、音频、视频和文档输入能力。管理界面同时说明 RunForge 当前能在
对话请求中直接发送文本和图片，避免把模型声明能力解释成运行时已经接入的附件类型。

## 验证范围

- 中立消息到 AI SDK `ModelMessage` 的角色、图片、tool call 和 tool result 转换。
- OpenAI Responses 的 `store: false` 与 reasoning provider state 回放。
- 三种协议的类型检查、真实流式调用、工具调用和 Provider attempt 观测。
- 模型目录完整名称匹配、明确别名、未知模型待填写状态和资料来源校验。
