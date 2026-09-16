import { z } from 'zod';
import type { RunStatus } from './agent.js';

const optionalId = z.string().trim().min(1).max(256).optional();
const idempotencyKey = z.string().trim().min(1).max(256);

export const externalSourceSchema = z.object({
  applicationRef: optionalId,
  externalThreadRef: optionalId,
  externalEventId: optionalId,
  triggerRef: optionalId,
  correlationRef: optionalId,
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict().default({ metadata: {} });

const runInputFields = {
  input: z.string().trim().min(1),
  modelRef: z.string().trim().min(1).optional(),
  trustedPrompt: z.string().trim().min(1).optional(),
  source: externalSourceSchema,
};

export const externalCommandSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('run.create'),
    idempotencyKey,
    title: z.string().trim().min(1).max(200).optional(),
    ...runInputFields,
  }).strict(),
  z.object({
    operation: z.literal('run.append'),
    idempotencyKey,
    threadId: z.string().trim().regex(/^th_[0-9A-Za-z]+$/),
    delivery: z.literal('next_step').optional(),
    ...runInputFields,
  }).strict(),
  z.object({
    operation: z.literal('run.get'),
    runId: z.string().trim().regex(/^ru_[0-9A-Za-z]+$/),
  }).strict(),
  z.object({
    operation: z.literal('run.cancel'),
    idempotencyKey,
    runId: z.string().trim().regex(/^ru_[0-9A-Za-z]+$/),
    source: externalSourceSchema,
  }).strict(),
]);

export type ExternalSource = z.output<typeof externalSourceSchema>;
export type ExternalCommand = z.output<typeof externalCommandSchema>;

export interface ExternalCallerSummary {
  id: string;
  tenantId: string;
  spaceId: string;
  name: string;
  status: 'active' | 'disabled';
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalTokenSummary {
  id: string;
  callerId: string;
  label: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreateExternalCallerInput {
  name: string;
  metadata?: Record<string, unknown>;
  tokenLabel?: string | null;
  tokenExpiresAt?: string | null;
}

export interface CreateExternalCallerResponse {
  caller: ExternalCallerSummary;
  token: ExternalTokenSummary & { token: string };
}

export interface ExternalRunReceipt {
  operation: 'run.create' | 'run.append';
  threadId: string;
  runId: string;
  status: RunStatus;
}

export interface ExternalRunView {
  operation: 'run.get';
  threadId: string;
  runId: string;
  status: RunStatus;
  input: string;
  output: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExternalCancelReceipt {
  operation: 'run.cancel';
  threadId: string;
  runId: string;
  status: RunStatus;
}
