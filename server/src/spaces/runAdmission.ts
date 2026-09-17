import type { RunRow, Scope, Store, ThreadRow } from '../store/types.js';
import { SpaceConfigChangedError } from '../store/types.js';
import { store as defaultStore } from '../store/index.js';
import { spaceConfigService as defaultConfigService, type SpaceConfigService } from './config.js';

export interface AdmitWebRunInput {
  input: string;
  requestedModelRef?: string | null;
  parentRunId?: string | null;
}

/**
 * run 接纳边界：先把空间选择规则解析成不含密钥的完整快照，再让 Store 在创建事务中
 * 校验 config_version。若管理员恰好同时更新空间，只重读并重试一次，不让新 run 混用两版配置。
 */
export class RunAdmissionService {
  constructor(
    private readonly store: Store = defaultStore,
    private readonly configService: SpaceConfigService = defaultConfigService,
  ) {}

  async createWebRun(scope: Scope, thread: ThreadRow, input: AdmitWebRunInput): Promise<RunRow> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const space = await this.store.findSpace(scope.tenantId, thread.space_id);
      if (!space) throw new Error('space 不存在');
      const resolved = await this.configService.resolveForRun(
        scope.tenantId,
        space,
        input.requestedModelRef,
      );
      try {
        return await this.store.createRun(scope, thread.id, input.input, {
          modelRef: resolved.modelRef,
          parentRunId: input.parentRunId,
          runtimeCapabilitiesSnapshot: resolved.runtimeCapabilitiesSnapshot as unknown as Record<string, unknown>,
          spaceConfigSnapshot: resolved.snapshot as unknown as Record<string, unknown>,
          pluginLock: resolved.pluginLock as unknown as Record<string, unknown>,
          expectedSpaceConfigVersion: resolved.configVersion,
        });
      } catch (error) {
        if (!(error instanceof SpaceConfigChangedError) || attempt > 0) throw error;
      }
    }
    throw new SpaceConfigChangedError();
  }
}

export const runAdmission = new RunAdmissionService();
