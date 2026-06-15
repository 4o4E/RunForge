export type DatasourceType = 'postgres' | 'mysql' | 'mongodb' | 'hive';
export type DatasourceStatus = 'active' | 'disabled';
export type PermissionMode = 'readonly' | 'limited_write' | 'custom';
export type AccountStatus = 'idle' | 'leased' | 'cooling_down' | 'disabled';
export type LeaseStatus = 'leased' | 'released' | 'expired' | 'failed';

export interface Datasource {
  id: string;
  name: string;
  type: DatasourceType;
  status: DatasourceStatus;
  connection: Record<string, unknown>;
  pool_config: Record<string, unknown>;
  hasAdminConfig: boolean;
  created_at: string;
  updated_at: string;
}

export interface PermissionProfile {
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

export interface DatasourceAccount {
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
  created_at: string;
  updated_at: string;
}

export interface DatasourceLease {
  id: string;
  account_id: string;
  datasource_id: string;
  profile_id: string;
  run_id: string;
  status: LeaseStatus;
  leased_at: string;
  expires_at: string;
  released_at: string | null;
  error: string | null;
}

export interface DatasourceInput {
  name: string;
  type: DatasourceType;
  status?: DatasourceStatus;
  connection: Record<string, unknown>;
  adminConfig?: Record<string, unknown>;
  poolConfig?: Record<string, unknown>;
}

export interface PermissionProfileInput {
  name: string;
  mode: PermissionMode;
  templateRole?: string;
  grants?: Record<string, unknown>;
  poolConfig?: Record<string, unknown>;
}

export interface DatasourceColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  position: number;
}

export interface DatasourceTableInfo {
  schema: string;
  name: string;
  type: string;
  columns: DatasourceColumnInfo[];
}

export interface DatasourceTestResult {
  ok: true;
  type: DatasourceType;
  database?: string;
  tableCount: number;
  tables: DatasourceTableInfo[];
}

export interface DatasourceDetailResponse {
  datasource: Datasource;
  profiles: PermissionProfile[];
  accounts: DatasourceAccount[];
  leases: DatasourceLease[];
}
