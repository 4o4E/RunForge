import { lstat, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  StorageUsageBreakdown,
  StorageUsagePoint,
  StorageUsageTotals,
  TokenUsageBreakdown,
  TokenUsagePoint,
  TokenUsageTotals,
  UsageAggregateResponse,
  UsageScopeOption,
} from '@runforge/contracts';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { getSystemToolSettings } from '../settings.js';

export interface UsageFilter {
  tenantId?: string | null;
  userId?: string | null;
  spaceId?: string | null;
  /** 只控制筛选项可见范围；租户接口必须设置，系统接口保持为空。 */
  availableTenantId?: string | null;
  /** 个人接口只返回当前用户选项，不能借筛选项泄露同租户账号。 */
  availableUserId?: string | null;
  /** 普通用户的统计还要遵守空间查看权限，不能把 execution user 当成 viewer。 */
  availableSpaceIds?: string[] | null;
  from: Date;
  to: Date;
}

interface StorageMetric {
  logicalBytes: number;
  allocatedBytes: number;
  fileCount: number;
  symlinkCount: number;
}

interface StorageBucket extends StorageMetric {
  tenantId: string;
  userId: string | null;
  spaceId: string | null;
  category: string;
}

interface TokenRow {
  day: string;
  tenant_id: string;
  tenant_name: string;
  user_id: string | null;
  user_label: string | null;
  space_id: string;
  space_name: string;
  provider: string;
  model: string;
  purpose: string;
  status: string;
  input_tokens: string;
  output_tokens: string;
  cached_input_tokens: string;
  attempts: string;
  attempts_with_usage: string;
}

interface StorageSampleRow {
  period: 'hour' | 'day';
  period_start: Date;
  tenant_id: string;
  tenant_name: string;
  user_id: string | null;
  user_label: string | null;
  space_id: string | null;
  space_name: string | null;
  category: string;
  logical_bytes: string;
  allocated_bytes: string;
  file_count: string;
  symlink_count: string;
}

const EMPTY_STORAGE: StorageMetric = { logicalBytes: 0, allocatedBytes: 0, fileCount: 0, symlinkCount: 0 };
const EMPTY_TOKEN: TokenUsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  attemptedTokens: 0,
  effectiveTokens: 0,
  attempts: 0,
  attemptsWithUsage: 0,
  attemptsWithoutUsage: 0,
};

function addStorage(target: StorageMetric, value: StorageMetric): void {
  target.logicalBytes += value.logicalBytes;
  target.allocatedBytes += value.allocatedBytes;
  target.fileCount += value.fileCount;
  target.symlinkCount += value.symlinkCount;
}

function addToken(target: TokenUsageTotals, value: TokenUsageTotals): void {
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.cachedInputTokens += value.cachedInputTokens;
  target.attemptedTokens += value.attemptedTokens;
  target.effectiveTokens += value.effectiveTokens;
  target.attempts += value.attempts;
  target.attemptsWithUsage += value.attemptsWithUsage;
  target.attemptsWithoutUsage += value.attemptsWithoutUsage;
}

function allocatedBytes(info: Awaited<ReturnType<typeof lstat>>): number {
  const blocks = Number(info.blocks ?? 0);
  return blocks > 0 ? blocks * 512 : Number(info.size);
}

/** 统计一个路径；符号链接只计算链接本身，绝不进入链接指向的共享目录。 */
export async function scanStoragePath(path: string): Promise<StorageMetric> {
  const total = { ...EMPTY_STORAGE };
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return total;
    throw error;
  }
  if (info.isSymbolicLink()) {
    total.logicalBytes = info.size;
    total.allocatedBytes = allocatedBytes(info);
    total.symlinkCount = 1;
    return total;
  }
  if (info.isFile()) {
    total.logicalBytes = info.size;
    total.allocatedBytes = allocatedBytes(info);
    total.fileCount = 1;
    return total;
  }
  if (!info.isDirectory()) return total;

  total.allocatedBytes += allocatedBytes(info);
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return total;
    throw error;
  }
  for (const entry of entries) {
    addStorage(total, await scanStoragePath(join(path, entry.name)));
  }
  return total;
}

function bucketKey(bucket: Pick<StorageBucket, 'tenantId' | 'userId' | 'spaceId' | 'category'>): string {
  return [bucket.tenantId, bucket.userId ?? '', bucket.spaceId ?? '', bucket.category].join('\u0000');
}

function addBucket(map: Map<string, StorageBucket>, bucket: StorageBucket): void {
  const key = bucketKey(bucket);
  const current = map.get(key);
  if (current) addStorage(current, bucket);
  else map.set(key, { ...bucket });
}

async function scanThreadWorkspaces(map: Map<string, StorageBucket>, workspaceRoot: string): Promise<void> {
  const result = await query<{ id: string; tenant_id: string; user_id: string | null; space_id: string }>(
    'SELECT id, tenant_id, user_id, space_id FROM threads ORDER BY space_id, id',
  );
  for (const thread of result.rows) {
    const root = resolve(workspaceRoot, thread.space_id, thread.id);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      const category = entry.name === 'uploads'
          ? 'thread_uploads'
          : entry.name === '.agents'
            ? 'thread_agent_runtime'
            : entry.name === 'plugins'
              ? 'thread_plugins'
              : 'thread_workspace';
      const metric = await scanStoragePath(join(root, entry.name));
      addBucket(map, {
        tenantId: thread.tenant_id,
        userId: thread.user_id,
        spaceId: thread.space_id,
        category,
        ...metric,
      });
    }
  }
}

async function scanExternalArtifacts(map: Map<string, StorageBucket>, workspaceRoot: string): Promise<void> {
  const root = resolve(workspaceRoot, '.runforge', 'external-artifacts');
  const result = await query<{
    storage_key: string;
    tenant_id: string;
    user_id: string | null;
    space_id: string;
  }>(`SELECT a.storage_key, c.tenant_id, th.user_id, a.space_id
      FROM artifacts a
      JOIN external_callers c ON c.id = a.caller_id
      LEFT JOIN threads th ON th.id = a.thread_id
      ORDER BY a.storage_key`);
  for (const artifact of result.rows) {
    const path = resolve(root, artifact.storage_key);
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;
      addBucket(map, {
        tenantId: artifact.tenant_id,
        userId: artifact.user_id,
        spaceId: artifact.space_id,
        category: 'external_artifacts',
        logicalBytes: info.size,
        allocatedBytes: allocatedBytes(info),
        fileCount: 1,
        symlinkCount: 0,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function scanBusinessPlugins(map: Map<string, StorageBucket>): Promise<void> {
  const tenants = (await query<{ id: string }>('SELECT id FROM tenants ORDER BY id')).rows;
  for (const configuredRoot of config.businessPlugins.roots) {
    for (const tenant of tenants) {
      const root = resolve(configuredRoot, tenant.id);
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || (entry.name.startsWith('.') && entry.name !== '.runforge-snapshots')) continue;
        const category = entry.name === '.runforge-snapshots'
          ? 'business_plugin_snapshots'
          : 'business_plugin_current';
        addBucket(map, {
          tenantId: tenant.id,
          userId: null,
          spaceId: null,
          category,
          ...await scanStoragePath(join(root, entry.name)),
        });
      }
    }
  }
}

async function scanDatabaseLogicalUsage(map: Map<string, StorageBucket>): Promise<void> {
  const result = await query<{
    tenant_id: string;
    user_id: string | null;
    space_id: string | null;
    logical_bytes: string;
    row_count: string;
  }>(`WITH sized AS (
      SELECT th.tenant_id, th.user_id, th.space_id, pg_column_size(to_jsonb(th))::bigint AS bytes FROM threads th
      UNION ALL
      SELECT th.tenant_id, th.user_id, th.space_id, pg_column_size(to_jsonb(r))::bigint FROM runs r JOIN threads th ON th.id = r.thread_id
      UNION ALL
      SELECT th.tenant_id, th.user_id, th.space_id, pg_column_size(to_jsonb(m))::bigint FROM messages m JOIN threads th ON th.id = m.thread_id
      UNION ALL
      SELECT th.tenant_id, th.user_id, th.space_id, pg_column_size(to_jsonb(e))::bigint FROM events e JOIN runs r ON r.id = e.run_id JOIN threads th ON th.id = r.thread_id
      UNION ALL
      SELECT th.tenant_id, th.user_id, th.space_id, pg_column_size(to_jsonb(s))::bigint FROM steps s JOIN runs r ON r.id = s.run_id JOIN threads th ON th.id = r.thread_id
      UNION ALL
      SELECT pi.tenant_id, th.user_id, pi.space_id, pg_column_size(to_jsonb(pi))::bigint FROM provider_invocations pi JOIN threads th ON th.id = pi.thread_id
      UNION ALL
      SELECT pi.tenant_id, th.user_id, pi.space_id, pg_column_size(to_jsonb(pa))::bigint FROM provider_attempts pa JOIN provider_invocations pi ON pi.id = pa.invocation_id JOIN threads th ON th.id = pi.thread_id
      UNION ALL
      SELECT sr.tenant_id, th.user_id, th.space_id, pg_column_size(to_jsonb(sr))::bigint FROM subagent_runs sr JOIN runs r ON r.id = sr.parent_run_id JOIN threads th ON th.id = r.thread_id
      UNION ALL
      SELECT rc.tenant_id, th.user_id, th.space_id, pg_column_size(to_jsonb(rc))::bigint FROM runtime_capability_calls rc JOIN runs r ON r.id = rc.run_id JOIN threads th ON th.id = r.thread_id
    )
    SELECT tenant_id, user_id, space_id, COALESCE(sum(bytes), 0)::text AS logical_bytes, count(*)::text AS row_count
    FROM sized GROUP BY tenant_id, user_id, space_id`);
  for (const row of result.rows) {
    addBucket(map, {
      tenantId: row.tenant_id,
      userId: row.user_id,
      spaceId: row.space_id,
      category: 'database_logical',
      logicalBytes: Number(row.logical_bytes),
      allocatedBytes: 0,
      fileCount: Number(row.row_count),
      symlinkCount: 0,
    });
  }
}

let scanInFlight: Promise<Date> | null = null;

function truncatePeriod(date: Date, period: 'hour' | 'day'): Date {
  const value = new Date(date);
  if (period === 'day') value.setUTCHours(0, 0, 0, 0);
  else value.setUTCMinutes(0, 0, 0);
  return value;
}

async function persistStorageBuckets(capturedAt: Date, buckets: StorageBucket[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const period of ['hour', 'day'] as const) {
      const start = truncatePeriod(capturedAt, period);
      await client.query('DELETE FROM storage_usage_samples WHERE period = $1 AND period_start = $2', [period, start]);
      for (const bucket of buckets) {
        await client.query(
          `INSERT INTO storage_usage_samples
             (period, period_start, tenant_id, user_id, space_id, category,
              logical_bytes, allocated_bytes, file_count, symlink_count)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [period, start, bucket.tenantId, bucket.userId, bucket.spaceId, bucket.category,
            bucket.logicalBytes, bucket.allocatedBytes, bucket.fileCount, bucket.symlinkCount],
        );
      }
    }
    await client.query(`DELETE FROM storage_usage_samples
      WHERE (period = 'hour' AND period_start < now() - interval '30 days')
         OR (period = 'day' AND period_start < now() - interval '1 year')`);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function scanStorageUsage(): Promise<Date> {
  if (scanInFlight) return scanInFlight;
  scanInFlight = (async () => {
    const settings = await getSystemToolSettings();
    const buckets = new Map<string, StorageBucket>();
    await scanThreadWorkspaces(buckets, settings.workspaceRoot);
    await scanExternalArtifacts(buckets, settings.workspaceRoot);
    await scanBusinessPlugins(buckets);
    await scanDatabaseLogicalUsage(buckets);
    const capturedAt = new Date();
    await persistStorageBuckets(capturedAt, [...buckets.values()]);
    return capturedAt;
  })().finally(() => { scanInFlight = null; });
  return scanInFlight;
}

function tokenTotals(row: TokenRow): TokenUsageTotals {
  const inputTokens = Number(row.input_tokens);
  const outputTokens = Number(row.output_tokens);
  const attempts = Number(row.attempts);
  const attemptsWithUsage = Number(row.attempts_with_usage);
  const tokens = inputTokens + outputTokens;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: Number(row.cached_input_tokens),
    attemptedTokens: tokens,
    effectiveTokens: row.status === 'success' ? tokens : 0,
    attempts,
    attemptsWithUsage,
    attemptsWithoutUsage: attempts - attemptsWithUsage,
  };
}

function storageTotals(row: StorageSampleRow): StorageMetric {
  return {
    logicalBytes: Number(row.logical_bytes),
    allocatedBytes: Number(row.allocated_bytes),
    fileCount: Number(row.file_count),
    symlinkCount: Number(row.symlink_count),
  };
}

function tokenBreakdown(
  rows: TokenRow[],
  keyOf: (row: TokenRow) => { id: string; label: string; tenantId?: string },
): TokenUsageBreakdown[] {
  const grouped = new Map<string, TokenUsageBreakdown>();
  for (const row of rows) {
    const key = keyOf(row);
    const current = grouped.get(`${key.tenantId ?? ''}\u0000${key.id}`)
      ?? { ...key, ...EMPTY_TOKEN };
    addToken(current, tokenTotals(row));
    grouped.set(`${key.tenantId ?? ''}\u0000${key.id}`, current);
  }
  return [...grouped.values()].sort((a, b) => b.attemptedTokens - a.attemptedTokens || a.label.localeCompare(b.label));
}

function storageBreakdown(
  rows: StorageSampleRow[],
  keyOf: (row: StorageSampleRow) => { id: string; label: string; tenantId?: string },
): StorageUsageBreakdown[] {
  const grouped = new Map<string, StorageUsageBreakdown>();
  for (const row of rows) {
    const key = keyOf(row);
    const mapKey = `${key.tenantId ?? ''}\u0000${key.id}`;
    const current = grouped.get(mapKey) ?? { ...key, ...EMPTY_STORAGE };
    addStorage(current, storageTotals(row));
    grouped.set(mapKey, current);
  }
  return [...grouped.values()].sort((a, b) => b.allocatedBytes - a.allocatedBytes || b.logicalBytes - a.logicalBytes || a.label.localeCompare(b.label));
}

async function tokenRows(filter: UsageFilter): Promise<TokenRow[]> {
  const params: unknown[] = [filter.from, filter.to];
  const conditions = ['pa.started_at >= $1', 'pa.started_at < $2'];
  if (filter.tenantId) { params.push(filter.tenantId); conditions.push(`pi.tenant_id = $${params.length}`); }
  if (filter.userId) { params.push(filter.userId); conditions.push(`th.user_id = $${params.length}`); }
  if (filter.spaceId) { params.push(filter.spaceId); conditions.push(`pi.space_id = $${params.length}`); }
  if (filter.availableSpaceIds) {
    params.push(filter.availableSpaceIds);
    conditions.push(`pi.space_id = ANY($${params.length}::text[])`);
  }
  return (await query<TokenRow>(`SELECT
      to_char(date_trunc('day', pa.started_at AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD') AS day,
      pi.tenant_id, tn.name AS tenant_name, th.user_id, u.email AS user_label,
      pi.space_id, sp.name AS space_name, pi.provider, pi.model, pi.purpose, pa.status,
      COALESCE(sum(COALESCE((pa.usage->>'inputTokens')::bigint, 0)), 0)::text AS input_tokens,
      COALESCE(sum(COALESCE((pa.usage->>'outputTokens')::bigint, 0)), 0)::text AS output_tokens,
      COALESCE(sum(COALESCE((pa.usage->>'cachedInputTokens')::bigint, 0)), 0)::text AS cached_input_tokens,
      count(*)::text AS attempts,
      count(*) FILTER (WHERE pa.usage IS NOT NULL)::text AS attempts_with_usage
    FROM provider_attempts pa
    JOIN provider_invocations pi ON pi.id = pa.invocation_id
    JOIN threads th ON th.id = pi.thread_id
    JOIN tenants tn ON tn.id = pi.tenant_id
    JOIN spaces sp ON sp.id = pi.space_id
    LEFT JOIN users u ON u.id = th.user_id
    WHERE ${conditions.join(' AND ')}
    GROUP BY day, pi.tenant_id, tn.name, th.user_id, u.email, pi.space_id, sp.name,
      pi.provider, pi.model, pi.purpose, pa.status
    ORDER BY day`, params)).rows;
}

async function storageRows(filter: UsageFilter): Promise<{ current: StorageSampleRow[]; history: StorageSampleRow[]; capturedAt: Date | null }> {
  const params: unknown[] = [];
  const conditions: string[] = [];
  if (filter.tenantId) { params.push(filter.tenantId); conditions.push(`s.tenant_id = $${params.length}`); }
  if (filter.userId) { params.push(filter.userId); conditions.push(`s.user_id = $${params.length}`); }
  if (filter.spaceId) { params.push(filter.spaceId); conditions.push(`s.space_id = $${params.length}`); }
  if (filter.availableSpaceIds) {
    params.push(filter.availableSpaceIds);
    conditions.push(`s.space_id = ANY($${params.length}::text[])`);
  }
  const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';
  const captured = await query<{ period_start: Date; captured_at: Date }>(
    `SELECT period_start, max(created_at) AS captured_at
       FROM storage_usage_samples s
      WHERE period = 'hour' ${where}
      GROUP BY period_start
      ORDER BY period_start DESC
      LIMIT 1`,
    params,
  );
  const periodStart = captured.rows[0]?.period_start ?? null;
  const capturedAt = captured.rows[0]?.captured_at ?? null;
  const common = `SELECT s.period, s.period_start, s.tenant_id, tn.name AS tenant_name,
      s.user_id, u.email AS user_label, s.space_id, sp.name AS space_name, s.category,
      s.logical_bytes::text, s.allocated_bytes::text, s.file_count::text, s.symlink_count::text
    FROM storage_usage_samples s
    JOIN tenants tn ON tn.id = s.tenant_id
    LEFT JOIN users u ON u.id = s.user_id
    LEFT JOIN spaces sp ON sp.id = s.space_id`;
  const current = periodStart
    ? (await query<StorageSampleRow>(`${common} WHERE s.period = 'hour' AND s.period_start = $${params.length + 1} ${where}`,
      [...params, periodStart])).rows
    : [];
  const historyParams: unknown[] = [...params, filter.from, filter.to];
  const history = (await query<StorageSampleRow>(`${common}
    WHERE s.period = 'day'
      AND s.period_start >= $${params.length + 1}
      AND s.period_start < $${params.length + 2}
      ${where}
    ORDER BY s.period_start`, historyParams)).rows;
  return { current, history, capturedAt };
}

async function scopeOptions(filter: UsageFilter): Promise<UsageAggregateResponse['options']> {
  const tenantCondition = filter.availableTenantId ? 'WHERE t.id = $1' : '';
  const tenantParams = filter.availableTenantId ? [filter.availableTenantId] : [];
  const tenants: UsageScopeOption[] = (await query<{ id: string; name: string }>(
    `SELECT t.id, t.name FROM tenants t ${tenantCondition} ORDER BY t.name, t.id`, tenantParams,
  )).rows.map((row) => ({ id: row.id, label: row.name }));
  const userConditions = filter.tenantId ? ['u.tenant_id = $1'] : [];
  const userParams: unknown[] = filter.tenantId ? [filter.tenantId] : [];
  if (filter.availableUserId) {
    userParams.push(filter.availableUserId);
    userConditions.push(`u.id = $${userParams.length}`);
  }
  const users: UsageScopeOption[] = (await query<{ id: string; email: string; tenant_id: string }>(
    `SELECT u.id, u.email, u.tenant_id FROM users u ${userConditions.length ? `WHERE ${userConditions.join(' AND ')}` : ''} ORDER BY u.email`,
    userParams,
  )).rows.map((row) => ({ id: row.id, label: row.email, tenantId: row.tenant_id }));
  const spaceConditions = filter.tenantId ? ['sp.tenant_id = $1'] : [];
  const spaceParams: unknown[] = filter.tenantId ? [filter.tenantId] : [];
  if (filter.userId) {
    spaceParams.push(filter.userId);
    spaceConditions.push(`EXISTS (SELECT 1 FROM threads option_thread WHERE option_thread.space_id = sp.id AND option_thread.user_id = $${spaceParams.length})`);
  }
  if (filter.availableSpaceIds) {
    spaceParams.push(filter.availableSpaceIds);
    spaceConditions.push(`sp.id = ANY($${spaceParams.length}::text[])`);
  }
  const spaces: UsageScopeOption[] = (await query<{ id: string; name: string; tenant_id: string }>(
    `SELECT sp.id, sp.name, sp.tenant_id FROM spaces sp ${spaceConditions.length ? `WHERE ${spaceConditions.join(' AND ')}` : ''} ORDER BY sp.name`,
    spaceParams,
  )).rows.map((row) => ({ id: row.id, label: row.name, tenantId: row.tenant_id }));
  return { tenants, users, spaces };
}

export async function aggregateUsage(filter: UsageFilter): Promise<UsageAggregateResponse> {
  const [tokens, storage, options] = await Promise.all([tokenRows(filter), storageRows(filter), scopeOptions(filter)]);
  const tokenTotal = { ...EMPTY_TOKEN };
  tokens.forEach((row) => addToken(tokenTotal, tokenTotals(row)));
  const dailyMap = new Map<string, TokenUsagePoint>();
  for (const row of tokens) {
    const current = dailyMap.get(row.day) ?? { date: row.day, ...EMPTY_TOKEN };
    addToken(current, tokenTotals(row));
    dailyMap.set(row.day, current);
  }
  const storageTotal = { ...EMPTY_STORAGE };
  storage.current.forEach((row) => addStorage(storageTotal, storageTotals(row)));
  const historyMap = new Map<string, StorageUsagePoint>();
  for (const row of storage.history) {
    const at = row.period_start.toISOString();
    const current = historyMap.get(at) ?? { at, period: row.period, ...EMPTY_STORAGE };
    addStorage(current, storageTotals(row));
    historyMap.set(at, current);
  }
  return {
    generatedAt: new Date().toISOString(),
    filters: {
      from: filter.from.toISOString(),
      to: filter.to.toISOString(),
      tenantId: filter.tenantId ?? null,
      userId: filter.userId ?? null,
      spaceId: filter.spaceId ?? null,
    },
    options,
    tokens: {
      totals: tokenTotal,
      daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      byTenant: tokenBreakdown(tokens, (row) => ({ id: row.tenant_id, label: row.tenant_name })),
      byUser: tokenBreakdown(tokens.filter((row) => row.user_id), (row) => ({ id: row.user_id!, label: row.user_label ?? row.user_id!, tenantId: row.tenant_id })),
      bySpace: tokenBreakdown(tokens, (row) => ({ id: row.space_id, label: row.space_name, tenantId: row.tenant_id })),
      byModel: tokenBreakdown(tokens, (row) => ({ id: `${row.provider}:${row.model}`, label: `${row.provider} · ${row.model}` })),
      byPurpose: tokenBreakdown(tokens, (row) => ({ id: row.purpose, label: row.purpose })),
    },
    storage: {
      capturedAt: storage.capturedAt?.toISOString() ?? null,
      totals: storageTotal,
      history: [...historyMap.values()].sort((a, b) => a.at.localeCompare(b.at)),
      byTenant: storageBreakdown(storage.current, (row) => ({ id: row.tenant_id, label: row.tenant_name })),
      byUser: storageBreakdown(storage.current.filter((row) => row.user_id), (row) => ({ id: row.user_id!, label: row.user_label ?? row.user_id!, tenantId: row.tenant_id })),
      bySpace: storageBreakdown(storage.current.filter((row) => row.space_id), (row) => ({ id: row.space_id!, label: row.space_name ?? row.space_id!, tenantId: row.tenant_id })),
      byCategory: storageBreakdown(storage.current, (row) => ({ id: row.category, label: row.category })),
    },
  };
}

let scheduler: NodeJS.Timeout | null = null;

export function startStorageUsageScheduler(): void {
  if (scheduler) return;
  const run = () => void scanStorageUsage().catch((error) => {
    console.warn(`[usage] 存储占用扫描失败：${(error as Error).message}`);
  });
  run();
  scheduler = setInterval(run, 60 * 60 * 1_000);
  scheduler.unref();
}
