import type { Tool } from './types.js';
import { toLlmTool } from './types.js';
import type { LlmTool } from '../llm/types.js';
import { shellTool } from './shell.js';
import { fileReadTool } from './fileRead.js';
import { fileWriteTool } from './fileWrite.js';
import { fileEditTool } from './fileEdit.js';
import { globTool } from './glob.js';
import { grepTool } from './grep.js';
import { webFetchTool } from './webFetch.js';
import { webSearchTool } from './webSearch.js';
import { askUserTool } from './askUser.js';

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
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function toolSchemas(): LlmTool[] {
  return TOOLS.map(toLlmTool);
}

export function getTool(name: string): Tool | undefined {
  return byName.get(name);
}

export async function runTool(name: string, args: Record<string, unknown>): Promise<string> {
  const tool = byName.get(name);
  if (!tool) return `Unknown tool: ${name}`;
  try {
    return await tool.run(args);
  } catch (err) {
    return `Tool ${name} threw: ${(err as Error).message}`;
  }
}
