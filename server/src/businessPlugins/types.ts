import type { WorkloadResourceType } from '@runforge/contracts';
import type { PluginDependency } from '../plugins/types.js';

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

export interface BusinessExecutableDeclaration {
  /** shell 中显示的命令名称；不允许包含目录分隔符。 */
  name: string;
  /** 相对于插件根目录的普通文件路径。 */
  path: string;
}

/**
 * 业务插件只是 Skill、外部 MCP、tenant Secret key 和标准运行资源的声明集合。
 * 它不能携带或引用可装入 RunForge 服务进程的 Cordis/JavaScript 入口。
 */
export interface BusinessPluginManifest {
  schemaVersion: 1 | 2;
  id: string;
  version?: string;
  displayName: string;
  description: string;
  skills: BusinessSkillDeclaration[];
  mcpServers: BusinessMcpServerDeclaration[];
  secrets: BusinessSecretDeclaration[];
  resources: BusinessResourceDeclaration[];
  configSchema: Record<string, unknown>;
  /** 依赖使用业务插件 ID；转换为 Cordis 运行时 ID 时自动添加 business. 前缀。 */
  dependencies?: PluginDependency[];
  executables?: BusinessExecutableDeclaration[];
}

export interface BusinessSkillEntrySnapshot {
  id: string;
  path: string;
  name: string;
  description: string;
  content: string;
}

export interface BusinessPluginDefinition {
  root: string;
  manifestPath: string;
  contentHash: string;
  manifest: BusinessPluginManifest;
  skillEntries: BusinessSkillEntrySnapshot[];
}

export interface BusinessPluginExecutable {
  pluginId: string;
  name: string;
  path: string;
}
