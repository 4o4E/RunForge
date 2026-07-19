import pg from 'pg';
import { DatasourceError, getDatasource } from './accountPool.js';
import type { DatasourceRow, DatasourceTestResult, DatasourceType } from './types.js';
import type { TenantScope } from '../store/types.js';

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function datasourceType(value: unknown): DatasourceType {
  if (value === 'postgres' || value === 'mysql' || value === 'mongodb' || value === 'hive') return value;
  throw new DatasourceError(400, '数据源 type 必须是 postgres / mysql / mongodb / hive');
}

function draftDatasource(input: unknown): DatasourceRow {
  const body = jsonObject(input);
  return {
    id: 'draft',
    tenant_id: 'draft',
    name: stringValue(body.name, 'draft'),
    type: datasourceType(body.type),
    status: body.status === 'disabled' ? 'disabled' : 'active',
    enabled: typeof body.enabled === 'boolean' ? body.enabled : true,
    connection: jsonObject(body.connection),
    admin_config: jsonObject(body.adminConfig),
    pool_config: jsonObject(body.poolConfig),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function adminConnectionUrl(datasource: DatasourceRow): string {
  const url = stringValue(datasource.admin_config.connectionUrl);
  if (!url) throw new DatasourceError(400, '缺少管理连接 URL，无法测试连接');
  return url;
}

async function testPostgres(datasource: DatasourceRow): Promise<DatasourceTestResult> {
  const client = new pg.Client({ connectionString: adminConnectionUrl(datasource) });
  await client.connect();
  try {
    const database = await client.query<{ current_database: string }>('SELECT current_database()');
    const tables = await client.query<{
      table_schema: string;
      table_name: string;
      table_type: string;
    }>(
      `SELECT table_schema, table_name, table_type
       FROM information_schema.tables
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name
       LIMIT 200`,
    );
    const columns = await client.query<{
      table_schema: string;
      table_name: string;
      column_name: string;
      data_type: string;
      is_nullable: 'YES' | 'NO';
      ordinal_position: number;
    }>(
      `SELECT table_schema, table_name, column_name, data_type, is_nullable, ordinal_position
       FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
       ORDER BY table_schema, table_name, ordinal_position`,
    );
    const columnMap = new Map<string, DatasourceTestResult['tables'][number]['columns']>();
    for (const column of columns.rows) {
      const key = `${column.table_schema}.${column.table_name}`;
      const list = columnMap.get(key) ?? [];
      list.push({
        name: column.column_name,
        type: column.data_type,
        nullable: column.is_nullable === 'YES',
        position: column.ordinal_position,
      });
      columnMap.set(key, list);
    }
    const tableInfos = tables.rows.map((table) => ({
      schema: table.table_schema,
      name: table.table_name,
      type: table.table_type,
      columns: columnMap.get(`${table.table_schema}.${table.table_name}`) ?? [],
    }));
    return {
      ok: true,
      type: 'postgres',
      database: database.rows[0]?.current_database,
      tableCount: tableInfos.length,
      tables: tableInfos,
    };
  } finally {
    await client.end();
  }
}

export async function testDatasourceDraft(input: unknown): Promise<DatasourceTestResult> {
  return testDatasource(draftDatasource(input));
}

export async function testDatasourceById(scope: TenantScope, id: string, input: unknown = {}): Promise<DatasourceTestResult> {
  const datasource = await getDatasource(scope, id);
  if (!datasource) throw new DatasourceError(404, '数据源不存在');
  const body = jsonObject(input);
  const adminConfig = jsonObject(body.adminConfig);
  const merged: DatasourceRow = {
    ...datasource,
    admin_config: Object.keys(adminConfig).length > 0 ? adminConfig : datasource.admin_config,
  };
  return testDatasource(merged);
}

async function testDatasource(datasource: DatasourceRow): Promise<DatasourceTestResult> {
  if (datasource.type === 'postgres') return testPostgres(datasource);
  throw new DatasourceError(501, `暂未实现 ${datasource.type} 的测试连接适配器`);
}
