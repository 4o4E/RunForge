## Why

项目入口、能力说明和配置示例需要准确描述已有的多租户 Agent 运行平台；开发助手需要可读取、可验证的规格与统一的项目技能配置。用户要求完善文档、补全 OpenSpec，并将 4o4E/skills 接入 RunForge 开发环境；进一步明确由 OpenSpec 承担技能中的架构决定记录。

## What Changes

- 完善 README、系统说明、能力边界、包描述与 GitHub 项目简介。
- 将现有产品行为核对后导入九个 OpenSpec 能力主题，作为当前源码基线，不声明新增产品功能或生产验收。
- 新增开发工作流规格：27 个正式工程/通用生产力技能与官方 OpenSpec 技能均为项目级资源。
- 统一需求、设计决定、任务和归档；调整技能的实际读写入口，GitHub Issues 只引用 OpenSpec。
- 将已有确认决定纳入设计记录，保留确认日期和替代关系；术语单独维护。

## Capabilities

### New Capabilities

- `development-workflow`：OpenSpec 与项目工程技能协作、工作项引用和更新边界。

### Modified Capabilities

无产品运行时行为变更。九份产品规格是已有行为基线导入，不创建虚假的产品功能 delta。

## Impact

影响正式文档、项目元数据、`openspec/`、`.agents/skills/`、技能来源锁和开发规则入口。没有业务代码修改、数据库 schema 变更、应用部署、共享资源调整、提交或推送。其他会话已有修改保持原位。
