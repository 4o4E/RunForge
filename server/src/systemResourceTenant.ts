import { prisma } from './db/prisma.js';

const useMemory = process.env.STORE === 'memory';
let cachedTenantId: string | null = useMemory ? 'default' : null;

/** 启动引导完成后固定系统资源所在的 bootstrap tenant。 */
export function setSystemResourceTenantId(tenantId: string): void {
  if (!tenantId) throw new Error('bootstrap tenant ID 不能为空');
  cachedTenantId = tenantId;
}

/**
 * CLI 验收脚本可能不会执行 HTTP 服务的启动引导，因此允许从数据库恢复一次。
 * 正常服务进程由 runBootstrap 预先写入缓存，不会在每次读取系统设置时查询 tenant。
 */
export async function getSystemResourceTenantId(): Promise<string> {
  if (cachedTenantId) return cachedTenantId;
  const rows = await prisma.tenants.findMany({
    where: { is_bootstrap: true },
    select: { id: true },
    take: 2,
  });
  if (rows.length !== 1) {
    throw new Error(`系统需要且只能存在一个 bootstrap tenant，当前数量：${rows.length}`);
  }
  cachedTenantId = rows[0].id;
  return cachedTenantId;
}
