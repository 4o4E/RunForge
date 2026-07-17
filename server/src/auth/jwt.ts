import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { TenantUserRole } from '@runforge/contracts';

export interface TenantJwtClaims {
  sub: string;
  scope: 'tenant';
  tenant_id: string;
  role: TenantUserRole;
  iat: number;
  exp: number;
}

export interface SystemJwtClaims {
  sub: string;
  scope: 'system';
  iat: number;
  exp: number;
}

export type JwtClaims = TenantJwtClaims | SystemJwtClaims;

export function assertJwtSecretConfigured(): void {
  if (!config.auth.jwtSecret.trim()) {
    throw new Error('缺少 RUNFORGE_JWT_SECRET，请在 .env 中配置 JWT 签名密钥');
  }
}

function jwtSecret(): string {
  const secret = config.auth.jwtSecret.trim();
  if (!secret) throw new Error('缺少 RUNFORGE_JWT_SECRET，无法签发或校验 JWT');
  return secret;
}

/** JWT 的紧凑串正好含两个 '.' 分隔符；不透明 token(atk_...)不会满足这个形状。 */
export function looksLikeJwt(token: string): boolean {
  return typeof token === 'string' && (token.match(/\./g)?.length ?? 0) === 2;
}

export function signTenantAccessToken(
  user: { id: string; tenantId: string; role: TenantUserRole },
  ttlSeconds: number = config.auth.accessTokenTtlSeconds,
): string {
  return jwt.sign(
    { scope: 'tenant', tenant_id: user.tenantId, role: user.role },
    jwtSecret(),
    { subject: user.id, expiresIn: ttlSeconds, algorithm: 'HS256' },
  );
}

export function signSystemAccessToken(
  admin: { id: string },
  ttlSeconds: number = config.auth.accessTokenTtlSeconds,
): string {
  return jwt.sign(
    { scope: 'system' },
    jwtSecret(),
    { subject: admin.id, expiresIn: ttlSeconds, algorithm: 'HS256' },
  );
}

/** 校验签名和过期时间；任何失败都返回 null，从不抛出。 */
export function verifyAccessToken(token: string): JwtClaims | null {
  try {
    const decoded = jwt.verify(token, jwtSecret(), { algorithms: ['HS256'] });
    if (typeof decoded !== 'object' || decoded === null || typeof decoded.sub !== 'string') return null;
    if (decoded.scope === 'tenant' && typeof decoded.tenant_id === 'string' && typeof decoded.role === 'string') {
      return decoded as unknown as TenantJwtClaims;
    }
    if (decoded.scope === 'system') {
      return decoded as unknown as SystemJwtClaims;
    }
    return null;
  } catch {
    return null;
  }
}
