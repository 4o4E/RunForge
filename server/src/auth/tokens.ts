import { createHash, randomBytes } from 'node:crypto';

const OPAQUE_TOKEN_PREFIX = 'atk';

/** 不透明 token(refresh token / API token 共用),风格与 datasources/token.ts 的 workload token 一致。 */
export function generateOpaqueToken(): string {
  return `${OPAQUE_TOKEN_PREFIX}_${randomBytes(32).toString('base64url')}`;
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
