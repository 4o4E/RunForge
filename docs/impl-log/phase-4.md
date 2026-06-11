# Phase 4 实施日志 · 接入可观测 / debug(OpenTelemetry)

> 对应 [refactor-plan.md](../refactor-plan.md) §6 Phase 4。
> 日期:2026-06-11 · 状态:✅ 完成
> 顺序说明:用户选择先跳过前端 Phase 3,优先做 Phase 4(与前端改造解耦、低风险)。

## 目标

后端开启 AI SDK `experimental_telemetry`(OTEL GenAI 语义约定),并对 run / tool
执行补充自有 span,使调试可观测面接近"零自维护":任意 OTLP 后端
(Jaeger / Langfuse / Laminar)即插即用,能看到 `invoke_agent → chat →
execute_tool` 的 span、token 与 tool I/O。

## 改动

依赖(server):`@opentelemetry/api`、`/sdk-node`、`/sdk-trace-base`、`/resources`、
`/semantic-conventions`、`/exporter-trace-otlp-http`。

新增:

- [server/src/telemetry.ts](../../server/src/telemetry.ts)
  - `initTelemetry()`:`OTEL_ENABLED=true` 时启动 `NodeSDK`;有
    `OTEL_EXPORTER_OTLP_ENDPOINT` 走 OTLP(BatchSpanProcessor),否则/或
    `OTEL_CONSOLE=true` 走 ConsoleSpanExporter;注册 SIGTERM/SIGINT 优雅关闭。
  - `withSpan(name, attrs, fn)`:用全局 tracer 的 `startActiveSpan` 包裹,
    自动记录异常并 end;telemetry 关闭时全局 tracer 为 no-op,**零额外分支**。

修改:

- [server/src/index.ts](../../server/src/index.ts) —— 入口第一时间 `initTelemetry()`
  (AI SDK / executor 在调用时读取全局 tracer,无需 import-time patch)。
- [server/src/llm/providers/aiSdk.ts](../../server/src/llm/providers/aiSdk.ts) ——
  `generateText` / `streamText` 传 `experimental_telemetry: { isEnabled, functionId:'chat',
  metadata:{model,flavor} }`。
- [server/src/agent/executor.ts](../../server/src/agent/executor.ts) ——
  run 主体抽成 `runLoop()` 闭包并由 `withSpan('invoke_agent', …)` 包裹(使
  AI SDK 的 `chat` 与 `execute_tool` span 嵌套其下);每次工具执行包
  `withSpan('execute_tool', { 'gen_ai.tool.name', 'tool.call_id' })` 并记录
  `tool.result.length`。
- [server/src/config.ts](../../server/src/config.ts) —— 新增 `telemetry` 配置块。
- [docker-compose.yml](../../docker-compose.yml) —— 新增 **opt-in** `jaeger`
  服务(profile `debug`),OTLP HTTP `4318` + UI `16686`;默认不启动。
- [.env.example](../../.env.example) —— 新增 OTEL 开关与 endpoint 文档。

## 验收

- `tsc` 构建 / `typecheck`:通过。
- `npm test`:23/23 通过(executor 重构后行为不变)。
- **真机冒烟(ConsoleSpanExporter)**:
  - 离线(MemoryStore + scripted provider):打印 `execute_tool`
    (`gen_ai.tool.name: glob`、`tool.result.length: 26`)与 `invoke_agent`
    (`run.id`)span,嵌套正确。
  - 在线(tencentmaas deepseek-v4-pro):打印 `ai.generateText` /
    `ai.generateText.doGenerate`,`ai.telemetry.functionId: chat`、
    `gen_ai.request.model`、`gen_ai.usage.input_tokens=8 / output_tokens=26`、
    finish reason、response text/reasoning。
  - ⇒ `invoke_agent → chat → execute_tool` + token + tool I/O 全部可见,满足验收。

## 使用

```bash
docker compose --profile debug up -d jaeger     # 启动 Jaeger
# 运行 server:
OTEL_ENABLED=true OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm --prefix server run dev
# 打开 http://localhost:16686 查看 trace
```

换 Langfuse / Laminar 只需把 `OTEL_EXPORTER_OTLP_ENDPOINT` 指向其 OTLP 入口,
无需改代码(OTEL 标准协议)。

## 备注

- 默认 `OTEL_ENABLED=false`:不加载导出器、不产生开销,运行版本零变化。
- "debug 面板渲染原始 parts/A2UI JSON" 属前端项,随被推迟的 Phase 3/5 再做;
  本阶段后端侧 trace 已覆盖 token / tool I/O / 多步链路。
