import { loadWorkflowIndex, readWorkflow } from '../workflows/registry.js';
import { loadSkillIndex, selectSkill } from '../skills/registry.js';
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
  description: '读取 RunForge workspace workflow 的 WORKFLOW.md 正文，只适用于 .workflows 和 .agents/workflows。注意：skill 内部 workflows/*.md 不是 RunForge workflow；先激活对应 skill，再按 skill root 用文件工具读取。',
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
    const workspaceRoot = requireWorkspaceRoot(ctx);
    let loaded;
    try {
      loaded = await readWorkflow(workspaceRoot, name);
    } catch (err) {
      const skills = await loadSkillIndex(workspaceRoot);
      const skill = selectSkill(skills, name);
      if (skill) {
        return [
          `未找到 RunForge workflow: ${name}`,
          `但找到了同名 skill: ${skill.name}`,
          `skill root: ${skill.root}`,
          '',
          '说明：RunForge workflow 只来自 workspace 的 .workflows 或 .agents/workflows。',
          '说明：skill 内部的 workflows/*.md 属于该 skill 的普通资源，不会被 workflow_read 读取。',
          '下一步：请先使用 skill_activate 激活该 skill，然后用 file_read 或 shell 读取 skill root 下的 SKILL.md、workflows/index.md 或具体 workflows/*.md。',
        ].join('\n');
      }
      throw err;
    }
    const { workflow, body } = loaded;
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
