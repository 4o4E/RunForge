# 项目开发技能

这些技能用于开发 RunForge，不是运行中的产品 Agent 的 Skill，也不随业务插件安装到租户。

## 安装内容

项目采用可编辑的共享目录 `.agents/skills/`，不安装全局插件，不同时安装另一份相同技能。来源为 [4o4E/skills](https://github.com/4o4E/skills) 的正式工程与生产力目录，来源与上游内容 hash 保存在根目录 `skills-lock.json`；许可见 [.agents/LICENSE](../../.agents/LICENSE)。

安装的 27 个工程技能按用途分组：

| 用途 | 技能 |
| --- | --- |
| 选择与讨论 | `ask-matt`、`grill-with-docs`、`grill-me`、`grilling`、`to-questionnaire`、`wait-what` |
| 设计与分析 | `domain-modeling`、`codebase-design`、`improve-codebase-architecture`、`research`、`prototype` |
| 规格与分工 | `to-spec`、`to-tickets`、`triage`、`wayfinder` |
| 实现与审查 | `implement`、`implement-spec`、`diagnosing-bugs`、`tdd`、`code-review`、`pr` |
| 协作与维护 | `handoff`、`retro`、`teach`、`wizard`、`writing-for-agents`、`setup-matt-pocock-skills` |

OpenSpec CLI 1.14.3 另外生成六个官方技能：`openspec-explore`、`openspec-propose`、`openspec-update-change`、`openspec-apply-change`、`openspec-sync-specs`、`openspec-archive-change`。全部位于同一共享目录，具体调用形式由开发助手决定。

## 项目配置

执行工程技能前读取：

- [领域文档](domain.md)：术语、规格和架构决定的读取与更新位置。
- [问题跟踪](issue-tracker.md)：GitHub Issues 工作项与 OpenSpec 的职责。
- [分流标签](triage-labels.md)：工作项状态标签，不自动推进远程工作。
- [OpenSpec](../../openspec/README.md)：变更、同步和归档方式。

领域建模使用根目录 `GLOSSARY.md`；需求与架构决定由 OpenSpec 承担。`domain-modeling`、`grill-with-docs`、`to-spec`、`to-tickets`、实现、审查与路由技能均已使用这些入口。

默认保留当前分支和原项目现场。通用技能中的操作受项目规则约束：分支、worktree、提交、推送、PR、远程 Issue 操作与部署按用户授权执行；子任务由主助手管理，不允许子任务继续创建子任务。

## 更新与复核

本项目技能包含明确的项目适配，不能把上游覆盖安装当作完整更新：

1. 对照 `skills-lock.json` 与上游正式目录查看需要更新的技能；保留未提交现场。
2. 更新有需要的项目副本与对应来源锁，保留许可证。来源锁描述上游内容，不表示适配后文件仍与上游逐字相同。
3. 对照 [domain.md](domain.md) 检查 `domain-modeling`、`grill-with-docs`、setup 模板、`to-spec`、`to-tickets`、实现、审查与 `ask-matt`：规格与决定继续写入 OpenSpec，工作项只引用规格。
4. 官方 OpenSpec 生成技能通过以下命令更新；当前项目仍使用记录的 CLI 版本，升级版本时单独核对生成差异：

   ```bash
   pnpm dlx @fission-ai/openspec@1.14.3 update
   ```

5. 在仓库根目录运行技能发现与规格校验，另外核对本次实际改动的技能引用：

   ```bash
   pnpm dlx skills@latest list --json
   pnpm dlx @fission-ai/openspec@1.14.3 list --specs
   pnpm dlx @fission-ai/openspec@1.14.3 validate --all --strict --no-interactive
   ```

首次安装来源为 `pnpm dlx skills@latest add 4o4E/skills --agent universal --skill <所需技能名称> --yes`，仅用于选择需要的正式技能；后续更新必须包含上述项目适配复核。不安装 misc、in-progress 或无关的课程、写作及特定工具配置技能。
