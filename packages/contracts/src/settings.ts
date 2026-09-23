export type SandboxBackendName = 'auto' | 'none' | 'bwrap';

export interface ToolSettings {
  sandbox: 'off' | 'enforce';
  sandboxBackend: SandboxBackendName;
  workspaceRoot: string;
  shellEnabled: boolean;
  shellUseHostPath: boolean;
  shellPathMode: 'system' | 'custom';
  shellPath: string;
  network: 'enabled' | 'disabled';
  shellDeny: string[];
  maxOutput: number;
}

export interface ToolSettingsOptions {
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

export type LlmProtocol = 'openai-responses' | 'openai-chat' | 'anthropic-messages';
export type LlmInputModality = 'text' | 'image' | 'audio' | 'video' | 'document';
export type LlmModelCapabilitySource = 'catalog' | 'manual';
export type LlmModelCapabilityField = 'contextWindow' | 'inputModalities';

export interface LlmModelCapabilityReference {
  title: string;
  url: string;
  checkedAt: string;
  fields: LlmModelCapabilityField[];
}

export interface LlmModelCapabilitySettings {
  model: string;
  contextWindow: number | null;
  contextWindowSource: LlmModelCapabilitySource;
  compactionThreshold: number | null;
  compactionThresholdSource: LlmModelCapabilitySource;
  maxOutputTokens: number | null;
  inputModalities: LlmInputModality[];
  inputModalitiesSource: LlmModelCapabilitySource;
  references: LlmModelCapabilityReference[];
}

export interface LlmProviderSettings {
  id: string;
  label: string;
  protocol: LlmProtocol;
  baseUrl: string;
  apiKey: string;
  discoveredModels: string[];
  models: string[];
  modelCapabilities: LlmModelCapabilitySettings[];
  defaultModel: string;
  timeoutMs: number;
  retries: number;
}

export interface LlmModelOption {
  ref: string;
  providerId: string;
  providerLabel: string;
  protocol: LlmProtocol;
  model: string;
  label: string;
}

export interface LlmSettings {
  defaultModelRef: string;
  titleModelRef: string;
  providers: LlmProviderSettings[];
}

export interface LlmSettingsOptions {
  defaultModelRef: string;
  titleModelRef: string;
  models: LlmModelOption[];
}

export interface TenantResourceAuthorization {
  llmProviderIds: string[];
  datasourceIds: string[];
}

export interface TenantResourceAuthorizationCatalog {
  llmProviders: Array<{
    id: string;
    label: string;
    models: string[];
  }>;
  datasources: Array<{
    id: string;
    name: string;
    type: string;
    status: string;
    enabled: boolean;
  }>;
}

export interface TenantResourceAuthorizationView {
  authorization: TenantResourceAuthorization;
  catalog: TenantResourceAuthorizationCatalog;
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

export type PageState = Record<string, unknown>;
