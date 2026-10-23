# RunForge OpenSpec

## 文档职责

| 内容 | 权威位置 |
| --- | --- |
| 当前源码的行为要求与场景 | `specs/<capability>/spec.md` |
| 一次变更的目标与范围 | `changes/<change>/proposal.md` |
| 架构决定、理由、备选方案、确认与替代关系 | 同一变更的 `design.md` |
| 实施和验收任务 | 同一变更的 `tasks.md` |
| 待同步的行为修改 | 同一变更的 `specs/<capability>/spec.md` |
| 已完成变更的决定与证据 | `changes/archive/<date>-<change>/` |
| 领域术语 | [GLOSSARY.md](../GLOSSARY.md) |
| 使用方法、协议字段与实现解释 | [README](../README.md) 与 [docs](../docs/) |

OpenSpec 同时承担架构决定记录。开发技能读取或记录决定时进入相关 `design.md`；GitHub Issues 引用这些文件，作为分工与讨论入口，不维护第二份规格或架构决定正文。

## 当前能力规格

- [Agent 执行](specs/agent-execution/spec.md)：任务层级、模型协议、计划、上下文压缩、恢复与按 profile 授权的异步子任务。
- [身份与租户权限](specs/tenant-access/spec.md)：登录、角色、系统授权、会话与文件分享。
- [空间与外部接入](specs/spaces-external/spec.md)：配置副本、提示词、执行用户、调用方和共享对话。
- [工具与 Shell](specs/tools-shell/spec.md)：策略、bwrap、访问范围、托管命令与包管理镜像。
- [运行 Skill 与 MCP](specs/skills-mcp/spec.md)：发现、运行级激活、只读资源与连接生命周期。
- [业务插件与 SDK](specs/business-plugins-sdk/spec.md)：导入、打包、运行锁、Secret 与短期资源。
- [文件与多模态](specs/files-multimodal/spec.md)：目录、上传、图片和文档音视频读取。
- [历史、观测与用量](specs/history-observability/spec.md)：step 权威数据、实时衔接、trace 与统计。
- [部署与验证](specs/deployment/spec.md)：两种 Compose、迁移、密钥和验收边界。
- [开发工作流](specs/development-workflow/spec.md)：项目技能、OpenSpec、Issues 与更新规则。

产品规格由现有源码与现行专题核对建立，不补造过去未记录的提案或验收。开发工作流变更单独记录本次实际工作；当前源码、稳定版和运行实例的版本分别核对。

## 使用流程

项目使用 OpenSpec CLI `1.14.3`，在仓库根目录执行，不调用来源不明的全局同名程序：

```bash
pnpm dlx @fission-ai/openspec@1.14.3 list --specs
pnpm dlx @fission-ai/openspec@1.14.3 list
pnpm dlx @fission-ai/openspec@1.14.3 validate --all --strict --no-interactive
```

1. 调查问题时读取对应规格、现行专题和相关活动/归档 `design.md`。使用 `openspec-explore` 讨论，不把提案当成现有行为。
2. 方案明确后使用 `openspec-propose` 创建变更；`to-spec` 也生成同一套 OpenSpec 内容。架构与数据库修改先得到用户确认。
3. 使用 `to-tickets` 将已确认任务分成工作项，保留 `tasks.md` 中的验收与依赖；只有用户要求发布工作项时才操作 GitHub Issues。
4. 使用 `openspec-apply-change`、`implement` 或 `implement-spec` 实施，三者都消费同一变更，不另建规格体系。
5. 运行实际改动入口、定向检查并记录证据，再由 `openspec-sync-specs` 同步 delta，由 `openspec-archive-change` 归档。审查需核对范围、实现、规格与验证。

CLI 查看某个变更的真实状态与当前生成指令：

```bash
pnpm dlx @fission-ai/openspec@1.14.3 status --change <change> --json
pnpm dlx @fission-ai/openspec@1.14.3 instructions design --change <change> --json
pnpm dlx @fission-ai/openspec@1.14.3 instructions apply --change <change> --json
```

## 架构决定的生命周期

决定写明日期、状态、背景、决定与原因；只有真实存在且值得保留的备选方案才记录。尚未确认的选择标记为 proposed，不得作为实施授权。完成后保留在归档 `design.md`；以后改动在新变更中引用原决定、说明替代原因并更新受影响规格，不改写已归档记录。

既有已确认的外部共享权限、图片理解与 bwrap 只读边界收录在[已归档设计决定](changes/archive/2026-10-23-establish-project-specs/design.md)，保留原确认日期和替代关系，不将导入日期当成历史实施日期。本次开发规范的实施与验证证据也保存在该归档中。
