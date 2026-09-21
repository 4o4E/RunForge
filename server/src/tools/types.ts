import type { LlmContentPart, LlmTool } from '../llm/types.js';
import type { ToolSettings } from '../settings.js';
import type { Scope } from '../store/types.js';

/** 工具返回给 LLM 的标准文本结果。复杂展示应写入 Markdown/HTML artifact，而不是返回 UI JSON。 */
export interface ToolResult {
  text: string;
  /** 工具结果附带的模型输入内容；仅由请求前转换为 provider 多模态内容。 */
  contentParts?: LlmContentPart[];
}

export interface ToolRunContext {
  settings: ToolSettings;
  scope: Scope;
  env?: Record<string, string>;
  /** 当前 run 由业务插件声明的命令；按空间插件顺序提供名称和绝对路径。 */
  pluginExecutables?: Array<{ name: string; path: string }>;
  threadId?: string;
  runId?: string;
  stepId?: string;
  step?: number;
  abortSignal?: AbortSignal;
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
