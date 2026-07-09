import type { Tool } from './types.js';

export const subagentRunTool: Tool = {
  name: 'subagent_run',
  description:
    '启动一个异步 subagent 子任务，立即返回 subagentRunId，不等待完成。runtimeProfileId=writer 时可按主 agent 授权使用读写文件和 shell 工具；其他 profile 默认只读推理。可一次启动多个，再用 subagent_poll 或 subagent_list 轮询结果。',
  parameters: {
    type: 'object',
    properties: {
      workflowId: { type: 'string', description: '可选 workflow id，用于证据追踪。' },
      stageId: { type: 'string', description: 'workflow stage id，例如 design、implement、review、test。' },
      stageGoal: { type: 'string', description: '当前阶段目标。' },
      runtimeProfileId: { type: 'string', description: '运行时配置 id。writer=可使用读写文件和 shell 工具；readonly/default=只读推理和只读工具。' },
      modelRef: {
        type: 'string',
        description: '可选 subagent 模型引用，格式为 provider:model，例如 deepseek:deepseek-v4。供应商和模型必须已在设置页配置。',
      },
      skillNames: {
        type: 'array',
        items: { type: 'string' },
        description: '本子任务需要加载的 skill 名称。后端会读取这些 skill 的说明注入 subagent 上下文。',
      },
      task: { type: 'string', description: '本次 task assignment 的具体目标。' },
      context: { type: 'string', description: '必要背景、上游结论或输入材料。' },
      expectedOutput: { type: 'string', description: '期望输出格式或交付物要求。' },
      constraints: { type: 'string', description: '本次限制，例如只读、不要改文件、只列风险。' },
    },
    required: ['task'],
  },
  async run() {
    return 'subagent_run 由 agent executor 内置执行；如果看到这条消息，说明调用路径没有进入 executor。';
  },
};

export const subagentPollTool: Tool = {
  name: 'subagent_poll',
  description: '查询一个 subagent 子任务的当前状态和结果。可设置 waitSeconds 等待完成，超时后返回当前状态，避免连续轮询。',
  parameters: {
    type: 'object',
    properties: {
      subagentRunId: { type: 'string', description: 'subagent_run 返回的 subagentRunId。' },
      waitSeconds: { type: 'number', description: '最多等待多少秒让 subagent 完成；0 或不填表示立即返回。最大 120。' },
      timeoutSeconds: { type: 'number', description: 'waitSeconds 的兼容别名；最多等待多少秒。' },
    },
    required: ['subagentRunId'],
  },
  async run() {
    return 'subagent_poll 由 agent executor 内置执行；如果看到这条消息，说明调用路径没有进入 executor。';
  },
};

export const subagentListTool: Tool = {
  name: 'subagent_list',
  description: '列出当前 thread 下的 subagent 子任务，用于跨 run 恢复、查看正在运行和已完成的 subagent。',
  parameters: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['running', 'done', 'error'], description: '可选状态过滤。' },
      limit: { type: 'number', description: '最多返回多少条，默认 20。' },
    },
  },
  async run() {
    return 'subagent_list 由 agent executor 内置执行；如果看到这条消息，说明调用路径没有进入 executor。';
  },
};
