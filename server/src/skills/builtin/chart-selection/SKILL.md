---
name: chart-selection
description: 为回答或报告选择合适展示方式：默认优先 Markdown/Mermaid，仅在 Mermaid 不支持、用户明确需要交互或独立页面时使用 HTML artifact。Use when choosing between Markdown/Mermaid by default and HTML artifacts only for unsupported chart types or clearly interactive/standalone pages.
allowed-tools: file_read grep shell file_write
metadata:
  my-agent.tool-scope: markdown
---

# Chart Selection

## Workflow

1. 先判断 Markdown/Mermaid 是否能直接表达清楚；能表达清楚就不要另生 HTML 文件。
2. 数据分析、对比、趋势、占比、流程、关系、时序、状态和架构说明优先用 Mermaid。
3. 只有 Mermaid 不支持的图型、明确交互需求、独立分享页面或复杂 dashboard，才使用 HTML artifact。
4. 如果文字或列表更清楚，不要强行画图。
5. 如果需要 Mermaid 具体图型对照，读取 `references/presentation-guide.md`。

## Quick Decision

- 解释执行流程、状态机、模块关系：Mermaid。
- 展示时间线、排期、实体关系：Mermaid。
- 展示真实数值趋势、柱状图、折线图、占比图：优先 Mermaid。
- 展示散点图、气泡图、热力图、地图、桑基图、多个联动视图：HTML artifact。
- 用户明确要求“交互”“可视化页面”“仪表盘”“独立报告”：HTML artifact。

## Output Rules

- Mermaid 用 Markdown fenced code block。
- HTML artifact 通过 shell 或文件写入工具生成到 workspace 下，优先放在 `artifacts/<描述性名称>.html`。
- HTML artifact 完成后，最终回答必须使用 Markdown 链接语法说明，例如 `[artifacts/report.html](artifacts/report.html)`。
- 图前说明图要表达的结论，不写空泛标题。
- 图后补充口径限制，例如“只展示主路径，异常路径已省略”。
