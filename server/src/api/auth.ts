import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { resolveIdentityFromAuthorizationHeader } from '../auth/resolve.js';
import { runWithIdentity } from '../auth/context.js';

export const MIN_SHARE_TTL_SECONDS = 60;
export const MAX_SHARE_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isSignedFileRequest(req: Request): boolean {
  return req.method === 'GET'
    && (req.path === '/files/raw' || req.path === '/files/preview' || req.path === '/files/hex' || req.path === '/files/pdf-preview')
    && typeof req.query.sig === 'string'
    && typeof req.query.expires === 'string';
}

/** /runtime/* 是容器/shell 脚本用 workload token(不是 JWT,也不在 auth_tokens 表里)
 *  调用的内部接口,由 runtimeApi 自己的 validateWorkloadToken 校验,不走这里的租户身份解析。 */
function isRuntimeRequest(req: Request): boolean {
  return req.path === '/runtime' || req.path.startsWith('/runtime/');
}

/** 全局鉴权中间件:签名文件请求、runtime workload-token 请求直接放行(不建立身份上下文);
 *  否则解析出 {tenantId, userId, role} 或系统管理员身份,写入 AsyncLocalStorage 再继续。 */
export async function requireApiAccess(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (isSignedFileRequest(req) || isRuntimeRequest(req)) {
    next();
    return;
  }
  const identity = await resolveIdentityFromAuthorizationHeader(req.headers.authorization);
  if (!identity) {
    res.status(401).json({ error: '缺少或无效的访问 token' });
    return;
  }
  runWithIdentity(identity, next);
}

export function tokenFromWebSocketProtocols(header: unknown): string {
  if (typeof header !== 'string') return '';
  const protocols = header.split(',').map((item) => item.trim()).filter(Boolean);
  const encoded = protocols.find((item) => item.startsWith('runforge-token.'));
  if (!encoded) return '';
  try {
    return Buffer.from(encoded.slice('runforge-token.'.length), 'base64url').toString('utf8');
  } catch {
    return '';
  }
}

function shareSecret(): string {
  const secret = config.auth.shareSecret.trim();
  if (!secret) throw new Error('缺少 RUNFORGE_SHARE_SECRET，无法生成分享签名');
  return secret;
}

export function clampShareTtlSeconds(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw)) return 24 * 60 * 60;
  return Math.min(MAX_SHARE_TTL_SECONDS, Math.max(MIN_SHARE_TTL_SECONDS, Math.floor(raw)));
}

// tenantId 进签名输入:分享链接本身不带身份，匿名访问时 tenantId 只能来自请求方
// 自己声明的 query 参数，必须和签名当时的 tenantId 绑在一起校验，否则改个 query.tenant
// 就能让签名在另一个租户的 workspaceRoot 下"重放"(docs/multi-tenancy-design.md §7)。
export function signFileShare(canonicalPath: string, tenantId: string, expiresEpochSeconds: number): string {
  return createHmac('sha256', shareSecret())
    .update(`${tenantId}\n${canonicalPath}\n${expiresEpochSeconds}`)
    .digest('base64url');
}

export function verifyFileShare(
  canonicalPath: string,
  tenantId: string,
  expiresRaw: unknown,
  signatureRaw: unknown,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  if (typeof expiresRaw !== 'string' || typeof signatureRaw !== 'string') return false;
  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires) || expires < nowSeconds) return false;
  const expected = signFileShare(canonicalPath, tenantId, expires);
  return safeEqual(signatureRaw, expected);
}
