import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExternalRunReceipt } from '@runforge/contracts';
import type { SpaceWithVisibilityRow } from '../store/types.js';
import { ExternalCommandService } from './service.js';
import { ExternalApiError, type ExternalCallerAccess, type ExternalRepository } from './types.js';

const uuidToken = '123e4567-e89b-42d3-a456-426614174000';
const space: SpaceWithVisibilityRow = {
  id: 'sp_external',
  tenant_id: 'tn_external',
  mode: 'external',
  name: 'External',
  execution_user_id: 'us_execution',
  config: {},
  config_version: 3,
  created_by_user_id: null,
  visible_user_ids: [],
  deleted_at: null,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
};
const access: ExternalCallerAccess = {
  caller: {
    id: 'ec_caller',
    tenantId: space.tenant_id,
    spaceId: space.id,
    name: 'Caller',
    status: 'active',
    metadata: {},
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  },
  token: {
    id: 'et_token',
    callerId: 'ec_caller',
    label: null,
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: new Date(0).toISOString(),
  },
  space,
};

function unused(): never {
  throw new Error('test repository method should not be called');
}

function fakeRepository(overrides: Partial<ExternalRepository>): ExternalRepository {
  return {
    authenticateToken: async () => access,
    createCaller: async () => unused(),
    listCallers: async () => unused(),
    updateCaller: async () => unused(),
    issueToken: async () => unused(),
    revokeToken: async () => unused(),
    createRun: async () => unused(),
    appendRun: async () => unused(),
    getRun: async () => unused(),
    cancelRun: async () => unused(),
    ...overrides,
  };
}

const resolvedConfig = {
  configVersion: 3,
  modelRef: 'main:model-a',
  snapshot: {
    schemaVersion: 1 as const,
    spaceId: space.id,
    mode: 'external' as const,
    systemPrompt: 'space prompt',
    model: {
      modelRef: 'main:model-a',
      allowedModelRefs: ['main:model-a'],
      contextWindow: 100_000,
      contextBudget: 50_000,
      contextBudgetSource: 'model-settings',
    },
    capabilities: { tools: [], mcpServers: [], runtime: [] },
    external: { allowTrustedPrompt: true, allowNextStep: false },
  },
  runtimeCapabilitiesSnapshot: {
    allowedCapabilities: [],
    llm: { enabled: false, defaultModelId: '', models: [] },
    image: { enabled: false, defaultModelId: '', models: [] },
    video: { enabled: false, defaultModelId: '', models: [] },
  },
};

test('external command: run.create 固化可信提示词，只启动一次 executor', async () => {
  const started: Array<{ runId: string; userId: string }> = [];
  let capturedHash = '';
  const repository = fakeRepository({
    createRun: async (_access, input) => {
      capturedHash = input.requestHash;
      assert.equal(input.snapshot.spaceConfig.external.trustedPrompt, '只返回机器可读结果');
      return {
        response: { operation: 'run.create', threadId: 'th_created', runId: 'ru_created', status: 'pending' },
        replayed: false,
        executionUserId: 'us_execution',
      };
    },
  });
  const service = new ExternalCommandService(
    repository,
    (runId, scope) => started.push({ runId, userId: scope.userId }),
    async () => {},
    { resolveForRun: async () => structuredClone(resolvedConfig) },
  );
  const response = await service.execute(uuidToken, {
    operation: 'run.create',
    idempotencyKey: 'create-1',
    input: '执行任务',
    trustedPrompt: '只返回机器可读结果',
    source: { externalThreadRef: 'conversation-1' },
  }) as ExternalRunReceipt;

  assert.equal(response.runId, 'ru_created');
  assert.match(capturedHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(started, [{ runId: 'ru_created', userId: 'us_execution' }]);
});

test('external command: 幂等键不进入请求 hash，重放回执不会再次启动 executor', async () => {
  const hashes: string[] = [];
  let starts = 0;
  const repository = fakeRepository({
    createRun: async (_access, input) => {
      hashes.push(input.requestHash);
      return {
        response: { operation: 'run.create', threadId: 'th_same', runId: 'ru_same', status: 'pending' },
        replayed: input.idempotencyKey === 'key-2',
        executionUserId: 'us_execution',
      };
    },
  });
  const service = new ExternalCommandService(
    repository,
    () => { starts += 1; },
    async () => {},
    { resolveForRun: async () => structuredClone(resolvedConfig) },
  );
  const request = { operation: 'run.create', input: 'same', source: { externalEventId: 'event-1' } } as const;
  await service.execute(uuidToken, { ...request, idempotencyKey: 'key-1' });
  await service.execute(uuidToken, { ...request, idempotencyKey: 'key-2' });
  assert.equal(hashes[0], hashes[1]);
  assert.equal(starts, 1);
});

test('external command: next_step 在持久化执行链完成前明确拒绝', async () => {
  const service = new ExternalCommandService(fakeRepository({}), () => {}, async () => {}, {
    resolveForRun: async () => structuredClone(resolvedConfig),
  });
  await assert.rejects(
    service.execute(uuidToken, {
      operation: 'run.append',
      idempotencyKey: 'append-1',
      threadId: 'th_abc',
      delivery: 'next_step',
      input: '追加',
    }),
    (error: unknown) => error instanceof ExternalApiError && error.code === 'NEXT_STEP_NOT_READY',
  );
});

test('external command: UUID Token 无效时不会进入命令处理', async () => {
  let authenticated = false;
  const service = new ExternalCommandService(fakeRepository({
    authenticateToken: async () => {
      authenticated = true;
      return access;
    },
  }));
  await assert.rejects(
    service.execute('not-a-uuid', { operation: 'run.get', runId: 'ru_abc' }),
    (error: unknown) => error instanceof ExternalApiError && error.status === 401,
  );
  assert.equal(authenticated, false);
});
