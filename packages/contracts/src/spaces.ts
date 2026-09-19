import { z } from 'zod';
import type { LlmModelOption, RuntimeCapabilityName } from './settings.js';

export type SpaceMode = 'web' | 'external';

const idListSchema = z.array(z.string().trim().min(1)).default([]);
const runtimeCapabilityNames = ['datasource.credentials', 'llm', 'image', 'video'] as const satisfies readonly RuntimeCapabilityName[];

export interface PromptPlaceholder {
  key: string;
  token: string;
  label: string;
  description: string;
  content: string;
  runtime: boolean;
}

export interface PromptPlaceholdersView {
  placeholders: PromptPlaceholder[];
}

/**
 * 空间保存创建或编辑时选择的完整能力列表。run 接纳后会把配置解析成不含密钥的完整快照。
 */
export const spaceConfigSchema = z.object({
  schemaVersion: z.literal(3).default(3),
  promptTemplate: z.string().default(''),
  model: z.object({
    defaultModelRef: z.string().trim().min(1).nullable().default(null),
    allowedModelRefs: idListSchema,
    contextBudget: z.number().int().positive().nullable().default(null),
  }).strict().default({ defaultModelRef: null, allowedModelRefs: [], contextBudget: null }),
  capabilities: z.object({
    tools: idListSchema,
    mcpServers: idListSchema,
    // 业务插件承载成组的业务权限，必须由管理员显式选择；部署新增插件不能自动扩权。
    businessPlugins: z.array(z.string().trim().min(1)).default([]),
    runtime: z.array(z.enum(runtimeCapabilityNames)).default([]),
  }).strict().default({ tools: [], mcpServers: [], businessPlugins: [], runtime: [] }),
  external: z.object({
    allowTrustedPrompt: z.boolean().default(false),
    allowNextStep: z.boolean().default(false),
  }).strict().default({ allowTrustedPrompt: false, allowNextStep: false }),
}).strict();

export type SpaceConfig = z.output<typeof spaceConfigSchema>;
/** systemPrompt 仅用于兼容旧客户端输入，服务端会转换成完整 promptTemplate。 */
export type SpaceConfigInput = z.input<typeof spaceConfigSchema> & { systemPrompt?: string };

export interface SpaceSummary {
  id: string;
  tenantId: string;
  mode: SpaceMode;
  name: string;
  executionUserId: string | null;
  config: SpaceConfig;
  configVersion: number;
  createdByUserId: string | null;
  visibleUserIds: string[];
  isDefault: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 空间管理页使用的 tenant 能力目录，不包含供应商密钥或连接配置。 */
export interface SpaceOptions {
  defaultModelRef: string;
  models: LlmModelOption[];
  tools: string[];
  mcpServers: Array<{ id: string; label: string }>;
  businessPlugins: Array<{ id: string; label: string; description: string; contentHash: string }>;
  runtimeCapabilities: RuntimeCapabilityName[];
}

export interface SpaceDebugTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface SpaceDebugSkill {
  id: string;
  name: string;
  description: string;
  content: string;
}

export interface SpaceDebugMcpServer {
  id: string;
  label: string;
  description: string;
}

/** 对话页管理员调试区使用的当前空间配置视图，不包含密钥和运行时激活状态。 */
export interface SpaceDebugView {
  configVersion: number;
  promptTemplate: string;
  tools: SpaceDebugTool[];
  skills: SpaceDebugSkill[];
  mcpServers: SpaceDebugMcpServer[];
}

export interface SpaceDebugMcpSchema {
  tools: SpaceDebugTool[];
}

export interface CreateSpaceInput {
  mode: SpaceMode;
  name: string;
  executionUserId?: string | null;
  config?: SpaceConfigInput;
  visibleUserIds?: string[];
}

export interface UpdateSpaceInput {
  name?: string;
  executionUserId?: string | null;
  config?: SpaceConfigInput;
  visibleUserIds?: string[];
}
