import { normalizeRemotePath } from '../files/workspace.js';
import type { ToolRunContext } from './types.js';

/** 工具执行时统一把相对路径解释为当前用户 workspace 下的路径。
 *  policy 已经负责安全检查,这里负责让真实 IO 和 policy 使用同一套路径语义。 */
export function resolveToolPath(raw: unknown, ctx?: ToolRunContext): string {
  const path = String(raw ?? '');
  if (!ctx?.settings?.workspaceRoot) return path;
  return normalizeRemotePath(path, ctx.settings.workspaceRoot);
}

export function resolveToolRoot(raw: unknown, ctx?: ToolRunContext): string {
  const path = raw == null || raw === '' ? '.' : raw;
  return resolveToolPath(path, ctx);
}
