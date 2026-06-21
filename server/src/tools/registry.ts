import type { Tool, ToolResult } from './types.js';
import { toLlmTool } from './types.js';
import type { LlmTool } from '../llm/types.js';
import { createPolicy } from './policy.js';
import { getToolSettings, type McpSettings } from '../settings.js';
import { callMcpTool, mcpToolSchemas, parseMcpToolName } from '../mcp/client.js';
import { shellTool } from './shell.js';
import { fileReadTool } from './fileRead.js';
import { fileWriteTool } from './fileWrite.js';
import { fileEditTool } from './fileEdit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { webFetchTool } from './webFetch.js';
import { webSearchTool } from './webSearch.js';
import { askUserTool } from './askUser.js';
import { updatePlanTool } from './updatePlan.js';
import { skillActivateTool } from './skillActivate.js';
import { subagentListTool, subagentPollTool, subagentRunTool } from './subagentRun.js';
import { workflowListTool, workflowReadTool } from './workflow.js';
import { datasourceListTool } from './datasourceList.js';
import { managedShellTools } from './managedShell.js';

const TOOLS: Tool[] = [
  shellTool,
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  globTool,
  grepTool,
  webFetchTool,
  webSearchTool,
  askUserTool,
  updatePlanTool,
  skillActivateTool,
  workflowListTool,
  workflowReadTool,
  subagentRunTool,
  subagentPollTool,
  subagentListTool,
  datasourceListTool,
  ...managedShellTools,
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
const CORE_TOOL_NAMES = new Set([
  'ask_user',
  'update_plan',
  'skill_activate',
  'workflow_list',
  'workflow_read',
  'subagent_run',
  'subagent_poll',
  'subagent_list',
]);

export async function toolSchemas(allowedTools?: string[], mcpSettings?: McpSettings): Promise<LlmTool[]> {
  const builtinTools = !allowedTools ? TOOLS.map(toLlmTool) : (() => {
    const allowed = new Set([...allowedTools, ...CORE_TOOL_NAMES]);
    return TOOLS.filter((tool) => allowed.has(tool.name)).map(toLlmTool);
  })();
  const mcpTools = await mcpToolSchemas(mcpSettings);
  if (!allowedTools) return [...builtinTools, ...mcpTools];
  const allowed = new Set([...allowedTools, ...CORE_TOOL_NAMES]);
  return [...builtinTools, ...mcpTools.filter((tool) => allowed.has(tool.name))];
}

export function getTool(name: string): Tool | undefined {
  return byName.get(name);
}

/**
 * 按名称执行工具，并统一包装成 ToolResult。
 * policy 先拦截，具体工具仍需要拿到 thread/run/step 等生命周期上下文。
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: {
    settings?: Awaited<ReturnType<typeof getToolSettings>>;
    env?: Record<string, string>;
    threadId?: string;
    runId?: string;
    stepId?: string;
    step?: number;
    mcpSettings?: McpSettings;
  } = {},
): Promise<ToolResult> {
  const mcpTool = parseMcpToolName(name);
  const tool = byName.get(name);
  if (!tool && !mcpTool) return { text: `未知工具：${name}` };
  // 所有工具调用先经过沙箱/权限策略。
  const settings = ctx.settings ?? (await getToolSettings());
  const policy = createPolicy(settings);
  const decision = policy.check(name, args);
  if (!decision.ok) return { text: `工具策略已阻止：${decision.reason}` };
  try {
    if (mcpTool) {
      const result = await callMcpTool(name, args, ctx.mcpSettings, {
        workspaceRoot: settings.workspaceRoot,
        runId: ctx.runId,
      });
      return { text: policy.capOutput(result.text) };
    }
    if (!tool) return { text: `未知工具：${name}` };
    const raw = await tool.run(args, { ...ctx, settings });
    const result: ToolResult = typeof raw === 'string' ? { text: raw } : raw;
    return { text: policy.capOutput(result.text) };
  } catch (err) {
    return { text: `工具 ${name} 抛出异常：${(err as Error).message}` };
  }
}
