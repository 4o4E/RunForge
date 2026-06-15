---
name: workflow-orchestration
description: 使用本地 workflow 文件拆解任务、规划阶段、派发异步 subagent、轮询结果并汇总交付。Use when a task should follow a staged workflow or coordinate multiple subagents.
allowed-tools: workflow_list workflow_read subagent_run subagent_poll subagent_list update_plan file_read grep glob
metadata:
  my-agent.tool-scope: orchestration
---

# Workflow Orchestration

## 何时使用

当任务需要阶段化推进、多人协作模拟、并行检查、review/test 分工或跨 run 等待 subagent 结果时使用。

## 核心流程

1. 调用 `workflow_list` 找到候选 workflow。
2. 调用 `workflow_read` 读取选定 workflow 的阶段、gate、默认 skill 和输出要求。
3. 用 `update_plan` 把当前 run 的阶段和计划同步出来。
4. 对只读分析、review、测试建议等可并行部分，用 `subagent_run` 派发异步 subagent。
5. 用 `subagent_poll` 查询单个 subagent，或用 `subagent_list` 恢复当前 thread 下的全部 subagent。
6. 综合 subagent 结论时标明证据、冲突和不确定性。

## 约束

- `subagent_run` 不等待完成；不要把它当同步工具。
- 同一个任务可以启动多个 subagent，但每个 subagent 的 `task`、`expectedOutput` 和 `constraints` 必须清楚。
- workflow 只定义稳定阶段和 gate；本次具体目标写进 task assignment。
- 如果需要新建或修改 workflow，写入 `.workflows/<name>/WORKFLOW.md`，不要修改 `.agents/workflows`。

## 输出

最终汇报说明：

- 使用了哪个 workflow。
- 启动了哪些 subagent。
- 每个 subagent 的状态和关键结论。
- 哪些计划项完成、失败或仍有风险。
