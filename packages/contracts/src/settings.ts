export type SandboxBackendName = 'auto' | 'none' | 'bwrap';

export interface ToolSettings {
  sandbox: 'off' | 'enforce';
  sandboxBackend: SandboxBackendName;
  workspaceRoot: string;
  shellEnabled: boolean;
  shellUseHostPath: boolean;
  shellPathMode: 'system' | 'custom';
  shellPath: string;
  shellAllowCommands: string[];
  network: 'enabled' | 'disabled';
  shellDeny: string[];
  maxOutput: number;
}

export interface ShellCommandOptionItem {
  name: string;
  path: string | null;
  available: boolean;
}

export interface ToolSettingsOptions {
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
  description: string;
  enabled: boolean;
  url: string;
  bearerToken: string;
  headers: McpHeaderSettings[];
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
export type LlmInputModality = 'text' | 'image' | 'audio' | 'video';
export type LlmModelCapabilitySource = 'provider' | 'catalog' | 'default' | 'manual';

export interface LlmModelCapabilitySettings {
  model: string;
  contextWindow: number;
  contextWindowSource: LlmModelCapabilitySource;
  inputModalities: LlmInputModality[];
  inputModalitiesSource: LlmModelCapabilitySource;
}

export interface LlmProviderSettings {
  id: string;
  label: string;
  provider: LlmProviderName;
  baseUrl: string;
  apiKey: string;
  discoveredModels: string[];
  discoveredModelCapabilities: LlmModelCapabilitySettings[];
  models: string[];
  modelCapabilities: LlmModelCapabilitySettings[];
  defaultModel: string;
  maxTokens: number | null;
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
  defaultModelRef: string;
  models: LlmModelOption[];
}

export type RuntimeCapabilityName = 'datasource.credentials' | 'llm' | 'image' | 'video';

export interface RuntimeLlmCapabilitySettings {
  enabled: boolean;
  defaultModelId: string;
  models: RuntimeLlmCapabilityModel[];
}

export interface RuntimeLlmCapabilityModel {
  id: string;
  label: string;
  modelRef: string;
}

export interface RuntimeImageCapabilitySettings {
  enabled: boolean;
  defaultModelId: string;
  models: RuntimeImageCapabilityModel[];
}

export interface RuntimeImageCapabilityModel {
  id: string;
  label: string;
  provider: 'packy-gpt-image-2';
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface RuntimeVideoCapabilitySettings {
  enabled: boolean;
  defaultModelId: string;
  models: RuntimeVideoCapabilityModel[];
}

export interface RuntimeVideoCapabilityModel {
  id: string;
  label: string;
  provider: string;
  model: string;
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
  models: Record<string, unknown>[];
}

export interface LlmProviderProbeResult {
  models: string[];
  modelCapabilities: LlmModelCapabilitySettings[];
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
