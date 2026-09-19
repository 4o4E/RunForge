import { z } from 'zod';
import type { AgentEvent, RunStatus } from './agent.js';

const optionalId = z.string().trim().min(1).max(256).optional();
const idempotencyKey = z.string().trim().min(1).max(256);
const artifactId = z.string().trim().regex(/^ar_[0-9A-Za-z]+$/);
export const MAX_EXTERNAL_ARTIFACTS_PER_INPUT = 20;
const artifactIds = z.array(artifactId)
  .max(MAX_EXTERNAL_ARTIFACTS_PER_INPUT)
  .refine((ids) => new Set(ids).size === ids.length, 'artifactIds 不能重复')
  .optional();

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
    title: z.string().trim().min(1).max(200),
    artifactIds,
    ...runInputFields,
  }).strict(),
  z.object({
    operation: z.literal('run.append'),
    idempotencyKey,
    threadId: z.string().trim().regex(/^th_[0-9A-Za-z]+$/),
    delivery: z.literal('next_step').optional(),
    artifactIds,
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
  z.object({
    operation: z.literal('artifact.upload'),
    idempotencyKey,
    name: z.string().trim().min(1).max(255),
    mimeType: z.string().trim().min(1).max(255).default('application/octet-stream'),
    contentBase64: z.string().min(1).max(36 * 1024 * 1024),
    metadata: z.record(z.string(), z.unknown()).default({}),
    source: externalSourceSchema,
  }).strict(),
  z.object({
    operation: z.literal('artifact.get'),
    artifactId,
  }).strict(),
]);

export type ExternalSource = z.output<typeof externalSourceSchema>;
export type ExternalCommand = z.output<typeof externalCommandSchema>;

export const externalSubscriptionSchema = z.object({
  type: z.literal('subscribe'),
  runId: z.string().trim().regex(/^ru_[0-9A-Za-z]+$/),
  cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
}).strict();

export type ExternalSubscription = z.output<typeof externalSubscriptionSchema>;

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

export interface ExternalNextStepReceipt {
  operation: 'run.append';
  delivery: 'next_step';
  threadId: string;
  runId: string;
  inputId: string;
  version: number;
  status: 'accepted';
}

export interface ExternalArtifactSummary {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  status: 'staged' | 'materialized';
  metadata: Record<string, unknown>;
  threadId: string | null;
  runId: string | null;
  createdAt: string;
  materializedAt: string | null;
}

export interface ExternalArtifactUploadReceipt {
  operation: 'artifact.upload';
  artifact: ExternalArtifactSummary;
}

export interface ExternalArtifactGetResponse {
  operation: 'artifact.get';
  artifact: ExternalArtifactSummary;
  contentBase64: string;
}

export type ExternalWebSocketFrame =
  | { type: 'subscribed'; runId: string; cursor: number }
  | { type: 'event'; runId: string; cursor: number; event: AgentEvent }
  | { type: 'error'; code: string; message: string };
