import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool } from '../db/pool.js';
import { prisma } from '../db/prisma.js';
import { PgStore } from '../store/pgStore.js';
import { findSetting, upsertSettings } from '../store/settingsRepository.js';

const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const tenantId = `prisma-verify-${suffix}`;
const systemAdminEmail = `prisma-verify-${suffix}@system.test`;
const toolResult = `验证工具结果：${'原始内容'.repeat(60)}`;
const store = new PgStore();

try {
  const tenant = await store.createTenant({ id: tenantId, name: 'Prisma 验证租户' });
  const user = await store.createUser({
    tenantId,
    email: `owner-${suffix}@tenant.test`,
    passwordHash: 'verification-only',
    role: 'owner',
  });
  const scope = { tenantId, userId: user.id };

  assert.equal((await store.findTenant(tenantId))?.id, tenant.id);
  assert.equal((await store.listTenants()).some((item) => item.id === tenant.id), true);
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

  const thread = await store.createThread(scope, 'Prisma 验证会话');
  assert.equal(await store.getThread({ tenantId, userId: 'user_other' }, thread.id), null);
  assert.equal((await store.listThreads(scope)).some((item) => item.id === thread.id), true);

  const run = await store.createRun(scope, thread.id, '验证输入', {
    modelRef: 'verify:model',
    runtimeCapabilitiesSnapshot: { allowedCapabilities: ['llm'] },
  });
  assert.equal((await store.getThread(scope, thread.id))?.active_run_id, run.id);
  assert.equal((await store.getThreadUnscoped(thread.id))?.id, thread.id);
  assert.equal((await store.getRunUnscoped(run.id))?.id, run.id);
  assert.equal((await store.listRuns(scope, thread.id)).length, 1);
  assert.equal((await store.listRunsByStatusUnscoped(['pending'])).some((item) => item.id === run.id), true);
  await store.setGoalState(scope, run.id, {
    intent: '验证 Prisma Store',
    plan: [],
    decisions: [],
    next: '完成真实库验收',
    phase: 'working',
  });
  assert.equal((await store.getRun(scope, run.id))?.goal_state?.intent, '验证 Prisma Store');
  const step = await store.createStep(scope, run.id, 1);
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
  }));
} finally {
  await prisma.app_settings.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.threads.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.auth_tokens.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.users.deleteMany({ where: { tenant_id: tenantId } });
  await prisma.tenants.deleteMany({ where: { id: tenantId } });
  await prisma.system_admins.deleteMany({ where: { email: systemAdminEmail } });
  await prisma.$disconnect();
  await pool.end();
}
