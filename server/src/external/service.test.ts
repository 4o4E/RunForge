import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExternalArtifactSummary, ExternalNextStepReceipt, ExternalRunReceipt } from '@runforge/contracts';
import type { SpaceWithVisibilityRow } from '../store/types.js';
import { ExternalCommandService } from './service.js';
import { ExternalApiError, type ExternalCallerAccess, type ExternalRepository } from './types.js';
import { FileExternalArtifactStorage } from './artifactStorage.js';
import { ExternalArtifactMaterializer } from './artifactMaterializer.js';
import { attachExternalArtifactTokens, externalArtifactRemotePath } from './artifactProtocol.js';

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
    appendNextStep: async () => unused(),
    createArtifact: async () => unused(),
    findArtifactUploadReplay: async () => null,
    getArtifact: async () => unused(),
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
      assert.deepEqual(input.artifactIds, ['ar_input']);
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
    artifactIds: ['ar_input'],
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

test('external command: next_step 返回持久化接纳回执，且不会启动第二个 executor', async () => {
  let starts = 0;
  let capturedInput = '';
  const service = new ExternalCommandService(fakeRepository({
    appendNextStep: async (_access, input) => {
      capturedInput = input.input;
      return {
        response: {
          operation: 'run.append',
          delivery: 'next_step',
          threadId: input.threadId,
          runId: 'ru_active',
          inputId: 'ri_accepted',
          version: 2,
          status: 'accepted',
        },
        replayed: false,
        executionUserId: 'us_execution',
      };
    },
  }), () => { starts += 1; }, async () => {}, {
    resolveForRun: async () => structuredClone(resolvedConfig),
  });
  const response = await service.execute(uuidToken, {
    operation: 'run.append',
    idempotencyKey: 'append-1',
    threadId: 'th_abc',
    delivery: 'next_step',
    input: '追加',
  }) as ExternalNextStepReceipt;

  assert.equal(capturedInput, '追加');
  assert.equal(response.inputId, 'ri_accepted');
  assert.equal(response.version, 2);
  assert.equal(starts, 0);
});

test('external command: artifact 上传到受控存储并按 caller 授权读取', async () => {
  const files = new Map<string, Buffer>();
  let writes = 0;
  let artifact: ExternalArtifactSummary | null = null;
  let storageKey = '';
  const repository = fakeRepository({
    findArtifactUploadReplay: async () => artifact
      ? { operation: 'artifact.upload', artifact }
      : null,
    createArtifact: async (callerAccess, input) => {
      assert.equal(callerAccess.caller.id, access.caller.id);
      storageKey = input.storageKey;
      artifact = {
        id: input.artifactId,
        name: input.name,
        mimeType: input.mimeType,
        size: input.size,
        status: 'staged',
        metadata: input.metadata,
        threadId: null,
        runId: null,
        createdAt: new Date(0).toISOString(),
        materializedAt: null,
      };
      return { response: { operation: 'artifact.upload', artifact }, replayed: false };
    },
    getArtifact: async (_callerAccess, artifactId) => artifact?.id === artifactId
      ? { artifact, storageKey }
      : null,
  });
  const service = new ExternalCommandService(
    repository,
    () => {},
    async () => {},
    { resolveForRun: async () => structuredClone(resolvedConfig) },
    {
      write: async (key, content) => { writes += 1; files.set(key, Buffer.from(content)); },
      read: async (key) => files.get(key) ?? Promise.reject(new Error('missing')),
      remove: async (key) => { files.delete(key); },
    },
  );
  const content = Buffer.from('artifact-content', 'utf8');
  const uploadCommand = {
    operation: 'artifact.upload',
    idempotencyKey: 'artifact-1',
    name: 'input.txt',
    mimeType: 'text/plain',
    contentBase64: content.toString('base64'),
    metadata: { purpose: 'test' },
  } as const;
  const uploaded = await service.execute(uuidToken, uploadCommand) as { artifact: ExternalArtifactSummary };
  assert.match(uploaded.artifact.id, /^ar_[0-9A-Za-z]+$/);
  assert.equal(files.get(storageKey)?.toString('utf8'), 'artifact-content');
  const replayed = await service.execute(uuidToken, uploadCommand) as { artifact: ExternalArtifactSummary };
  assert.equal(replayed.artifact.id, uploaded.artifact.id);
  assert.equal(writes, 1);

  const fetched = await service.execute(uuidToken, {
    operation: 'artifact.get',
    artifactId: uploaded.artifact.id,
  }) as { contentBase64: string };
  assert.equal(Buffer.from(fetched.contentBase64, 'base64').toString('utf8'), 'artifact-content');
});

test('external artifact storage: storage key 不能逃出受控目录', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-external-artifact-'));
  const storage = new FileExternalArtifactStorage(root);
  try {
    await storage.write('ec_test/ar_keep', Buffer.from('keep'));
    await storage.write('ec_test/ar_test', Buffer.from('safe'));
    await assert.rejects(storage.write('ec_test/ar_keep', Buffer.from('overwrite')));
    assert.equal((await storage.read('ec_test/ar_keep')).toString('utf8'), 'keep');
    assert.equal((await storage.read('ec_test/ar_test')).toString('utf8'), 'safe');
    await assert.rejects(storage.write('../escape', Buffer.from('unsafe')), /越界/);
    assert.equal(await storage.reconcile(new Set(['ec_test/ar_keep'])), 1);
    assert.equal((await storage.read('ec_test/ar_keep')).toString('utf8'), 'keep');
    await assert.rejects(storage.read('ec_test/ar_test'));
    await storage.remove('ec_test/ar_keep');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external artifact materializer: 使用确定路径写入 workspace 并在文件完成后提交状态', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-external-materialize-'));
  const storage = new FileExternalArtifactStorage(join(root, 'storage'));
  const workspace = join(root, 'workspace');
  const artifact = {
    id: 'ar_materialize',
    storageKey: 'ec_test/ar_materialize',
    name: '分析 报告.pdf',
    mimeType: 'application/pdf',
    size: 7,
    status: 'staged' as 'staged' | 'materialized',
    initialInput: true,
  };
  let marks = 0;
  const materializer = new ExternalArtifactMaterializer({
    list: async () => [artifact],
    mark: async (_scope, runId, artifactId) => {
      assert.equal(runId, 'ru_materialize');
      assert.equal(artifactId, artifact.id);
      marks += 1;
      artifact.status = 'materialized';
    },
  }, storage);
  try {
    await storage.write(artifact.storageKey, Buffer.from('content'));
    assert.equal((await materializer.materializeRun({ tenantId: 'tn_test', userId: 'us_test' }, 'ru_materialize', workspace)).length, 1);
    const remotePath = externalArtifactRemotePath({ id: artifact.id, name: artifact.name });
    assert.equal((await readFile(join(workspace, remotePath))).toString('utf8'), 'content');
    assert.equal((await materializer.materializeRun({ tenantId: 'tn_test', userId: 'us_test' }, 'ru_materialize', workspace)).length, 1);
    assert.equal(marks, 1);
    assert.match(attachExternalArtifactTokens('处理附件', [artifact]), /\[\[file:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('external command: artifact 拒绝非法 MIME 类型且不会写盘', async () => {
  let writes = 0;
  const service = new ExternalCommandService(
    fakeRepository({}),
    () => {},
    async () => {},
    { resolveForRun: async () => structuredClone(resolvedConfig) },
    {
      write: async () => { writes += 1; },
      read: async () => Buffer.alloc(0),
      remove: async () => {},
    },
  );
  await assert.rejects(service.execute(uuidToken, {
    operation: 'artifact.upload',
    idempotencyKey: 'artifact-invalid-mime',
    name: 'input.txt',
    mimeType: 'not-a-mime',
    contentBase64: Buffer.from('content').toString('base64'),
  }), (error: unknown) => error instanceof ExternalApiError && error.code === 'INVALID_ARTIFACT_MIME_TYPE');
  assert.equal(writes, 0);
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
