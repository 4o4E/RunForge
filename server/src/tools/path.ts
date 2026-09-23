import { resolveWorkspaceFilePath } from '../files/workspace.js';
import { isWithin } from './policy.js';
import { isAbsolute, relative, resolve } from 'node:path';
import type { ToolRunContext } from './types.js';

/** 工具执行时统一把相对路径解释为当前用户 workspace 下的路径。
 *  policy 已经负责安全检查,这里负责让真实 IO 和 policy 使用同一套路径语义。 */
export async function resolveToolPath(raw: unknown, ctx: ToolRunContext | undefined, access: 'read' | 'write'): Promise<string> {
  const path = String(raw ?? '');
  if (!ctx?.settings?.workspaceRoot) return path;
  if (isAbsolute(path) && ctx.userFiles && isWithin(ctx.userFiles.mountPath, path)) {
    const target = resolve(ctx.userFiles.source, relative(ctx.userFiles.mountPath, path));
    return resolveWorkspaceFilePath(ctx.userFiles.source, target, { access });
  }
  return resolveWorkspaceFilePath(ctx.settings.workspaceRoot, path, {
    access,
    managedReadRoots: ctx.managedReadRoots,
    pluginRoots: ctx.pluginRoots,
  });
}

export async function resolveToolRoot(raw: unknown, ctx: ToolRunContext | undefined): Promise<string> {
  const path = raw == null || raw === '' ? '.' : raw;
  return resolveToolPath(path, ctx, 'read');
}
