# Phase 3 实施日志 · 前端迁移到 useChat(自定义 ChatTransport)

> 对应 [refactor-plan.md](../refactor-plan.md) §6 Phase 3。
> 日期:2026-06-11 · 状态:Stage 1 ✅(Stage 2 shadcn 外壳见后续追加)

## 目标

前端用 AI SDK `useChat` 接管消息/流式/分片状态,删除自建的累加/去重逻辑。
**后端零改动**:复用 Phase 0 的 `UiTransport`/`UiEvent` 抽象,写一个自定义
`ChatTransport` 把现有 REST+WS(`legacyTransport`)桥接成 `useChat` 消费的
UI message stream。这样 executor / WS / PG 持久化全部不动,风险最低、锁定最少。

## 设计

- AI SDK 的 `ChatTransport.sendMessages` 返回 `ReadableStream<UIMessageChunk>`。
  我们把每次 run 的 `UiEvent` 流转成该 chunk 流:text/reasoning → start/delta/end
  (每 step 一段),tool → `tool-input-available`/`tool-output-available`。
- 线程的创建/选择/PG 恢复仍走现有 REST;历史 run 经 `runsToUiMessages` 折叠成
  `UIMessage[]` 交给 `useChat` 初始化,渲染路径与实时流一致。

## 改动(web,后端不动)

新增:

- [web/src/transport/aiSdkChat.ts](../../web/src/transport/aiSdkChat.ts)
  - `uiEventStreamToChunks(runId, abortSignal, subscribe?)`:`UiEvent` → `UIMessageChunk`
    可读流;`SubscribeFn` 可注入便于离线测试。
  - `createAiSdkChatTransport(handle)`:实现 `ChatTransport<UIMessage>`,懒创建线程、
    `legacyTransport.send` 起 run、订阅转流;`reconnectToStream` 返回 null(恢复走 PG)。
- [web/src/history.ts](../../web/src/history.ts)
  - `foldUiEventsToParts`:`UiEvent[]` → 线性 parts(text/reasoning 合并,tool 按 id 合并 input/output)。
  - `runsToUiMessages`:PG 历史 `RunWithEvents[]` → `UIMessage[]`。
- [web/src/components/Conversation.tsx](../../web/src/components/Conversation.tsx)
  —— 渲染 `UIMessage.parts`(text→Streamdown 气泡、reasoning→折叠卡、tool→工具卡)。
  (此为临时样式版,Stage 2 用 shadcn 重做。)

修改:

- [web/src/App.tsx](../../web/src/App.tsx) —— 用 `useChat({ transport })` 接管;`threadIdRef`
  让稳定的 transport 读写当前线程;`selectThread` 经 `runsToUiMessages` 恢复历史。
- [web/src/components/ChatView.tsx](../../web/src/components/ChatView.tsx) —— props 由
  `turns` 改为 `messages` + `busy`。
- 删除 [web/src/components/MessageList.tsx](../../web/src/components/MessageList.tsx)
  (blocks/累加/去重/step 分组逻辑被 useChat parts 取代)。
- 依赖:新增 `@ai-sdk/react`、`ai`。

## 验收

- `tsc -b` + `vite build`:通过(bundle ~790 kB,+150 kB 为 ai/@ai-sdk/react)。
- 离线冒烟:
  - `foldUiEventsToParts`:reasoning→tool(output-available)→text,`final` 不重复正文。✓
  - `runsToUiMessages`:user + assistant[tool,text]。✓
  - `uiEventStreamToChunks`(注入 fake subscribe):
    `start reasoning-start/delta×2/end tool-input-available[shell] tool-output-available text-start/delta/end finish`。✓
- 后端未改;线程列表/切换/PG 恢复保持。

## Stage 2 — shadcn/ui 基础设施 + 全量重做对话外壳 ✅

手动接入(当前 shadcn CLI 已 Tailwind v4 优先,手动避免覆盖现有自定义主题):

- 依赖:`class-variance-authority clsx tailwind-merge lucide-react @radix-ui/react-slot`
  (+ scroll-area/tooltip 备用),dev `tailwindcss-animate @types/node`。
- 别名 `@/* → src/*`:[web/tsconfig.json](../../web/tsconfig.json)(baseUrl+paths)、
  [web/vite.config.ts](../../web/vite.config.ts)(`resolve.alias`,`node:url`)。
- 新增 [web/src/lib/utils.ts](../../web/src/lib/utils.ts)(`cn()`)、
  [web/components.json](../../web/components.json)(v3 形态)。
- 主题 token 共存([web/src/index.css](../../web/src/index.css) +
  [web/tailwind.config.js](../../web/tailwind.config.js)):
  - 新增 shadcn 语义 token(HSL,slate base + teal `--primary`);保留 `--surface-*`(rgb)
    与 teal `primary` 50–900、`darkMode:'class'`、Streamdown content glob。
  - `primary` 在 config 里**合并** `DEFAULT/foreground` 进 50–900,`bg-primary` 与
    `bg-primary-500` 同时可用;`tailwindcss-animate` 插件 + `borderRadius` 变量。
  - **未加**全局 `* {@apply border-border}`,避免改动既有边框。
- 新增 copy-in 组件 [web/src/components/ui/](../../web/src/components/ui/):
  `button card badge separator table textarea`(离线手写,Card/Table/Badge/Separator
  也作 Stage 3 的 A2UI catalog 基座)。
- 用 shadcn 重做外壳:[Sidebar](../../web/src/components/Sidebar.tsx)、
  [Composer](../../web/src/components/Composer.tsx)、[ChatView](../../web/src/components/ChatView.tsx)、
  [Conversation](../../web/src/components/Conversation.tsx)(气泡/工具卡/思考卡改 Card/Badge +
  lucide 图标;Markdown 仍走 Streamdown)。

验收:`tsc -b` + `vite build` 绿(CSS 25→28 kB,shadcn 类已收录);
SSR `renderToStaticMarkup(<ChatView>)` 含工具卡/用户气泡/状态徽章。`.dark` 与
现有 `useTheme` 零冲突。

## Stage 2.1 — 改用 AI Elements 官方聊天组件 ✅

手搓的气泡/工具卡风格与官方 chat 演示差距大;改用 **AI Elements**(Vercel 官方、基于
shadcn、直接吃 AI SDK `UIMessage.parts`)。`npx ai-elements add conversation message
reasoning tool prompt-input`(自动确认覆盖)。

- 重写 [Conversation.tsx](../../web/src/components/Conversation.tsx):用 AI Elements
  `Conversation/ConversationContent/ConversationEmptyState/ConversationScrollButton`、
  `Message/MessageContent/MessageResponse`(Streamdown)、`Reasoning*`、`Tool*`;
  `data-a2ui` 分片仍渲染我们的 `<A2uiSurface>`。
- 重写 [Composer.tsx](../../web/src/components/Composer.tsx):用 `PromptInput*`(自管输入态、
  Enter 发送、Submit 状态图标)。
- AI Elements 装入 `src/components/ai-elements/` + 一批 `ui/`(collapsible/select/dialog/
  dropdown/tooltip/input-group/…)与 radix/streamdown 插件依赖。
- **旧 shadcn primitive 摩擦修复**:AI Elements 假设较新 shadcn,补
  [button.tsx](../../web/src/components/ui/button.tsx) `icon-sm/icon-lg` size、
  [select.tsx](../../web/src/components/ui/select.tsx) `SelectTrigger` 的 `size` prop。

验收:`tsc -b` + `vite build` 绿(bundle 升至 ~2.3MB,含 Streamdown math/mermaid/shiki,
后续可按需 lazy-load);SSR `ChatView` 渲染用户气泡 + 工具卡 + Reasoning + A2UI 表格 + 助手
Markdown 全部正常。

## 后续(Stage 3/4)

- A2UI 声明式 UI 以 `data-a2ui` 分片接入,`uiEventStreamToChunks` 已为 `a2ui` 预留分支位;
  catalog 复用 shadcn 组件。
