export interface BusinessPluginSkillView {
  id: string;
  path: string;
  name: string;
  description: string;
  content: string;
}

export interface BusinessPluginMcpHeaderView {
  name: string;
  value: string | null;
  secretKey: string | null;
}

export interface BusinessPluginMcpView {
  id: string;
  label: string;
  description: string;
  transport: 'streamable-http';
  url: string | null;
  urlConfigKey: string | null;
  bearerSecretKey: string | null;
  headers: BusinessPluginMcpHeaderView[];
  timeoutMs: number;
  maxOutput: number;
}

export interface BusinessPluginMcpToolView {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface BusinessPluginMcpToolsView {
  tools: BusinessPluginMcpToolView[];
}

export interface BusinessPluginResourceView {
  type: string;
}

export interface BusinessPluginSecretView {
  key: string;
  description: string;
  required: boolean;
  configured: boolean;
}

export interface BusinessPluginAdminItem {
  id: string;
  displayName: string;
  description: string;
  version: string | null;
  contentHash: string;
  configSchema: Record<string, unknown>;
  config: Record<string, unknown>;
  skills: BusinessPluginSkillView[];
  mcpServers: BusinessPluginMcpView[];
  resources: BusinessPluginResourceView[];
  secrets: BusinessPluginSecretView[];
  ready: boolean;
  error: string | null;
}

export interface BusinessPluginAdminView {
  plugins: BusinessPluginAdminItem[];
}

export interface BusinessPluginImportResponse {
  pluginId: string;
  replaced: boolean;
  view: BusinessPluginAdminView;
}

export interface BusinessPluginUninstallResponse {
  pluginId: string;
  affectedSpaces: Array<{ id: string; name: string }>;
  view: BusinessPluginAdminView;
}

/** secrets 只提交变更：字符串设置当前值，null 删除，未出现的 key 保持不变。 */
export interface UpdateBusinessPluginSettingsInput {
  plugins?: Record<string, { config: Record<string, unknown> }>;
  secrets?: Record<string, string | null>;
}
