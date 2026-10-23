---
name: implement
description: "实施 RunForge 已明确的需求或工作项，按 OpenSpec 与项目约定验证实际行为。"
disable-model-invocation: true
---

读取用户需求、对应 OpenSpec change 与 `docs/agents/domain.md`；工作项引用按 `docs/agents/issue-tracker.md` 获取。事实不明确先调查，业务或架构选择未确认先询问。

按 implement-spec 的项目流程实施；快速修复保持范围明确，不强制额外创建分支或工作项。已有不相关修改保持原位。

运行实际变更入口与相关检查，审查需求、规格和文档一致性，只将已验收任务标记完成。提交、推送、PR 和部署仅在用户明确要求时执行。
