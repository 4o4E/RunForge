export type SandboxBackendName = 'auto' | 'none' | 'bwrap';

export interface ToolSettings {
  sandbox: 'off' | 'enforce';
  sandboxBackend: SandboxBackendName;
  workspaceRoot: string;
  toolAccessMode: 'allow' | 'deny';
  allow: string[];
  deny: string[];
  shellEnabled: boolean;
  shellUseHostPath: boolean;
  shellPathMode: 'system' | 'custom';
  shellPath: string;
  shellAllowCommands: string[];
  network: 'enabled' | 'disabled';
  shellDeny: string[];
  maxOutput: number;
}

export interface ToolSettingsOptionItem {
  name: string;
  description: string;
}

export interface ShellCommandOptionItem {
  name: string;
  path: string | null;
  available: boolean;
}

export interface ToolSettingsOptions {
  tools: ToolSettingsOptionItem[];
  shellCommands: ShellCommandOptionItem[];
  systemPath: string;
}

export interface McpHeaderSettings {
  name: string;
  value: string;
}

export interface McpServerSettings {
  id: string;
  label: string;
  enabled: boolean;
  url: string;
  bearerToken: string;
  headers: McpHeaderSettings[];
  allowedTools: string[];
  timeoutMs: number;
  maxOutput: number;
}

export interface McpSettings {
  servers: McpServerSettings[];
}

export interface McpToolOption {
  serverId: string;
  serverLabel: string;
  name: string;
  mappedName: string;
  description: string;
  enabled: boolean;
}

export interface McpSettingsOptions {
  tools: McpToolOption[];
}

export interface McpServerProbeResult {
  ok: boolean;
  message: string;
  toolCount: number;
  tools: McpToolOption[];
}

export type LlmProviderName = 'aisdk' | 'openai-responses' | 'openai-chat' | 'anthropic' | 'mock';
export type LlmAiSdkFlavor = 'openai-compatible' | 'openai' | 'anthropic';

export interface LlmProviderSettings {
  id: string;
  label: string;
  provider: LlmProviderName;
  baseUrl: string;
  apiKey: string;
  discoveredModels: string[];
  models: string[];
  defaultModel: string;
  maxTokens: number;
  timeoutMs: number;
  retries: number;
  stream: boolean;
  aisdkFlavor: LlmAiSdkFlavor;
  reasoningTag: string;
}

export interface LlmModelOption {
  ref: string;
  providerId: string;
  providerLabel: string;
  provider: LlmProviderName;
  model: string;
  label: string;
}

export interface LlmSettings {
  defaultModelRef: string;
  providers: LlmProviderSettings[];
}

export interface LlmSettingsOptions {
  models: LlmModelOption[];
}

export type RuntimeCapabilityName = 'datasource.credentials' | 'llm' | 'image' | 'video';

export interface RuntimeLlmCapabilitySettings {
  enabled: boolean;
}

export interface RuntimeImageCapabilitySettings {
  enabled: boolean;
  provider: 'packy-gpt-image-2';
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface RuntimeVideoCapabilitySettings {
  enabled: boolean;
}

export interface RuntimeCapabilitiesSettings {
  llm: RuntimeLlmCapabilitySettings;
  image: RuntimeImageCapabilitySettings;
  video: RuntimeVideoCapabilitySettings;
}

export interface RuntimeCapabilityCredential {
  capability: RuntimeCapabilityName;
  baseUrl: string;
  headers: Record<string, string>;
  expiresAt: string;
  endpoints: Record<string, string>;
  defaults: Record<string, unknown>;
}

export interface LlmProviderProbeResult {
  models: string[];
  source: string;
}

export interface LlmProviderPingResult {
  ok: boolean;
  latencyMs: number;
  message: string;
  modelCount?: number;
}

export interface LlmProviderChatTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  input: string;
  output: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ShellCommandScanInput {
  shellPathMode: ToolSettings['shellPathMode'];
  shellPath: string;
  include: string[];
}

export interface ShellCommandScanResult {
  shellCommands: ShellCommandOptionItem[];
  path: string;
}

export type PageState = Record<string, unknown>;
