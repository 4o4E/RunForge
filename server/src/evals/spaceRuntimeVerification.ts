import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ExternalArtifactGetResponse,
  ExternalArtifactUploadReceipt,
  ExternalNextStepReceipt,
  ExternalRunReceipt,
  ExternalRunView,
  ToolSettings,
} from '@runforge/contracts';
import { executeRun } from '../agent/executor.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import { pool } from '../db/pool.js';
import { prisma } from '../db/prisma.js';
import { ExternalArtifactMaterializer } from '../external/artifactMaterializer.js';
import { externalArtifactRemotePath } from '../external/artifactProtocol.js';
import { FileExternalArtifactStorage } from '../external/artifactStorage.js';
import { PrismaExternalRepository } from '../external/repository.js';
import { ExternalCommandService } from '../external/service.js';
import { ExternalApiError } from '../external/types.js';
import { resolveWorkspaceRootForThread } from '../files/workspaceRoot.js';
import { PrismaProviderObservationRepository } from '../llm/observability/repository.js';
import { ProviderTraceWriter } from '../llm/observability/trace.js';
import { ProviderRunner } from '../llm/providerRunner.js';
import type { Provider } from '../llm/types.js';
import { tenantSettingsTemplateEntries } from '../settings.js';
import { SpaceAccessService } from '../spaces/access.js';
import { SpaceConfigService } from '../spaces/config.js';
import { PgStore } from '../store/pgStore.js';
import type { Scope } from '../store/types.js';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const tenantId = `space-e2e-${suffix}`;
const runtimeRoot = join(tmpdir(), `runforge-space-e2e-${suffix}`);
const artifactRoot = join(runtimeRoot, 'artifact-storage');
const traceRoot = join(runtimeRoot, 'provider-traces');
const startedAt = new Date().toISOString();
const reportDirectory = join(process.cwd(), '..', 'workspace', 'space-runtime-verification', startedAt.replaceAll(':', '-'));
const reportPath = join(reportDirectory, 'report.md');

const store = new PgStore();
const spaceConfig = new SpaceConfigService();
const spaceAccess = new SpaceAccessService(store, spaceConfig);
const externalRepository = new PrismaExternalRepository();
const artifactStorage = new FileExternalArtifactStorage(artifactRoot);
const artifactMaterializer = new ExternalArtifactMaterializer(undefined, artifactStorage);
const scheduledRuns = new Map<string, Scope>();
const scheduledRunCounts = new Map<string, number>();
const externalCommands = new ExternalCommandService(
  externalRepository,
  (runId, scope) => {
    scheduledRuns.set(runId, scope);
    scheduledRunCounts.set(runId, (scheduledRunCounts.get(runId) ?? 0) + 1);
  },
  async () => {},
  spaceConfig,
  artifactStorage,
);

let upstreamRequests = 0;
let activeUpstreamRequests = 0;
let maxConcurrentUpstreamRequests = 0;
const provider: Provider = {
  name: 'space-runtime-verification',
  async complete(messages, tools, options) {
    const response = await options!.fetch!('https://provider.verify/v1/chat?key=space-runtime-query-secret', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer space-runtime-header-secret',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'verification-model', messages, tools }),
    });
    const data = await response.json() as { output: string };
    return {
      content: data.output,
      toolCalls: [],
      usage: { inputTokens: 12, outputTokens: 4 },
      finishReason: 'stop',
      rawFinishReason: 'stop',
    };
  },
};

const providerRunner = new ProviderRunner(
  new PrismaProviderObservationRepository(),
  new ProviderTraceWriter(traceRoot),
  async () => {},
  () => 0,
  async (input, init) => {
    upstreamRequests += 1;
    activeUpstreamRequests += 1;
    maxConcurrentUpstreamRequests = Math.max(maxConcurrentUpstreamRequests, activeUpstreamRequests);
    try {
      const requestNumber = upstreamRequests;
      const request = input instanceof Request ? input : new Request(input, init);
      const body = await request.clone().json() as { messages?: Array<{ role?: string; content?: unknown }> };
      const lastUser = [...(body.messages ?? [])].reverse().find((message) => message.role === 'user');
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(JSON.stringify({
        id: `resp_space_e2e_${requestNumber}`,
        output: `verified:${String(lastUser?.content ?? '')}`,
      }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': `req_space_e2e_${requestNumber}`,
        },
      });
    } finally {
      activeUpstreamRequests -= 1;
    }
  },
);

function toolSettings(workspaceRoot: string): ToolSettings {
  return {
    sandbox: 'enforce',
    sandboxBackend: 'none',
    workspaceRoot,
    shellEnabled: false,
    shellUseHostPath: true,
    shellPathMode: 'system',
    shellPath: process.env.PATH ?? '',
    shellAllowCommands: [],
    network: 'disabled',
    shellDeny: [],
    maxOutput: 40_000,
  };
}

async function executeObservedRun(runId: string, scope: Scope): Promise<string> {
  const workspaceRoot = join(runtimeRoot, 'run-workspaces', runId);
  await executeRun(runId, {
    scope,
    store,
    provider,
    providerDescriptor: {
      provider: provider.name,
      model: 'verification-model',
      retries: 0,
    },
    providerRunner,
    stream: false,
    publish: () => {},
    hardStepCap: 3,
    toolSettings: toolSettings(workspaceRoot),
    mcpSettings: { servers: [] },
    generateThreadTitle: false,
    materializeRunArtifacts: (targetScope, targetRunId, targetWorkspaceRoot) => (
      artifactMaterializer.materializeRun(targetScope, targetRunId, targetWorkspaceRoot)
    ),
  });
  const run = await store.getRun(scope, runId);
  assert.equal(run?.status, 'done');
  return workspaceRoot;
}

function source(applicationRef: string, event: string, thread?: string) {
  return {
    applicationRef,
    externalThreadRef: thread,
    externalEventId: `${applicationRef}-${event}-${suffix}`,
    metadata: { verification: true },
  };
}

async function expectExternalError(action: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(action, (error: unknown) => error instanceof ExternalApiError && error.code === code);
}

try {
  await mkdir(runtimeRoot, { recursive: true });
  const provisioned = await store.createTenantWithOwner({
    id: tenantId,
    name: '空间端到端验收租户',
    ownerEmail: `owner-${suffix}@space-e2e.test`,
    ownerPasswordHash: 'verification-only',
    settingsTemplate: tenantSettingsTemplateEntries(),
  });
  const viewer = await store.createUser({
    tenantId,
    email: `viewer-${suffix}@space-e2e.test`,
    passwordHash: 'verification-only',
    role: 'member',
  });
  const ownerScope = { tenantId, userId: provisioned.owner.id };
  const viewerScope = { tenantId, userId: viewer.id };
  const ownerActor = {
    scope: 'tenant' as const,
    tenantId,
    userId: provisioned.owner.id,
    role: 'owner' as const,
  };
  const viewerActor = {
    scope: 'tenant' as const,
    tenantId,
    userId: viewer.id,
    role: 'member' as const,
  };

  const spaceA = await spaceAccess.create(ownerActor, {
    mode: 'external',
    name: '外部应用 A',
    executionUserId: viewer.id,
    visibleUserIds: [viewer.id],
    config: {
      systemPrompt: 'SPACE_A_PROMPT_V1',
      external: { allowNextStep: true, allowTrustedPrompt: true },
    },
  });
  const spaceB = await spaceAccess.create(ownerActor, {
    mode: 'external',
    name: '外部应用 B',
    executionUserId: viewer.id,
    visibleUserIds: [viewer.id],
    config: {
      systemPrompt: 'SPACE_B_PROMPT',
      external: { allowNextStep: true, allowTrustedPrompt: true },
    },
  });

  const tokenA = randomUUID();
  const callerA = await externalRepository.createCaller({
    tenantId,
    spaceId: spaceA.id,
    name: '可信应用 A',
    metadata: { applicationRef: 'app-a' },
    tokenHash: hashOpaqueToken(tokenA),
    tokenLabel: 'e2e-a',
    tokenExpiresAt: null,
  });
  const tokenB = randomUUID();
  const callerB = await externalRepository.createCaller({
    tenantId,
    spaceId: spaceB.id,
    name: '可信应用 B',
    metadata: { applicationRef: 'app-b' },
    tokenHash: hashOpaqueToken(tokenB),
    tokenLabel: 'e2e-b',
    tokenExpiresAt: null,
  });

  const artifactContent = Buffer.from('artifact-from-app-a', 'utf8');
  const artifactA = await externalCommands.execute(tokenA, {
    operation: 'artifact.upload',
    idempotencyKey: 'artifact-a',
    name: 'input-a.txt',
    mimeType: 'text/plain',
    contentBase64: artifactContent.toString('base64'),
    metadata: { caller: 'a' },
    source: source('app-a', 'artifact'),
  }) as ExternalArtifactUploadReceipt;
  const artifactReplay = await externalCommands.execute(tokenA, {
    operation: 'artifact.upload',
    idempotencyKey: 'artifact-a',
    name: 'input-a.txt',
    mimeType: 'text/plain',
    contentBase64: artifactContent.toString('base64'),
    metadata: { caller: 'a' },
    source: source('app-a', 'artifact'),
  }) as ExternalArtifactUploadReceipt;
  assert.equal(artifactReplay.artifact.id, artifactA.artifact.id);
  await expectExternalError(
    externalCommands.execute(tokenB, { operation: 'artifact.get', artifactId: artifactA.artifact.id }),
    'ARTIFACT_NOT_FOUND',
  );

  const createA = {
    operation: 'run.create' as const,
    idempotencyKey: 'run-a-v1',
    input: 'APP_A_INITIAL_INPUT',
    trustedPrompt: 'APP_A_TRUSTED_V1',
    artifactIds: [artifactA.artifact.id],
    source: source('app-a', 'create-v1', 'app-a-thread'),
  };
  const runA = await externalCommands.execute(tokenA, createA) as ExternalRunReceipt;
  const replayA = await externalCommands.execute(tokenA, createA) as ExternalRunReceipt;
  assert.equal(replayA.runId, runA.runId);
  assert.equal(scheduledRunCounts.get(runA.runId), 1);

  const nextStepA = {
    operation: 'run.append' as const,
    delivery: 'next_step' as const,
    idempotencyKey: 'run-a-next-step',
    threadId: runA.threadId,
    input: 'APP_A_NEXT_STEP_INPUT',
    source: source('app-a', 'next-step'),
  };
  const acceptedNextStep = await externalCommands.execute(tokenA, nextStepA) as ExternalNextStepReceipt;
  const replayedNextStep = await externalCommands.execute(tokenA, nextStepA) as ExternalNextStepReceipt;
  assert.equal(replayedNextStep.inputId, acceptedNextStep.inputId);

  const runB = await externalCommands.execute(tokenB, {
    operation: 'run.create',
    idempotencyKey: 'run-b-v1',
    input: 'APP_B_INITIAL_INPUT',
    trustedPrompt: 'APP_B_TRUSTED',
    source: source('app-b', 'create-v1', 'app-b-thread'),
  }) as ExternalRunReceipt;
  assert.equal(scheduledRunCounts.get(runB.runId), 1);
  await expectExternalError(
    externalCommands.execute(tokenA, { operation: 'run.get', runId: runB.runId }),
    'RUN_NOT_FOUND',
  );
  await expectExternalError(
    externalCommands.execute(tokenB, { operation: 'run.get', runId: runA.runId }),
    'RUN_NOT_FOUND',
  );

  const updatedSpaceA = await spaceAccess.update(ownerActor, spaceA.id, {
    config: {
      systemPrompt: 'SPACE_A_PROMPT_V2',
      external: { allowNextStep: true, allowTrustedPrompt: true },
    },
  });
  assert.equal(updatedSpaceA.configVersion, spaceA.configVersion + 1);

  const webThread = await store.createThread(ownerScope, 'default Web 验收');
  const webRun = await store.createRun(ownerScope, webThread.id, 'DEFAULT_WEB_INPUT');
  await executeObservedRun(webRun.id, ownerScope);
  const [workspaceA] = await Promise.all([
    executeObservedRun(runA.runId, scheduledRuns.get(runA.runId)!),
    executeObservedRun(runB.runId, scheduledRuns.get(runB.runId)!),
  ]);
  assert.ok(maxConcurrentUpstreamRequests >= 2, '两个外部 run 应实际并发进入上游请求');

  const runAView = await externalCommands.execute(tokenA, { operation: 'run.get', runId: runA.runId }) as ExternalRunView;
  assert.equal(runAView.status, 'done');
  assert.match(runAView.output ?? '', /APP_A_NEXT_STEP_INPUT/);
  const runBView = await externalCommands.execute(tokenB, { operation: 'run.get', runId: runB.runId }) as ExternalRunView;
  assert.equal(runBView.status, 'done');

  const artifactAfterRun = await externalCommands.execute(tokenA, {
    operation: 'artifact.get',
    artifactId: artifactA.artifact.id,
  }) as ExternalArtifactGetResponse;
  assert.equal(artifactAfterRun.artifact.status, 'materialized');
  assert.equal(
    await readFile(join(workspaceA, externalArtifactRemotePath(artifactAfterRun.artifact)), 'utf8'),
    artifactContent.toString('utf8'),
  );

  const appendedA = await externalCommands.execute(tokenA, {
    operation: 'run.append',
    idempotencyKey: 'run-a-v2',
    threadId: runA.threadId,
    input: 'APP_A_V2_INPUT',
    trustedPrompt: 'APP_A_TRUSTED_V2',
    source: source('app-a', 'append-v2'),
  }) as ExternalRunReceipt;
  assert.equal(scheduledRunCounts.get(appendedA.runId), 1);
  await executeObservedRun(appendedA.runId, scheduledRuns.get(appendedA.runId)!);

  const persistedRuns = await prisma.runs.findMany({
    where: { id: { in: [runA.runId, appendedA.runId] } },
    select: { id: true, space_config_version: true },
  });
  const versionByRun = new Map(persistedRuns.map((run) => [run.id, run.space_config_version]));
  assert.equal(versionByRun.get(runA.runId), spaceA.configVersion);
  assert.equal(versionByRun.get(appendedA.runId), updatedSpaceA.configVersion);

  const observedRunIds = [webRun.id, runA.runId, runB.runId, appendedA.runId];
  const invocations = await prisma.provider_invocations.findMany({
    where: { run_id: { in: observedRunIds } },
    include: { provider_attempts: true },
  });
  assert.equal(invocations.length, observedRunIds.length);
  assert.equal(invocations.every((invocation) => invocation.status === 'success'), true);
  assert.equal(invocations.every((invocation) => invocation.provider_attempts.length === 1), true);
  const attempts = invocations.flatMap((invocation) => invocation.provider_attempts);
  assert.equal(attempts.every((attempt) => attempt.status === 'success' && attempt.http_status === 200), true);
  assert.equal(attempts.every((attempt) => attempt.raw_stream?.includes('resp_space_e2e_')), true);
  assert.equal(attempts.every((attempt) => attempt.normalized_response != null), true);
  assert.equal(attempts.every((attempt) => attempt.usage != null && attempt.finish_reason === 'stop'), true);
  assert.equal(attempts.every((attempt) => Boolean(attempt.provider_response_id) && attempt.ended_at != null), true);
  assert.equal(attempts.every((attempt) => attempt.url.includes('space-runtime-query-secret') === false), true);
  assert.equal(attempts.every((attempt) => new URL(attempt.url).searchParams.get('key') === '[REDACTED]'), true);
  assert.equal(JSON.stringify(attempts).includes('space-runtime-header-secret'), false);

  const attemptByRun = new Map(invocations.map((invocation) => [
    invocation.run_id,
    JSON.stringify(invocation.provider_attempts[0].request_body),
  ]));
  assert.match(attemptByRun.get(runA.runId) ?? '', /SPACE_A_PROMPT_V1/);
  assert.doesNotMatch(attemptByRun.get(runA.runId) ?? '', /SPACE_A_PROMPT_V2/);
  assert.match(attemptByRun.get(runA.runId) ?? '', /APP_A_TRUSTED_V1/);
  assert.match(attemptByRun.get(runA.runId) ?? '', /APP_A_NEXT_STEP_INPUT/);
  assert.match(attemptByRun.get(runA.runId) ?? '', new RegExp(artifactA.artifact.id));
  assert.match(attemptByRun.get(appendedA.runId) ?? '', /SPACE_A_PROMPT_V2/);
  assert.match(attemptByRun.get(appendedA.runId) ?? '', /APP_A_TRUSTED_V2/);
  assert.doesNotMatch(attemptByRun.get(runB.runId) ?? '', /SPACE_A_PROMPT/);
  assert.doesNotMatch(attemptByRun.get(runB.runId) ?? '', /APP_A_/);

  const tenant = await store.findTenant(tenantId);
  const externalThreadA = await store.getThread(scheduledRuns.get(runA.runId)!, runA.threadId);
  assert.ok(tenant && externalThreadA);
  const defaultWorkspace = resolveWorkspaceRootForThread(webThread, tenant, runtimeRoot);
  const externalWorkspace = resolveWorkspaceRootForThread(externalThreadA, tenant, runtimeRoot);
  assert.equal(defaultWorkspace.kind, 'user');
  assert.equal(externalWorkspace.kind, 'thread');
  assert.notEqual(defaultWorkspace.root, externalWorkspace.root);
  assert.match(externalWorkspace.root, new RegExp(`${runA.threadId}$`));

  const ownerSpaces = await spaceAccess.list(ownerActor);
  assert.equal(ownerSpaces.some((space) => space.id === provisioned.defaultSpace.id), true);
  assert.equal(ownerSpaces.some((space) => space.id === spaceA.id), true);
  assert.equal(ownerSpaces.some((space) => space.id === spaceB.id), true);
  const viewerSpaces = await spaceAccess.list(viewerActor);
  assert.deepEqual(viewerSpaces.map((space) => space.id).sort(), [spaceA.id, spaceB.id].sort());
  const viewerThreads = await store.listThreadsForViewer(viewerScope, 50, {
    webSpaceIds: viewerSpaces.filter((space) => space.mode === 'web').map((space) => space.id),
    externalSpaceIds: viewerSpaces.filter((space) => space.mode === 'external').map((space) => space.id),
  });
  assert.equal(viewerThreads.some((thread) => thread.id === runA.threadId), true);
  assert.equal(viewerThreads.some((thread) => thread.id === runB.threadId), true);
  assert.equal(viewerThreads.some((thread) => thread.id === webThread.id), false);

  const replayedEvents = await store.getEventsAfterCursor(scheduledRuns.get(runA.runId)!, runA.runId, 0);
  assert.equal(replayedEvents.some((item) => item.event.type === 'external_input_applied'), true);
  assert.equal(replayedEvents.some((item) => item.event.type === 'final'), true);
  assert.equal(replayedEvents.every((item, index) => index === 0 || item.cursor > replayedEvents[index - 1].cursor), true);
  assert.deepEqual(
    await store.getEventsAfterCursor(scheduledRuns.get(runA.runId)!, runA.runId, replayedEvents.at(-1)!.cursor),
    [],
  );

  await spaceAccess.delete(ownerActor, spaceB.id);
  await expectExternalError(
    externalCommands.execute(tokenB, { operation: 'run.get', runId: runB.runId }),
    'EXTERNAL_TOKEN_INVALID',
  );
  await spaceAccess.restore(ownerActor, spaceB.id);
  await expectExternalError(
    externalCommands.execute(tokenB, { operation: 'run.get', runId: runB.runId }),
    'EXTERNAL_TOKEN_INVALID',
  );
  assert.equal(
    (await externalCommands.execute(tokenA, { operation: 'run.get', runId: runA.runId }) as ExternalRunView).status,
    'done',
  );

  const traceFiles = await readdir(traceRoot);
  const traceLines = (await Promise.all(traceFiles.map(async (name) => (
    (await readFile(join(traceRoot, name), 'utf8')).trim().split('\n').filter(Boolean)
  )))).flat();
  assert.equal(traceLines.length, attempts.length);
  assert.equal(traceLines.some((line) => line.includes('space-runtime-header-secret')), false);
  assert.equal(upstreamRequests, observedRunIds.length);

  const report = [
    '# Space Runtime End-to-End Verification',
    '',
    `startedAt: ${startedAt}`,
    'status: passed',
    '',
    `- tenant: ${tenantId}`,
    `- defaultSpace: ${provisioned.defaultSpace.id}`,
    `- externalSpaces: ${spaceA.id}, ${spaceB.id}`,
    `- callers: ${callerA.caller.id}, ${callerB.caller.id}`,
    `- runs: ${observedRunIds.join(', ')}`,
    `- providerInvocations: ${invocations.length}`,
    `- providerAttempts: ${attempts.length}`,
    `- traceLines: ${traceLines.length}`,
    `- maxConcurrentUpstreamRequests: ${maxConcurrentUpstreamRequests}`,
    '',
    '通过项：default Web 运行、两个外部调用方隔离、幂等重放、持久化 next_step、Artifact materialize、',
    '配置副本版本隔离、普通用户可见名单、workspace 映射、数据库 event cursor 回放、',
    'Provider invocation/attempt 关联、URL/请求头密钥不落库、空间软删除后 Token 不恢复。',
    '',
  ].join('\n');
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(reportPath, report, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    reportPath,
    tenantId,
    defaultSpaceId: provisioned.defaultSpace.id,
    externalSpaceIds: [spaceA.id, spaceB.id],
    runIds: observedRunIds,
    providerInvocationCount: invocations.length,
    providerAttemptCount: attempts.length,
    traceLineCount: traceLines.length,
    maxConcurrentUpstreamRequests,
  }));
} finally {
  await rm(runtimeRoot, { recursive: true, force: true });
  await prisma.app_settings.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.threads.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.tenants.updateMany({ where: { id: tenantId }, data: { default_space_id: null } });
  await prisma.spaces.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.users.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.tenants.deleteMany({ where: { id: tenantId } });
  await prisma.$disconnect();
  await pool.end();
}
