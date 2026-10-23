---
name: to-spec
description: "将当前已确认讨论整理为 RunForge OpenSpec 变更，包括目标、需求场景、设计选择和任务。"
disable-model-invocation: true
---

# 生成规格

从当前讨论与代码事实整理规格，不重新进行整轮访谈。先读取 `docs/agents/domain.md`、`docs/agents/issue-tracker.md` 和相关主规格；事实可以调查，尚未决定的业务或架构选择必须保留为未决，不擅自补齐。

1. 找到当前工作对应的 OpenSpec change；没有时使用 `pnpm dlx @fission-ai/openspec@1.14.3 new change <name>` 创建。
2. 使用 CLI `status` 与各 artifact 的 `instructions --json` 获取当前模板及项目规则，不自建另一种规格结构。
3. 将问题、用户场景、目标、非目标与影响写入 `proposal.md`；新增/修改/删除的行为写入 delta specs，每条需求至少包含一个可观察 WHEN/THEN 场景。
4. 架构选择、理由、确认状态与必要的取舍写入 `design.md`；引用已归档决定，不改写原记录。
5. 在 `tasks.md` 写入有可验证结果的实施与实际验收任务，优先使用已有验证入口，不通过复制 mock 响应制造成功。
6. 运行该变更的 `validate --strict --no-interactive`。报告变更路径、校验结果与阻止实施的未决问题。

OpenSpec 是规格正文来源。用户另外要求发布工作项时，依据问题跟踪配置创建引用该变更的 Issue，不把全部规格再发布一份。确认方案与执行发布是不同授权。
