import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';

export const MIN_SHARE_TTL_SECONDS = 60;
export const MAX_SHARE_TTL_SECONDS = 10 * 365 * 24 * 60 * 60;

export function assertAccessTokenConfigured(): void {
  if (!config.auth.accessToken.trim()) {
    throw new Error('缺少 RUNFORGE_ACCESS_TOKEN，请在 .env 中配置访问 token');
  }
}

function tokenFromAuthorization(header: unknown): string {
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function hasValidAccessToken(req: Request): boolean {
  const token = tokenFromAuthorization(req.headers.authorization);
  return Boolean(token && config.auth.accessToken && safeEqual(token, config.auth.accessToken));
}

function isSignedFileRequest(req: Request): boolean {
  return req.method === 'GET'
    && (req.path === '/files/raw' || req.path === '/files/preview' || req.path === '/files/hex' || req.path === '/files/pdf-preview')
    && typeof req.query.sig === 'string'
    && typeof req.query.expires === 'string';
}

export function requireApiAccess(req: Request, res: Response, next: NextFunction): void {
  if (hasValidAccessToken(req) || isSignedFileRequest(req)) {
    next();
    return;
  }
  res.status(401).json({ error: '缺少或无效的访问 token' });
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

export function isValidAccessTokenValue(token: string): boolean {
  return Boolean(token && config.auth.accessToken && safeEqual(token, config.auth.accessToken));
}

function shareSecret(): string {
  const secret = config.auth.shareSecret.trim();
  if (!secret) throw new Error('缺少 RUNFORGE_SHARE_SECRET 或 RUNFORGE_ACCESS_TOKEN，无法生成分享签名');
  return secret;
}

export function clampShareTtlSeconds(value: unknown): number {
  const raw = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(raw)) return 24 * 60 * 60;
  return Math.min(MAX_SHARE_TTL_SECONDS, Math.max(MIN_SHARE_TTL_SECONDS, Math.floor(raw)));
}

export function signFileShare(canonicalPath: string, expiresEpochSeconds: number): string {
  return createHmac('sha256', shareSecret())
    .update(`${canonicalPath}\n${expiresEpochSeconds}`)
    .digest('base64url');
}

export function verifyFileShare(canonicalPath: string, expiresRaw: unknown, signatureRaw: unknown, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (typeof expiresRaw !== 'string' || typeof signatureRaw !== 'string') return false;
  const expires = Number(expiresRaw);
  if (!Number.isInteger(expires) || expires < nowSeconds) return false;
  const expected = signFileShare(canonicalPath, expires);
  return safeEqual(signatureRaw, expected);
}
