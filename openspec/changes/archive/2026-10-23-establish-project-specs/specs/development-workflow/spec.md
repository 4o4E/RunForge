# 开发工作流

## Purpose

统一 RunForge 开发助手的工程技能、领域术语、行为规格、架构决定、工作项与验证入口，使项目开发始终消费同一套 OpenSpec 资料，并保护现有工作目录和用户授权边界。

## ADDED Requirements

### Requirement: 项目级开发技能

仓库 SHALL 在 `.agents/skills` 提供来自 4o4E/skills 的正式工程与生产力技能，并保存来源锁。开发技能 SHALL 与产品运行 Skill 分离，不安装到全局或产品业务插件目录。

#### Scenario: 在仓库中读取开发技能
- **WHEN** 开发助手选择工程技能
- **THEN** 从当前仓库读取对应 `SKILL.md` 和项目配置，运行中的产品 Agent 不因此获得这些技能

### Requirement: OpenSpec 是规格与架构决定来源

开发流程 SHALL 将现行需求与场景保存到 `openspec/specs`，将变更范围、架构决定与任务保存到同一 change 的 proposal、design 和 tasks。决定 SHALL 记录确认状态、背景、原因与必要的替代关系，完成后随变更归档。

#### Scenario: 讨论中确认架构选择
- **WHEN** 用户确认一个需要长期保留的架构决定
- **THEN** domain-modeling 更新相关 change 的 `design.md`，并在涉及行为时更新 delta spec，不创建独立的决定文档体系

#### Scenario: 以后替代已归档决定
- **WHEN** 新需求需要改变既有架构选择
- **THEN** 新变更引用原归档决定并记录替代理由，更新受影响规格，不覆盖历史 design

### Requirement: 规格生成与工作项引用

`to-spec` SHALL 生成或更新 OpenSpec 变更。GitHub Issues SHALL 只用于工作项、讨论和依赖，引用对应 change 与任务，不复制维护规格正文；创建或关闭远程工作项需要用户授权。

#### Scenario: 根据已确认讨论生成规格
- **WHEN** 用户调用 to-spec
- **THEN** 写入本地 OpenSpec proposal、delta specs、必要的 design 与 tasks，并报告未决问题，不自动发布第二份规格 Issue

### Requirement: 实施与审查消费同一变更

实现和审查技能 SHALL 读取对应 OpenSpec 及项目规则，保护已有未提交修改；不因通用技能默认流程而自动创建 worktree、重置分支、提交、推送或发布。

#### Scenario: 用户要求依据规格实施
- **WHEN** implement-spec 开始实施已有 OpenSpec 变更
- **THEN** 在当前项目现场按已批准任务执行，记录真实验收并更新 tasks，不自动建立另一套分支与规格流程

### Requirement: 技能更新保留项目适配

技能更新 SHALL 核对上游来源与本项目的 OpenSpec 读写适配，保留许可证与来源记录，并运行实际发现、指令生成与严格校验。

#### Scenario: 更新工程技能
- **WHEN** 维护者从上游更新项目技能
- **THEN** 检查 domain-modeling、to-spec、setup、实现、审查及路由中的 OpenSpec 入口，并确认没有恢复独立的规格或架构决定写入路径
