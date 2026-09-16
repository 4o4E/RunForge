import type {
  ExternalCallerSummary,
  ExternalCancelReceipt,
  ExternalRunReceipt,
  ExternalRunView,
  ExternalNextStepReceipt,
  ExternalSource,
  ExternalTokenSummary,
} from '@runforge/contracts';
import type { RunSpaceConfigSnapshot, RuntimeCapabilitiesSnapshot } from '../spaces/config.js';
import type { SpaceWithVisibilityRow } from '../store/types.js';

export class ExternalApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ExternalApiError';
  }
}

export interface ExternalCallerAccess {
  caller: ExternalCallerSummary;
  token: ExternalTokenSummary;
  space: SpaceWithVisibilityRow;
}

export interface ExternalRunSnapshot {
  configVersion: number;
  modelRef: string;
  spaceConfig: RunSpaceConfigSnapshot;
  runtimeCapabilities: RuntimeCapabilitiesSnapshot;
}

export interface ExternalRunWriteInput {
  requestHash: string;
  idempotencyKey: string;
  input: string;
  title?: string;
  source: ExternalSource;
  snapshot: ExternalRunSnapshot;
}

export interface ExternalAppendRunInput extends ExternalRunWriteInput {
  threadId: string;
}

export interface ExternalCancelInput {
  requestHash: string;
  idempotencyKey: string;
  runId: string;
  source: ExternalSource;
}

export interface ExternalWriteResult<T> {
  response: T;
  replayed: boolean;
  executionUserId: string;
}

export interface ExternalCallerWithTokens {
  caller: ExternalCallerSummary;
  tokens: ExternalTokenSummary[];
}

export interface ExternalRepository {
  authenticateToken(tokenHash: string): Promise<ExternalCallerAccess | null>;
  createCaller(input: {
    tenantId: string;
    spaceId: string;
    name: string;
    metadata: Record<string, unknown>;
    tokenHash: string;
    tokenLabel: string | null;
    tokenExpiresAt: string | null;
  }): Promise<ExternalCallerWithTokens>;
  listCallers(tenantId: string, spaceId: string): Promise<ExternalCallerWithTokens[]>;
  updateCaller(input: {
    tenantId: string;
    spaceId: string;
    callerId: string;
    name?: string;
    status?: 'active' | 'disabled';
    metadata?: Record<string, unknown>;
  }): Promise<ExternalCallerSummary | null>;
  issueToken(input: {
    tenantId: string;
    spaceId: string;
    callerId: string;
    tokenHash: string;
    label: string | null;
    expiresAt: string | null;
  }): Promise<ExternalTokenSummary | null>;
  revokeToken(tenantId: string, spaceId: string, callerId: string, tokenId: string): Promise<ExternalTokenSummary | null>;
  createRun(access: ExternalCallerAccess, input: ExternalRunWriteInput): Promise<ExternalWriteResult<ExternalRunReceipt>>;
  appendRun(access: ExternalCallerAccess, input: ExternalAppendRunInput): Promise<ExternalWriteResult<ExternalRunReceipt>>;
  appendNextStep(
    access: ExternalCallerAccess,
    input: Omit<ExternalAppendRunInput, 'snapshot'>,
  ): Promise<ExternalWriteResult<ExternalNextStepReceipt>>;
  getRun(access: ExternalCallerAccess, runId: string): Promise<{ response: ExternalRunView; executionUserId: string } | null>;
  cancelRun(access: ExternalCallerAccess, input: ExternalCancelInput): Promise<ExternalWriteResult<ExternalCancelReceipt> | null>;
}
