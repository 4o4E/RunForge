import { listDatasources, listPermissionProfiles } from '../datasources/accountPool.js';
import type { DatasourceRow, PermissionProfileRow } from '../datasources/types.js';
import type { Tool } from './types.js';

const SECRET_KEY_RE = /(password|passwd|pwd|secret|token|key|credential|connectionurl|admin)/i;

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : redactValue(item);
  }
  return out;
}

export function publicDatasourceForTool(datasource: DatasourceRow, profiles: PermissionProfileRow[]) {
  return {
    id: datasource.id,
    name: datasource.name,
    type: datasource.type,
    status: datasource.status,
    enabled: datasource.enabled,
    connection: redactValue(datasource.connection),
    hasAdminConfig: Object.keys(datasource.admin_config).length > 0,
    usable: datasource.enabled && datasource.status === 'active' && profiles.length > 0,
    issues: [
      ...(datasource.enabled ? [] : ['not_enabled']),
      ...(profiles.length ? [] : ['profiles_empty']),
      ...(Object.keys(datasource.admin_config).length > 0 ? [] : ['admin_config_empty']),
    ],
    profiles: profiles.map((profile) => ({
      name: profile.name,
      mode: profile.mode,
      templateRole: profile.template_role,
    })),
  };
}

export const datasourceListTool: Tool = {
  name: 'datasource_list',
  description: '列出系统中已定义的数据源及可用权限档位，供数据库访问 skill 选择 DATASOURCE_ID 和 DATASOURCE_PROFILE。不会返回管理连接串、密码或 token。',
  parameters: {
    type: 'object',
    properties: {
      includeDisabled: { type: 'boolean', description: '是否包含 disabled 数据源，默认 false' },
    },
  },
  async run(args, ctx) {
    if (!ctx?.scope) throw new Error('datasource_list 需要当前身份 scope，上下文缺失。');
    const includeDisabled = args.includeDisabled === true;
    const datasources = (await listDatasources(ctx.scope)).filter((datasource) => datasource.enabled && (includeDisabled || datasource.status === 'active'));
    const result = [];
    for (const datasource of datasources) {
      result.push(publicDatasourceForTool(datasource, await listPermissionProfiles(ctx.scope, datasource.id)));
    }
    return JSON.stringify({ datasources: result }, null, 2);
  },
};
