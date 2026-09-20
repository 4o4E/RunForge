import { externalArtifactStorage } from '../external/artifactStorage.js';

export async function removeExternalArtifacts(storageKeys: readonly string[]): Promise<void> {
  await Promise.all(storageKeys.map(async (storageKey) => {
    try {
      await externalArtifactStorage.remove(storageKey);
    } catch (error) {
      console.error(`[deletion] 外部附件删除失败，需手动处理：${storageKey}：${(error as Error).message}`);
    }
  }));
}
