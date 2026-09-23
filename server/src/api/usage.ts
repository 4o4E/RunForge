import { Router, type Request, type Response } from 'express';
import { getIdentity } from '../auth/context.js';
import { aggregateUsage, type UsageFilter } from '../usage/service.js';
import { spaceAccess } from '../spaces/access.js';

export const usageApi = Router();

const DEFAULT_RANGE_DAYS = 84;
const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;

export class UsageAccessError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'UsageAccessError';
  }
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error('时间范围格式无效');
  return parsed;
}

export function parseUsageFilter(req: Request, tenantId?: string): UsageFilter {
  const defaultTo = new Date();
  const to = parseDate(queryString(req, 'to'), defaultTo);
  const from = parseDate(queryString(req, 'from'), new Date(to.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1_000));
  if (from >= to) throw new Error('开始时间必须早于结束时间');
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw new Error('查询时间范围不能超过一年');
  return {
    tenantId: tenantId ?? queryString(req, 'tenantId') ?? null,
    userId: queryString(req, 'userId') ?? null,
    spaceId: queryString(req, 'spaceId') ?? null,
    from,
    to,
  };
}

/** 个人统计同时收紧用户和可见空间；execution user 不等于外部空间 viewer。 */
export function applyPersonalUsageScope(
  filter: UsageFilter,
  userId: string,
  visibleSpaceIds: readonly string[],
): UsageFilter {
  if (filter.userId && filter.userId !== userId) {
    throw new UsageAccessError(403, '不能查询其他用户的用量');
  }
  if (filter.spaceId && !visibleSpaceIds.includes(filter.spaceId)) {
    throw new UsageAccessError(403, '无权访问该空间');
  }
  return {
    ...filter,
    userId,
    availableUserId: userId,
    availableSpaceIds: [...visibleSpaceIds],
  };
}

usageApi.get('/aggregate', async (req, res) => {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'tenant') {
    res.status(403).json({ error: '需要租户身份' });
    return;
  }
  const tenantWide = req.query.scope === 'tenant';
  if (tenantWide && identity.role !== 'owner' && identity.role !== 'admin') {
    res.status(403).json({ error: '需要 owner 或 admin 权限' });
    return;
  }
  let filter: UsageFilter;
  try {
    filter = parseUsageFilter(req, identity.tenantId);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
    return;
  }
  filter.availableTenantId = identity.tenantId;
  if (!tenantWide) {
    let visibleSpaceIds: string[];
    try {
      const visibleSpaces = await spaceAccess.list(identity);
      visibleSpaceIds = visibleSpaces.map((space) => space.id);
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
      return;
    }
    try {
      filter = applyPersonalUsageScope(filter, identity.userId, visibleSpaceIds);
    } catch (error) {
      if (error instanceof UsageAccessError) {
        res.status(error.status).json({ error: error.message });
        return;
      }
      res.status(500).json({ error: (error as Error).message });
      return;
    }
  }
  try {
    res.json(await aggregateUsage(filter));
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});
