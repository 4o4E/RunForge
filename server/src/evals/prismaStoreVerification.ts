import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pool } from '../db/pool.js';
import { prisma } from '../db/prisma.js';
import { PgStore } from '../store/pgStore.js';
import { findSetting, upsertSettings } from '../store/settingsRepository.js';
import { tenantSettingsTemplateEntries } from '../settings.js';
import { DefaultSpaceImmutableError, RunActiveError } from '../store/types.js';
import { newArtifactId, newSpaceId } from '../id.js';
import { SpaceAccessService } from '../spaces/access.js';
import { SpaceConfigService } from '../spaces/config.js';
import { RunAdmissionService } from '../spaces/runAdmission.js';
import { hashOpaqueToken } from '../auth/tokens.js';
import { listRunArtifactsForMaterialization, PrismaExternalRepository } from '../external/repository.js';
import { ExternalApiError } from '../external/types.js';
import { FileExternalArtifactStorage } from '../external/artifactStorage.js';
import { ExternalArtifactMaterializer } from '../external/artifactMaterializer.js';
import { externalArtifactRemotePath } from '../external/artifactProtocol.js';
import { ProviderRunner } from '../llm/providerRunner.js';
import { PrismaProviderObservationRepository } from '../llm/observability/repository.js';
import type { Provider } from '../llm/types.js';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const tenantId = `prisma-verify-${suffix}`;
const otherTenantId = `prisma-verify-other-${suffix}`;
const systemAdminEmail = `prisma-verify-${suffix}@system.test`;
const toolResult = `验证工具结果：${'原始内容'.repeat(60)}`;
const store = new PgStore();
const spaceConfig = new SpaceConfigService();
const spaceAccess = new SpaceAccessService(store, spaceConfig);
const runAdmission = new RunAdmissionService(store, spaceConfig);
const externalRepository = new PrismaExternalRepository();
const artifactVerificationRoot = await mkdtemp(join(tmpdir(), 'runforge-prisma-artifact-'));

try {
  const provisioned = await store.createTenantWithOwner({
    id: tenantId,
    name: 'Prisma 验证租户',
    ownerEmail: `owner-${suffix}@tenant.test`,
    ownerPasswordHash: 'verification-only',
    settingsTemplate: tenantSettingsTemplateEntries(),
  });
  const { tenant, owner: user, defaultSpace } = provisioned;
  const scope = { tenantId, userId: user.id };

  assert.equal((await store.findTenant(tenantId))?.id, tenant.id);
  assert.equal(tenant.default_space_id, defaultSpace.id);
  assert.equal((await store.getDefaultSpace(tenantId))?.id, defaultSpace.id);
  assert.notEqual(await findSetting(tenantId, 'llm.settings'), undefined);
  assert.equal((await store.listTenants()).some((item) => item.id === tenant.id), true);

  const otherTenant = await store.createTenantWithOwner({
    id: otherTenantId,
    name: 'Prisma 隔离验证租户',
    ownerEmail: `owner-other-${suffix}@tenant.test`,
    ownerPasswordHash: 'verification-only',
    settingsTemplate: [],
  });
  await assert.rejects(
    prisma.spaces.create({
      data: {
        id: newSpaceId(),
        tenant_id: tenantId,
        mode: 'external',
        name: '非法跨租户执行用户',
        execution_user_id: otherTenant.owner.id,
      },
    }),
  );
  assert.equal((await store.updateTenantStatus(tenantId, 'suspended'))?.status, 'suspended');
  assert.equal((await store.updateTenantStatus(tenantId, 'active'))?.status, 'active');
  assert.equal((await store.findUserByEmail(tenantId, user.email))?.id, user.id);
  assert.equal((await store.findUserById(user.id))?.id, user.id);
  assert.equal((await store.listUsersByTenant(tenantId)).length, 1);
  assert.equal((await store.updateUserRole(user.id, 'admin'))?.role, 'admin');
  assert.equal((await store.updateUserStatus(user.id, 'disabled'))?.status, 'disabled');
  assert.equal((await store.updateUser(user.id, {
    role: 'owner',
    status: 'active',
    passwordHash: 'verification-updated',
  }))?.password_hash, 'verification-updated');

  const visibleMember = await store.createUser({
    tenantId,
    email: `member-${suffix}@tenant.test`,
    passwordHash: 'verification-only',
    role: 'member',
  });
  const ownerIdentity = { scope: 'tenant' as const, tenantId, userId: user.id, role: 'owner' as const };
  const externalSpace = await spaceAccess.create(ownerIdentity, {
    mode: 'external',
    name: 'Prisma 外部空间',
    executionUserId: visibleMember.id,
    visibleUserIds: [visibleMember.id],
    config: { systemPrompt: 'v1' },
  });
  assert.equal((await store.findSpace(tenantId, externalSpace.id))?.execution_user_id, visibleMember.id);
  assert.deepEqual((await store.findSpace(tenantId, externalSpace.id))?.visible_user_ids, [visibleMember.id]);
  const updatedExternalSpace = await spaceAccess.update(ownerIdentity, externalSpace.id, {
    config: { systemPrompt: 'v2', external: { allowNextStep: true } },
  });
  assert.equal(updatedExternalSpace.configVersion, 2);

  const externalTokenValue = randomUUID();
  const externalCaller = await externalRepository.createCaller({
    tenantId,
    spaceId: externalSpace.id,
    name: 'Prisma 验证调用方',
    metadata: { applicationRef: 'prisma-verifier' },
    tokenHash: hashOpaqueToken(externalTokenValue),
    tokenLabel: 'initial',
    tokenExpiresAt: null,
  });
  const callerId = externalCaller.caller.id;
  const externalToken = externalCaller.tokens[0];
  const deletedExternalSpace = await spaceAccess.delete(ownerIdentity, externalSpace.id);
  assert.notEqual(deletedExternalSpace.deletedAt, null);
  assert.notEqual((await prisma.external_tokens.findUnique({ where: { id: externalToken.id } }))?.revoked_at, null);
  const restoredExternalSpace = await spaceAccess.restore(ownerIdentity, externalSpace.id);
  assert.equal(restoredExternalSpace.deletedAt, null);
  assert.deepEqual(restoredExternalSpace.visibleUserIds, [visibleMember.id]);
  assert.notEqual((await prisma.external_tokens.findUnique({ where: { id: externalToken.id } }))?.revoked_at, null);
  await assert.rejects(
    store.softDeleteSpaceAndRevokeTokens(tenantId, defaultSpace.id),
    (error: unknown) => error instanceof DefaultSpaceImmutableError,
  );

  const commandTokenValue = randomUUID();
  const commandCaller = await externalRepository.createCaller({
    tenantId,
    spaceId: externalSpace.id,
    name: 'Prisma Command 调用方',
    metadata: {},
    tokenHash: hashOpaqueToken(commandTokenValue),
    tokenLabel: 'command',
    tokenExpiresAt: null,
  });
  const commandAccess = await externalRepository.authenticateToken(hashOpaqueToken(commandTokenValue));
  assert.ok(commandAccess);
  assert.notEqual(commandAccess.token.lastUsedAt, null);
  const artifactId = newArtifactId();
  const artifactInput = {
    requestHash: `artifact-hash-${suffix}`,
    idempotencyKey: 'artifact-1',
    artifactId,
    storageKey: `${commandCaller.caller.id}/${artifactId}`,
    name: 'verification.txt',
    mimeType: 'text/plain',
    size: 12,
    metadata: { purpose: 'verification' },
    source: { externalEventId: `artifact-event-${suffix}`, metadata: {} },
  };
  const artifactResults = await Promise.all([
    externalRepository.createArtifact(commandAccess, artifactInput),
    externalRepository.createArtifact(commandAccess, artifactInput),
  ]);
  assert.equal(artifactResults[0].response.artifact.id, artifactResults[1].response.artifact.id);
  assert.equal(artifactResults.filter((item) => item.replayed).length, 1);
  assert.equal((await externalRepository.getArtifact(commandAccess, artifactId))?.artifact.name, 'verification.txt');
  assert.equal(await prisma.artifacts.count({ where: { caller_id: commandCaller.caller.id } }), 1);
  const currentExternalSpace = await store.findSpace(tenantId, externalSpace.id);
  assert.ok(currentExternalSpace);
  const resolvedExternal = await spaceConfig.resolveForRun(tenantId, currentExternalSpace);
  const externalSnapshot = {
    configVersion: resolvedExternal.configVersion,
    modelRef: resolvedExternal.modelRef,
    spaceConfig: resolvedExternal.snapshot,
    runtimeCapabilities: resolvedExternal.runtimeCapabilitiesSnapshot,
    pluginLock: resolvedExternal.pluginLock,
  };
  const externalCreateInput = {
    requestHash: `create-hash-${suffix}`,
    idempotencyKey: 'create-1',
    input: '外部创建输入',
    artifactIds: [artifactId],
    title: '外部任务',
    source: {
      applicationRef: 'verification-app',
      externalThreadRef: `external-thread-${suffix}`,
      externalEventId: `external-event-${suffix}`,
      triggerRef: 'trigger-1',
      correlationRef: 'correlation-1',
      metadata: { channel: 'verification' },
    },
    snapshot: externalSnapshot,
  };
  const externalCreateResults = await Promise.all([
    externalRepository.createRun(commandAccess, externalCreateInput),
    externalRepository.createRun(commandAccess, externalCreateInput),
  ]);
  assert.equal(externalCreateResults[0].response.runId, externalCreateResults[1].response.runId);
  assert.equal(externalCreateResults.filter((item) => item.replayed).length, 1);
  const externalCreated = externalCreateResults[0];
  const externalScope = { tenantId, userId: visibleMember.id };
  assert.equal((await store.getRun(externalScope, externalCreated.response.runId))?.input, '外部创建输入');
  assert.equal((await prisma.artifacts.findUnique({ where: { id: artifactId } }))?.thread_id, externalCreated.response.threadId);
  assert.equal((await listRunArtifactsForMaterialization(externalScope, externalCreated.response.runId))[0]?.id, artifactId);
  const verificationStorage = new FileExternalArtifactStorage(join(artifactVerificationRoot, 'storage'));
  await verificationStorage.write(artifactInput.storageKey, Buffer.alloc(artifactInput.size, 1));
  const materializedArtifacts = await new ExternalArtifactMaterializer(undefined, verificationStorage).materializeRun(
    externalScope,
    externalCreated.response.runId,
    join(artifactVerificationRoot, 'workspace'),
  );
  const materializedArtifact = materializedArtifacts[0];
  assert.ok(materializedArtifact);
  assert.equal(materializedArtifact.id, artifactId);
  assert.equal((await readFile(join(
    artifactVerificationRoot,
    'workspace',
    externalArtifactRemotePath(materializedArtifact),
  ))).length, artifactInput.size);
  assert.equal((await prisma.artifacts.findUnique({ where: { id: artifactId } }))?.status, 'materialized');
  assert.equal((await store.getThread(externalScope, externalCreated.response.threadId))?.source_caller_id, commandCaller.caller.id);
  assert.equal(
    (await store.listThreadsForViewer(scope, 50, { externalSpaceIds: [externalSpace.id] }))
      .some((item) => item.id === externalCreated.response.threadId),
    true,
  );
  assert.equal(
    (await store.listThreadsForViewer(scope, 50, { webSpaceIds: [externalSpace.id] }))
      .some((item) => item.id === externalCreated.response.threadId),
    false,
  );
  assert.deepEqual((await prisma.external_requests.findFirst({
    where: { run_id: externalCreated.response.runId },
  }))?.source_ref, {
    applicationRef: 'verification-app',
    externalThreadRef: `external-thread-${suffix}`,
    externalEventId: `external-event-${suffix}`,
    triggerRef: 'trigger-1',
    correlationRef: 'correlation-1',
    metadata: { channel: 'verification' },
  });
  await store.setRunStatus(externalScope, externalCreated.response.runId, 'done', { output: '外部完成' });
  assert.equal((await externalRepository.getRun(commandAccess, externalCreated.response.runId))?.response.output, '外部完成');

  const concurrentExternalAppend = {
    requestHash: `append-hash-${suffix}`,
    idempotencyKey: 'append-same',
    threadId: externalCreated.response.threadId,
    input: '外部追加输入',
    source: { externalEventId: `append-event-${suffix}`, metadata: {} },
    snapshot: externalSnapshot,
  };
  const appendResults = await Promise.all([
    externalRepository.appendRun(commandAccess, concurrentExternalAppend),
    externalRepository.appendRun(commandAccess, concurrentExternalAppend),
  ]);
  assert.equal(appendResults[0].response.runId, appendResults[1].response.runId);
  assert.equal(appendResults.filter((item) => item.replayed).length, 1);
  await assert.rejects(
    externalRepository.appendRun(commandAccess, { ...concurrentExternalAppend, requestHash: 'different-request' }),
    (error: unknown) => error instanceof ExternalApiError && error.code === 'IDEMPOTENCY_CONFLICT',
  );

  const activeExternalRunId = appendResults[0].response.runId;
  const nextStepArtifactId = newArtifactId();
  await externalRepository.createArtifact(commandAccess, {
    ...artifactInput,
    requestHash: `artifact-next-step-hash-${suffix}`,
    idempotencyKey: 'artifact-next-step',
    artifactId: nextStepArtifactId,
    storageKey: `${commandCaller.caller.id}/${nextStepArtifactId}`,
    source: { externalEventId: `artifact-next-step-event-${suffix}`, metadata: {} },
  });
  const sameNextStep = {
    requestHash: `next-step-same-hash-${suffix}`,
    idempotencyKey: 'next-step-same',
    threadId: externalCreated.response.threadId,
    input: '同键并发注入',
    artifactIds: [nextStepArtifactId],
    source: { externalEventId: `next-step-same-event-${suffix}`, metadata: {} },
  };
  const sameNextStepResults = await Promise.all([
    externalRepository.appendNextStep(commandAccess, sameNextStep),
    externalRepository.appendNextStep(commandAccess, sameNextStep),
  ]);
  assert.equal(sameNextStepResults[0].response.inputId, sameNextStepResults[1].response.inputId);
  assert.equal(sameNextStepResults.filter((item) => item.replayed).length, 1);
  const storedNextStep = await prisma.run_inputs.findUnique({ where: { id: sameNextStepResults[0].response.inputId } });
  assert.deepEqual(storedNextStep?.artifacts, [nextStepArtifactId]);
  assert.equal(storedNextStep?.content, '同键并发注入');

  const distinctNextStepResults = await Promise.all([
    externalRepository.appendNextStep(commandAccess, {
      ...sameNextStep,
      artifactIds: [],
      idempotencyKey: 'next-step-a',
      requestHash: `next-step-a-hash-${suffix}`,
      input: '不同键注入 A',
      source: { externalEventId: `next-step-a-event-${suffix}`, metadata: {} },
    }),
    externalRepository.appendNextStep(commandAccess, {
      ...sameNextStep,
      artifactIds: [],
      idempotencyKey: 'next-step-b',
      requestHash: `next-step-b-hash-${suffix}`,
      input: '不同键注入 B',
      source: { externalEventId: `next-step-b-event-${suffix}`, metadata: {} },
    }),
  ]);
  assert.deepEqual(
    [sameNextStepResults[0], ...distinctNextStepResults].map((item) => item.response.version).sort((a, b) => a - b),
    [1, 2, 3],
  );
  const appliedNextSteps = await store.applyPendingRunInputs(externalScope, activeExternalRunId);
  assert.deepEqual(appliedNextSteps.map((input) => input.version), [1, 2, 3]);
  assert.match(appliedNextSteps[0]?.content ?? '', new RegExp(nextStepArtifactId));
  assert.equal(await prisma.run_inputs.count({ where: { run_id: activeExternalRunId, status: 'applied' } }), 3);

  // append 与正常终态收口竞争同一 run 行：追加若成功，收口事务必须同时应用它；
  // 否则追加只能得到 RUN_INPUT_CLOSED，不能出现成功回执对应 pending 输入被遗漏。
  const [closedRace, appendedRace] = await Promise.allSettled([
    store.closeExternalInputAndApplyPending(externalScope, activeExternalRunId),
    externalRepository.appendNextStep(commandAccess, {
      ...sameNextStep,
      artifactIds: [],
      idempotencyKey: 'next-step-race',
      requestHash: `next-step-race-hash-${suffix}`,
      input: '终态竞争注入',
      source: { externalEventId: `next-step-race-event-${suffix}`, metadata: {} },
    }),
  ]);
  assert.equal(closedRace.status, 'fulfilled');
  if (closedRace.status === 'fulfilled') assert.equal(closedRace.value.closed, true);
  if (appendedRace.status === 'fulfilled') {
    assert.equal(
      closedRace.status === 'fulfilled'
        && closedRace.value.inputs.some((input) => input.inputId === appendedRace.value.response.inputId),
      true,
    );
  } else {
    assert.equal(appendedRace.reason instanceof ExternalApiError && appendedRace.reason.code === 'RUN_INPUT_CLOSED', true);
  }

  // 模拟进程重启：beginRunExecution 根据 run 配置副本重新打开接纳，新 Store 实例仍能
  // 从数据库应用已确认的 pending 输入。
  assert.equal(await store.beginRunExecution(externalScope, activeExternalRunId), true);
  const restartPending = await externalRepository.appendNextStep(commandAccess, {
    ...sameNextStep,
    artifactIds: [],
    idempotencyKey: 'next-step-restart',
    requestHash: `next-step-restart-hash-${suffix}`,
    input: '重启后注入',
    source: { externalEventId: `next-step-restart-event-${suffix}`, metadata: {} },
  });
  const restartedStore = new PgStore();
  assert.equal(
    (await restartedStore.applyPendingRunInputs(externalScope, activeExternalRunId))[0]?.inputId,
    restartPending.response.inputId,
  );

  const cancelPending = await externalRepository.appendNextStep(commandAccess, {
    ...sameNextStep,
    artifactIds: [],
    idempotencyKey: 'next-step-cancel',
    requestHash: `next-step-cancel-hash-${suffix}`,
    input: '取消前注入',
    source: { externalEventId: `next-step-cancel-event-${suffix}`, metadata: {} },
  });
  const externalCanceled = await externalRepository.cancelRun(commandAccess, {
    requestHash: `cancel-hash-${suffix}`,
    idempotencyKey: 'cancel-1',
    runId: activeExternalRunId,
    source: { externalEventId: `cancel-event-${suffix}`, metadata: {} },
  });
  assert.equal(externalCanceled?.response.status, 'canceling');
  assert.equal((await prisma.run_inputs.findUnique({ where: { id: cancelPending.response.inputId } }))?.status, 'canceled');
  assert.notEqual((await prisma.run_inputs.findUnique({ where: { id: cancelPending.response.inputId } }))?.canceled_at, null);
  await store.setRunStatus(externalScope, activeExternalRunId, 'canceled');

  const rotatedTokenValue = randomUUID();
  const rotatedToken = await externalRepository.issueToken({
    tenantId,
    spaceId: externalSpace.id,
    callerId: commandCaller.caller.id,
    tokenHash: hashOpaqueToken(rotatedTokenValue),
    label: 'rotated',
    expiresAt: null,
  });
  assert.ok(rotatedToken);
  await externalRepository.revokeToken(tenantId, externalSpace.id, commandCaller.caller.id, rotatedToken.id);
  assert.equal(await externalRepository.authenticateToken(hashOpaqueToken(rotatedTokenValue)), null);

  const guardedWebSpace = await spaceAccess.create(ownerIdentity, {
    mode: 'web',
    name: 'Prisma 权限兜底空间',
    visibleUserIds: [visibleMember.id],
  });
  const memberScope = { tenantId, userId: visibleMember.id };
  const guardedThread = await store.createThread(memberScope, 'Prisma 权限兜底会话', {
    spaceId: guardedWebSpace.id,
  });
  await spaceAccess.update(ownerIdentity, guardedWebSpace.id, { visibleUserIds: [] });
  await assert.rejects(
    store.createThread(memberScope, '不可创建', { spaceId: guardedWebSpace.id }),
    /不可写|不允许创建/,
  );
  await assert.rejects(store.createRun(memberScope, guardedThread.id, '不可追加'), /不可写/);

  const thread = await store.createThread(scope, 'Prisma 验证会话');
  assert.equal(thread.space_id, defaultSpace.id);
  assert.equal(await store.getThread({ tenantId, userId: 'user_other' }, thread.id), null);
  assert.equal((await store.listThreads(scope)).some((item) => item.id === thread.id), true);

  const run = await runAdmission.createWebRun(scope, thread, { input: '验证输入' });
  assert.ok(run.model_ref);
  assert.equal((run.space_config_snapshot as { spaceId?: string } | null)?.spaceId, defaultSpace.id);
  assert.equal(JSON.stringify(run.runtime_capabilities_snapshot).includes('apiKey'), false);
  assert.equal((await store.getThread(scope, thread.id))?.active_run_id, run.id);
  assert.equal((await store.getThreadUnscoped(thread.id))?.id, thread.id);
  assert.equal((await store.getRunUnscoped(run.id))?.id, run.id);
  assert.equal((await store.listRuns(scope, thread.id)).length, 1);
  assert.equal((await store.listRunsByStatusUnscoped(['pending'])).some((item) => item.id === run.id), true);
  assert.equal((await store.getThread(scope, thread.id))?.executing_run_id, run.id);
  assert.equal(await store.beginRunExecution(scope, run.id), true);
  assert.equal((await store.getRun(scope, run.id))?.status, 'running');
  await store.setGoalState(scope, run.id, {
    intent: '验证 Prisma Store',
    plan: [],
    decisions: [],
    next: '完成真实库验收',
    phase: 'working',
  });
  assert.equal((await store.getRun(scope, run.id))?.goal_state?.intent, '验证 Prisma Store');
  const step = await store.createStep(scope, run.id, 1);
  const verificationProvider: Provider = {
    name: 'prisma-verification',
    async complete(_messages, _tools, options) {
      const response = await options!.fetch!('https://provider.verify/v1/chat?api_key=verification-query-secret', {
        method: 'POST',
        headers: { Authorization: 'Bearer verification-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'verification-model', input: 'provider persistence' }),
      });
      const data = await response.json() as { id: string; output: string };
      return {
        content: data.output,
        toolCalls: [],
        usage: { inputTokens: 4, outputTokens: 2 },
        finishReason: 'stop',
        rawFinishReason: 'stop',
      };
    },
  };
  const providerResult = await new ProviderRunner(
    new PrismaProviderObservationRepository(),
    null,
    async () => {},
    () => 0,
    async () => new Response(JSON.stringify({ id: 'resp_prisma_verify', output: 'observed' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  ).run({
    provider: verificationProvider,
    context: {
      tenantId,
      spaceId: thread.space_id,
      threadId: thread.id,
      runId: run.id,
      stepId: step.id,
      purpose: 'agent',
      provider: verificationProvider.name,
      model: 'verification-model',
      retries: 0,
    },
    messages: [{ role: 'user', content: 'provider persistence' }],
    tools: [],
  });
  assert.equal(providerResult.content, 'observed');
  const providerInvocation = await prisma.provider_invocations.findFirst({
    where: { run_id: run.id },
    include: { provider_attempts: true },
  });
  assert.equal(providerInvocation?.status, 'success');
  assert.equal(providerInvocation?.provider_attempts.length, 1);
  assert.equal(providerInvocation?.provider_attempts[0].provider_response_id, 'resp_prisma_verify');
  assert.equal(providerInvocation?.provider_attempts[0].url.includes('verification-query-secret'), false);
  assert.equal(new URL(providerInvocation!.provider_attempts[0].url).searchParams.get('api_key'), '[REDACTED]');
  assert.equal(JSON.stringify(providerInvocation).includes('verification-secret'), false);
  await store.addMessage(scope, thread.id, run.id, null, { role: 'user', content: '验证输入' });
  await store.addMessage(scope, thread.id, run.id, step.id, {
    role: 'assistant',
    content: null,
    toolCalls: [{ id: 'call_verify', name: 'verify_tool', arguments: '{"ok":true}' }],
  });
  const toolMessageId = await store.addMessage(scope, thread.id, run.id, step.id, {
    role: 'tool',
    content: toolResult,
    toolCallId: 'call_verify',
  });
  await store.addEvent(scope, run.id, step.id, { type: 'step_start', step: 1 });

  assert.equal(await store.getLastStepIndex(scope, run.id), 1);
  assert.equal(await store.getLastCompletedStepIndex(scope, run.id), 1);
  assert.equal(await store.countRunMessages(scope, run.id), 3);
  assert.equal((await store.getEvents(scope, run.id))[0]?.type, 'step_start');
  const persistedEvents = await store.getEventsAfterCursor(scope, run.id, 0);
  assert.equal(persistedEvents[0]?.event.type, 'step_start');
  assert.deepEqual(await store.getEventsAfterCursor(scope, run.id, persistedEvents[0].cursor), []);
  assert.equal((await store.searchThreadMessages(scope, '验证输入')).length, 1);

  await store.addThreadNotice(scope, {
    threadId: thread.id,
    kind: 'verification',
    message: 'Prisma notice 验证',
  });
  assert.equal((await store.listThreadNotices(scope, thread.id))[0]?.kind, 'verification');

  await store.markMessagesCollapsed(scope, [toolMessageId], 'masked');
  assert.equal((await store.loadThreadMessageMetadata(scope, thread.id)).length, 1);
  assert.match((await store.loadThreadMessages(scope, thread.id)).at(-1)?.content ?? '', /chars elided/);
  assert.equal((await store.loadRawThreadMessages(scope, thread.id)).at(-1)?.content, toolResult);

  await store.setRuntimeCapabilitiesSnapshot(scope, run.id, { allowedCapabilities: ['llm', 'image'] });
  assert.deepEqual((await store.getRun(scope, run.id))?.runtime_capabilities_snapshot, {
    allowedCapabilities: ['llm', 'image'],
  });
  assert.equal((await store.updateThread(scope, thread.id, { pinned: true }))?.pinned_at != null, true);

  const concurrentThread = await store.createThread(scope, 'Prisma 并发验证');
  const concurrent = await Promise.allSettled([
    store.createRun(scope, concurrentThread.id, '并发输入 A'),
    store.createRun(scope, concurrentThread.id, '并发输入 B'),
  ]);
  const accepted = concurrent.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof store.createRun>>> => result.status === 'fulfilled');
  const rejected = concurrent.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(accepted.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof RunActiveError);
  assert.equal(rejected[0].reason.currentRunId, accepted[0].value.id);
  await store.setRunStatus(scope, accepted[0].value.id, 'done');
  assert.equal((await store.getThread(scope, concurrentThread.id))?.executing_run_id, null);

  await upsertSettings(tenantId, [{ key: 'prisma.verify', value: { ok: true } }]);
  assert.deepEqual(await findSetting(tenantId, 'prisma.verify'), { ok: true });

  const token = await store.createAuthToken({
    tenantId,
    userId: user.id,
    kind: 'api',
    tokenHash: `hash-${suffix}`,
    label: 'Prisma 验证',
  });
  assert.equal((await store.findAuthTokenByHash(token.token_hash))?.id, token.id);
  assert.equal((await store.listApiTokensByTenant(tenantId))[0]?.id, token.id);
  await store.revokeAuthToken(token.id);
  assert.equal((await store.findAuthTokenByHash(token.token_hash))?.revoked_at != null, true);

  const admin = await store.createSystemAdmin({ email: systemAdminEmail, passwordHash: 'verification-only' });
  assert.equal((await store.findSystemAdminByEmail(systemAdminEmail))?.id, admin.id);
  assert.equal((await store.findSystemAdminById(admin.id))?.id, admin.id);
  assert.equal((await store.listSystemAdmins()).some((item) => item.id === admin.id), true);
  const adminToken = await store.createSystemAdminToken({
    systemAdminId: admin.id,
    tokenHash: `system-hash-${suffix}`,
  });
  assert.equal((await store.findSystemAdminTokenByHash(adminToken.token_hash))?.system_admin_id, admin.id);
  await store.revokeSystemAdminToken(adminToken.id);
  assert.equal((await store.findSystemAdminTokenByHash(adminToken.token_hash))?.revoked_at != null, true);

  console.log(JSON.stringify({
    ok: true,
    tenantId: tenant.id,
    threadId: thread.id,
    runId: run.id,
    messageCount: await store.countRunMessages(scope, run.id),
    providerAttemptCount: await prisma.provider_attempts.count({ where: { invocation_id: providerInvocation!.id } }),
  }));
} finally {
  await rm(artifactVerificationRoot, { recursive: true, force: true });
  await prisma.app_settings.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.threads.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.auth_tokens.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.tenants.updateMany({ where: { id: tenantId }, data: { default_space_id: null } });
  await prisma.spaces.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.users.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.tenants.deleteMany({ where: { id: tenantId } });
  await prisma.app_settings.deleteMany({ where: { tenant_id: otherTenantId } });
  await prisma.tenants.updateMany({ where: { id: otherTenantId }, data: { default_space_id: null } });
  await prisma.spaces.deleteMany({ where: { tenant_id: otherTenantId } });
  await prisma.users.deleteMany({ where: { tenant_id: otherTenantId } });
  await prisma.tenants.deleteMany({ where: { id: otherTenantId } });
  await prisma.system_admins.deleteMany({ where: { email: systemAdminEmail } });
  await prisma.$disconnect();
  await pool.end();
}
