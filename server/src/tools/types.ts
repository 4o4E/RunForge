import type { LlmTool } from '../llm/types.js';

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters object */
  parameters: Record<string, unknown>;
  /** Execute the tool with parsed args; return a string result for the LLM */
  run(args: Record<string, unknown>): Promise<string>;
}

export function toLlmTool(tool: Tool): LlmTool {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}
