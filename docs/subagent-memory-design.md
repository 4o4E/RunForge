# Subagent、Agent 配置与 Gene Memory 设计

本文记录 `RunForge` 当前 subagent v1、skill、workflow 的协作边界，并设计后续 runtime profile
和 gene memory 体系。目标不是把 agent 变成低代码流程编排器，而是让入口 agent 能按任务成熟度选择：

- 稳定工作：读稳定文档和 skill，自动注入少量相关经验，按已验证流程执行。
- 不稳定工作：依赖 LLM 探索能力，主动检索碎片经验，完成后沉淀候选 gene。
- 成熟过程：碎片经验经过多次验证后，逐步提升为 workflow 文档或 skill。

## 背景和原逻辑

当前系统已经有这些基础：

- `thread` 内历史消息会在新 run 启动时加载，支持同一会话内连续记忆。
- 长任务通过 Goal 锚点、上下文压缩和 `update_plan` 降低目标漂移。
- skill 系统已经按文件夹协议实现，`SKILL.md` 是入口，激活后才加载正文和资源。
- skill 激活是 run 级状态，run 结束后清空，避免工具暴露和上下文持续膨胀。
- workflow 系统已经按文件夹协议实现，LLM 可通过 `workflow_list` 和 `workflow_read` 读取稳定流程。
- subagent v1 已实现异步只读推理：主 agent 可以派发子任务，拿到 `subagentRunId` 后轮询或跨 run 查看结果。
- 当前没有跨 thread 的 memory 系统，也没有经验检索、写入、引用和退化闭环。

在已落地能力之上，后续设计继续做这些改变：

- 把长期经验拆成结构化 gene，而不是继续堆进 skill 文档。
- 把阶段目标、输入输出、gate 和失败策略写进 workflow stage。
- 把本次 subagent 的具体目标、上下文和交付物写进 task assignment。
- 把稳定业务方法、检查清单、脚本和引用资料写进少量粗粒度 skill。
- 把 subagent 的模型、工具、权限、隔离和轮数限制写进 runtime profile。
- 把模型倾向和模型补丁放进 model profile 或带模型作用域的 gene。
- 用 RAG 检索碎片化经验，但用结构化条件和二次判定决定是否真正注入。
- 引入经验退化和提升机制，让经验能被验证、吸收、降权或废弃。

这样做的原因是：workflow 决定现在做到哪一步，task assignment 决定这次具体交付什么，
skill 决定这类事通常怎么做，runtime profile 决定能用什么资源做，gene 决定过去有哪些
经验需要提醒。subagent 会放大上下文污染和错误经验传播，所以必须先明确经验的作用域、
读写时机和生命周期。

## 核心分层

### Workflow Stage

Workflow stage 定义稳定流程中的阶段边界，不承载具体实现经验。

当前实现采用本地文件协议：

```text
server/src/workflows/builtin/<name>/WORKFLOW.md
<workspaceRoot>/.agents/workflows/<name>/WORKFLOW.md
<workspaceRoot>/.workflows/<name>/WORKFLOW.md
```

- `server/src/workflows/builtin` 是内置 workflow 源文件。
- 服务运行时会把内置 workflow 物化到 `<workspaceRoot>/.agents/workflows`，该目录只读。
- 用户 workflow 放在 `<workspaceRoot>/.workflows`，同名时优先于内置 workflow。
- 未来多用户支持时，只要把 `workspaceRoot` 或用户资源根切到对应用户目录，就能自然读取各自的 `.workflows` 和 `.skills`。
- LLM 通过 `workflow_list` 查看可用 workflow，通过 `workflow_read` 按需读取正文。

应包含：

- `id`：阶段 ID，例如 `design`、`implement`、`review`。
- `goal`：这一阶段要达成什么。
- `input_contract`：进入阶段前需要哪些输入。
- `output_contract`：阶段结束时必须产出什么。
- `gate`：阶段通过条件。
- `handoff`：交给下一阶段的内容。
- `failure_policy`：失败、超时或信息不足时怎么处理。
- `skills`：本阶段默认使用哪些 skill。
- `runtime_profile`：本阶段默认使用的运行时配置。

不应包含：

- 大段方法说明。
- 某个模型的行为补丁。
- 临时项目经验。
- 未验证的历史猜测。

示例：

```yaml
id: review
goal: "确认本次代码变更是否存在阻塞问题。"
input_contract:
  - "变更 diff"
  - "实现说明"
  - "测试结果"
output_contract:
  - "按严重程度排序的问题"
  - "文件和行号"
  - "是否阻塞合并"
gate:
  - "没有 P0/P1 问题"
skills: ["code-review"]
runtime_profile: "readonly"
```

### Task Assignment

Task assignment 是 router 派发给 subagent 的一次性任务单，承载本次任务的具体目标。

应包含：

- `goal`：本次子任务要完成什么。
- `context`：必要背景和上游结论。
- `inputs`：本次可用输入。
- `expected_output`：本次交付物。
- `constraints`：本次限制，例如不要写文件、只做审查。
- `stop_condition`：做到什么程度就停止。

Task assignment 不应沉淀为长期文档。它来自当前 run 的具体上下文，完成后进入 run 证据链。

### Skill

Skill 承载可复用能力的方法、检查清单、脚本、模板和引用资料。Skill 数量不宜过多，
应保持粗粒度和可复用。

适合放：

- 这类能力通常怎么做。
- 检查清单和常见风险。
- 工具、脚本、模板和引用资料。
- 可复用的验证方法。
- 适用边界和不适用场景。

不适合放：

- 某个 workflow stage 的具体目标、输入和输出。
- 某次 subagent 的具体任务单。
- 大量零散踩坑。
- 只对某个模型有效的提示补丁。
- 一次性任务结论。
- 尚未验证的经验。

建议先保持少量稳定 skill，例如：

```text
requirements-analysis
architecture-design
repo-editing
code-review
test-debugging
docs-writing
release-check
```

### Subagent Runtime Profile

Subagent runtime profile 是运行时壳，不写业务方法。

应包含：

- `model`：使用的模型，或继承主 run。
- `tools`：允许暴露的工具集合。
- `write_access`：是否允许写文件。
- `isolation`：是否使用独立 workspace、worktree 或沙箱。
- `max_turns`：最大轮数。
- `timeout`：超时策略。
- `memory_policy`：是否允许主动读取 memory，是否允许创建 candidate。

权限必须由后端执行，不能靠 skill 正文约束。Skill 可以声明建议权限，但不能放大全局策略。

### Gene Memory

Gene memory 是短小、可触发、可验证的行为经验。它不是长文档，也不是聊天摘要。

适合放：

- 什么时候该做什么。
- 之前做过什么并被验证有效。
- 哪些做法被证明会失败。
- 某个模型、项目、工具组合下的行为调整。
- 尚未成熟到能写进 skill 的碎片经验。

Gene 的基本结构：

```yaml
id: gene_...
kind: behavior
status: candidate
summary: "一句话说明这条经验解决什么问题。"
signals:
  - "触发场景"
anti_signals:
  - "不适用场景"
scope:
  user: "*"
  project: "RunForge"
  agent_roles: ["router", "coder"]
  models: ["*"]
strategy:
  - "执行时应该怎么做。"
avoid:
  - "AVOID 明确禁止重复的错误行为。"
validation:
  - "怎么判断这条经验真的有用。"
source:
  run_ids: []
  step_ids: []
  evidence: []
lifecycle:
  created_at: "2026-06-15T00:00:00Z"
  updated_at: "2026-06-15T00:00:00Z"
  last_used_at: null
  last_validated_at: null
  use_count: 0
  success_count: 0
  failure_count: 0
  confidence: 0.4
  decay_after_days: 30
  absorbed_by: null
```

### Model Profile

Model profile 记录模型倾向，不污染业务 skill。

适合放：

- 某个模型在长任务中的稳定偏差。
- 某个模型需要更明确的输出格式。
- 某个模型对工具调用、计划维护、英文提示词的适配要求。

如果一条经验只对某个模型有效，应写成带 `models` scope 的 gene，或进入该模型的 profile。
模型特定经验必须来自真实运行证据，不能凭感觉长期固化。

## 稳定工作和不稳定工作

### 稳定工作

稳定工作已经有多次成功经验，流程、输入、输出和验收方式比较明确。

执行路径：

```text
用户任务
-> router 识别稳定工作类型
-> 选择 workflow stage
-> 生成本次 task assignment
-> 自动激活 stage 关联 skill
-> 创建对应 runtime profile 的 subagent
-> 检索与该 skill 关联的少量 active gene
-> 生成或更新计划
-> 执行并验证
-> run 结束后补充或退化 gene
```

读取策略：

- 可以自动注入 workflow stage、skill 和少量高置信 gene。
- gene 只做轻量校正，不替代主流程。
- 修改计划时可以自动检索计划相关 gene。
- 派发 subagent 前可以按 stage、skill 和 runtime profile 检索相关 gene。

写入策略：

- 完成后由 memory reflector 自动总结候选 gene。
- 如果发现 skill 已覆盖某条 gene，把该 gene 标记为 `absorbed`。
- 如果出现新边缘场景，只写 candidate，不直接改稳定 skill。

### 不稳定工作

不稳定工作还没有清晰流程，主要依赖 LLM 探索能力。

执行路径：

```text
用户任务
-> router 识别探索型任务
-> 只注入基础用户偏好和项目硬约定
-> 工作 agent 按需主动调用 memory_search
-> RAG 返回候选 gene 和历史证据
-> agent 自己决定是否采纳
-> 用户明确要求时创建高优先级候选 gene
-> run 结束后 memory reflector 提取经验
```

读取策略：

- 默认不自动塞入大量历史经验。
- RAG 负责找可能相关的碎片经验。
- 结构化 scope、signals、anti_signals 和 LLM rerank 决定是否真正采用。
- 候选或过期 gene 可以在主动搜索中返回，但必须标明状态。

写入策略：

- 主动写只能创建 candidate，不能直接 active。
- 被动写是主通道，从完整 run 轨迹中提取候选经验。
- 多次成功复用后再进入 active 或 promotion 流程。

## Gene 读取设计

Gene 读取分为被动读取和主动读取。

### 被动读取

被动读取由系统在关键边界自动触发，工作 agent 不需要显式调用。

触发点：

- run 启动：读取用户偏好、项目硬约定和高置信 active gene。
- skill 激活：读取与该 skill 关联的 active gene。
- `update_plan` 创建或大幅修改计划：按计划项读取相关 gene。
- subagent 派发前：按 agent role、任务输入和工具权限读取相关 gene。
- run resume：读取上次使用过且仍有效的 gene 锚点。

原则：

- 不在每轮 LLM 调用前全量检索，避免噪声和成本失控。
- 默认只注入少量 active gene。
- 每条注入的 gene 必须记录引用来源和触发原因。
- stale gene 不自动注入，只在主动搜索或审计中可见。

### 主动读取

主动读取由 agent 通过 `memory_search` 触发。

适用场景：

- agent 不确定项目约定。
- 任务看起来和历史问题相似。
- 用户问“之前怎么做的”。
- 不稳定任务需要查相似经验。
- subagent 需要补充自己的角色经验。

返回结果必须包含：

- gene 内容。
- status 和 confidence。
- source run 或证据片段。
- 为什么被召回。
- 是否可能过期。

## Gene 写入设计

Gene 写入分为主动写入和被动写入。

### 主动写入

主动写入由工作 agent 或用户触发。

适用场景：

- 用户明确说“记住这个”“以后都这样”。
- agent 发现强约束，例如项目约定、启动方式、安全边界。
- agent 遇到明确可复用的失败教训。

限制：

- 工作 agent 只能创建 `candidate`。
- 不能直接创建 `active`。
- 必须带 source run、证据和适用范围。
- 如果用户明确授权，可标记为 high priority candidate，但仍需要后续验证或用户确认。

### 被动写入

被动写入由 run 结束后的 memory reflector 触发，对工作 agent 无感。

输入：

- 用户原始需求。
- plan 变化。
- 工具调用和错误。
- subagent 输入输出。
- 最终验证结果。
- 用户纠正和确认。
- 本次使用过的 gene。

输出：

- 新 candidate gene。
- 对已有 gene 的成功或失败反馈。
- 对 stale、deprecated、absorbed 的状态建议。
- 对 workflow 文档或 skill 的 promotion 建议。

被动写入要避免：

- 从最终回答里直接总结，忽略工具证据。
- 把一次性结论写成长久经验。
- 把猜测写成事实。
- 把业务文档内容复制进 gene。

## RAG 与触发判定

Gene 到一定规模后需要 RAG，但不能只靠向量相似度决定触发。

推荐流程：

```text
硬过滤
-> 候选召回
-> LLM rerank
-> 注入预算裁剪
-> 使用记录
```

硬过滤：

- user scope。
- project scope。
- agent role scope。
- model scope。
- status。
- 工具和运行环境条件。

候选召回：

- 关键词、tag、路径匹配。
- embedding 语义检索。
- 最近成功使用过的 gene 加权。
- 与已激活 skill 关联的 gene 加权。

LLM rerank：

- 检查 signals 是否匹配。
- 检查 anti_signals 是否命中。
- 检查 validation 是否能在当前任务中执行。
- 检查是否被更稳定的 skill 覆盖。

注入预算：

- 稳定任务默认 3 到 8 条。
- 不稳定任务默认只注入基础约定，其他由主动读取获取。
- 每条 gene 必须短，不能变成长文档。

## 经验成熟度生命周期

经验不是一次写完，而是持续演化。

```text
L0 原始轨迹
-> L1 candidate gene
-> L2 active gene
-> L3 gene cluster
-> L4 draft workflow 或 draft skill
-> L5 stable workflow 或 stable skill
```

### L0 原始轨迹

完整 run、step、message、event、artifact 和 subagent 输出。它是证据，不直接进入上下文。

### L1 Candidate Gene

从单次任务中提取，尚未证明稳定。默认不自动注入。

### L2 Active Gene

经过用户确认、多次成功复用或验证器证明有效。可以被自动召回。

### L3 Gene Cluster

多条 gene 指向同一个稳定模式，说明这类工作开始成型。

### L4 Draft Workflow 或 Draft Skill

由 promotion agent 把 gene cluster 整理为文档草案。

### L5 Stable Workflow 或 Stable Skill

如果阶段目标、输入输出、gate 和失败策略已经清楚，提升为 stable workflow。
如果通用方法、检查清单、脚本和引用资料已经稳定，提升为 stable skill。

## 退化机制

Gene 必须会失效。系统、代码、模型、工具和用户偏好变化后，旧经验可能变成错误指导。

状态流转：

```text
candidate -> active -> promoted
                    -> absorbed
                    -> stale
                    -> deprecated
                    -> rejected
```

状态含义：

- `candidate`：候选经验，未验证。
- `active`：当前可用，可自动召回。
- `promoted`：已经提升成 workflow 文档或 skill。
- `absorbed`：已被某个 skill 覆盖，默认不再单独注入。
- `stale`：疑似过期，只在主动搜索或审计中返回。
- `deprecated`：确认失效，不再返回给工作 agent。
- `rejected`：确认错误，保留审计但不可复用。

退化触发：

- 时间退化：长时间未使用或未验证。
- 环境变更：关键文件、配置、依赖、schema、skill、AGENTS 文档变化。
- 执行失败：采用 gene 后任务失败或验证不通过。
- 用户纠正：用户明确指出经验错误或不再适用。
- 冲突替代：新 gene 与旧 gene 冲突，旧 gene 降权或废弃。
- 文档吸收：经验已被整理进 skill 或 workflow 文档。
- 模型变化：模型作用域不匹配或模型行为已变化。

读取规则：

- `active` 且未过期：可以自动注入。
- `stale`：不自动注入，主动搜索时返回并标注风险。
- `deprecated` 和 `rejected`：不返回给工作 agent，只用于审计。
- `absorbed`：默认改为注入对应 skill 或文档。

## Subagent 协作设计

### Router Agent

Router agent 是入口 agent，负责：

- 判断任务是稳定工作还是不稳定工作。
- 选择 workflow stage、skill、runtime profile 和初始 gene。
- 为每个 subagent 生成 task assignment。
- 拆解子任务。
- 派发 subagent。
- 汇总结果。
- 处理冲突、失败、超时和用户确认。

Router 不应该：

- 把所有 memory 直接塞给所有 subagent。
- 让 subagent 共享同一个无限上下文。
- 让 subagent 直接写 active memory。

### Subagent

每个 subagent 应有独立上下文。

输入：

- workflow stage 的阶段目标和 gate。
- router 生成的 task assignment。
- 必要的上游结论。
- 必要的 skill。
- 与角色相关的少量 gene。
- runtime profile 决定的工具和限制。

输出：

- 结论。
- 证据。
- 已执行动作。
- 验证结果。
- 未解决问题。
- 可选 memory candidate。

### 结果汇总

Router 汇总时必须能看到：

- 每个 subagent 使用了哪些 gene。
- 每个 subagent 激活了哪些 skill。
- 哪些结论有证据。
- 哪些结论冲突。
- 哪些输出可提升为 candidate gene。

### 执行语义

subagent 是 thread 级异步资源，不阻塞入口 agent 的主循环。

当前语义：

- `subagent_run` 只负责创建任务单并返回 `subagentRunId`，不等待子任务完成。
- 后台执行完成后写回 `subagent_runs.output/error/usage`，并追加 `subagent_finished` 或
  `subagent_failed` 事件。
- 入口 agent 可以连续启动多个 subagent，再用 `subagent_poll` 查询单个结果，或用
  `subagent_list` 查看当前 thread 的所有 subagent。
- subagent 归属 thread，而不是只归属当前 run；后续 run 可以继续轮询和使用之前 run
  创建的 subagent 结果。
- 第一版后台任务依赖当前服务进程存活；如果服务重启，`running` 状态任务需要后续补
  recovery worker 或超时标记机制。

这样设计的原因是：workflow 协作模型里，入口 agent 的职责是分派、协调和综合，不应该
被某一个子任务的 LLM 调用卡住；否则多个 subagent 只是同步工具调用，无法模拟真实多人
并行协作。

## 数据模型

当前已经落库 `subagent_runs`，用于保存 subagent task assignment、stage、skill、输出和 usage。
memory / gene 相关表仍是后续建议。RAG 索引可以后接，不应先绑死在某个向量库。

建议表：

```text
workflows
  id, name, description, stages, source, readonly, hash, created_at, updated_at

runtime_profiles
  id, name, model, tools, write_access, isolation, max_turns,
  timeout_ms, memory_policy, created_at, updated_at

memories
  id, kind, status, summary, body, scope, signals, anti_signals,
  strategy, avoid, validation, source_refs, lifecycle, embedding_ref,
  created_at, updated_at

memory_usages
  id, memory_id, run_id, step_id, subagent_id, trigger,
  decision, outcome, created_at

memory_events
  id, memory_id, event_type, payload, created_at

subagent_runs
  id, parent_run_id, parent_step_id, workflow_id, stage_id, runtime_profile_id,
  status, task_assignment, skill_names, output, error, usage,
  created_at, updated_at, finished_at
```

其中：

- `memories.body` 保存原始 YAML 或 JSON。
- `scope`、`signals`、`lifecycle` 使用 JSONB。
- `embedding_ref` 只引用向量索引，不让业务逻辑依赖具体向量库。
- `memory_events` 记录 promote、absorb、stale、deprecated、rejected 等生命周期变化。
- `subagent_runs.task_assignment` 保存一次性任务单，避免把本次任务误写进 skill。
- `subagent_runs.parent_run_id` 只表示创建来源；查询授权和 UI 展示应按 thread 汇总，
  支持跨 run 继续读取。

## 实施流程

### 阶段 1：设计和只读检索

目标：先把边界立住，不让 memory 影响主流程稳定性。

要做：

- 新增 memory/gene schema。
- 新增 `memory_search` 工具。
- 支持按 user、project、agent role、model、status 过滤。
- run 启动时只注入少量 user/project active gene。
- 记录 `memory_retrieved` 和 `memory_used` 事件。

验收：

- agent 能主动搜索 memory。
- 自动注入内容可在事件中追踪。
- 不会把 candidate/stale gene 自动塞进上下文。

### 阶段 2：被动写入和候选经验

目标：让 run 完成后自动沉淀候选经验，但不直接污染后续任务。

要做：

- 新增 memory reflector。
- run done/error/canceled 后异步扫描完整轨迹。
- 生成 candidate gene。
- 自动建议 scope 和 decay 策略。
- 前端展示候选 memory，支持确认、拒绝、编辑。

验收：

- 候选 gene 有 source run 和证据。
- 用户能看到为什么生成这条候选。
- 候选不会自动注入未来 run。

### 阶段 3：计划和 skill 边界的自动读取

目标：在稳定流程中自动给 agent 补充少量相关经验。

要做：

- `skill_activate` 后检索 skill 关联 active gene。
- `update_plan` 创建或修改计划后检索 plan 相关 active gene。
- 检索结果追加为轻量 system 锚点或 runtime context。
- 每次注入记录触发原因。

验收：

- 稳定任务能自动拿到相关 gene。
- 不稳定任务不会被大量旧经验干扰。
- 修改计划后能看到对应 memory 事件。

### 阶段 4：Subagent v1（已完成基础版）

目标：实现入口 agent 拆解、subagent 独立执行、结果回收。

已完成：

- 新增 workflow stage 配置。
- 新增 subagent 调度接口。
- subagent 使用独立上下文。
- subagent 可以加载指定 skill。
- 前端区分主 agent 和 subagent 事件。

仍待平台化：

- 新增 subagent runtime profile，并由后端执行工具权限和资源边界。
- 派发前按 stage、skill 和 runtime profile 检索 active gene。
- subagent 输出结构化结果和可选 memory candidate。
- 增加超时回收、跨进程恢复和失败隔离。
- 每个 subagent 的 stage、task assignment、runtime profile、skill 和 gene 完整可追踪。

### 阶段 5：RAG 索引和混合召回

目标：解决 gene 增多后的召回问题。

要做：

- 为 gene summary、signals、strategy、avoid 建 embedding。
- 增加关键词、tag、路径、向量混合召回。
- 增加 LLM rerank。
- 增加召回预算和去重。
- 支持 stale gene 在主动搜索中低优先级返回。

验收：

- 相似但不同措辞的任务能召回相关 gene。
- anti_signals 命中的 gene 不会自动注入。
- 召回结果解释清楚。

### 阶段 6：Promotion 和退化

目标：让经验从碎片到文档持续演化，也能在失效后退出。

要做：

- 统计 gene 使用、成功、失败、用户纠正。
- 聚类相似 gene，形成 gene cluster。
- promotion agent 生成 draft workflow 或 draft skill。
- 被吸收 gene 标记 `absorbed`。
- 关键文件变化、模型变化、失败反馈触发 stale/deprecated。
- 前端展示 promotion 和退化建议。

验收：

- 多次成功复用的经验能生成文档草案。
- 被文档覆盖的 gene 不再重复注入。
- 失效经验不会继续影响工作 agent。

## 实施顺序建议

最小可行路径：

```text
memory schema
-> memory_search
-> run 后 candidate gene
-> skill/plan 自动读取 active gene
-> workflow stage + runtime profile
-> subagent v1
-> RAG 混合召回
-> promotion 和退化
```

不要先做完整 RAG，也不要先让 agent 自动写 active memory。

原因：

- 没有 schema 和生命周期，RAG 只会更快召回脏经验。
- 没有 candidate 状态，主动写 memory 会污染后续任务。
- 没有使用记录，就无法判断经验是否应该提升或退化。
- 没有 subagent 证据链，就无法知道经验在多人协作里是否有效。

## 不采用的方案

### 不把 memory 写成长 Markdown

长 Markdown 适合 workflow 文档和 skill，不适合碎片经验。碎片经验需要 signals、scope、
validation、status 和 evidence，否则无法安全召回和退化。

### 不让 RAG 决定一切

RAG 只负责候选召回。是否注入必须经过 scope、status、anti_signals、计划语义和预算裁剪。

### 不让工作 agent 直接写 active memory

工作 agent 正在解决当前任务，容易把临时结论当长期经验。主动写入只能生成 candidate。

### 不把模型补丁塞进业务 skill

业务 skill 应尽量模型无关。模型倾向进入 model profile 或带模型 scope 的 gene。

## 参考

- Anthropic Claude Code Subagents: https://code.claude.com/docs/en/sub-agents
- Anthropic Agent Skills: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- OpenAI Codex Skills: https://developers.openai.com/codex/skills
- LangGraph Memory: https://docs.langchain.com/oss/python/concepts/memory
- LangMem Core Concepts: https://langchain-ai.github.io/langmem/concepts/conceptual_guide/
- Agent Workflow Memory: https://arxiv.org/abs/2409.07429
- Reflexion: https://papers.nips.cc/paper_files/paper/2023/hash/1b44b878bb782e6954cd888628510e90-Abstract-Conference.html
- Voyager: https://arxiv.org/abs/2305.16291
- Strategy Genes: https://arxiv.org/abs/2604.15097
