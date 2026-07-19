import { join, resolve } from 'node:path';
import { config } from '../config.js';

/** 按租户派生 workspace 根目录(docs/multi-tenancy-design.md §6)。
 *  tenantId === 'default' 时直接返回原始未加后缀的路径,保证现有单租户部署的文件
 *  路径不因升级而漂移;其余租户落在 `<base>/tenants/<tenantId>/workspace`。 */
export function resolveWorkspaceRoot(tenantId: string, base: string = config.tools.workspaceRoot): string {
  if (tenantId === 'default') return resolve(base);
  return resolve(join(base, 'tenants', tenantId, 'workspace'));
}
