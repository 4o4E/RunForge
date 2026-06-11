import type { Tool, ToolResult } from './types.js';
import { toLlmTool } from './types.js';
import type { LlmTool } from '../llm/types.js';
import { policy } from './policy.js';
import { shellTool } from './shell.js';
import { fileReadTool } from './fileRead.js';
import { fileWriteTool } from './fileWrite.js';
import { fileEditTool } from './fileEdit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { webFetchTool } from './webFetch.js';
import { webSearchTool } from './webSearch.js';
import { askUserTool } from './askUser.js';
import { renderUiTool } from './renderUi.js';
import { updatePlanTool } from './updatePlan.js';
import { finishConversationTool } from './finishConversation.js';

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
  renderUiTool,
  updatePlanTool,
  finishConversationTool,
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function toolSchemas(): LlmTool[] {
  return TOOLS.map(toLlmTool);
}

export function getTool(name: string): Tool | undefined {
  return byName.get(name);
}

/** Run a tool by name, returning a normalized `ToolResult` ({ text, display? }).
 *  Plain-string tool returns are wrapped; the policy gate runs first and the
 *  output cap is applied to `text`. */
export async function runTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = byName.get(name);
  if (!tool) return { text: `Unknown tool: ${name}` };
  // Every tool call passes through the sandbox/permission policy first.
  const decision = policy.check(name, args);
  if (!decision.ok) return { text: `Blocked by tool policy: ${decision.reason}` };
  try {
    const raw = await tool.run(args);
    const result: ToolResult = typeof raw === 'string' ? { text: raw } : raw;
    return { text: policy.capOutput(result.text), display: result.display };
  } catch (err) {
    return { text: `Tool ${name} threw: ${(err as Error).message}` };
  }
}
