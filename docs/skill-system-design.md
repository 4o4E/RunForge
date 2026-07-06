# Skill 系统设计

本文设计 `RunForge` 的 skill 系统。目标是把业务流程、项目经验、工具用法、模板和脚本沉淀为可复用能力，同时避免把大量工具说明和流程文档长期塞进 LLM 上下文。

## 背景和目标

当前原逻辑是：后端在每轮 LLM 调用时通过 `toolSchemas()` 暴露全部工具 schema，工具说明、参数 schema 和业务特化工具都会进入模型上下文。随着工具数量增加，会带来三个问题：

- 上下文膨胀：模型每轮都要读一堆不相关工具。
- 工具选择变差：工具越多，模型越容易选错或误用。
- 业务经验无法复用：流程、检查清单、特定系统的脚本只能靠反复提示。

新的 skill 系统要做的改变：

- 初始上下文只注入 skill 的 `name` 和 `description`，用于路由判断。
- skill 激活后才加载 `SKILL.md` 的正文和运行上下文。
- skill 可以携带 `references/`、`assets/`、`scripts/`，但这些内容只按需读取或执行。
- skill 内资源通过 bash 和文件系统暴露，不引入 `skill://` resource URL。
- 内置 skill 和用户 skill 使用同一套协议，但来源、权限和写保护不同。

这个设计参考 Agent Skills 的开放协议、Claude/Codex 的渐进加载实践，以及 MCP 对 tools/resources/prompts 的职责划分：

- OpenAI Codex Skills: https://developers.openai.com/codex/skills
- Anthropic Agent Skills: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- Agent Skills Spec: https://agentskills.io/specification
- Claude Code Skills: https://code.claude.com/docs/en/skills
- MCP Resources: https://modelcontextprotocol.io/specification/2025-06-18/server/resources

## 核心原则

1. **skill 是文件夹协议，不是单条提示词。**
   `SKILL.md` 是入口，附属内容放在同一目录下，便于版本管理和本地执行。

2. **初始上下文只做路由。**
   初始注入只包含 `name` 和 `description`。路径、来源、工具权限、hash、版本都不进入初始列表。

3. **激活后最小注入。**
   激活 skill 时只注入这个 skill 独有的信息：`name`、运行时根目录和去掉 frontmatter 后的 `SKILL.md` 正文。路径规则、资源规则、权限语义等通用说明放在系统提示词中，不随每个 skill 重复注入。

4. **资源直接走 bash / 文件工具。**
   skill 中的模板、数据、文档和脚本都是普通文件。模型可以用 `sed`、`rg`、`node`、`python` 等命令查看和执行，但所有调用必须经过现有工具策略和沙箱。

5. **权限由后端执行，不靠提示词约束。**
   `allowed-tools` 只能缩小 skill 可用工具范围，不能放大全局权限。内置 skill 只读也必须由 policy 或 bwrap 只读挂载保证。

6. **长任务中保留轻量锚点。**
   skill 的大正文和工具结果可以被上下文压缩；每轮只需要保留已激活 skill 的短锚点，必要时重新读取 `SKILL.md` 或附属文件。

## 目录结构

内置 skill 源文件放在服务代码下：

```text
server/src/skills/builtin/
└── code-review/
    ├── SKILL.md
    ├── references/
    ├── assets/
    └── scripts/
```

服务启动后把内置 skill materialize 到 workspace 内：

```text
<workspaceRoot>/.agents/skills/
└── code-review/
    ├── SKILL.md
    ├── references/
    ├── assets/
    └── scripts/
```

用户 skill 直接放在 workspace 下：

```text
<workspaceRoot>/.skills/
└── data-query/
    ├── SKILL.md
    ├── references/
    ├── assets/
    └── scripts/
```

目录约定：

- `SKILL.md`：必需入口文件，包含 YAML frontmatter 和正文。
- `references/`：可按需读取的说明、schema、API 文档、业务规则。
- `assets/`：模板、样例、图片、字体、SQL 模板、HTML/React 模板等输出素材。
- `scripts/`：确定性脚本，例如校验、转换、查询封装、生成报告。
- `agents/`：可选 UI 元数据，后续用于设置页展示，不参与第一阶段路由。

## 内置 skill 的 materialize 流程

内置 skill 源文件可以包含开发注释，方便维护；启动后复制到 `.agents/skills` 前需要清理。

启动流程：

```text
server start
-> 扫描 server/src/skills/builtin
-> 校验每个 skill 的 SKILL.md
-> 过滤内置开发注释
-> 复制到 <workspaceRoot>/.agents/skills
-> 生成 materialized hash 清单
-> 建立 SkillIndex
```

过滤规则建议：

- 仅对内置 skill 生效，用户 skill 不做内容改写。
- 支持约定注释块，例如：

```markdown
<!-- @internal
这里是给开发者看的维护说明，不复制到运行时 skill。
-->
```

- 过滤后重新计算 hash，hash 记录运行时实际内容。
- 如果 `.agents/skills/<name>` 已存在且 hash 未变化，不重复复制。
- 如果 hash 变化，原子替换目录，避免多进程读到半成品。

只读规则：

- `.agents/skills` 是运行时只读目录。
- file 写工具不得修改 `.agents/skills`。
- shell 在 enforce 模式下应把 `.agents/skills` 只读挂载。
- 如果后端只能做进程内 policy，至少要拦截常见写操作路径，例如重定向、`rm`、`mv`、`cp` 写入、`sed -i` 等。更完整的保护应放到 bwrap 或后续容器层。

## Skill 元数据

`SKILL.md` 必须包含：

```yaml
---
name: data-query
description: Query project datasource docs and run readonly SQL helper scripts. Use when the user asks about datasource schemas, account pools, or report queries.
allowed-tools: shell grep file_read
compatibility: Requires node and psql client when running scripts.
metadata:
  runforge.tool-scope: readonly
  runforge.requires-network: "false"
---
```

字段规则：

- `name`：必需，和目录名一致；小写字母、数字和短横线；不使用 `builtin-` 前缀。
- `description`：必需，写清楚这个 skill 做什么、什么时候用；这是初始路由的核心。
- `allowed-tools`：可选，声明该 skill 预期需要的最小工具集合。
- `compatibility`：可选，说明运行环境要求，例如需要 `python3`、`node`、`psql`。
- `metadata.runforge.*`：可选，本项目私有扩展。

不建议注入给模型的字段：

- license、author、version、hash。
- 未知 metadata。
- 内置源文件真实路径。

这些字段可以保留在后端索引和 UI 中，但不应进入 LLM 上下文。

## Skill 索引

后端启动时构造统一索引：

```typescript
interface SkillIndexItem {
  id: string;             // builtin:code-review 或 user:data-query
  name: string;           // code-review
  description: string;
  source: 'builtin' | 'user';
  root: string;
  readonly: boolean;
  allowedTools: string[];
  compatibility?: string;
  hash: string;
}
```

初始注入给模型的列表只包含：

```text
可用 Skills / Available skills:
- code-review: Review code changes and identify bugs, regressions, and missing tests.
- data-query: Query project datasource docs and run readonly SQL helper scripts.
```

不注入路径、hash、source、allowedTools 的原因：

- 初始列表只用于选择 skill，不用于执行。
- 路径提前出现会增加模型错误引用路径的概率。
- 权限信息由后端执行，提前告诉模型没有安全价值。
- 大量附加信息会挤占上下文。

当 skill 很多时，初始列表需要裁剪：

- 总预算建议为上下文预算的 1% 到 2%，或固定 8,000 字符。
- 优先保留用户明确点名的 skill。
- 再保留当前 workspace 的用户 skill。
- 再保留最近使用过的 skill。
- 最后按 `description` 与用户请求的关键词匹配度裁剪。

## 激活流程

skill 激活是 run 级状态，不是全局状态。

```text
LLM 看到初始 skill 列表
-> 判断任务需要某个 skill
-> 调用 skill_activate(name)
-> 后端解析 SkillIndex
-> 校验 allowed-tools 和全局工具策略
-> 读取并解析 SKILL.md
-> 注入 name + root + 正文
-> 记录 skill_activated 事件
```

激活后只注入最小内容：

```text
已激活 Skill / Activated Skill:
- name: data-query
- root: /workspace/.skills/data-query

正文 / Instructions:
<去掉 YAML frontmatter 后的 SKILL.md body>
```

不随 skill 重复注入的内容：

- `source`、`readonly`、`hash`、`allowedTools` 等索引和审计字段。
- 相对路径如何解析。
- `references/`、`assets/`、`scripts/` 的通用用法。
- `allowed-tools` 和全局工具策略的权限关系。
- 内置 skill 只读、用户 skill 脚本不可信等安全规则。

这些内容由系统提示词和后端策略统一承载。

系统提示词中固定加入一次通用规则：

```text
Skill 使用规则 / Skill usage rules:
- 激活 skill 后，你会看到该 skill 的 name、root 和 instructions。
- After a skill is activated, you will see its name, root, and instructions.
- Skill 正文里的相对路径都以该 skill 的 root 为基准解析。
- Resolve relative paths in skill instructions against that skill root.
- references、assets、scripts 都是 root 下的普通文件，可用文件工具或 shell 按需读取。
- references, assets, and scripts are normal files under root; inspect them with file tools or shell when needed.
- 不要修改 skill 目录本身；输出文件写到 workspace 的普通工作目录，除非用户明确要求编辑某个用户 skill。
- Do not modify skill directories; write outputs to normal workspace locations unless the user explicitly asks to edit a user skill.
- 脚本执行必须遵守工具策略、沙箱、网络开关和输出截断。
- Script execution must follow tool policy, sandboxing, network settings, and output limits.
```

生命周期：

- 一个 run 内激活后默认保持可用。
- run 结束后 active skill 清空。
- 下一轮 run 不盲目继承 active skill，但可以把最近使用 skill 作为路由参考。
- 如果多轮 thread 继续同一任务，由模型或路由器重新激活 skill。

这样做的原因是：skill 是任务上下文，不是长期 memory。永久激活会造成上下文和工具暴露范围越来越大。

## 附属内容读取和脚本执行

本设计不使用 `skill://` resource URL。skill 附属内容通过真实文件路径暴露给 bash 和文件工具。

选择 bash/文件系统的原因：

- 和 Claude Code 这类本地 coding agent 的实践一致。
- skill 作者不需要学习额外资源协议。
- `scripts/` 能被 `node`、`python`、`bash`、`jq`、`psql` 等直接执行。
- `assets/` 模板可以被普通文件工具复制、读取或作为脚本输入。
- 当前项目已有 workspaceRoot、shell sandbox、输出截断和工具策略，能复用现有边界。

典型用法：

```bash
sed -n '1,200p' /workspace/.skills/data-query/references/schema.md
rg "account pool" /workspace/.skills/data-query/references
node /workspace/.skills/data-query/scripts/query.js --help
```

执行脚本规则：

- 脚本必须位于已激活 skill 的 `scripts/` 下。
- 用户 skill 的脚本视为不可信代码，必须走 shell sandbox、网络开关、命令 denylist 和输出截断。
- 内置 skill 脚本也不能绕过全局策略。
- 执行前建议先用 `--help` 或读脚本头部确认参数。
- 对会写 workspace 的脚本，`SKILL.md` 必须明确写出输出目录和副作用。

读取资源规则：

- `references/` 是给模型读入上下文的材料，按需读。
- `assets/` 是给输出使用的素材，不要默认全文读入上下文。
- 大文件先用 `ls`、`file`、`head`、`rg` 定位，再局部读取。
- 二进制文件不要直接塞进工具输出；脚本应输出摘要或生成 artifact。

## allowed-tools 语义

`allowed-tools` 是 skill 的最小工具需求声明，不是授权来源。

最终工具可用集合：

```text
全局 app_settings 工具策略
∩ run 级策略
∩ skill allowed-tools
```

含义：

- 如果全局禁用 shell，skill 写了 `allowed-tools: shell` 也不能用。
- 如果全局 deny 了 web_search，skill 不能重新打开。
- 如果 skill 没写 `allowed-tools`，只给基础安全工具，例如 `file_read`、`grep`，不自动给 shell、网络和写文件。
- 如果多个 skill 同时激活，可用工具集取所有 active skill 的并集后再和全局策略取交集；但写工具、shell 和网络仍应按 run 策略严格限制。

建议第一阶段支持的工具名沿用现有 registry 名称：

```text
shell file_read file_write file_edit glob grep web_fetch web_search ask_user update_plan
```

后续如果引入业务工具，可以让业务工具只在特定 skill 激活后暴露给模型，避免常驻工具 schema 膨胀。

## 内置和用户 skill 的冲突

skill `name` 不加 `builtin-` 前缀。

原因：

- `name` 应表达能力，不应表达来源。
- 标准协议要求 `name` 和目录名一致，带 `builtin-` 会污染用户点名体验。
- Claude Code 的 bundled skills 也使用普通名字，例如 `code-review`、`debug`。

内部唯一标识用：

```text
builtin:code-review
user:code-review
```

冲突策略：

- 同名冲突不静默覆盖。
- 默认用户 skill 优先，但启动时写 warning event/log。
- 如果模型只说 `code-review` 且存在冲突，激活用户 skill；如果需要内置版本，允许用户或模型指定 `builtin:code-review`。
- 前端设置页应展示 source 和 readonly，避免用户误以为内置 skill 可编辑。

## 上下文裁剪

裁剪分三层。

第一层：初始 skill 列表裁剪。

- 只保留 `name` 和 `description`。
- 超预算时裁剪低相关 skill。
- 被裁剪的 skill 不代表不可用；后续可以通过搜索或设置页选择。

第二层：active skill 内容裁剪。

- 激活时只注入 `name`、`root` 和 `SKILL.md` 正文。
- `references/`、`assets/`、`scripts/` 不提前全文注入。
- 长任务中如果 `SKILL.md` 的工具结果被压缩，不必强保留全文。

第三层：长任务锚点。

每轮保留短锚点：

```text
当前激活 Skills / Active skills:
- data-query, root=/workspace/.skills/data-query
```

如果模型需要详细说明，再重新读：

```bash
sed -n '1,220p' /workspace/.skills/data-query/SKILL.md
```

这样既不丢任务方向，又不会让 skill 正文永久占上下文。

## 事件和审计

新增事件建议：

- `skill_indexed`：启动扫描时记录 skill 数量、来源和冲突。
- `skill_materialized`：内置 skill 复制或 hash 变化。
- `skill_activated`：run 内激活 skill。
- `skill_deactivated`：后续支持手动卸载时记录。
- `skill_policy_blocked`：skill 请求的工具被全局策略拒绝。

`skill_activated` 事件至少记录：

```json
{
  "skillId": "user:data-query",
  "name": "data-query",
  "source": "user",
  "root": "/workspace/.skills/data-query",
  "readonly": false,
  "hash": "sha256:...",
  "allowedTools": ["shell", "grep", "file_read"]
}
```

注意：事件里可以记录真实路径用于调试；LLM 初始路由列表不注入真实路径。

## 安全边界

必须后端保证的边界：

- `.agents/skills` 只读。
- skill 路径必须位于 `workspaceRoot` 下。
- 禁止 symlink 越界读取或写入；路径校验应使用 realpath。
- shell 执行仍受 `SHELL_ENABLED`、`SHELL_DENY`、`TOOL_NETWORK`、`TOOL_MAX_OUTPUT` 控制。
- 用户 skill 脚本视为不可信输入。
- 内置 skill 不能因为来自代码仓库就绕过全局工具策略。
- `allowed-tools` 只能缩小权限。

第一阶段不解决的问题：

- 远程 skill marketplace。
- 非文件资源，例如数据库动态 resource。
- 多租户强隔离。
- skill 签名和供应链校验。
- per-skill CPU、内存、进程数、磁盘配额。

这些能力适合在后续平台化执行环境里做，不应阻塞本地原型。

## 不采用 skill URL 的原因

讨论过 `skill://builtin/code-review/SKILL.md` 这类 resource URL。它的优点是隐藏真实路径、便于审计、适合远程资源和多租户网关。

但第一阶段不采用，原因是：

- 当前目标是本地 agent 平台，bash/文件系统是最自然的交互面。
- 脚本、模板和数据文件需要被 shell 直接操作，resource URL 会增加一层转换。
- 项目已有工具策略和 workspaceRoot，可以先复用。
- 引入 URL 协议会让 skill 作者多学一套路径模型。
- 远程 skill、数据库 resource、对象存储 resource 还不是当前刚需。

保留后续兼容空间：

- 后端索引可以内部记录 resource id，但不暴露给模型。
- 如果未来支持远程 skill，可在后端 materialize 到本地目录后继续用 bash 模型。
- 如果未来运行环境没有 shell，再增加 `skill_read_resource` 作为兼容工具。

## 推荐实施阶段

当前实现状态：

- 阶段 1 已落地：`server/src/skills/` 会扫描内置和用户 skill，物化内置 skill 到 `.agents/skills`，初始上下文注入 skill 名称和描述，并通过 `skill_activate` 按需加载正文。
- 阶段 2 已部分落地：`allowed-tools` 会参与工具 schema 暴露，工具策略会保护 `.agents/skills` 写入；更细的 symlink 越界和 bwrap 只读挂载仍需要继续验收。
- 阶段 3 已部分落地：DB events 能看到 `skill_activated`，但设置页管理、冲突展示和完整前端调试面仍未完成。
- 阶段 4、阶段 5 仍是后续平台化方向。

阶段 1：文件协议和索引。

- 新增 `server/src/skills/` 模块。
- 扫描内置和用户 skill。
- 校验 `SKILL.md`。
- materialize 内置 skill 到 `.agents/skills`。
- 初始上下文注入 `name` 和 `description`。
- 新增 `skill_activate` 工具。
- 记录 `skill_activated` 事件。

阶段 2：权限和沙箱收紧。

- `allowed-tools` 参与工具 schema 暴露。
- `.agents/skills` 写保护。
- shell/bwrap 对 `.agents/skills` 只读挂载。
- realpath 防 symlink 越界。

阶段 3：前端和调试。

- 设置页展示 builtin/user skill。
- 展示冲突、hash、readonly、allowed-tools。
- run 详情展示本次激活了哪些 skill。

阶段 4：复杂路由。

- skill 索引预算裁剪。
- 最近使用 skill 加权。
- 用户点名 `builtin:name` / `user:name`。
- 业务工具只在 skill 激活后暴露。

阶段 5：平台化扩展。

- 远程 skill 安装。
- 签名校验。
- per-skill 权限 profile。
- 非文件 resource 支持。
- 多租户隔离和资源配额。

## 验收标准

基础验收：

- 启动后能发现内置 skill 和用户 skill。
- 初始 LLM 上下文只包含 `name` 和 `description`。
- 模型能激活 skill，并看到运行时 root 和 `SKILL.md` 正文。
- 模型能通过 bash 读取 `references/`，执行 `scripts/`，使用 `assets/`。
- 内置 skill materialize 后不可被 file 写工具或 shell 修改。
- 用户 skill 同名覆盖内置 skill 时有明确 warning。
- `allowed-tools` 能限制 skill 激活后的工具可见集合。
- 长任务压缩后仍保留 active skill 锚点，必要时可重新读取 `SKILL.md`。

安全验收：

- `.agents/skills` 写入被拒绝。
- symlink 指向 workspace 外部时读取/执行被拒绝。
- 全局禁用 shell 时，skill 脚本无法执行。
- 全局禁用网络时，skill 脚本不能通过 shell 获取网络能力。
- 工具输出仍受 `TOOL_MAX_OUTPUT` 限制。

诊断验收：

- DB events 能看到 `skill_activated`。
- run 失败时能从事件中判断激活了哪个 skill、使用了哪些工具、是否被策略拦截。
- 前端能展示本次 run 激活的 skill 列表。
