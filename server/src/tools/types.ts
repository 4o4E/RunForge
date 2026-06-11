import type { LlmTool } from '../llm/types.js';
import type { A2uiDisplay } from '../agent/a2ui.js';
import type { ToolSettings } from '../settings.js';

/** Structured tool result (refactor-plan §4): text for the LLM, plus an optional
 *  declarative display (A2UI) surfaced to the UI. */
export interface ToolResult {
  text: string;
  display?: A2uiDisplay;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the tool's parameters object */
  parameters: Record<string, unknown>;
  /**
   * Execute the tool with parsed args. Return a plain string (text for the LLM)
   * or a `ToolResult` to additionally emit a declarative UI surface.
   */
  run(args: Record<string, unknown>, ctx?: { settings: ToolSettings }): Promise<string | ToolResult>;
}

export function toLlmTool(tool: Tool): LlmTool {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}
