---
name: workflow-authoring
description: 创建或维护本地 workflow 文件，定义阶段目标、输入输出、gate、默认 skill 和 subagent 分工。Use when the user asks to add, edit, or evolve workflow definitions.
allowed-tools: workflow_list workflow_read file_read file_write grep glob
metadata:
  my-agent.tool-scope: workspace-readwrite
---

# Workflow Authoring

## 存放位置

用户 workflow 写入：

```text
.workflows/<workflow-name>/WORKFLOW.md
```

内置 workflow 会物化到 `.agents/workflows`，该目录只读，不能直接修改。

未来多用户支持时，每个用户只要拥有自己的 workspace 或用户目录，就能通过读取各自 `.workflows` 和 `.skills` 获得独立配置。

## 文件要求

`WORKFLOW.md` 必须有 frontmatter：

```yaml
---
name: workflow-name
description: 一句话说明用途和触发场景。
---
```

`name` 必须和目录名一致，只能使用小写字母、数字和连字符。

## 推荐结构

每个阶段写清楚：

- 目标：这一阶段要完成什么。
- 默认 skill：这一阶段建议激活哪些 skill。
- 输入：需要哪些上游材料。
- 输出：交付什么内容。
- Gate：进入下一阶段前必须满足什么条件。
- Subagent：哪些内容适合派发给异步 subagent。

## 边界

- workflow 写稳定流程，不写一次性任务细节。
- skill 写通用方法、检查清单、脚本和引用资料。
- 本次具体目标、上下文和交付物写进 `subagent_run` 的 task assignment。
- 不确定是否稳定时，先写 draft workflow，经过多次成功使用后再收敛。
