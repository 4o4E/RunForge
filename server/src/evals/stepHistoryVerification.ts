import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { prisma } from '../db/prisma.js';
import { tenantSettingsTemplateEntries } from '../settings.js';
import { PgStore } from '../store/pgStore.js';
import type { Scope, StepAggregate } from '../store/types.js';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const tenantId = `step-history-${suffix}`;
const otherTenantId = `step-history-other-${suffix}`;
const store = new PgStore();

try {
  const { owner } = await store.createTenantWithOwner({
    id: tenantId,
    name: 'Step 历史集成验证租户',
    ownerEmail: `owner-${suffix}@step-history.test`,
    ownerPasswordHash: 'verification-only',
    settingsTemplate: tenantSettingsTemplateEntries(),
  });
  const scope: Scope = { tenantId, userId: owner.id };
  const thread = await store.createThread(scope, 'Step 历史集成验证');
  const ancestor = await store.createRun(scope, thread.id, '祖先 run 输入');
  const step = await store.createStep(scope, ancestor.id, 1);
  const observationOnly = 'REQUEST_SNAPSHOT_MUST_NOT_ENTER_CONTEXT';
  await store.saveStepContext(scope, step.id, {
    messages: [{ role: 'user', content: observationOnly }],
    tools: [],
    stream: true,
    capturedAt: new Date().toISOString(),
  });
  const aggregate: StepAggregate = {
    reasoning: 'step reasoning',
    output: '权威 step 正文',
    toolCalls: [
      { id: `call-finished-${suffix}`, name: 'file_read', arguments: '{}' },
      { id: `call-interrupted-${suffix}`, name: 'file_write', arguments: '{}' },
    ],
    providerState: { textProviderOptions: { fixture: { state: 'opaque-provider-state' } } },
    usage: { inputTokens: 11, outputTokens: 7 },
    streamStats: null,
    finishReason: 'tool-calls',
    rawFinishReason: 'tool_calls',
    startedAt: '2026-09-30T00:00:00.000Z',
    reasoningStartedAt: null,
    endedAt: '2026-09-30T00:00:01.000Z',
    durationMs: 1000,
  };
  const assistantMessageId = await store.saveStepResult(scope, step.id, aggregate);
  const completedCallId = aggregate.toolCalls[0]!.id;
  const interruptedCallId = aggregate.toolCalls[1]!.id;
  const completedToolContent = '已完成工具结果'.repeat(80);
  const completedToolMessageId = await store.addMessage(scope, thread.id, ancestor.id, step.id, {
    role: 'tool', content: completedToolContent, toolCallId: completedCallId,
  });
  await store.markMessagesCollapsed(scope, [completedToolMessageId], 'masked');
  await store.setRunRuntimeState(scope, ancestor.id, {
    skillIds: ['skill-history-check'],
    mcpServerIds: ['mcp-history-check'],
    rejectedImageModels: ['image-history-check'],
    lastAppliedExternalInputVersion: 4,
  });
  await store.setRunStatus(scope, ancestor.id, 'error', { error: '工具执行期间中断' });

  const child = await store.createRun(scope, thread.id, '后代 run 输入');
  const childUserId = await store.addMessage(scope, thread.id, child.id, null, { role: 'user', content: child.input });
  await store.recordInterruptedToolResult(
    scope,
    assistantMessageId,
    interruptedCallId,
    '工具执行中断，未执行成功。',
  );

  const stepAfterRecovery = (await store.getHistorySteps(scope, ancestor.id)).find((row) => row.id === step.id);
  assert.equal(stepAfterRecovery?.assistantMessageId, assistantMessageId);
  assert.deepEqual(stepAfterRecovery?.tool_results.map((item) => item.toolCallId).sort(), [completedCallId, interruptedCallId].sort());
  assert.equal(stepAfterRecovery?.result?.output, aggregate.output);
  const modelContext = await store.loadThreadMessages(scope, thread.id, { runId: child.id });
  assert.equal(modelContext.some((message) => message.content?.includes(observationOnly)), false);
  assert.equal(modelContext.some((message) => message.role === 'assistant' && message.content === aggregate.output), true);
  const assistantPosition = modelContext.findIndex((message) => message.role === 'assistant' && message.toolCalls?.some((call) => call.id === interruptedCallId));
  const interruptedResultPosition = modelContext.findIndex((message) => message.role === 'tool' && message.toolCallId === interruptedCallId);
  const childUserPosition = modelContext.findIndex((message) => message.role === 'user' && message.content === child.input);
  assert.ok(assistantPosition >= 0 && interruptedResultPosition > assistantPosition && childUserPosition > interruptedResultPosition);

  const persistedIndexes = await prisma.messages.findMany({
    where: { run_id: ancestor.id, step_id: step.id, role: { in: ['assistant', 'tool'] } },
    select: { role: true, content: true, tool_calls: true, provider_state: true, media_refs: true },
  });
  assert.equal(persistedIndexes.length, 3);
  assert.equal(persistedIndexes.every((message) => message.content === null && message.tool_calls === null && message.provider_state === null && message.media_refs === null), true);

  const { owner: otherOwner } = await store.createTenantWithOwner({
    id: otherTenantId,
    name: '隔离验证租户',
    ownerEmail: `other-${suffix}@step-history.test`,
    ownerPasswordHash: 'verification-only',
    settingsTemplate: tenantSettingsTemplateEntries(),
  });
  await assert.rejects(store.recordInterruptedToolResult(
    { tenantId: otherTenantId, userId: otherOwner.id },
    assistantMessageId,
    interruptedCallId,
    '不得跨租户写入',
  ));
  assert.equal((await store.getHistorySteps(scope, ancestor.id)).find((row) => row.id === step.id)?.tool_results.length, 2);

  await store.setRunStatus(scope, child.id, 'done', { output: '后代 run 完成' });
  const fork = await store.forkThreadAtRun(scope, child.id);
  assert.ok(fork);
  assert.equal(typeof fork.activeRun.created_at, 'string');
  assert.equal(Number.isFinite(Date.parse(fork.activeRun.created_at)), true);
  const forkedAncestorId = fork.activeRun.parent_run_id;
  assert.ok(forkedAncestorId);
  const forkedAncestor = await store.getRun(scope, forkedAncestorId);
  assert.deepEqual(forkedAncestor?.runtime_state, {
    skillIds: ['skill-history-check'],
    mcpServerIds: ['mcp-history-check'],
    rejectedImageModels: ['image-history-check'],
    lastAppliedExternalInputVersion: 4,
  });
  const forkedCollapsed = Object.keys(forkedAncestor?.metadata.context?.collapsed ?? {});
  assert.equal(forkedCollapsed.length, 1);
  assert.notEqual(forkedCollapsed[0], String(completedToolMessageId));
  const forkContext = await store.loadThreadMessages(scope, fork.thread.id, { runId: fork.activeRun.id });
  const forkedTool = forkContext.find((message) => message.role === 'tool' && message.toolCallId === completedCallId);
  assert.ok(forkedTool);
  assert.notEqual(forkedTool.content, completedToolContent);
  assert.match(forkedTool.content ?? '', /chars elided/u);
  assert.equal((await store.loadThreadMessages({ tenantId, userId: `not-${owner.id}` }, fork.thread.id, { runId: fork.activeRun.id })).length, 0);

  console.log(JSON.stringify({ ok: true, checks: [
    'step 聚合正文和协议状态为模型上下文来源',
    'context_snapshot 不进入模型上下文',
    '祖先 run 中断工具结果回写原 step 并排在调用与后代用户消息之间',
    'assistant/tool 索引不重复保存正文',
    '中断结果写入遵守租户隔离',
    'fork 返回日期字符串并保留 run 元数据与重映射压缩状态',
  ] }));
} finally {
  await prisma.threads.deleteMany({ where: { tenant_id: { in: [tenantId, otherTenantId] } } });
  await prisma.tenants.updateMany({ where: { id: { in: [tenantId, otherTenantId] } }, data: { default_space_id: null } });
  await prisma.spaces.deleteMany({ where: { tenant_id: { in: [tenantId, otherTenantId] } } });
  await prisma.users.deleteMany({ where: { tenant_id: { in: [tenantId, otherTenantId] } } });
  await prisma.tenants.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
  await prisma.$disconnect();
  await pool.end();
}
