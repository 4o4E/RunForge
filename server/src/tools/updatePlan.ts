import type { Tool } from './types.js';

/**
 * 维护当前任务的工作计划。工具本身无状态，只负责确认；
 * executor 会读取同一份参数，更新 run 持久化的目标锚点
 * （intent/plan/decisions/next），并在每一步重新注入上下文，
 * 使其在压缩后仍保留（长任务设计 §3.2、§9/G1）。
 */
export const updatePlanTool: Tool = {
  name: 'update_plan',
  description:
    '记录或刷新当前任务的工作计划：包含 run 阶段、步骤及状态、需要记住的关键决策、马上要做的下一步。多步骤任务开始时调用；计划变化时也要调用。decisions 会追加，plan 和 next 会替换旧值。执行失败的步骤必须保留并标记为 failed，不要删除。本工具只更新计划，不会结束 run；收口时先调用本工具把 phase 设为 reporting 或 completed，随后下一轮输出无工具调用的完整最终回答。',
  parameters: {
    type: 'object',
    properties: {
      phase: {
        type: 'string',
        enum: ['working', 'reporting', 'completed'],
        description: '当前 run 阶段。working=执行中，reporting=计划已收口并准备最终汇报，completed=已完成。',
      },
      plan: {
        type: 'array',
        description: '完整的当前计划，会替换旧计划。',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '这个步骤要完成的事情' },
            status: { type: 'string', enum: ['todo', 'doing', 'done', 'failed'] },
            autoComplete: { type: 'boolean', description: '仅用于最后的最终汇报/总结步骤；为 true 时，完整可见回答输出后运行时可自动把该步骤标记为 done 并结束。' },
          },
          required: ['text', 'status'],
        },
      },
      decisions: {
        type: 'array',
        description: '后续需要记住的关键决策，会追加到已有决策。',
        items: { type: 'string' },
      },
      next: { type: 'string', description: '马上要执行的下一步动作。' },
    },
  },
  async run() {
    return '计划已更新。';
  },
};
