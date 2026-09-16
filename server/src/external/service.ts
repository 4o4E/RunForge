import { createHash } from 'node:crypto';
import {
  externalCommandSchema,
  type ExternalArtifactGetResponse,
  type ExternalCommand,
} from '@runforge/contracts';
import { executeRun } from '../agent/executor.js';
import { shellManager } from '../shell/manager.js';
import { SpaceConfigChangedError, type Scope } from '../store/types.js';
import {
  SpaceConfigError,
  spaceConfigService,
  type RunSpaceConfigSnapshot,
  type SpaceConfigService,
} from '../spaces/config.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import { externalRepository } from './repository.js';
import { ExternalApiError, type ExternalCallerAccess, type ExternalRepository, type ExternalRunSnapshot } from './types.js';
import { isExternalUuidToken } from './token.js';
import { newArtifactId } from '../id.js';
import {
  externalArtifactStorage,
  type ExternalArtifactStorage,
} from './artifactStorage.js';
import { MAX_EXTERNAL_ARTIFACT_BYTES } from './artifactProtocol.js';

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function commandHash(command: ExternalCommand): string {
  const { idempotencyKey: _key, ...body } = command as ExternalCommand & { idempotencyKey?: string };
  return createHash('sha256').update(stableJson(body), 'utf8').digest('hex');
}

function parseCommand(value: unknown): ExternalCommand {
  const parsed = externalCommandSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new ExternalApiError(400, 'INVALID_REQUEST', `${path}${issue?.message ?? '外部请求格式无效'}`);
  }
  return parsed.data;
}

function decodeArtifactContent(contentBase64: string): Buffer {
  if (contentBase64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentBase64)) {
    throw new ExternalApiError(400, 'INVALID_ARTIFACT_CONTENT', 'contentBase64 不是规范的 Base64');
  }
  const content = Buffer.from(contentBase64, 'base64');
  if (content.length > MAX_EXTERNAL_ARTIFACT_BYTES) {
    throw new ExternalApiError(413, 'ARTIFACT_TOO_LARGE', `artifact 不能超过 ${MAX_EXTERNAL_ARTIFACT_BYTES} 字节`);
  }
  return content;
}

function artifactFileName(value: string): string {
  const name = value.trim();
  if (name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw new ExternalApiError(400, 'INVALID_ARTIFACT_NAME', 'name 只能是文件名，不能包含路径');
  }
  return name;
}

function artifactMimeType(value: string): string {
  const mimeType = value.split(';', 1)[0].trim().toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType)) {
    throw new ExternalApiError(400, 'INVALID_ARTIFACT_MIME_TYPE', 'mimeType 不是有效的 MIME 类型');
  }
  return mimeType;
}

function snapshotWithTrustedPrompt(
  base: RunSpaceConfigSnapshot,
  trustedPrompt: string | undefined,
): RunSpaceConfigSnapshot {
  if (!trustedPrompt) return base;
  if (!base.external.allowTrustedPrompt) {
    throw new ExternalApiError(403, 'TRUSTED_PROMPT_DISABLED', '当前空间不允许调用方提供可信提示词');
  }
  return {
    ...base,
    external: { ...base.external, trustedPrompt },
  };
}

type StartRun = (runId: string, scope: Scope) => void;
type CancelRunShells = (scope: Scope, runId: string) => Promise<void>;

export class ExternalCommandService {
  private readonly artifactStorage: ExternalArtifactStorage;

  constructor(
    private readonly repository: ExternalRepository = externalRepository,
    private readonly startRun: StartRun = (runId, scope) => { void executeRun(runId, { scope }); },
    private readonly cancelRunShells: CancelRunShells = async (scope, runId) => {
      await shellManager.killRunCommands(scope, runId, 'run_cancel');
    },
    private readonly configService: Pick<SpaceConfigService, 'resolveForRun'> = spaceConfigService,
    artifactStorage: ExternalArtifactStorage = externalArtifactStorage,
  ) {
    this.artifactStorage = artifactStorage;
  }

  async execute(uuidToken: string, value: unknown): Promise<unknown> {
    if (!isExternalUuidToken(uuidToken)) {
      throw new ExternalApiError(401, 'EXTERNAL_TOKEN_INVALID', '外部访问凭证无效');
    }
    let access = await this.repository.authenticateToken(hashOpaqueToken(uuidToken));
    if (!access) throw new ExternalApiError(401, 'EXTERNAL_TOKEN_INVALID', '外部访问凭证无效');
    const command = parseCommand(value);

    if (command.operation === 'artifact.upload') {
      const requestHash = commandHash(command);
      const replay = await this.repository.findArtifactUploadReplay(access, {
        idempotencyKey: command.idempotencyKey,
        requestHash,
        source: command.source,
      });
      if (replay) return replay;
      const content = decodeArtifactContent(command.contentBase64);
      const name = artifactFileName(command.name);
      const mimeType = artifactMimeType(command.mimeType);
      const artifactId = newArtifactId();
      const storageKey = `${access.caller.id}/${artifactId}`;
      try {
        await this.artifactStorage.write(storageKey, content);
      } catch (error) {
        console.warn(`[artifact] 写入受控存储失败 ${artifactId}: ${(error as Error).message}`);
        throw new ExternalApiError(500, 'ARTIFACT_STORAGE_ERROR', 'artifact 内容当前无法保存');
      }
      try {
        const created = await this.repository.createArtifact(access, {
          requestHash,
          idempotencyKey: command.idempotencyKey,
          artifactId,
          storageKey,
          name,
          mimeType,
          size: content.length,
          metadata: command.metadata,
          source: command.source,
        });
        if (created.response.artifact.id !== artifactId) {
          await this.artifactStorage.remove(storageKey).catch(() => {});
        }
        return created.response;
      } catch (error) {
        await this.artifactStorage.remove(storageKey).catch(() => {});
        throw error;
      }
    }
    if (command.operation === 'artifact.get') {
      const found = await this.repository.getArtifact(access, command.artifactId);
      if (!found) throw new ExternalApiError(404, 'ARTIFACT_NOT_FOUND', 'artifact 不存在');
      let content: Buffer;
      try {
        content = await this.artifactStorage.read(found.storageKey);
      } catch {
        throw new ExternalApiError(500, 'ARTIFACT_STORAGE_ERROR', 'artifact 内容当前不可用');
      }
      if (content.length !== found.artifact.size) {
        throw new ExternalApiError(500, 'ARTIFACT_STORAGE_ERROR', 'artifact 内容大小与元数据不一致');
      }
      const response: ExternalArtifactGetResponse = {
        operation: 'artifact.get',
        artifact: found.artifact,
        contentBase64: content.toString('base64'),
      };
      return response;
    }

    if (command.operation === 'run.get') {
      const found = await this.repository.getRun(access, command.runId);
      if (!found) throw new ExternalApiError(404, 'RUN_NOT_FOUND', 'run 不存在');
      return found.response;
    }
    if (command.operation === 'run.cancel') {
      const canceled = await this.repository.cancelRun(access, {
        runId: command.runId,
        idempotencyKey: command.idempotencyKey,
        requestHash: commandHash(command),
        source: command.source,
      });
      if (!canceled) throw new ExternalApiError(404, 'RUN_NOT_FOUND', 'run 不存在');
      if (!canceled.replayed && canceled.response.status === 'canceling') {
        const scope = { tenantId: access.caller.tenantId, userId: canceled.executionUserId };
        await this.cancelRunShells(scope, canceled.response.runId).catch(() => {});
      }
      return canceled.response;
    }
    if (command.operation === 'run.append' && command.delivery === 'next_step') {
      const appended = await this.repository.appendNextStep(access, {
        idempotencyKey: command.idempotencyKey,
        requestHash: commandHash(command),
        input: command.input,
        artifactIds: command.artifactIds ?? [],
        threadId: command.threadId,
        source: command.source,
      });
      return appended.response;
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const snapshot = await this.resolveSnapshot(access, command.modelRef, command.trustedPrompt);
        const result = command.operation === 'run.create'
          ? await this.repository.createRun(access, {
              idempotencyKey: command.idempotencyKey,
              requestHash: commandHash(command),
              input: command.input,
              artifactIds: command.artifactIds ?? [],
              title: command.title,
              source: command.source,
              snapshot,
            })
          : await this.repository.appendRun(access, {
              idempotencyKey: command.idempotencyKey,
              requestHash: commandHash(command),
              input: command.input,
              artifactIds: command.artifactIds ?? [],
              threadId: command.threadId,
              source: command.source,
              snapshot,
            });
        if (!result.replayed) {
          this.startRun(result.response.runId, {
            tenantId: access.caller.tenantId,
            userId: result.executionUserId,
          });
        }
        return result.response;
      } catch (error) {
        if (!(error instanceof SpaceConfigChangedError) || attempt > 0) throw error;
        const refreshed = await this.repository.authenticateToken(hashOpaqueToken(uuidToken));
        if (!refreshed) throw new ExternalApiError(401, 'EXTERNAL_TOKEN_INVALID', '外部访问凭证无效');
        access = refreshed;
      }
    }
    throw new SpaceConfigChangedError();
  }

  private async resolveSnapshot(
    access: ExternalCallerAccess,
    modelRef: string | undefined,
    trustedPrompt: string | undefined,
  ): Promise<ExternalRunSnapshot> {
    try {
      const resolved = await this.configService.resolveForRun(
        access.caller.tenantId,
        access.space,
        modelRef,
      );
      return {
        configVersion: resolved.configVersion,
        modelRef: resolved.modelRef,
        spaceConfig: snapshotWithTrustedPrompt(resolved.snapshot, trustedPrompt),
        runtimeCapabilities: resolved.runtimeCapabilitiesSnapshot,
      };
    } catch (error) {
      if (error instanceof SpaceConfigError) {
        throw new ExternalApiError(409, error.code, error.message);
      }
      throw error;
    }
  }
}

export const externalCommands = new ExternalCommandService();
