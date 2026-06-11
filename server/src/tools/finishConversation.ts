import type { Tool } from './types.js';

/** 结束对话的唯一出口。executor 会读取同一份参数决定 run 是否真正完成。 */
export const finishConversationTool: Tool = {
  name: 'finish_conversation',
  description:
    'Finish or checkpoint the current conversation. English: call this tool with `progress` before ending; only `completed: true` is allowed to finish the run. 中文：结束前必须调用本工具并填写 `progress` 工作进度；只有 `completed: true` 才允许真正结束本次 run。',
  parameters: {
    type: 'object',
    properties: {
      progress: {
        type: 'string',
        description: '工作进度 / Work progress: what has been done, key result, and remaining risk if any.',
      },
      completed: {
        type: 'boolean',
        description: '是否已完成 / Whether the requested work is fully completed.',
      },
    },
    required: ['progress', 'completed'],
  },
  async run(args) {
    const progress = typeof args.progress === 'string' ? args.progress.trim() : '';
    const completed = args.completed === true;
    if (!progress) return 'finish_conversation error: `progress` is required.';
    return completed ? `Conversation finished. Progress: ${progress}` : `Progress recorded, continue working: ${progress}`;
  },
};

