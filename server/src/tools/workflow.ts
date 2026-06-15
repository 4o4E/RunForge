import { loadWorkflowIndex, readWorkflow } from '../workflows/registry.js';
import type { Tool } from './types.js';

function requireWorkspaceRoot(ctx?: Parameters<Tool['run']>[1]): string {
  const root = ctx?.settings?.workspaceRoot;
  if (!root) throw new Error('缺少 workspaceRoot，无法读取 workflow');
  return root;
}

export const workflowListTool: Tool = {
  name: 'workflow_list',
  description: '列出当前 workspace 可用 workflow，包括用户 .workflows 和内置 .agents/workflows。用于选择任务阶段和 subagent 分工。',
  parameters: {
    type: 'object',
    properties: {},
  },
  async run(_args, ctx) {
    const workflows = await loadWorkflowIndex(requireWorkspaceRoot(ctx));
    if (!workflows.length) return '当前 workspace 没有可用 workflow。';
    return workflows
      .map((workflow) => [
        `name: ${workflow.name}`,
        `id: ${workflow.id}`,
        `source: ${workflow.source}`,
        `readonly: ${workflow.readonly}`,
        `root: ${workflow.root}`,
        `description: ${workflow.description}`,
      ].join('\n'))
      .join('\n\n---\n\n');
  },
};

export const workflowReadTool: Tool = {
  name: 'workflow_read',
  description: '读取一个 workflow 的 WORKFLOW.md 正文。可传 name 或 source:name。用户 workflow 优先于同名内置 workflow。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'workflow 名称，或 source:name 形式的唯一 id。' },
    },
    required: ['name'],
  },
  async run(args, ctx) {
    const name = typeof args.name === 'string' ? args.name.trim() : '';
    if (!name) return 'workflow_read 缺少必填 name。';
    const { workflow, body } = await readWorkflow(requireWorkspaceRoot(ctx), name);
    return [
      '已读取 Workflow / Loaded Workflow:',
      `- name: ${workflow.name}`,
      `- id: ${workflow.id}`,
      `- source: ${workflow.source}`,
      `- root: ${workflow.root}`,
      '',
      '正文 / Instructions:',
      body.trim() || '（空正文）',
    ].join('\n');
  },
};
