import type { NextFunction, Request, Response } from 'express';
import { getIdentity } from './context.js';

/** 只允许租户身份(owner/admin/member 均可)访问；系统管理员身份被拒绝。 */
export function requireTenantScope(req: Request, res: Response, next: NextFunction): void {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'tenant') {
    res.status(403).json({ error: '需要租户身份' });
    return;
  }
  next();
}

/** 只允许系统管理员身份访问；租户身份(不管什么角色)被拒绝。 */
export function requireSystemScope(req: Request, res: Response, next: NextFunction): void {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'system') {
    res.status(403).json({ error: '需要系统管理员身份' });
    return;
  }
  next();
}

export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'tenant' || identity.role !== 'owner') {
    res.status(403).json({ error: '需要 owner 权限' });
    return;
  }
  next();
}

export function requireOwnerOrAdmin(req: Request, res: Response, next: NextFunction): void {
  const identity = getIdentity();
  if (!identity || identity.scope !== 'tenant' || (identity.role !== 'owner' && identity.role !== 'admin')) {
    res.status(403).json({ error: '需要 owner 或 admin 权限' });
    return;
  }
  next();
}

/** 租户内角色只能管理自己的 tenant；:id 路径参数必须等于身份里的 tenantId。 */
export function requireMatchingTenantParam(paramName = 'id') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = getIdentity();
    if (!identity || identity.scope !== 'tenant' || req.params[paramName] !== identity.tenantId) {
      res.status(403).json({ error: '无权访问该租户' });
      return;
    }
    next();
  };
}
