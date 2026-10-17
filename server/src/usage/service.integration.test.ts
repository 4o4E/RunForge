import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { prisma } from '../db/prisma.js';
import { aggregateUsage } from './service.js';

after(async () => {
  await prisma.$disconnect();
  await pool.end();
});

// 显式传入隔离数据库的 DATABASE_URL，再通过 tsx --test 单独运行；不接入内存单元测试脚本。
test('task token aggregation counts each initiated run and includes its subagent and retry attempts', async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const tenantId = `usage-tenant-${suffix}`;
  const otherTenantId = `usage-other-tenant-${suffix}`;
  const user = { id: `usage-owner-${suffix}` };
  const visibleMember = { id: `usage-member-${suffix}` };
  const defaultSpace = { id: `usage-space-${suffix}` };
  const otherSpace = { id: `usage-other-space-${suffix}` };
  const otherTenant = {
    owner: { id: `usage-other-owner-${suffix}` },
    defaultSpace: { id: `usage-other-tenant-space-${suffix}` },
  };
  const tenantIds = [tenantId, otherTenantId];
  try {
    await prisma.tenants.createMany({ data: tenantIds.map((id) => ({ id, name: '任务用量回归租户' })) });
    await prisma.users.createMany({
      data: [
        { id: user.id, tenant_id: tenantId },
        { id: visibleMember.id, tenant_id: tenantId },
        { id: otherTenant.owner.id, tenant_id: otherTenantId },
      ].map((item) => ({ ...item, email: `${item.id}@usage.test`, password_hash: 'integration-test-only' })),
    });
    await prisma.spaces.createMany({
      data: [
        { id: defaultSpace.id, tenant_id: tenantId },
        { id: otherSpace.id, tenant_id: tenantId },
        { id: otherTenant.defaultSpace.id, tenant_id: otherTenantId },
      ].map((item) => ({ ...item, mode: 'web', name: '任务用量回归空间' })),
    });

    // 续聊按各自发起日分别计数；子 Agent 和压缩调用使用所属运行，不增加任务数量。
    const usageId = (name: string) => `usage-${name}-${suffix}`;
    const from = new Date('2025-03-01T00:00:00+08:00');
    const to = new Date('2025-03-03T00:00:00+08:00');
    const usageThreads = [
      { name: 'primary', tenant: tenantId, user: user.id, space: defaultSpace.id },
      { name: 'other-user', tenant: tenantId, user: visibleMember.id, space: defaultSpace.id },
      { name: 'other-space', tenant: tenantId, user: user.id, space: otherSpace.id },
      { name: 'fork-history', tenant: tenantId, user: user.id, space: defaultSpace.id },
      { name: 'other-tenant', tenant: otherTenantId, user: otherTenant.owner.id, space: otherTenant.defaultSpace.id },
    ];
    await prisma.threads.createMany({
      data: usageThreads.map((item) => ({
        id: usageId(`thread-${item.name}`),
        tenant_id: item.tenant,
        user_id: item.user,
        space_id: item.space,
        source_type: 'web',
        created_at: new Date(item.name === 'fork-history' ? '2025-03-02T05:00:00+08:00' : '2025-02-28T00:00:00+08:00'),
      })),
    });
    try {
      const usageRuns = [
        { name: 'first', thread: 'primary', status: 'done', at: '2025-03-01T00:30:00+08:00' },
        { name: 'cancelled', thread: 'primary', status: 'canceled', at: '2025-03-01T02:00:00+08:00' },
        { name: 'missing', thread: 'primary', status: 'error', at: '2025-03-01T03:00:00+08:00' },
        { name: 'running', thread: 'primary', status: 'running', at: '2025-03-02T01:00:00+08:00' },
        { name: 'old', thread: 'primary', status: 'done', at: '2025-02-28T23:59:59+08:00' },
        { name: 'at-cutoff', thread: 'primary', status: 'pending', at: to.toISOString() },
        { name: 'followup', thread: 'primary', status: 'done', at: '2025-03-02T02:00:00+08:00', parent: 'first' },
        { name: 'later-followup', thread: 'primary', status: 'error', at: '2025-03-02T03:00:00+08:00', parent: 'followup' },
        // 分支只复制历史检查点，保留的旧时间早于新会话创建，不是新发起的任务。
        { name: 'copied-history', thread: 'fork-history', status: 'done', at: '2025-03-01T00:30:00+08:00' },
        { name: 'other-user', thread: 'other-user', status: 'done', at: '2025-03-01T01:00:00+08:00' },
        { name: 'other-space', thread: 'other-space', status: 'done', at: '2025-03-01T01:00:00+08:00' },
        { name: 'other-tenant', thread: 'other-tenant', status: 'done', at: '2025-03-01T01:00:00+08:00' },
      ];
      await prisma.runs.createMany({
        data: usageRuns.map((item) => ({
          id: usageId(`run-${item.name}`),
          thread_id: usageId(`thread-${item.thread}`),
          input: '每日发起任务 Token 统计验证',
          status: item.status,
          created_at: new Date(item.at),
          parent_run_id: item.parent ? usageId(`run-${item.parent}`) : null,
        })),
      });
      const observedCalls = [
        ...usageRuns.filter((item) => !['cancelled', 'at-cutoff', 'copied-history'].includes(item.name))
          .map((item) => ({ ...item, run: item.name, purpose: 'agent' })),
        { name: 'subagent', run: 'first', thread: 'primary', purpose: 'subagent', at: '2025-03-02T04:00:00+08:00' },
        { name: 'compaction', run: 'first', thread: 'primary', purpose: 'compaction', at: '2025-03-02T04:30:00+08:00' },
      ];
      await prisma.provider_invocations.createMany({
        data: observedCalls.map((item) => {
          const owner = usageThreads.find((candidate) => candidate.name === item.thread)!;
          return {
            id: usageId(`invocation-${item.name}`),
            tenant_id: owner.tenant,
            space_id: owner.space,
            thread_id: usageId(`thread-${item.thread}`),
            run_id: usageId(`run-${item.run}`),
            purpose: item.purpose,
            provider: 'usage-regression',
            model: 'usage-regression',
            logical_request: {},
            started_at: new Date(item.at),
          };
        }),
      });
      const attempts = [
        { run: 'first', attempt: 1, status: 'error', at: '2025-03-01T00:31:00+08:00', usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 } },
        { run: 'first', attempt: 2, status: 'success', at: '2025-03-01T00:32:00+08:00', usage: { inputTokens: 50, outputTokens: 10, cachedInputTokens: 10 } },
        { run: 'first', attempt: 3, status: 'success', at: to.toISOString(), usage: { inputTokens: 999 } },
        { run: 'followup', attempt: 1, status: 'success', at: '2025-03-02T02:01:00+08:00', usage: { inputTokens: 25, outputTokens: 5, cachedInputTokens: 5 } },
        { run: 'later-followup', attempt: 1, status: 'error', at: '2025-03-02T03:01:00+08:00', usage: { outputTokens: 10 } },
        { run: 'subagent', attempt: 1, status: 'success', at: '2025-03-02T04:01:00+08:00', usage: { inputTokens: 40, outputTokens: 10, cachedInputTokens: 20 } },
        { run: 'compaction', attempt: 1, status: 'success', at: '2025-03-02T04:31:00+08:00', usage: { inputTokens: 20, outputTokens: 5, cachedInputTokens: 10 } },
        { run: 'missing', attempt: 1, status: 'error', at: '2025-03-01T03:01:00+08:00' },
        { run: 'running', attempt: 1, status: 'running', at: '2025-03-02T01:01:00+08:00', usage: { inputTokens: 60, cachedInputTokens: 30 } },
        { run: 'old', attempt: 1, status: 'success', at: '2025-03-01T01:00:00+08:00', usage: { inputTokens: 900 } },
        { run: 'other-user', attempt: 1, status: 'success', at: '2025-03-01T01:01:00+08:00', usage: { inputTokens: 400 } },
        { run: 'other-space', attempt: 1, status: 'success', at: '2025-03-01T01:01:00+08:00', usage: { inputTokens: 800 } },
        { run: 'other-tenant', attempt: 1, status: 'success', at: '2025-03-01T01:01:00+08:00', usage: { inputTokens: 1600 } },
      ];
      await prisma.provider_attempts.createMany({
        data: attempts.map((item) => ({
          id: usageId(`attempt-${item.run}-${item.attempt}`),
          invocation_id: usageId(`invocation-${item.run}`),
          attempt: item.attempt,
          url: 'https://usage-regression.invalid',
          request_body: {},
          status: item.status,
          started_at: new Date(item.at),
          ...(item.usage ? { usage: item.usage } : {}),
        })),
      });
      const usageFilter = {
        tenantId, userId: user.id, spaceId: defaultSpace.id,
        availableTenantId: tenantId, availableUserId: user.id,
        availableSpaceIds: [defaultSpace.id], from, to,
      };
      const usage = await aggregateUsage(usageFilter);
      assert.deepEqual(usage.tasks.totals, {
        taskCount: 6, inputTokens: 295, outputTokens: 60, cachedInputTokens: 115,
        totalTokens: 355, averageTokens: 355 / 6, maxTokens: 255, minTokens: 0, cacheRate: 115 / 295,
      });
      assert.deepEqual(usage.tasks.daily, [
        {
          date: '2025-03-01', taskCount: 3, inputTokens: 210, outputTokens: 45, cachedInputTokens: 80,
          totalTokens: 255, averageTokens: 85, maxTokens: 255, minTokens: 0, cacheRate: 80 / 210,
        },
        {
          date: '2025-03-02', taskCount: 3, inputTokens: 85, outputTokens: 15, cachedInputTokens: 35,
          totalTokens: 100, averageTokens: 100 / 3, maxTokens: 60, minTokens: 10, cacheRate: 35 / 85,
        },
      ]);
      assert.equal(usage.tokens.totals.attemptedTokens, 1255);
      assert.deepEqual(usage.tokens.daily.map((point) => [point.date, point.attemptedTokens]), [
        ['2025-03-01', 1080], ['2025-03-02', 175],
      ]);
      assert.equal(usage.tokens.totals.attemptsWithoutUsage, 1);
      const laterCohort = await aggregateUsage({ ...usageFilter, from: new Date('2025-03-02T00:00:00+08:00') });
      assert.equal(laterCohort.tasks.totals.taskCount, 3);
      assert.equal(laterCohort.tasks.totals.totalTokens, 100);
      assert.equal(laterCohort.tokens.totals.attemptedTokens, 175);
      const earlyCutoff = await aggregateUsage({ ...usageFilter, to: new Date('2025-03-02T00:00:00+08:00') });
      assert.equal(earlyCutoff.tasks.totals.taskCount, 3);
      assert.equal(earlyCutoff.tasks.totals.totalTokens, 180);
      const zeroUsage = await aggregateUsage({
        ...usageFilter, from: new Date('2025-03-01T02:00:00+08:00'), to: new Date('2025-03-01T04:00:00+08:00'),
      });
      const emptyTotals = {
        taskCount: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0,
        totalTokens: 0, averageTokens: 0, maxTokens: 0, minTokens: 0, cacheRate: null,
      };
      assert.deepEqual(zeroUsage.tasks.totals, { ...emptyTotals, taskCount: 2 });
      const hiddenUsage = await aggregateUsage({ ...usageFilter, availableSpaceIds: [] });
      assert.deepEqual(hiddenUsage.tasks, { totals: emptyTotals, daily: [] });
      const tenantUsage = await aggregateUsage({ ...usageFilter, userId: null, spaceId: null });
      assert.equal(tenantUsage.tasks.totals.taskCount, 7);
      assert.equal(tenantUsage.tasks.totals.totalTokens, 755);
      const allSpacesUsage = await aggregateUsage({ ...usageFilter, spaceId: null, availableSpaceIds: null });
      assert.equal(allSpacesUsage.tasks.totals.taskCount, 7);
      assert.equal(allSpacesUsage.tasks.totals.totalTokens, 1155);
      const tenantAllUsage = await aggregateUsage({ from, to, tenantId });
      assert.equal(tenantAllUsage.tasks.totals.taskCount, 8);
      assert.equal(tenantAllUsage.tasks.totals.totalTokens, 1555);
      const spaceOnlyUsage = await aggregateUsage({ from, to, tenantId, spaceId: defaultSpace.id });
      assert.equal(spaceOnlyUsage.tasks.totals.taskCount, 7);
      assert.equal(spaceOnlyUsage.tasks.totals.totalTokens, 755);
      const otherUsage = await aggregateUsage({ from, to, tenantId: otherTenantId, spaceId: otherTenant.defaultSpace.id });
      assert.equal(otherUsage.tasks.totals.taskCount, 1);
      assert.equal(otherUsage.tasks.totals.totalTokens, 1600);
    } finally {
      await prisma.threads.deleteMany({ where: { id: { in: usageThreads.map((item) => usageId(`thread-${item.name}`)) } } });
    }
  } finally {
    await prisma.spaces.deleteMany({ where: { tenant_id: { in: tenantIds } } });
    await prisma.users.deleteMany({ where: { tenant_id: { in: tenantIds } } });
    await prisma.tenants.deleteMany({ where: { id: { in: tenantIds } } });
  }
});
