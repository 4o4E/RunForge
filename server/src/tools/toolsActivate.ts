import type { Tool } from './types.js';

export const toolsActivateTool: Tool = {
  name: 'tools_activate',
  description: '按需加载当前空间已授权的工具。只在现有工具无法完成任务时请求缺少的工具名；激活结果从下一次模型请求开始生效。',
  parameters: {
    type: 'object',
    properties: {
      names: {
        type: 'array',
        items: { type: 'string' },
        description: '需要加载的工具名称，必须来自系统提示中的按需工具目录。',
      },
    },
    required: ['names'],
  },
  async run() {
    throw new Error('tools_activate 必须在当前 run 的执行器上下文中调用。');
  },
};
