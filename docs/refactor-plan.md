# 架构改造方案 · Markdown + HTML Artifact

> 目标：一个运行在操作系统上、可调用系统能力的通用 Agent，同时提供稳定、可读、
> 易复制的用户输出。原则：日常输出走模型最稳定的 Markdown 能力；复杂页面写成
> HTML artifact；工具层和沙箱仍是项目核心。

## 1. 输出策略

- 默认输出：Markdown，覆盖标题、列表、表格、代码块、Mermaid 图、LaTeX 公式。
  Mermaid 使用 ```mermaid 代码块；LaTeX 行内公式使用 `$...$`，独立公式块使用 `$$...$$`。
- 复杂报告/页面：通过 shell 或文件写入工具生成完整 HTML 文件，前端文件面板用沙箱 iframe 预览。
- 工具结果：保持纯文本，便于 LLM 消化、压缩和持久化；不再返回 UI JSON。
- 结束规则：任务完成时先用 `update_plan` 收口计划并进入 `reporting`，随后最终回答说明 Markdown 结论或 HTML artifact 路径。

## 2. 目标架构

```text
前端
├─ 对话渲染        AI Elements + Streamdown
│                  Markdown / Mermaid / LaTeX / 代码高亮
├─ 文件面板        workspace 文件浏览 + HTML 沙箱预览
├─ 状态/流式       AI SDK useChat(UIMessage parts)
└─ 传输边界        当前 REST + WebSocket，适配为 UIMessage stream

后端
├─ Agent 引擎      多 step 工具循环 + reporting 后自然最终汇报
├─ Provider        AI SDK / OpenAI-compatible / Anthropic
├─ 工具层          shell / file / glob / grep / web / ask_user
├─ 沙箱/权限       allow/deny、路径围栏、shell/network 开关、输出截断
├─ 持久化          PostgreSQL thread/run/step/message/event
└─ 可观测          OTEL GenAI 语义约定
```

## 3. 取舍

- Markdown 路线稳定：LLM 训练充分，用户可复制，Streamdown 能处理流式未闭合块。
- Mermaid/LaTeX 适合日常图表和公式，不需要模型维护组件 id 引用。
- HTML artifact 适合大报告、仪表盘、交互页面，可通过 CDN 引入 Vue、axios、ECharts 等常用库。
- HTML 必须隔离预览：前端使用 iframe sandbox，不把模型生成的 HTML 注入主应用 DOM。
- 不再维护声明式 UI JSON：它要求模型同时写对 schema、组件字段、id 引用和状态绑定，复杂长任务中错误率高。

## 4. 工具契约

```ts
interface ToolResult {
  text: string;
}
```

复杂页面统一写文件，优先放在 `artifacts/<描述性名称>.html`：

```bash
mkdir -p artifacts
# 用脚本或数据文件生成 HTML，避免把完整页面塞进工具调用参数。
node scripts/build-report.mjs > artifacts/report.html
```

artifact 必须写在 workspace 内的 `.html` / `.htm` 文件。最终回答必须用 Markdown 链接语法
说明位置，例如 `[artifacts/report.html](artifacts/report.html)`，便于用户直接打开。

## 5. 后续路线

- 完善 artifact 索引：按 run 记录生成文件、大小、类型和清理策略。
- 给 HTML artifact 增加资源 allowlist 和网络策略提示。
- 为常见报告沉淀 HTML 模板，但模板只作为辅助，不要求模型输出 JSON UI。
- 继续强化 Streamdown 的 Markdown、Mermaid、LaTeX 渲染体验。
