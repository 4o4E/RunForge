# Phase 2 实施日志 · 后端接 AI SDK

> 对应 [refactor-plan.md](../refactor-plan.md) §6 Phase 2。
> 日期:2026-06-11 · 状态:✅ 完成(灰度:旧 provider 暂留作回退)

## 目标

用 **Vercel AI SDK** 承接 provider 协议映射、流式、重试、tool_call 拼装,替换
自维护的 `openai-chat` / `openai-responses` / `anthropic` 三套手写翻译。
保留:工具实现、PG 持久化、thread/run/step、WS 事件契约。

## 设计抉择(为什么是 provider 级替换,而非 streamText 接管整个循环)

计划 Phase 2 写的是 `streamText + tools(execute) + toUIMessageStreamResponse`。
但 `toUIMessageStreamResponse` 是给 `useChat`(Phase 3)消费的 UI message stream,
现在切过去会让仍走 WS/`AgentEvent` 的前端断掉,违反"每阶段不阻塞当前可运行版本 /
先灰度可回退"。

因此本阶段采用**最小风险的等价做法**:新增一个 **AI SDK 背后的 `Provider`**,
仍实现 executor 依赖的 `complete` / `completeStream` 单轮契约——工具**不带 `execute`**
注册,SDK 只吐出 tool-call 交由现有 executor 执行。这样:

- executor 多步循环、`AgentEvent`、WS、PG schema、既有单测**全部不动**;
- 仍删掉了三套手写 provider 的协议翻译职责(改由 AI SDK 承担);
- `streamText(execute) + toUIMessageStreamResponse` 这套与前端 `useChat` 强耦合的
  改动,挪到 Phase 3 与前端一起落,避免中间态破坏。

## 改动

依赖(server):新增 `ai@^6`、`@ai-sdk/openai-compatible`、`@ai-sdk/openai`、
`@ai-sdk/anthropic`、`zod`。

新增:

- [server/src/llm/providers/aiSdk.ts](../../server/src/llm/providers/aiSdk.ts)
  - `buildModel`:按 flavor 选 `createOpenAICompatible`(默认,tencentmaas/deepseek)/
    `createOpenAI` / `createAnthropic`;可选 `extractReasoningMiddleware({tagName})`
    把 `<think>` 思维链从正文流中拆出(DeepSeek)。
  - `toModelMessages`:中性 `LlmMessage[]` → AI SDK `ModelMessage[]`;tool 结果在
    v6 需 `toolName`,从对应 id 的 assistant tool-call 回查补齐。
  - `createAiSdkProvider`:`complete` 走 `generateText`、`completeStream` 走
    `streamText` 并在 `fullStream` 上转发 `text-delta` / `reasoning-delta`;
    `maxOutputTokens` / `maxRetries` / `abortSignal(timeout)` 由 SDK 内置。
- [server/src/llm/aiSdk.test.ts](../../server/src/llm/aiSdk.test.ts) —— `toModelMessages`
  纯函数离线单测(角色映射、tool 结果回查名、坏参降级)。

修改:

- [server/src/llm/index.ts](../../server/src/llm/index.ts) —— `ProviderName` 增加
  `aisdk` 并设为入口;旧三套 provider 保留可选(回退路径)。
- [server/src/config.ts](../../server/src/config.ts) —— 默认 `LLM_PROVIDER=aisdk`;
  新增 `aisdkFlavor`、`reasoningTag`。
- [.env.example](../../.env.example) / `.env` —— 默认 `aisdk` + `LLM_AISDK_FLAVOR` +
  `LLM_REASONING_TAG`,并标注旧 provider 仅作回退。
- [server/package.json](../../server/package.json) —— 测试脚本纳入 `aiSdk.test.ts`。

## 验收

- `tsc` 构建 / `typecheck`:通过。
- `npm test`:23/23 通过(含新 3 个转换单测;executor/provider/tools 单测不变即过,
  证明 `Provider` 契约与 WS/PG 行为未变)。
- **真机冒烟**(tencentmaas `deepseek-v4-pro`,真实 endpoint):
  - `complete("Reply pong")` → `"pong"`,reasoning 捕获,usage `{in:12,out:31}`。
  - `completeStream(+glob tool)` → 21 个流式增量 + 正确拼装的 tool-call
    `glob {"pattern":"**/*.json"}`。
  - 证明模型构造、消息转换、流式、思维链提取、tool-call 拼装、结果归一全链路正确。

## 灰度与回退

- 旧 `openai-chat` / `openai-responses` / `anthropic` 暂留:`LLM_PROVIDER=openai-chat`
  即可回退,零代码改动。
- **后续清理**:在 `aisdk` 路径经过更多真实多步任务验证后,删除三套手写 provider
  与其 `providers.test.ts`(计划中的 "删 ~900 行" 的剩余部分),作为独立小提交。

## 后续(Phase 3 衔接)

- Phase 3 切前端 `useChat` 时,后端可改用 `streamText(execute) + stopWhen +
  toUIMessageStreamResponse`,届时 executor 的手写工具循环可一并退役。
- 可观测(Phase 4)挂 AI SDK `experimental_telemetry`,本阶段已为其留好接入点。
