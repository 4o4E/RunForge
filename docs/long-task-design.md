# 长任务支持 · Goal 锚点 + 上下文压缩级联

> 目标：让 agent 稳定支持**长程任务**（数十步工具调用），去掉「固定最大步数」这一硬性
> 主控制器，引入 **Goal 锚点**防止目标漂移，引入**上下文压缩级联**防止撞窗口崩溃与
> context rot。本文为设计与落地路线，按阶段增量实施，每阶段可独立验证。

---

## 1. 现状与问题

当前实现（[server/src/agent/executor.ts](../server/src/agent/executor.ts)、[context.ts](../server/src/agent/context.ts)）是最简朴的 ReAct 循环：

- 主循环 `for stepIdx <= maxSteps`（默认 25），步数是**唯一主控制器**。
- `Context` 每个 run 从 `loadThreadMessages`（**全量**）重建，无截断/摘要/窗口。
- provider 已返回 `usage`（input/output tokens），但 executor **完全忽略**。
- 只有工具单条输出有 `TOOL_MAX_OUTPUT=100000` 字符硬截断，不管历史总量。
- **没有取消能力**。

两个会同时爆的隐患：

1. **撞 token 窗口**：thread 一长，拼出的 messages 超模型上下文 → provider 直接报错，run 失败且无降级。
2. **目标漂移 + context rot**：几十步后没有目标锚点和历史压缩，模型注意力稀释，偏题/返工。

---

## 2. 业界最佳实践（2025–2026 共识）

收敛到**分层级联**，而非一上来就 LLM 摘要：

1. **context rot 是真问题**：输入越长质量越差，即使没到窗口上限 → **保守设预算**（如 1M 窗口只用 ~50%）。成功指标是任务完成率/决策一致性，不是省了多少 token。
2. **压缩级联，从便宜到贵**：① 压工具输出 → ② 滑动窗口裁旧消息 → ③ 实在不行才 LLM 摘要。
3. **Observation masking 性价比最高**：旧工具结果替换为占位符（保留 reasoning 轨迹），SWE-bench 上成本减半、完成率持平 LLM 摘要。
4. **锚定式增量摘要**（Factory AI）：不重新生成整段，而是扩展结构化锚点 `intent / changes / decisions / next`，对保留文件路径、错误信息等技术细节准确率最高。
5. **Goal 靠「结构化外部笔记 + 每轮重注入」**：目标写在上下文之外，压缩后读回。Anthropic 结论：模型够强时，光靠 compaction 即可维持长程连续性。
6. **触发用 token 预算阈值**：常见 75% 预警、90% 触发。

参考来源：
- [Anthropic — Context engineering: memory, compaction, tool clearing](https://platform.claude.com/cookbook/tool-use-context-engineering-context-engineering-tools)
- [Factory AI — Evaluating Context Compression Strategies (ZenML)](https://www.zenml.io/llmops-database/evaluating-context-compression-strategies-for-long-running-ai-agent-sessions)
- [ACON: Optimizing Context Compression for Long-Horizon LLM Agents (arXiv 2510.00615)](https://arxiv.org/pdf/2510.00615)
- [Arize — Context management in agent harnesses](https://arize.com/blog/context-management-in-agent-harnesses/)
- [Redis — Context Compaction for AI Agents](https://redis.io/blog/context-compaction/)

---

## 3. 设计

### 3.1 去掉 maxSteps —— 改成「健康度 + 预算」终止

把步数上限从**主控制器**降级为**兜底**，主控制器换成多维终止条件：

| 终止条件 | 机制 |
|---|---|
| 正常结束 | 模型不再调用工具 → final（已有） |
| Token 预算 | 累计超 run 级预算 → 触发压缩；压缩后仍无法推进才停 |
| 无进展检测 | 连续 N 步重复相同 tool+args，或反复空转 → 警告/停 |
| 用户取消 | run 状态置 `canceling`，loop 每步检查 |
| 安全兜底 | 很高的 `hardStepCap`（默认 1000），仅防失控 |

### 3.2 Goal 锚点

结构化、每轮重注入、跨压缩存活的目标锚点（Factory 四字段），存为 `runs.goal_state` JSONB：

```typescript
interface GoalState {
  intent: string;        // 几乎不变，最初目标
  plan: PlanItem[];      // agent 用 update_plan 工具维护
  decisions: string[];   // 追加式，压缩时必须保留
  next: string;          // 下一步
}
interface PlanItem { id: number; text: string; status: 'todo' | 'doing' | 'done'; }
```

- run 启动时确立 `intent`（首轮直接用 user input；多轮可一次轻量 LLM 抽取）。
- 新增轻量 `update_plan` 工具（类似 Claude Code TodoWrite）让 agent 维护 `plan/next/decisions`。
- **每轮把 goal_state 渲染进 system 段之后** —— 即使历史被压缩，目标永远在场。

### 3.3 上下文压缩级联（核心）

把 `Context`（纯容器）升级为 `ContextManager`，在**每次 LLM 调用前**跑级联检查。

**关键约束：不能破坏 `tool_call ↔ tool_result` 配对**（否则 provider 报错）→ 优先 masking（保留消息结构、只替换内容），摘要按「完整轮」边界折叠。

```
估算 tokens（用上一轮 usage.inputTokens 校准 + 字符/4 兜底）
  < 75% 预算 → 原样
  ≥ 75%     → L1: 对较老的 tool_result 做 observation masking
                  content → "[tool output elided · N chars · <tool>]"，保留 toolCallId 配对
  仍 ≥ 90%  → L2: 滑动窗口——最近 K 轮逐字保留
                  L3: 更早区间送一次 LLM，按锚点四字段生成一条 summary 系统消息替换整段
```

- **保守预算**：`min(模型窗口 × 0.5, LLM_CONTEXT_BUDGET)`。
- **压缩结果持久化**：`masked`/`summarized` 写回 `messages` 表，下个 run 的 `loadThreadMessages` 直接拿压缩视图，不重复压。原始内容不删（`events` 表仍可回放）。
- **利用已有 `usage`**：executor 接住 `usage.inputTokens` 精确驱动阈值，先用「字符/4」估算兜底。

---

## 4. 存储设计

`threads / steps / events` 不变。`runs` 与 `messages` 各加几列：

```sql
ALTER TABLE runs ADD COLUMN goal_state JSONB;          -- 当前目标锚点
-- runs.status 增加 'canceling' 取值

ALTER TABLE messages ADD COLUMN collapsed TEXT;        -- NULL | 'masked' | 'summarized'
ALTER TABLE messages ADD COLUMN tokens_est INT;        -- token 估算缓存
ALTER TABLE messages ADD COLUMN summary_of INT[];      -- 若本行是摘要，记录折叠了哪些 message id
```

`loadThreadMessages` 返回**压缩后视图**：masked 行 content 已是占位符；summarized 区间只返回 summary 行（原始行 `collapsed='summarized'` 被跳过）。

---

## 5. 走查：一段会触发压缩的长任务

任务：「把 server/src 下所有 `console.log` 换成 `logger.info`，然后跑测试确认通过」。
演示用预算 `LLM_CONTEXT_BUDGET=16000`，阈值 12000 / 14400。

**Step 0** — 启动，`goal_state` 初始化（intent=用户输入，plan 待填）；messages = `[system, system(goal), user]`，≈400 tok。

**Step 1–2** — grep 出 23 处命中（~3KB 结果）；调 `update_plan` 写 plan/decisions。≈2800 tok，<75% 原样。

**Step 3–10** — 逐文件 read→edit→ok。到 Step 11，≈12600（>75%）→ **L1 masking**：最老的已完成 tool_result content 替换为 `[tool output elided · 3,021 chars · grep]`，保留 toolCallId。回落到 ≈8200，masked 写回库。

**Step 15** — 又涨到 ≈14600（>90%）→ **L2+L3**：最近 4 轮逐字保留；step1–10 区间送 LLM 生成一条 summary（锚点四字段，强制保留 decisions），替换整段。回到 ≈4500。被折叠原始行标 `collapsed='summarized'`。

**Step 16–18** — 完成剩余文件 → `npm test` → 47 passed → 无 toolCalls → final，run done。

整个 run 走 18 步，**远超旧 maxSteps=25 也不再是问题**：终止由 final 自然触发，token 由级联控制在预算内，`hardStepCap` 没碰到。

---

## 6. 关键不变式

| 不变式 | 原因 |
|---|---|
| `tool_call ↔ tool_result` 配对永不破坏 | masking 改内容不删消息；摘要按完整轮边界折叠 |
| goal_state 每轮重注入、永不被压缩 | 目标漂移防护 |
| `decisions` 追加式、摘要时强制保留 | 关键决策丢失会回退返工 |
| 压缩结果持久化 + 原始保留在 events | LLM 视图省 token；前端回放/审计不丢信息 |
| 用上一轮 `usage.inputTokens` 校准估算 | provider 已返回，免引 tokenizer |

---

## 7. 涉及改动点

| 模块 | 改动 |
|---|---|
| [config.ts](../server/src/config.ts) | 加 `contextBudget`、`hardStepCap`、压缩阈值；`maxSteps` 降级为兜底 |
| [context.ts](../server/src/agent/context.ts) | `Context` → `ContextManager`：token 估算 + `maybeCompact()` + masking/摘要 |
| [executor.ts](../server/src/agent/executor.ts) | 循环改终止条件；每步前 `maybeCompact()`；接住 `usage`；取消检查；注入 goal_state |
| [store/types.ts](../server/src/store/types.ts) + pgStore | runs 加 `goal_state`；messages 加折叠标记；取消状态；`loadThreadMessages` 返回压缩视图 |
| tools/registry | 新增 `update_plan` 工具 |
| 新建 `agent/compaction.ts` | 锚定摘要 prompt + masking 逻辑 + token 估算 |
| db/schema.sql | 上述 ALTER |

---

## 8. 实施阶段（每阶段独立验证）

1. **✅ 阶段 1 — 安全网（已实现）**：取消能力 + 接住 `usage` + `hardStepCap` 替代 maxSteps 主控。解锁长任务最低安全网，改动小。
2. **✅ 阶段 2 — 压缩级联 L1/L2（已实现）**：token 估算 + observation masking + 滑动窗口。无需额外 LLM，直接解决撞窗口硬伤。
3. **✅ 阶段 2.5 — 压缩落库（已实现）**：masking 决策持久化到 `messages.collapsed`，`loadThreadMessages` 返回压缩视图，**中途重启零数据丢失、不重算**。
4. **⬜ 阶段 3 — Goal 锚点**：`runs.goal_state` + 每轮注入 + `update_plan` 工具。
5. **⬜ 阶段 4 — 压缩 L3**：锚定 LLM 摘要（`summary_of` 折叠区间）。

### 落地说明

**压缩落库的核心原则**：`messages` 表是**全保真 append-only 日志**（`content` 永远是原始内容，压缩从不覆盖）；压缩是一个**从全量日志派生的视图**，靠 `collapsed` 标记驱动：

- **masking（L1）**：决策持久化为 `collapsed='masked'`。原始 `content` 保留在库，占位符由长度在 `loadThreadMessages` 时派生（`maskPlaceholder(len)`）。重启后视图一致、不丢、不重算。
- **滑动窗口 drop（L2）**：**仅内存安全阀**，不落库——因为 drop 会丢信息。重启后从全量日志按相同逻辑重新派生，DB 数据从不销毁。
- **summarized（阶段 4）**：折叠行标 `collapsed='summarized'`，`loadThreadMessages` 跳过、只留摘要行。列已预留。

已落地文件：

- [config.ts](../server/src/config.ts) — `agent.hardStepCap / contextBudget / compactWarnRatio / compactHardRatio / keepRecentMessages`
- [agent/compaction.ts](../server/src/agent/compaction.ts) — `estimateTokens / maskOldToolResults / slidingWindow / maskPlaceholder`（纯函数，有单测）
- [agent/context.ts](../server/src/agent/context.ts) — `Context` → `ContextManager`：`items` 跟踪 `dbId`；`maybeCompact()` 返回 `collapsedIds`；`recordUsage()` 校准
- [agent/executor.ts](../server/src/agent/executor.ts) — 循环改 `hardStepCap`；每步顶部检查取消；每步前 `maybeCompact()` 并 `markMessagesCollapsed(collapsedIds)`；捕获 `addMessage` 返回的 id 回填 `setLastDbId`；`recordUsage(result.usage)`
- [store/types.ts](../server/src/store/types.ts) + [pgStore.ts](../server/src/store/pgStore.ts) / [memoryStore.ts](../server/src/store/memoryStore.ts) — `ThreadMessage`(带 `id/collapsed`)；`addMessage` 返回 id；`markMessagesCollapsed`；`loadThreadMessages` 返回压缩视图
- [db/schema.sql](../server/src/db/schema.sql) — `messages.collapsed`（`ADD COLUMN IF NOT EXISTS`，幂等迁移）
- [api/http.ts](../server/src/api/http.ts) — `POST /runs/:id/cancel`
- [agent/types.ts](../server/src/agent/types.ts) / [llm/types.ts](../server/src/llm/types.ts) — `RunStatus` 加 `canceling/canceled`；`AgentEvent` 加 `compaction`；`LlmMessage` 加 `collapsed`

> 注：当前 run 仍是进程内 fire-and-forget，服务重启不会自动续跑被中断的 run（数据不丢，但需手动重新触发）。自动续跑是独立 feature，未包含。
