import { businessPluginRegistry } from '../businessPlugins/registry.js';
import {
  removeSpaceWorkspace,
  removeTenantWorkspace,
} from '../files/workspaceRoot.js';
import { store } from '../store/index.js';
import { DeleteConflictError } from '../store/types.js';
import { deletionGate } from '../deletion/gate.js';
import { stopThreadsForDeletion } from '../deletion/runtime.js';
import { removeExternalArtifacts } from '../deletion/files.js';

export class TenantDeletionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TenantDeletionError';
  }
}

export async function deleteTenant(tenantId: string): Promise<void> {
  const tenant = await store.findTenant(tenantId);
  if (!tenant) throw new TenantDeletionError(404, 'TENANT_NOT_FOUND', '租户不存在');
  if (tenant.is_bootstrap) {
    throw new TenantDeletionError(409, 'DEFAULT_TENANT_PROTECTED', 'default 租户不能删除');
  }
  const deletion = deletionGate.begin({ tenantId });
  try {
    const result = await businessPluginRegistry.deleteTenant(
      tenantId,
      async () => {
        const spaces = await store.listSpaces(tenantId);
        const threads = await store.listThreadsForDeletion(tenantId);
        deletion.addThreads(threads.map((thread) => thread.id));
        await deletion.waitForOperations();
        await stopThreadsForDeletion(threads);
        const deleted = await store.deleteTenant(tenantId);
        if (!deleted) throw new TenantDeletionError(404, 'TENANT_NOT_FOUND', '租户不存在');
        await Promise.all([
          removeTenantWorkspace(tenantId),
          ...spaces.map((space) => removeSpaceWorkspace(space.id)),
        ]);
        return deleted;
      },
    );
    await removeExternalArtifacts(result.artifactStorageKeys);
  } catch (error) {
    if (error instanceof DeleteConflictError) {
      throw new TenantDeletionError(409, error.code, error.message);
    }
    throw error;
  } finally {
    deletion.finish();
  }
}
