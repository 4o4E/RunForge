import { z } from 'zod';
import { askUserSpecSchema, goalStateSchema } from '@runforge/contracts';

/** 各能力只合并自己负责的元数据，恢复入口统一验证这些状态。 */
export const runMetadataSchema = z.object({
  runtime: z.object({
    skillIds: z.array(z.string()),
    mcpServerIds: z.array(z.string()),
    rejectedImageModels: z.array(z.string()),
    lastAppliedExternalInputVersion: z.number().int().nonnegative(),
  }),
  goal: goalStateSchema.nullable().optional(),
  pendingInteraction: askUserSpecSchema.nullable().optional(),
  context: z.object({ collapsed: z.record(z.string(), z.enum(['masked', 'summarized'])) }).optional(),
}).catchall(z.json());
