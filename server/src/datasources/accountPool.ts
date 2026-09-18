import type { PoolClient } from 'pg';
import { pool, query } from '../db/pool.js';
import { prisma } from '../db/prisma.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  newDatasourceAccountId,
  newDatasourceId,
  newDatasourceLeaseId,
  newDatasourceProfileId,
  newWorkloadTokenId,
} from '../id.js';
import { store } from '../store/index.js';
import type { Scope, TenantScope } from '../store/types.js';
import { getTenantResourceAuthorization } from '../settings.js';
import { getSystemResourceTenantId } from '../systemResourceTenant.js';
import { disablePostgresAccount, ensurePostgresAccount, ensurePostgresReadonlyTemplateRole } from './postgresAdapter.js';
import { generateWorkloadToken, hashWorkloadToken, iso, randomPassword, secondsFromNow } from './token.js';
import type { RuntimeCapabilityName } from '@runforge/contracts';
import type {
  CredentialLease,
  DatasourceAccountRow,
  DatasourceLeaseRow,
  DatasourceRow,
  DatasourceType,
  PermissionMode,
  PermissionProfileRow,
  PublicCredentialResponse,
  ValidatedWorkloadToken,
  WorkloadTokenRow,
} from './types.js';

// waiting_for_user 虽然不是 run 终态，但等待期间不应继续持有 token 或数据库租约；回答后
// executor 会先把 run 恢复为活动状态，再签发新的 token。
const WORKLOAD_INACTIVE_RUN_STATUSES = new Set(['done', 'error', 'canceling', 'canceled', 'waiting_for_user']);
export const DATASOURCE_CREDENTIAL_CAPABILITY: RuntimeCapabilityName = 'datasource.credentials';
export const RUNTIME_CAPABILITY_NAMES: RuntimeCapabilityName[] = ['datasource.credentials', 'llm', 'image', 'video'];
const DEFAULT_TOKEN_TTL_SECONDS = 30 * 60;
const DEFAULT_LEASE_TTL_SECONDS = 30 * 60;
const DEFAULT_MIN_POOL_SIZE = 0;
const DEFAULT_MAX_POOL_SIZE = 20;

export class DatasourceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.floor(value);
}

function boolValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function poolNumber(profile: PermissionProfileRow, datasource: DatasourceRow, key: string, fallback: number): number {
  const profileValue = profile.pool_config[key];
  if (typeof profileValue === 'number') return numberValue(profileValue, fallback);
  return numberValue(datasource.pool_config[key], fallback);
}

function datasourceType(value: unknown): DatasourceType {
  if (value === 'postgres' || value === 'mysql' || value === 'mongodb' || value === 'hive') return value;
  throw new DatasourceError(400, '数据源 type 必须是 postgres / mysql / mongodb / hive');
}

function permissionMode(value: unknown): PermissionMode {
  if (value === 'readonly' || value === 'limited_write' || value === 'custom') return value;
  return 'readonly';
}

function tokenAllowedDatasource(token: WorkloadTokenRow, datasourceId: string): boolean {
  return token.allowed_datasources.includes('*') || token.allowed_datasources.includes(datasourceId);
}

function capabilityList(value: unknown, fallback: RuntimeCapabilityName[]): RuntimeCapabilityName[] {
  if (!Array.isArray(value)) return fallback;
  const allowed = new Set(RUNTIME_CAPABILITY_NAMES);
  return [...new Set(value.map((item) => String(item).trim()).filter((item): item is RuntimeCapabilityName => allowed.has(item as RuntimeCapabilityName)))];
}

export function tokenAllowsCapability(token: WorkloadTokenRow, capability: RuntimeCapabilityName): boolean {
  return token.allowed_capabilities.includes(capability);
}

function toWorkloadTokenRow(row: {
  id: string;
  token_hash: string;
  run_id: string;
  allowed_datasources: string[];
  allowed_capabilities: string[];
  expires_at: Date;
  revoked_at: Date | null;
  created_at: Date;
}): WorkloadTokenRow {
  return {
    id: row.id,
    token_hash: row.token_hash,
    run_id: row.run_id,
    allowed_datasources: row.allowed_datasources,
    allowed_capabilities: row.allowed_capabilities as RuntimeCapabilityName[],
    expires_at: row.expires_at.toISOString(),
    revoked_at: row.revoked_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
  };
}

function usernameSlug(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return slug || 'run';
}

export function buildPoolUsername(profileName: string, accountId: string): string {
  const suffix = accountId.replace(/[^0-9a-zA-Z]/g, '').toLowerCase().slice(-12);
  return `ag_${usernameSlug(profileName).slice(0, 18)}_${suffix}`.slice(0, 63);
}

async function withTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function createDatasource(scope: TenantScope, input: unknown): Promise<DatasourceRow> {
  const body = jsonObject(input);
  const id = newDatasourceId();
  const name = stringValue(body.name);
  if (!name) throw new DatasourceError(400, 'name 为必填');
  const type = datasourceType(body.type);
  const enabled = boolValue(body.enabled, true);
  const { rows } = await query<DatasourceRow>(
    `INSERT INTO datasources (id, tenant_id, name, type, enabled, connection, admin_config, pool_config)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb)
     RETURNING *`,
    [
      id,
      scope.tenantId,
      name,
      type,
      enabled,
      JSON.stringify(jsonObject(body.connection)),
      JSON.stringify(jsonObject(body.adminConfig)),
      JSON.stringify(jsonObject(body.poolConfig)),
    ],
  );
  return rows[0];
}

export async function listDatasources(scope: TenantScope): Promise<DatasourceRow[]> {
  const { rows } = await query<DatasourceRow>(`SELECT * FROM datasources WHERE tenant_id = $1 ORDER BY created_at DESC`, [scope.tenantId]);
  return rows;
}

export async function listAuthorizedDatasources(scope: TenantScope): Promise<DatasourceRow[]> {
  const [systemTenantId, authorization] = await Promise.all([
    getSystemResourceTenantId(),
    getTenantResourceAuthorization(scope.tenantId),
  ]);
  const datasources = await listDatasources({ tenantId: systemTenantId });
  const allowed = new Set(authorization.datasourceIds);
  return datasources.filter((datasource) => allowed.has(datasource.id));
}

export async function getDatasource(scope: TenantScope, id: string): Promise<DatasourceRow | null> {
  const { rows } = await query<DatasourceRow>(`SELECT * FROM datasources WHERE id = $1 AND tenant_id = $2`, [id, scope.tenantId]);
  return rows[0] ?? null;
}

export async function updateDatasource(scope: TenantScope, id: string, input: unknown): Promise<DatasourceRow> {
  const current = await getDatasource(scope, id);
  if (!current) throw new DatasourceError(404, '数据源不存在');
  const body = jsonObject(input);
  const name = stringValue(body.name, current.name);
  const status = body.status === 'disabled' ? 'disabled' : body.status === 'active' ? 'active' : current.status;
  const enabled = boolValue(body.enabled, current.enabled);
  const { rows } = await query<DatasourceRow>(
    `UPDATE datasources
     SET name = $3,
         status = $4,
         enabled = $5,
         connection = $6::jsonb,
         admin_config = $7::jsonb,
         pool_config = $8::jsonb,
         updated_at = now()
     WHERE id = $1 AND tenant_id = $2
     RETURNING *`,
    [
      id,
      scope.tenantId,
      name,
      status,
      enabled,
      JSON.stringify('connection' in body ? jsonObject(body.connection) : current.connection),
      JSON.stringify('adminConfig' in body ? jsonObject(body.adminConfig) : current.admin_config),
      JSON.stringify('poolConfig' in body ? jsonObject(body.poolConfig) : current.pool_config),
    ],
  );
  return rows[0];
}

export async function createPermissionProfile(scope: TenantScope, datasourceId: string, input: unknown): Promise<PermissionProfileRow> {
  const datasource = await getDatasource(scope, datasourceId);
  if (!datasource) throw new DatasourceError(404, '数据源不存在');
  const body = jsonObject(input);
  const name = stringValue(body.name);
  if (!name) throw new DatasourceError(400, 'name 为必填');
  const id = newDatasourceProfileId();
  const { rows } = await query<PermissionProfileRow>(
    `INSERT INTO datasource_permission_profiles
       (id, datasource_id, name, mode, template_role, grants, pool_config)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb)
     RETURNING *`,
    [
      id,
      datasourceId,
      name,
      permissionMode(body.mode),
      stringValue(body.templateRole) || null,
      JSON.stringify(jsonObject(body.grants)),
      JSON.stringify(jsonObject(body.poolConfig)),
    ],
  );
  return rows[0];
}

export async function listPermissionProfiles(scope: TenantScope, datasourceId: string): Promise<PermissionProfileRow[]> {
  const datasource = await getDatasource(scope, datasourceId);
  if (!datasource) throw new DatasourceError(404, '数据源不存在');
  const { rows } = await query<PermissionProfileRow>(
    `SELECT * FROM datasource_permission_profiles WHERE datasource_id = $1 ORDER BY created_at`,
    [datasourceId],
  );
  return rows;
}

export async function listAuthorizedPermissionProfiles(
  scope: TenantScope,
  datasourceId: string,
): Promise<PermissionProfileRow[]> {
  const authorization = await getTenantResourceAuthorization(scope.tenantId);
  if (!authorization.datasourceIds.includes(datasourceId)) return [];
  return listPermissionProfiles({ tenantId: await getSystemResourceTenantId() }, datasourceId);
}

export async function updatePermissionProfile(
  scope: TenantScope,
  datasourceId: string,
  profileId: string,
  input: unknown,
): Promise<PermissionProfileRow> {
  const datasourceExists = await getDatasource(scope, datasourceId);
  if (!datasourceExists) throw new DatasourceError(404, '数据源不存在');
  const body = jsonObject(input);
  const { rows: currentRows } = await query<PermissionProfileRow>(
    `SELECT * FROM datasource_permission_profiles WHERE id = $1 AND datasource_id = $2`,
    [profileId, datasourceId],
  );
  const current = currentRows[0];
  if (!current) throw new DatasourceError(404, '权限档位不存在');

  const { rows } = await query<PermissionProfileRow>(
    `UPDATE datasource_permission_profiles
     SET name = $3,
         mode = $4,
         template_role = $5,
         grants = $6::jsonb,
         pool_config = $7::jsonb,
         updated_at = now()
     WHERE id = $1 AND datasource_id = $2
     RETURNING *`,
    [
      profileId,
      datasourceId,
      stringValue(body.name, current.name),
      permissionMode(body.mode ?? current.mode),
      'templateRole' in body ? stringValue(body.templateRole) || null : current.template_role,
      JSON.stringify('grants' in body ? jsonObject(body.grants) : current.grants),
      JSON.stringify('poolConfig' in body ? jsonObject(body.poolConfig) : current.pool_config),
    ],
  );
  return rows[0];
}

export async function ensureReadonlyPermissionProfile(scope: TenantScope, datasourceId: string): Promise<PermissionProfileRow> {
  const datasource = await getDatasource(scope, datasourceId);
  if (!datasource) throw new DatasourceError(404, '数据源不存在');
  if (datasource.status !== 'active') throw new DatasourceError(409, '数据源已禁用');
  if (datasource.type !== 'postgres') throw new DatasourceError(501, `暂未实现 ${datasource.type} 的只读档位初始化`);

  const templateRole = await ensurePostgresReadonlyTemplateRole(datasource);
  const { rows: existingRows } = await query<PermissionProfileRow>(
    `SELECT * FROM datasource_permission_profiles WHERE datasource_id = $1 AND name = 'readonly'`,
    [datasourceId],
  );
  const existing = existingRows[0];
  if (existing) {
    const { rows } = await query<PermissionProfileRow>(
      `UPDATE datasource_permission_profiles
       SET mode = 'readonly',
           template_role = $3,
           updated_at = now()
       WHERE id = $1 AND datasource_id = $2
       RETURNING *`,
      [existing.id, datasourceId, templateRole],
    );
    return rows[0];
  }

  return createPermissionProfile(scope, datasourceId, {
    name: 'readonly',
    mode: 'readonly',
    templateRole,
    grants: {},
    poolConfig: {},
  });
}

export async function listDatasourceAccounts(scope: TenantScope, datasourceId: string): Promise<DatasourceAccountRow[]> {
  const datasource = await getDatasource(scope, datasourceId);
  if (!datasource) throw new DatasourceError(404, '数据源不存在');
  const { rows } = await query<DatasourceAccountRow>(
    `SELECT *
     FROM datasource_accounts
     WHERE datasource_id = $1
     ORDER BY profile_id, created_at`,
    [datasourceId],
  );
  return rows;
}

export async function listDatasourceLeases(scope: TenantScope, datasourceId: string, limit = 50): Promise<DatasourceLeaseRow[]> {
  const datasource = await getDatasource(scope, datasourceId);
  if (!datasource) throw new DatasourceError(404, '数据源不存在');
  const { rows } = await query<DatasourceLeaseRow>(
    `SELECT *
     FROM datasource_account_leases
     WHERE datasource_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [datasourceId, limit],
  );
  return rows;
}

interface WorkloadTokenGrant {
  runId: string;
  allowedDatasourceIds: string[];
  allowedCapabilities: RuntimeCapabilityName[];
  ttlSeconds?: number;
}

export async function createWorkloadToken(scope: Scope, grant: WorkloadTokenGrant): Promise<{ token: string; row: WorkloadTokenRow }> {
  const runId = grant.runId.trim();
  if (!runId) throw new DatasourceError(400, 'runId 为必填');
  const run = await store.getRun(scope, runId);
  if (!run) throw new DatasourceError(404, 'run 不存在');
  if (WORKLOAD_INACTIVE_RUN_STATUSES.has(run.status)) throw new DatasourceError(409, `run 当前状态为 ${run.status}，不能签发 token`);
  const allowed = [...new Set(grant.allowedDatasourceIds.map((item) => item.trim()).filter(Boolean))];
  const allowedCapabilities = capabilityList(grant.allowedCapabilities, []);
  const ttlSeconds = numberValue(grant.ttlSeconds, DEFAULT_TOKEN_TTL_SECONDS);
  const expiresAt = secondsFromNow(ttlSeconds);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = generateWorkloadToken();
    try {
      const created = await prisma.$transaction(async (tx) => {
        // 一个 run 同时只保留一个活动 token；恢复执行会轮换 token，而不是按 Skill
        // 继续签发。Serializable 隔离让并发签发竞争时至少一方重试整个轮换过程。
        await tx.workload_tokens.updateMany({
          where: { run_id: runId, revoked_at: null },
          data: { revoked_at: new Date() },
        });
        return tx.workload_tokens.create({
          data: {
            id: newWorkloadTokenId(),
            token_hash: hashWorkloadToken(token),
            run_id: runId,
            allowed_datasources: allowed,
            allowed_capabilities: allowedCapabilities,
            expires_at: expiresAt,
          },
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      return { token, row: toWorkloadTokenRow(created) };
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as { code?: string }).code : undefined;
      if (attempt === 2 || (code !== 'P2034' && code !== 'P2002')) throw error;
    }
  }
  throw new Error('run workload token 并发签发重试耗尽');
}

export async function requireWorkloadCapability(rawToken: string, capability: RuntimeCapabilityName): Promise<ValidatedWorkloadToken> {
  const validated = await validateWorkloadToken(rawToken);
  if (!tokenAllowsCapability(validated.token, capability)) throw new DatasourceError(403, `WORKLOAD_TOKEN 无权使用运行时能力：${capability}`);
  return validated;
}

export async function validateWorkloadToken(rawToken: string): Promise<ValidatedWorkloadToken> {
  const tokenHash = hashWorkloadToken(rawToken);
  const stored = await prisma.workload_tokens.findUnique({
    where: { token_hash: tokenHash },
    include: { runs: { select: { status: true } } },
  });
  const row = stored ? toWorkloadTokenRow(stored) : null;
  if (!row) throw new DatasourceError(401, 'workload token 无效');
  if (row.revoked_at) throw new DatasourceError(401, 'workload token 已撤销');
  if (new Date(row.expires_at).getTime() <= Date.now()) throw new DatasourceError(401, 'workload token 已过期');
  if (WORKLOAD_INACTIVE_RUN_STATUSES.has(stored!.runs.status)) throw new DatasourceError(401, `run 当前状态为 ${stored!.runs.status}，workload token 失效`);
  return { token: row, runStatus: stored!.runs.status };
}

async function loadDatasourceAndProfile(datasourceId: string, profileName: string): Promise<{
  datasource: DatasourceRow;
  profile: PermissionProfileRow;
}> {
  const { rows } = await query<DatasourceRow & {
    profile_id: string;
    profile_name: string;
    profile_mode: PermissionMode;
    profile_template_role: string | null;
    profile_grants: Record<string, unknown>;
    profile_pool_config: Record<string, unknown>;
    profile_created_at: string;
    profile_updated_at: string;
  }>(
    `SELECT ds.*,
            p.id AS profile_id,
            p.name AS profile_name,
            p.mode AS profile_mode,
            p.template_role AS profile_template_role,
            p.grants AS profile_grants,
            p.pool_config AS profile_pool_config,
            p.created_at AS profile_created_at,
            p.updated_at AS profile_updated_at
     FROM datasources ds
     JOIN datasource_permission_profiles p ON p.datasource_id = ds.id
     WHERE ds.id = $1 AND p.name = $2`,
    [datasourceId, profileName],
  );
  const row = rows[0];
  if (!row) throw new DatasourceError(404, '数据源或权限档位不存在');
  if (!row.enabled) throw new DatasourceError(409, '数据源未启用，LLM 运行期不可访问');
  if (row.status !== 'active') throw new DatasourceError(409, '数据源已禁用');
  return {
    datasource: {
      id: row.id,
      tenant_id: row.tenant_id,
      name: row.name,
      type: row.type,
      status: row.status,
      enabled: row.enabled,
      connection: row.connection,
      admin_config: row.admin_config,
      pool_config: row.pool_config,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    profile: {
      id: row.profile_id,
      datasource_id: row.id,
      name: row.profile_name,
      mode: row.profile_mode,
      template_role: row.profile_template_role,
      grants: row.profile_grants,
      pool_config: row.profile_pool_config,
      created_at: row.profile_created_at,
      updated_at: row.profile_updated_at,
    },
  };
}

async function reserveAccount(
  datasource: DatasourceRow,
  profile: PermissionProfileRow,
  runId: string,
  tokenId: string,
  expiresAt: Date,
): Promise<{ account: DatasourceAccountRow; lease: DatasourceLeaseRow }> {
  return withTx(async (client) => {
    const idle = await client.query<DatasourceAccountRow>(
      `SELECT *
       FROM datasource_accounts
       WHERE datasource_id = $1 AND profile_id = $2 AND status = 'idle'
       ORDER BY last_lease_at NULLS FIRST, created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [datasource.id, profile.id],
    );

    let account = idle.rows[0];
    if (!account) {
      const countResult = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count
         FROM datasource_accounts
         WHERE datasource_id = $1 AND profile_id = $2 AND status <> 'disabled'`,
        [datasource.id, profile.id],
      );
      const currentSize = Number(countResult.rows[0]?.count ?? 0);
      const maxSize = poolNumber(profile, datasource, 'maxPoolSize', DEFAULT_MAX_POOL_SIZE);
      if (currentSize >= maxSize) throw new DatasourceError(429, `账号池已满，maxPoolSize=${maxSize}`);

      const accountId = newDatasourceAccountId();
      const username = buildPoolUsername(profile.name, accountId);
      const inserted = await client.query<DatasourceAccountRow>(
        `INSERT INTO datasource_accounts
           (id, datasource_id, profile_id, username, status, current_run_id, leased_until, last_lease_at)
         VALUES ($1, $2, $3, $4, 'leased', $5, $6, now())
         RETURNING *`,
        [accountId, datasource.id, profile.id, username, runId, expiresAt],
      );
      account = inserted.rows[0];
    } else {
      const updated = await client.query<DatasourceAccountRow>(
        `UPDATE datasource_accounts
         SET status = 'leased', current_run_id = $2, leased_until = $3, last_lease_at = now(), updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [account.id, runId, expiresAt],
      );
      account = updated.rows[0];
    }

    const leaseId = newDatasourceLeaseId();
    const leaseResult = await client.query<DatasourceLeaseRow>(
      `INSERT INTO datasource_account_leases
         (id, account_id, datasource_id, profile_id, run_id, token_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [leaseId, account.id, datasource.id, profile.id, runId, tokenId, expiresAt],
    );
    return { account, lease: leaseResult.rows[0] };
  });
}

async function markAccountReady(accountId: string): Promise<DatasourceAccountRow> {
  const { rows } = await query<DatasourceAccountRow>(
    `UPDATE datasource_accounts
     SET last_rotated_at = now(), failure_count = 0, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [accountId],
  );
  return rows[0];
}

async function markLeaseFailed(leaseId: string, accountId: string, message: string): Promise<void> {
  await query(
    `UPDATE datasource_account_leases
     SET status = 'failed', error = $2, updated_at = now()
     WHERE id = $1`,
    [leaseId, message],
  );
  await query(
    `UPDATE datasource_accounts
     SET status = 'disabled', current_run_id = NULL, leased_until = NULL,
         failure_count = failure_count + 1, updated_at = now()
     WHERE id = $1`,
    [accountId],
  );
}

async function ensureRemoteAccount(
  datasource: DatasourceRow,
  profile: PermissionProfileRow,
  account: DatasourceAccountRow,
  password: string,
  expiresAt: Date,
): Promise<void> {
  if (datasource.type === 'postgres') {
    await ensurePostgresAccount(datasource, profile, account, password, expiresAt);
    return;
  }
  throw new DatasourceError(501, `暂未实现 ${datasource.type} 的账号池适配器`);
}

async function disableRemoteAccount(datasource: DatasourceRow, account: DatasourceAccountRow): Promise<void> {
  const password = randomPassword();
  if (datasource.type === 'postgres') {
    await disablePostgresAccount(datasource, account, password);
    return;
  }
  throw new DatasourceError(501, `暂未实现 ${datasource.type} 的账号池适配器`);
}

export async function acquireCredential(rawToken: string, datasourceId: string, profileName = 'readonly'): Promise<CredentialLease> {
  const validated = await requireWorkloadCapability(rawToken, DATASOURCE_CREDENTIAL_CAPABILITY);
  if (!tokenAllowedDatasource(validated.token, datasourceId)) throw new DatasourceError(403, 'workload token 无权访问该数据源');
  const { datasource, profile } = await loadDatasourceAndProfile(datasourceId, profileName);
  if (profile.mode !== 'readonly') {
    throw new DatasourceError(403, 'WORKLOAD_TOKEN 当前只允许申请只读数据库账号');
  }
  // token 的 allowedDatasourceIds 是 run 接纳时保存的授权副本。数据源本身必须来自
  // 系统资源目录，避免任何租户遗留数据源被当作全局资源访问。
  if (datasource.tenant_id !== await getSystemResourceTenantId()) {
    throw new DatasourceError(403, '数据源不属于系统资源目录');
  }
  const leaseTtl = poolNumber(profile, datasource, 'leaseTtlSeconds', DEFAULT_LEASE_TTL_SECONDS);
  const expiresAt = secondsFromNow(leaseTtl);
  const password = randomPassword();
  const reserved = await reserveAccount(datasource, profile, validated.token.run_id, validated.token.id, expiresAt);

  try {
    await ensureRemoteAccount(datasource, profile, reserved.account, password, expiresAt);
    const account = await markAccountReady(reserved.account.id);
    return { datasource, profile, account, lease: reserved.lease, password, expiresAt: iso(expiresAt) };
  } catch (err) {
    await markLeaseFailed(reserved.lease.id, reserved.account.id, (err as Error).message);
    throw err;
  }
}

export function toPublicCredential(lease: CredentialLease): PublicCredentialResponse {
  const connection = { ...lease.datasource.connection };
  return {
    leaseId: lease.lease.id,
    type: lease.datasource.type,
    host: typeof connection.host === 'string' ? connection.host : undefined,
    port: typeof connection.port === 'number' ? connection.port : undefined,
    database: typeof connection.database === 'string' ? connection.database : undefined,
    username: lease.account.username,
    password: lease.password,
    expiresAt: lease.expiresAt,
    connection,
  };
}

async function loadLease(id: string): Promise<{
  lease: DatasourceLeaseRow;
  account: DatasourceAccountRow;
  datasource: DatasourceRow;
}> {
  const { rows } = await query<DatasourceLeaseRow & {
    account_username: string;
    account_status: string;
    datasource_tenant_id: string;
    datasource_name: string;
    datasource_type: DatasourceType;
    datasource_status: string;
    datasource_connection: Record<string, unknown>;
    datasource_admin_config: Record<string, unknown>;
    datasource_pool_config: Record<string, unknown>;
    datasource_enabled: boolean;
  }>(
    `SELECT l.*,
            a.username AS account_username,
            a.status AS account_status,
            ds.tenant_id AS datasource_tenant_id,
            ds.name AS datasource_name,
            ds.type AS datasource_type,
            ds.status AS datasource_status,
            ds.enabled AS datasource_enabled,
            ds.connection AS datasource_connection,
            ds.admin_config AS datasource_admin_config,
            ds.pool_config AS datasource_pool_config
     FROM datasource_account_leases l
     JOIN datasource_accounts a ON a.id = l.account_id
     JOIN datasources ds ON ds.id = l.datasource_id
     WHERE l.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new DatasourceError(404, '租约不存在');
  return {
    lease: row,
    account: {
      id: row.account_id,
      datasource_id: row.datasource_id,
      profile_id: row.profile_id,
      username: row.account_username,
      status: row.account_status as DatasourceAccountRow['status'],
      current_run_id: row.run_id,
      leased_until: row.expires_at,
      last_lease_at: row.leased_at,
      last_rotated_at: null,
      failure_count: 0,
      metadata: {},
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    datasource: {
      id: row.datasource_id,
      tenant_id: row.datasource_tenant_id,
      name: row.datasource_name,
      type: row.datasource_type,
      status: row.datasource_status as DatasourceRow['status'],
      enabled: row.datasource_enabled,
      connection: row.datasource_connection,
      admin_config: row.datasource_admin_config,
      pool_config: row.datasource_pool_config,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  };
}

export async function releaseLease(leaseId: string, expectedRunId?: string): Promise<void> {
  const { lease, account, datasource } = await loadLease(leaseId);
  if (lease.status !== 'leased') return;
  if (expectedRunId && lease.run_id !== expectedRunId) throw new DatasourceError(403, '不能释放其他 run 的租约');

  await query(`UPDATE datasource_accounts SET status = 'cooling_down', updated_at = now() WHERE id = $1`, [account.id]);
  try {
    await disableRemoteAccount(datasource, account);
    await query(
      `UPDATE datasource_account_leases
       SET status = 'released', released_at = now(), updated_at = now()
       WHERE id = $1`,
      [lease.id],
    );
    await query(
      `UPDATE datasource_accounts
       SET status = 'idle', current_run_id = NULL, leased_until = NULL, updated_at = now()
       WHERE id = $1`,
      [account.id],
    );
  } catch (err) {
    await query(
      `UPDATE datasource_account_leases
       SET status = 'failed', error = $2, updated_at = now()
       WHERE id = $1`,
      [lease.id, (err as Error).message],
    );
    await query(`UPDATE datasource_accounts SET status = 'disabled', updated_at = now() WHERE id = $1`, [account.id]);
    throw err;
  }
}

export async function releaseRunLeases(runId: string): Promise<number> {
  await prisma.workload_tokens.updateMany({
    where: { run_id: runId, revoked_at: null },
    data: { revoked_at: new Date() },
  });
  const { rows } = await query<{ id: string }>(
    `SELECT id FROM datasource_account_leases WHERE run_id = $1 AND status = 'leased' ORDER BY leased_at`,
    [runId],
  );
  let released = 0;
  for (const row of rows) {
    await releaseLease(row.id, runId);
    released += 1;
  }
  return released;
}

export async function reconcileExpiredLeases(limit = 20): Promise<number> {
  const { rows } = await query<{ id: string; run_id: string }>(
    `SELECT l.id, l.run_id
     FROM datasource_account_leases l
     LEFT JOIN runs r ON r.id = l.run_id
     WHERE l.status = 'leased'
       AND (l.expires_at <= now() OR r.status IN ('done', 'error', 'canceling', 'canceled', 'waiting_for_user'))
     ORDER BY l.expires_at
     LIMIT $1`,
    [limit],
  );
  let released = 0;
  for (const row of rows) {
    try {
      await releaseLease(row.id, row.run_id);
      released += 1;
    } catch {
      // 单个数据源清理失败不能阻塞其他租约，失败原因已写入 lease。
    }
  }
  return released;
}

export function poolDefaults() {
  return {
    minPoolSize: DEFAULT_MIN_POOL_SIZE,
    maxPoolSize: DEFAULT_MAX_POOL_SIZE,
    leaseTtlSeconds: DEFAULT_LEASE_TTL_SECONDS,
  };
}
