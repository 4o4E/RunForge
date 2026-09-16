import { resolve } from 'node:path';
import type { Scope } from '../store/types.js';
import { isWithin } from '../tools/policy.js';
import { externalArtifactRemotePath } from './artifactProtocol.js';
import type { ExternalArtifactTokenSource } from './artifactProtocol.js';
import { externalArtifactStorage, writeFileAtomically, type ExternalArtifactStorage } from './artifactStorage.js';
import {
  listRunArtifactsForMaterialization,
  markRunArtifactMaterialized,
  type RunArtifactForMaterialization,
} from './repository.js';

interface ArtifactMaterializationRepository {
  list(scope: Scope, runId: string): Promise<RunArtifactForMaterialization[]>;
  mark(scope: Scope, runId: string, artifactId: string): Promise<void>;
}

const defaultRepository: ArtifactMaterializationRepository = {
  list: listRunArtifactsForMaterialization,
  mark: markRunArtifactMaterialized,
};

/** 把已绑定的外部附件幂等复制到 run 的受控 workspace，再提交 materialized 状态。 */
export class ExternalArtifactMaterializer {
  constructor(
    private readonly repository: ArtifactMaterializationRepository = defaultRepository,
    private readonly storage: ExternalArtifactStorage = externalArtifactStorage,
  ) {}

  async materializeRun(scope: Scope, runId: string, workspaceRoot: string): Promise<ExternalArtifactTokenSource[]> {
    const artifacts = await this.repository.list(scope, runId);
    for (const artifact of artifacts) {
      if (artifact.status === 'materialized') continue;
      let content: Buffer;
      try {
        content = await this.storage.read(artifact.storageKey);
      } catch (error) {
        console.warn(`[artifact] 读取受控存储失败 ${artifact.id}: ${(error as Error).message}`);
        throw new Error(`artifact 内容当前不可用：${artifact.id}`);
      }
      if (content.length !== artifact.size) {
        throw new Error(`artifact 内容大小与元数据不一致：${artifact.id}`);
      }
      const target = resolve(workspaceRoot, externalArtifactRemotePath(artifact));
      if (!isWithin(workspaceRoot, target)) throw new Error(`artifact 目标路径越界：${artifact.id}`);
      // 文件成功但状态提交前退出时，重启会覆盖同一路径后再次提交，结果保持一致。
      try {
        await writeFileAtomically(target, content, `${target}.runforge-materializing`);
      } catch (error) {
        console.warn(`[artifact] 写入 workspace 失败 ${artifact.id}: ${(error as Error).message}`);
        throw new Error(`artifact 无法写入 workspace：${artifact.id}`);
      }
      await this.repository.mark(scope, runId, artifact.id);
    }
    return artifacts
      .filter((artifact) => artifact.initialInput)
      .map(({ id, name, mimeType, size }) => ({ id, name, mimeType, size }));
  }
}

export const externalArtifactMaterializer = new ExternalArtifactMaterializer();
