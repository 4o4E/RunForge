import type { Store } from '../store/types.js';
import { store as defaultStore } from '../store/index.js';
import { looksLikeJwt, verifyAccessToken } from './jwt.js';
import { hashOpaqueToken } from './tokens.js';
import { identityFromClaims, type IdentityContext } from './context.js';

function tokenFromAuthorization(header: unknown): string {
  if (typeof header !== 'string') return '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? '';
}

/** 双路径身份解析(docs/multi-tenancy-design.md §4"请求校验路径"):
 *  token 是 JWT 格式 → 验签验过期,不查库;否则按 hash 查 auth_tokens(kind='api')。
 *  requireApiAccess 和 files.ts 的 requireFileAccess 共用这一份逻辑。 */
export async function resolveIdentityFromAuthorizationHeader(
  header: unknown,
  storeArg: Store = defaultStore,
): Promise<IdentityContext | null> {
  const token = tokenFromAuthorization(header);
  if (!token) return null;

  if (looksLikeJwt(token)) {
    const claims = verifyAccessToken(token);
    return claims ? identityFromClaims(claims) : null;
  }

  const tokenHash = hashOpaqueToken(token);
  const record = await storeArg.findAuthTokenByHash(tokenHash);
  if (!record || record.kind !== 'api' || record.revoked_at) return null;
  if (record.expires_at && Date.parse(record.expires_at) < Date.now()) return null;
  const user = await storeArg.findUserById(record.user_id);
  if (!user || user.status !== 'active') return null;
  return { scope: 'tenant', tenantId: record.tenant_id, userId: user.id, role: user.role };
}
