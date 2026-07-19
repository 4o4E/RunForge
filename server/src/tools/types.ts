import type { LlmTool } from '../llm/types.js';
import type { ToolSettings } from '../settings.js';
import type { Scope } from '../store/types.js';

/** 工具返回给 LLM 的标准文本结果。复杂展示应写入 Markdown/HTML artifact，而不是返回 UI JSON。 */
export interface ToolResult {
  text: string;
}

export interface ToolRunContext {
  settings: ToolSettings;
  scope: Scope;
  env?: Record<string, string>;
  threadId?: string;
  runId?: string;
  stepId?: string;
  step?: number;
}

export interface Tool {
  name: string;
  description: string;
  /** 工具参数对象的 JSON Schema。 */
  parameters: Record<string, unknown>;
  /**
   * 使用解析后的参数执行工具。一般返回给 LLM 的纯文本；
   * 需要结构化文本包装时返回 ToolResult。
   */
  run(args: Record<string, unknown>, ctx?: ToolRunContext): Promise<string | ToolResult>;
}

export function toLlmTool(tool: Tool): LlmTool {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}
