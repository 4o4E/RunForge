import type { Tool } from './types.js';

export const mcpActivateTool: Tool = {
  name: 'mcp_activate',
  description: '激活一个 MCP Server，把它的远端工具 schema 加入当前 run 后续的模型请求。',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '初始 MCP 列表中的 server id' },
    },
    required: ['id'],
  },
  async run() {
    // 激活需要修改 run 局部上下文，由 executor 统一处理；这里保留 registry 的完整定义。
    return 'mcp_activate 必须在当前 run 的执行器上下文中调用。';
  },
};
