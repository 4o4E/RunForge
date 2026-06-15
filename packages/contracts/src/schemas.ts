import { z } from 'zod';

export const runStatusSchema = z.enum(['pending', 'running', 'waiting_for_user', 'done', 'error', 'canceling', 'canceled']);
export const askUserModeSchema = z.enum(['single', 'multiple', 'text']);
export const planStatusSchema = z.enum(['todo', 'doing', 'done', 'failed']);
export const goalPhaseSchema = z.enum(['working', 'reporting', 'completed']);

export const askUserOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  recommended: z.boolean().optional(),
  required: z.boolean().optional(),
});

export const askUserSpecSchema = z.object({
  question: z.string(),
  mode: askUserModeSchema,
  options: z.array(askUserOptionSchema),
  allowCustom: z.boolean(),
  required: z.boolean(),
});

export const askUserAnswerSchema = z.object({
  mode: askUserModeSchema,
  selected: z.array(askUserOptionSchema),
  customOptions: z.array(z.string()),
  text: z.string(),
  note: z.string(),
  usedRecommended: z.boolean(),
});

export const goalStateSchema = z.object({
  intent: z.string(),
  phase: goalPhaseSchema,
  plan: z.array(z.object({ text: z.string(), status: planStatusSchema })),
  decisions: z.array(z.string()),
  next: z.string(),
});

export const toolSettingsSchema = z.object({
  sandbox: z.enum(['off', 'enforce']),
  sandboxBackend: z.enum(['auto', 'none', 'bwrap']),
  workspaceRoot: z.string(),
  allow: z.array(z.string()),
  deny: z.array(z.string()),
  shellEnabled: z.boolean(),
  shellUseHostPath: z.boolean(),
  shellAllowCommands: z.array(z.string()),
  network: z.enum(['enabled', 'disabled']),
  shellDeny: z.array(z.string()),
  maxOutput: z.number(),
});

const recordSchema = z.record(z.string(), z.unknown());

export const datasourceInputSchema = z.object({
  name: z.string(),
  type: z.enum(['postgres', 'mysql', 'mongodb', 'hive']),
  status: z.enum(['active', 'disabled']).optional(),
  connection: recordSchema,
  adminConfig: recordSchema.optional(),
  poolConfig: recordSchema.optional(),
});

export const permissionProfileInputSchema = z.object({
  name: z.string(),
  mode: z.enum(['readonly', 'limited_write', 'custom']),
  templateRole: z.string().optional(),
  grants: recordSchema.optional(),
  poolConfig: recordSchema.optional(),
});
