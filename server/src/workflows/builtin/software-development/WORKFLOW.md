---
name: software-development
description: 软件开发任务的通用多人协作流程，覆盖需求澄清、方案设计、实现、review、测试验证和最终汇报。Use for coding tasks that benefit from staged planning and subagent delegation.
---

# Software Development Workflow

## 适用场景

用于代码仓库内的软件开发任务：修 bug、做功能、重构、补测试、写工程文档。入口 agent 负责路由、计划、派发和汇总；subagent 负责阶段性只读分析。

## 阶段总览

### product

目标：明确用户要解决的问题、验收标准、边界和不做什么。

默认 skill：

- workflow-orchestration

输入：

- 用户原始需求。
- 当前仓库事实和相关文档。

输出：

- 任务意图。
- 验收标准。
- 风险和待确认问题。

Gate：

- 如果需求影响范围不清楚，先查仓库事实；仍不清楚再问用户。

### design

目标：形成贴合现有代码结构的实现方案。

默认 skill：

- workflow-orchestration

输入：

- product 阶段结论。
- 相关模块、接口、数据流、测试约束。

输出：

- 设计路径。
- 需要修改的文件范围。
- 兼容性和迁移影响。

Gate：

- 方案必须来自真实代码和文档，不凭空设计。
- 若出现多条高风险路线，优先选择最小正确改动。

### implement

目标：按设计完成代码和文档改动。

默认 skill：

- workflow-orchestration

输入：

- design 阶段方案。
- 目标文件和既有模式。

输出：

- 代码改动。
- 必要文档更新。
- 已知限制。

Gate：

- 不覆盖用户未提交改动。
- 不做无关重构。
- 修改代码注释时使用中文有效注释。

### review

目标：发现行为回归、边界错误、遗漏测试和不符合项目约定的地方。

默认 skill：

- workflow-orchestration

输入：

- git diff。
- 关键实现文件。
- 测试结果。

输出：

- 阻塞问题。
- 非阻塞风险。
- 是否可提交。

Gate：

- review 结论必须有文件或运行证据。
- 没有阻塞问题时明确说明。

### test

目标：用项目真实验证链路证明改动可运行。

默认 skill：

- workflow-orchestration

输入：

- 修改范围。
- 项目测试脚本。
- 必要运行时环境。

输出：

- 执行过的命令。
- 通过/失败结果。
- 失败原因和修复动作。

Gate：

- 后端 agent 循环、工具、存储、上下文变更需要跑 `server` 测试和类型检查。
- 前端交互变更需要至少跑前端构建或类型检查；能做真实运行时优先真实运行。

### report

目标：向用户说明原逻辑、改动、原因、验证和剩余限制。

默认 skill：

- workflow-orchestration

输入：

- 实现结果。
- review/test 结论。
- commit 状态。

输出：

- 高信号最终汇报。
- 提交号或未提交说明。
- 剩余风险。

Gate：

- 计划项必须 settled，即 `done` 或 `failed`。
- 如果用户要求提交，必须确认工作区状态和提交结果。
