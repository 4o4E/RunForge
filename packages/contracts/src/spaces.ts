import { z } from 'zod';
import type { RuntimeCapabilityName } from './settings.js';

export type SpaceMode = 'web' | 'external';

const nullableIdListSchema = z.array(z.string().trim().min(1)).nullable().default(null);
const runtimeCapabilityNames = ['datasource.credentials', 'llm', 'image', 'video'] as const satisfies readonly RuntimeCapabilityName[];

/**
 * 空间保存的是对 tenant 能力目录的选择规则；null 表示在创建 run 时继承当时可用项，
 * 显式空数组表示禁用该类能力。run 接纳后会把规则解析成不含密钥的完整快照。
 */
export const spaceConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  systemPrompt: z.string().default(''),
  model: z.object({
    defaultModelRef: z.string().trim().min(1).nullable().default(null),
    allowedModelRefs: nullableIdListSchema,
    contextBudget: z.number().int().positive().nullable().default(null),
  }).strict().default({ defaultModelRef: null, allowedModelRefs: null, contextBudget: null }),
  capabilities: z.object({
    tools: nullableIdListSchema,
    mcpServers: nullableIdListSchema,
    runtime: z.array(z.enum(runtimeCapabilityNames)).nullable().default(null),
  }).strict().default({ tools: null, mcpServers: null, runtime: null }),
  external: z.object({
    allowTrustedPrompt: z.boolean().default(false),
    allowNextStep: z.boolean().default(false),
  }).strict().default({ allowTrustedPrompt: false, allowNextStep: false }),
}).strict();

export type SpaceConfig = z.output<typeof spaceConfigSchema>;
export type SpaceConfigInput = z.input<typeof spaceConfigSchema>;

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
