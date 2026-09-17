import type { WorkloadResourceType } from '@runforge/contracts';

export interface BusinessSkillDeclaration {
  id: string;
  path: string;
}

export interface BusinessMcpHeaderDeclaration {
  name: string;
  value?: string;
  secretKey?: string;
}

export interface BusinessMcpServerDeclaration {
  id: string;
  label: string;
  description: string;
  transport: 'streamable-http';
  url?: string;
  urlConfigKey?: string;
  bearerSecretKey?: string;
  headers: BusinessMcpHeaderDeclaration[];
  timeoutMs: number;
  maxOutput: number;
}

export interface BusinessSecretDeclaration {
  key: string;
  required: boolean;
  description: string;
}

export interface BusinessResourceDeclaration {
  type: WorkloadResourceType;
}

/**
 * 业务插件只是 Skill、外部 MCP、tenant Secret key 和标准运行资源的声明集合。
 * 它不能携带或引用可装入 RunForge 服务进程的 Cordis/JavaScript 入口。
 */
export interface BusinessPluginManifest {
  schemaVersion: 1;
  id: string;
  version?: string;
  displayName: string;
  description: string;
  skills: BusinessSkillDeclaration[];
  mcpServers: BusinessMcpServerDeclaration[];
  secrets: BusinessSecretDeclaration[];
  resources: BusinessResourceDeclaration[];
  configSchema: Record<string, unknown>;
}

export interface BusinessPluginDefinition {
  root: string;
  manifestPath: string;
  contentHash: string;
  manifest: BusinessPluginManifest;
}
