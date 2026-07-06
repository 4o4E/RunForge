import type { GoalPatch, GoalState, PlanItem } from '@runforge/contracts';
export type { GoalPatch, GoalState, PlanItem } from '@runforge/contracts';

// 目标锚点（长任务设计 §3.2、§9/G1）：用一段短小、结构化且始终存在的文本描述
// 当前 run 要完成什么。每一步都会重新渲染为 system message，使其在上下文压缩后仍保留，
// 避免长任务多步骤执行时目标漂移。

export function initGoal(intent: string): GoalState {
  return { intent, phase: 'working', plan: [], decisions: [], next: '' };
}

const PLAN_STATUSES = ['todo', 'doing', 'done', 'failed'] as const;
const GOAL_PHASES = ['working', 'reporting', 'completed'] as const;
const AUTO_COMPLETE_REPORT_RE = /(汇报|报告|总结|最终|final|report|summary)/i;

function planKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function isUnfinished(item: PlanItem): boolean {
  return item.status === 'todo' || item.status === 'doing';
}

function shouldInferAutoComplete(item: PlanItem, index: number, plan: PlanItem[]): boolean {
  return index === plan.length - 1 && isUnfinished(item) && AUTO_COMPLETE_REPORT_RE.test(item.text);
}

function normalizeAutoComplete(plan: PlanItem[]): PlanItem[] {
  return plan.map((item, index) => {
    const autoComplete = item.autoComplete === true || shouldInferAutoComplete(item, index, plan);
    if (autoComplete) return { ...item, autoComplete: true };
    const { autoComplete: _removed, ...rest } = item;
    return rest;
  });
}

function autoCompletePlanItems(goal: GoalState): PlanItem[] {
  return goal.plan.map((item) => item.autoComplete && isUnfinished(item) ? { ...item, status: 'done' } : item);
}

function reconcilePlan(current: PlanItem[], incoming: PlanItem[]): PlanItem[] {
  const incomingKeys = new Set(incoming.map((item) => planKey(item.text)));
  const preservedMissing = current
    .filter((item) => !incomingKeys.has(planKey(item.text)))
    .map((item) => ({
      ...item,
      status: item.status === 'done' || item.status === 'failed' ? item.status : 'failed',
    }));
  return normalizeAutoComplete([...incoming, ...preservedMissing]);
}

/** 合并补丁：plan/next 替换，decisions 追加，确保关键决策不丢失。 */
export function mergeGoal(goal: GoalState, patch: GoalPatch): GoalState {
  return {
    intent: goal.intent,
    phase: patch.phase ?? goal.phase ?? 'working',
    plan: patch.plan ? reconcilePlan(goal.plan, patch.plan) : goal.plan,
    decisions: patch.decisions?.length ? [...goal.decisions, ...patch.decisions] : goal.decisions,
    next: patch.next ?? goal.next,
  };
}

/** Run 已确认完成时收敛目标锚点，避免后续上下文继续注入过期的 doing/next。 */
export function finishGoal(goal: GoalState): GoalState {
  const plan = autoCompletePlanItems(goal);
  const hasFailed = plan.some((p) => p.status === 'failed');
  const hasUnfinished = plan.some(isUnfinished);
  return {
    intent: goal.intent,
    phase: 'completed',
    plan,
    decisions: goal.decisions,
    next: hasFailed ? '已结束（存在失败项）' : hasUnfinished ? '已结束（存在未完成项）' : '已完成',
  };
}

const BOX: Record<PlanItem['status'], string> = { done: 'x', doing: '~', todo: ' ', failed: '!' };

export function unfinishedPlanItems(goal: GoalState): PlanItem[] {
  return goal.plan.filter(isUnfinished);
}

function isReportablePhase(phase: GoalState['phase'] | undefined): boolean {
  return phase === 'reporting' || phase === 'completed';
}

export function canReportGoal(goal: GoalState): boolean {
  const unfinished = unfinishedPlanItems(goal);
  if (unfinished.some((item) => !item.autoComplete)) return false;
  if (unfinished.length > 0 && !isReportablePhase(goal.phase)) return false;
  return goal.plan.length === 0 || isReportablePhase(goal.phase);
}

export function reportBlockedMessage(goal: GoalState): string {
  const unfinished = unfinishedPlanItems(goal);
  const blocking = unfinished.filter((item) => !item.autoComplete);
  if (goal.plan.length > 0 && !blocking.length && !isReportablePhase(goal.phase)) {
    return '最终汇报已被暂缓：当前 goal 仍处于 working，请先调用 update_plan 把 phase 设置为 reporting 或 completed，再输出最终汇报。';
  }
  if (!blocking.length) return '';
  return [
    '最终汇报已被暂缓：当前计划仍有未收口条目。',
    ...blocking.map((item) => `- [${BOX[item.status]}] ${item.text}`),
    '请先继续执行，或调用 update_plan 把真实失败的条目标记为 failed、把已完成的条目标记为 done；只有最终汇报/总结步骤可以设置 autoComplete=true 并在完整回答输出后自动完成。',
  ].join('\n');
}

/** 把目标渲染成紧凑的 system message，固定放在上下文顶部。 */
export function renderGoal(goal: GoalState): string {
  const lines = ['## 当前目标：每一步都要保持聚焦', `意图：${goal.intent}`, `阶段：${goal.phase ?? 'working'}`];
  if (goal.plan.length) {
    lines.push('计划：');
    for (const p of goal.plan) lines.push(`- [${BOX[p.status] ?? ' '}] ${p.text}${p.autoComplete ? '（最终回答后自动完成）' : ''}`);
  }
  if (goal.decisions.length) lines.push(`已记录决策：${goal.decisions.join('; ')}`);
  if (goal.next) lines.push(`下一步：${goal.next}`);
  return lines.join('\n');
}

/** 把 update_plan 原始参数尽力规整为有效的 GoalPatch。 */
export function parseGoalPatch(args: Record<string, unknown>): GoalPatch {
  const patch: GoalPatch = {};
  if (GOAL_PHASES.includes(args.phase as never)) patch.phase = args.phase as GoalState['phase'];
  if (Array.isArray(args.plan)) {
    const parsedPlan = args.plan
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
      .map((p) => {
        const item: PlanItem = {
          text: String((p as { text?: unknown }).text ?? ''),
          status: PLAN_STATUSES.includes((p as { status?: unknown }).status as never)
            ? ((p as { status: PlanItem['status'] }).status)
            : 'todo',
        };
        if ((p as { autoComplete?: unknown }).autoComplete === true) item.autoComplete = true;
        return item;
      })
      .filter((p) => p.text);
    patch.plan = normalizeAutoComplete(parsedPlan);
  }
  if (Array.isArray(args.decisions)) {
    patch.decisions = args.decisions.map((d) => String(d)).filter(Boolean);
  } else if (typeof args.decisions === 'string' && args.decisions.trim()) {
    patch.decisions = [args.decisions.trim()];
  }
  if (typeof args.next === 'string') patch.next = args.next;
  return patch;
}
