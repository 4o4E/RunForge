export type PlanStatus = 'todo' | 'doing' | 'done' | 'failed';

export interface PlanItem {
  text: string;
  status: PlanStatus;
}

export type GoalPhase = 'working' | 'reporting' | 'completed';

export interface GoalState {
  /** 原始目标：run 开始时设置一次，agent 不应修改。 */
  intent: string;
  /** 当前 run 阶段：执行中、汇报中或已完成。 */
  phase: GoalPhase;
  /** 当前工作计划：agent 通过 update_plan 整体替换。 */
  plan: PlanItem[];
  /** 需要长期记住的关键决策：只追加，避免压缩后丢失。 */
  decisions: string[];
  /** 马上要执行的下一步。 */
  next: string;
}

/** agent 通过 update_plan 工具提交的目标补丁。 */
export interface GoalPatch {
  phase?: GoalPhase;
  plan?: PlanItem[];
  decisions?: string[];
  next?: string;
}
