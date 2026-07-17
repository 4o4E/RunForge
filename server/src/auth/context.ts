import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantUserRole } from '@runforge/contracts';
import type { JwtClaims } from './jwt.js';

export type IdentityContext =
  | { scope: 'tenant'; tenantId: string; userId: string; role: TenantUserRole }
  | { scope: 'system'; systemAdminId: string };

const storage = new AsyncLocalStorage<IdentityContext>();

/** 已知局限(设计文档 §3):ALS 只覆盖 run() 发起时活跃的调用链，不会传播进
 *  之后从别的调用点触发的 EventEmitter 回调(例如 runBus 的订阅回调)。
 *  Phase 1 只搭好请求/响应周期内的身份传递，后续阶段涉及跨异步边界的
 *  场景需要显式在事件 payload 里带 tenant_id，而不是依赖 ALS。 */
export function runWithIdentity<T>(ctx: IdentityContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function getIdentity(): IdentityContext | undefined {
  return storage.getStore();
}

export function identityFromClaims(claims: JwtClaims): IdentityContext {
  if (claims.scope === 'system') {
    return { scope: 'system', systemAdminId: claims.sub };
  }
  return { scope: 'tenant', tenantId: claims.tenant_id, userId: claims.sub, role: claims.role };
}
