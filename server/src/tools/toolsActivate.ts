import type { Tool } from './types.js';

export const toolsActivateTool: Tool = {
  name: 'tools_activate',
  description: '按需加载当前空间已授权的 RunForge 工具，名称只能取自系统提示中的按需工具目录。Skill 的业务能力、HTTP 接口和 SDK 操作应按 Skill 说明调用，不通过本工具激活。只在现有工具不足时请求，下一次模型请求生效。',
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
