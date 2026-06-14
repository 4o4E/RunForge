import type { Tool, ToolResult } from './types.js';
import { toLlmTool } from './types.js';
import type { LlmTool } from '../llm/types.js';
import { createPolicy } from './policy.js';
import { getToolSettings } from '../settings.js';
import { shellTool } from './shell.js';
import { fileReadTool } from './fileRead.js';
import { fileWriteTool } from './fileWrite.js';
import { fileEditTool } from './fileEdit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { webFetchTool } from './webFetch.js';
import { webSearchTool } from './webSearch.js';
import { askUserTool } from './askUser.js';
import { htmlArtifactTool } from './htmlArtifact.js';
import { updatePlanTool } from './updatePlan.js';
import { finishConversationTool } from './finishConversation.js';
import { skillActivateTool } from './skillActivate.js';
import { datasourceListTool } from './datasourceList.js';

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
  htmlArtifactTool,
  updatePlanTool,
  finishConversationTool,
  skillActivateTool,
  datasourceListTool,
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));
const CORE_TOOL_NAMES = new Set(['ask_user', 'update_plan', 'finish_conversation', 'skill_activate']);

export function toolSchemas(allowedTools?: string[]): LlmTool[] {
  if (!allowedTools) return TOOLS.map(toLlmTool);
  const allowed = new Set([...allowedTools, ...CORE_TOOL_NAMES]);
  return TOOLS.filter((tool) => allowed.has(tool.name)).map(toLlmTool);
}

export function getTool(name: string): Tool | undefined {
  return byName.get(name);
}

/** Run a tool by name, returning a normalized `ToolResult` ({ text }).
 *  Plain-string tool returns are wrapped; the policy gate runs first and the
 *  output cap is applied to `text`. */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: { settings?: Awaited<ReturnType<typeof getToolSettings>>; env?: Record<string, string> } = {},
): Promise<ToolResult> {
  const tool = byName.get(name);
  if (!tool) return { text: `未知工具：${name}` };
  // Every tool call passes through the sandbox/permission policy first.
  const settings = ctx.settings ?? (await getToolSettings());
  const policy = createPolicy(settings);
  const decision = policy.check(name, args);
  if (!decision.ok) return { text: `工具策略已阻止：${decision.reason}` };
  try {
    const raw = await tool.run(args, { settings, env: ctx.env });
    const result: ToolResult = typeof raw === 'string' ? { text: raw } : raw;
    return { text: policy.capOutput(result.text) };
  } catch (err) {
    return { text: `工具 ${name} 抛出异常：${(err as Error).message}` };
  }
}
