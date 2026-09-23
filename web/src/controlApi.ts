import type {
  Datasource,
  DatasourceDetailResponse,
  DatasourceInput,
  DatasourceTestResult,
  LlmProviderChatTestResult,
  LlmProviderPingResult,
  LlmProviderProbeResult,
  LlmProviderSettings,
  LlmSettings,
  LlmSettingsOptions,
  McpServerProbeResult,
  McpServerSettings,
  McpSettings,
  McpSettingsOptions,
  PermissionProfile,
  PermissionProfileInput,
  RuntimeCapabilitiesSettings,
  ToolSettings,
  ToolSettingsOptions,
} from './api';
import { sysAdminAuthFetch } from './sysAdminApi';

export interface SettingsControlApi {
  getToolSettings(): Promise<ToolSettings>;
  getToolSettingsOptions(): Promise<ToolSettingsOptions>;
  updateToolSettings(settings: ToolSettings): Promise<ToolSettings>;
  getMcpSettings(): Promise<McpSettings>;
  getMcpSettingsOptions(): Promise<McpSettingsOptions>;
  updateMcpSettings(settings: McpSettings): Promise<McpSettings>;
  probeMcpServer(server: McpServerSettings): Promise<McpServerProbeResult>;
  getLlmSettings(): Promise<LlmSettings>;
  getLlmSettingsOptions(): Promise<LlmSettingsOptions>;
  updateLlmSettings(settings: LlmSettings): Promise<LlmSettings>;
  probeLlmProviderModels(provider: LlmProviderSettings): Promise<LlmProviderProbeResult>;
  pingLlmProvider(provider: LlmProviderSettings): Promise<LlmProviderPingResult>;
  testLlmProviderChat(provider: LlmProviderSettings, model: string, input: string): Promise<LlmProviderChatTestResult>;
  getRuntimeCapabilitiesSettings(): Promise<RuntimeCapabilitiesSettings>;
  updateRuntimeCapabilitiesSettings(settings: RuntimeCapabilitiesSettings): Promise<RuntimeCapabilitiesSettings>;
}

export interface DatasourceControlApi {
  listDatasources(): Promise<{ datasources: Datasource[] }>;
  getDatasourceDetail(id: string): Promise<DatasourceDetailResponse>;
  createDatasource(input: DatasourceInput): Promise<{ datasource: Datasource }>;
  updateDatasource(id: string, input: DatasourceInput): Promise<{ datasource: Datasource }>;
  testDatasourceDraft(input: DatasourceInput): Promise<DatasourceTestResult>;
  testDatasource(id: string, input?: Partial<DatasourceInput>): Promise<DatasourceTestResult>;
  createPermissionProfile(datasourceId: string, input: PermissionProfileInput): Promise<{ profile: PermissionProfile }>;
  createReadonlyProfile(datasourceId: string): Promise<{ profile: PermissionProfile }>;
  updatePermissionProfile(datasourceId: string, profileId: string, input: PermissionProfileInput): Promise<{ profile: PermissionProfile }>;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      detail = '';
    }
    throw new Error(detail ? `${res.status} ${detail}` : `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

function systemJson<T>(path: string, init?: RequestInit): Promise<T> {
  return sysAdminAuthFetch(path, init).then(json<T>);
}

function jsonBody(method: 'POST' | 'PUT' | 'PATCH', body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

export function createSystemSettingsControlApi(): SettingsControlApi {
  const base = '/api/system/settings';
  return {
    getToolSettings: () => systemJson(`${base}/tools`),
    getToolSettingsOptions: () => systemJson(`${base}/tools/options`),
    updateToolSettings: (settings) => systemJson(`${base}/tools`, jsonBody('PUT', settings)),
    getMcpSettings: () => systemJson(`${base}/mcp`),
    getMcpSettingsOptions: () => systemJson(`${base}/mcp/options`),
    updateMcpSettings: (settings) => systemJson(`${base}/mcp`, jsonBody('PUT', settings)),
    probeMcpServer: (server) => systemJson(`${base}/mcp/server/probe`, jsonBody('POST', { server })),
    getLlmSettings: () => systemJson(`${base}/llm`),
    getLlmSettingsOptions: () => systemJson(`${base}/llm/options`),
    updateLlmSettings: (settings) => systemJson(`${base}/llm`, jsonBody('PUT', settings)),
    probeLlmProviderModels: (provider) => systemJson(`${base}/llm/provider/models`, jsonBody('POST', { provider })),
    pingLlmProvider: (provider) => systemJson(`${base}/llm/provider/ping`, jsonBody('POST', { provider })),
    testLlmProviderChat: (provider, model, input) => systemJson(`${base}/llm/provider/chat-test`, jsonBody('POST', { provider, model, input })),
    getRuntimeCapabilitiesSettings: () => systemJson(`${base}/runtime-capabilities`),
    updateRuntimeCapabilitiesSettings: (settings) => systemJson(`${base}/runtime-capabilities`, jsonBody('PUT', settings)),
  };
}

export function createSystemDatasourceControlApi(): DatasourceControlApi {
  const base = '/api/system/datasources';
  return {
    listDatasources: () => systemJson(base),
    getDatasourceDetail: (id) => systemJson(`${base}/${encodeURIComponent(id)}`),
    createDatasource: (input) => systemJson(base, jsonBody('POST', input)),
    updateDatasource: (id, input) => systemJson(`${base}/${encodeURIComponent(id)}`, jsonBody('PATCH', input)),
    testDatasourceDraft: (input) => systemJson(`${base}/test`, jsonBody('POST', input)),
    testDatasource: (id, input = {}) => systemJson(`${base}/${encodeURIComponent(id)}/test`, jsonBody('POST', input)),
    createPermissionProfile: (datasourceId, input) => systemJson(`${base}/${encodeURIComponent(datasourceId)}/profiles`, jsonBody('POST', input)),
    createReadonlyProfile: (datasourceId) => systemJson(`${base}/${encodeURIComponent(datasourceId)}/profiles/readonly-default`, { method: 'POST' }),
    updatePermissionProfile: (datasourceId, profileId, input) => systemJson(
      `${base}/${encodeURIComponent(datasourceId)}/profiles/${encodeURIComponent(profileId)}`,
      jsonBody('PATCH', input),
    ),
  };
}
