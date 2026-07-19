import type {
  AccountStatus,
  DatasourceColumnInfo,
  DatasourceStatus,
  DatasourceTableInfo,
  DatasourceTestResult,
  DatasourceType,
  LeaseStatus,
  PermissionMode,
  PublicCredentialResponse,
} from '@runforge/contracts';

export type {
  AccountStatus,
  DatasourceColumnInfo,
  DatasourceStatus,
  DatasourceTableInfo,
  DatasourceTestResult,
  DatasourceType,
  LeaseStatus,
  PermissionMode,
  PublicCredentialResponse,
} from '@runforge/contracts';

export interface DatasourceRow {
  id: string;
  tenant_id: string;
  name: string;
  type: DatasourceType;
  status: DatasourceStatus;
  enabled: boolean;
  connection: Record<string, unknown>;
  admin_config: Record<string, unknown>;
  pool_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PermissionProfileRow {
  id: string;
  datasource_id: string;
  name: string;
  mode: PermissionMode;
  template_role: string | null;
  grants: Record<string, unknown>;
  pool_config: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface DatasourceAccountRow {
  id: string;
  datasource_id: string;
  profile_id: string;
  username: string;
  status: AccountStatus;
  current_run_id: string | null;
  leased_until: string | null;
  last_lease_at: string | null;
  last_rotated_at: string | null;
  failure_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface WorkloadTokenRow {
  id: string;
  token_hash: string;
  run_id: string;
  skill_id: string | null;
  allowed_datasources: string[];
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

export interface DatasourceLeaseRow {
  id: string;
  account_id: string;
  datasource_id: string;
  profile_id: string;
  run_id: string;
  token_id: string | null;
  status: LeaseStatus;
  leased_at: string;
  expires_at: string;
  released_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ValidatedWorkloadToken {
  token: WorkloadTokenRow;
  runStatus: string;
}

export interface CredentialLease {
  lease: DatasourceLeaseRow;
  datasource: DatasourceRow;
  profile: PermissionProfileRow;
  account: DatasourceAccountRow;
  password: string;
  expiresAt: string;
}
