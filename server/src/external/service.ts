import { createHash } from 'node:crypto';
import {
  externalCommandSchema,
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
  constructor(
    private readonly repository: ExternalRepository = externalRepository,
    private readonly startRun: StartRun = (runId, scope) => { void executeRun(runId, { scope }); },
    private readonly cancelRunShells: CancelRunShells = async (scope, runId) => {
      await shellManager.killRunCommands(scope, runId, 'run_cancel');
    },
    private readonly configService: Pick<SpaceConfigService, 'resolveForRun'> = spaceConfigService,
  ) {}

  async execute(uuidToken: string, value: unknown): Promise<unknown> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuidToken)) {
      throw new ExternalApiError(401, 'EXTERNAL_TOKEN_INVALID', '外部访问凭证无效');
    }
    let access = await this.repository.authenticateToken(hashOpaqueToken(uuidToken));
    if (!access) throw new ExternalApiError(401, 'EXTERNAL_TOKEN_INVALID', '外部访问凭证无效');
    const command = parseCommand(value);

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
      throw new ExternalApiError(409, 'NEXT_STEP_NOT_READY', 'next_step 持久化注入将在下一协议切片启用');
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const snapshot = await this.resolveSnapshot(access, command.modelRef, command.trustedPrompt);
        const result = command.operation === 'run.create'
          ? await this.repository.createRun(access, {
              idempotencyKey: command.idempotencyKey,
              requestHash: commandHash(command),
              input: command.input,
              title: command.title,
              source: command.source,
              snapshot,
            })
          : await this.repository.appendRun(access, {
              idempotencyKey: command.idempotencyKey,
              requestHash: commandHash(command),
              input: command.input,
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
