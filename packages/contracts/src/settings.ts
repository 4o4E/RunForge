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
