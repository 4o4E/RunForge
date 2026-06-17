# Presentation Guide

## Mermaid vs HTML Artifact

用 Mermaid 的场景：

- 数据分析、对比、趋势、占比、流程或架构能用 Mermaid 表达清楚。
- 常规折线图、柱状图、饼图、甘特图、流程图、状态图、ER 图。
- 节点和边不多，或可以拆成多张图让读者一眼看懂。
- 图可以直接放进 Markdown。

用 HTML artifact 的场景：

- Mermaid 不支持的图型，例如散点图、气泡图、热力图、地图、桑基图或树图。
- 用户明确要求筛选、排序、tooltip、缩放、钻取或响应式交互布局。
- 用户明确要求独立报告、dashboard、数据大屏或可分享页面。
- 需要图表库能力，否则会让 Mermaid 图变得难读或误导。

HTML artifact 生成规则：

- 通过 shell 或文件写入工具生成完整 `.html` / `.htm` 文件。
- 文件放在 workspace 内，优先使用 `artifacts/<描述性名称>.html`。
- 不要把完整 HTML 文档作为工具调用参数传递，避免大正文绕过工具输出截断监控。
- 最终回答必须使用 Markdown 链接语法，例如 `[artifacts/report.html](artifacts/report.html)`。

不用图的场景：

- 内容只有 3-5 个要点，列表更清楚。
- 数据太少，图会制造假精确感。
- 关系太密，图会比正文更难读。

## Mermaid Choices

- 流程和决策：`flowchart`
- 时序交互：`sequenceDiagram`
- 时间线和里程碑：`timeline`
- 任务计划和排期：`gantt`
- 实体关系和数据模型：`erDiagram`
- 状态流转：`stateDiagram-v2`
- 用户旅程：`journey`
- Git 分支：`gitGraph`
- 象限分类：`quadrantChart`
- 需求或验收关系：`requirementDiagram`
- C4 架构视图：`C4Context` 或 `C4Container`

## Mermaid Rules

- 节点 ID 使用英文字母、数字和下划线。
- 中文、空格、符号、HTML、斜杠或 @ 放在 quoted label 中。
- 图里只放关键路径，例外和细节放正文。
- 超过 25 个节点时拆图或改用列表。

## Examples

流程：

```mermaid
flowchart TD
  start["收到用户请求"] --> inspect["读取真实上下文"]
  inspect --> decide{"是否需要工具"}
  decide -->|是| tool["调用工具"]
  decide -->|否| answer["直接回答"]
```

时序：

```mermaid
sequenceDiagram
  participant Web
  participant Server
  participant LLM
  Web->>Server: start run
  Server->>LLM: messages + tools
  LLM-->>Server: tool call
  Server-->>Web: stream event
```

状态：

```mermaid
stateDiagram-v2
  [*] --> pending
  pending --> running
  running --> done
  running --> error
  running --> canceled
```
