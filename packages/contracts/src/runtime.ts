import type { DatasourceType } from './datasources.js';
import type { RuntimeCapabilityCredential, RuntimeCapabilityName } from './settings.js';

export interface PublicCredentialResponse {
  leaseId: string;
  type: DatasourceType;
  host?: string;
  port?: number;
  database?: string;
  username: string;
  password: string;
  expiresAt: string;
  connection: Record<string, unknown>;
}

export interface RuntimeCapabilityCredentialRequest {
  capability: RuntimeCapabilityName;
}

export interface RuntimeCapabilityCredentialResponse extends RuntimeCapabilityCredential {}

export interface WorkloadSecretResponse {
  key: string;
  value: string;
}

export type WorkloadResourceType = 'database.readonly' | 'llm.proxy';
