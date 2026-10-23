---
name: domain-modeling
description: "讨论 RunForge 领域术语、更新术语表，或在 OpenSpec 变更中记录和审查架构决定。"
---

# 领域建模

开始前读取仓库 `docs/agents/domain.md`、`GLOSSARY.md`、相关 `openspec/specs` 和活动或归档 `design.md`。

## 明确领域语言

- 用实际用户操作和业务关系检查模糊或歧义术语；已有名称发生冲突时给出具体场景并请用户决定。
- 对照当前实现区分事实、推断与未知，不能只凭讨论推断现有行为。
- 用户确认术语后立即更新 `GLOSSARY.md`。只记录名称、定义与应避免的近义词，不混入实现、任务或架构细节。

## 记录架构决定

只有选择难以更改、未来读者需要知道原因、且确实存在实际取舍时，才长期记录决定。

1. 找到对应 OpenSpec change；尚无变更时，使用 `openspec-propose` 或 CLI `new change` 建立本次变更。
2. 在该 change 的 `design.md` 写明日期、状态、背景、决定、原因、成立的备选方案与后果。
3. 尚未确认的选择标记 proposed；得到用户确认才标记 accepted。数据库 schema 修改同样需要确认。
4. 涉及行为时更新同一 change 的 delta specs；实施内容与验收写入 `tasks.md`。
5. 决定替代既有选择时引用原 change/design.md，说明替代关系；归档记录保持原文。

规格与架构决定均由 OpenSpec 承担。完成标准：每个本次已确认术语或决定都写入对应权威位置，行为影响已有可观察场景，未决问题明确保留，既有规格冲突已交由用户确认。
