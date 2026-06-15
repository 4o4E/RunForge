import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createPolicy, isWithin, type ToolPolicyConfig } from './policy.js';

const ROOT = resolve('/workspace/app');

function cfg(over: Partial<ToolPolicyConfig> = {}): ToolPolicyConfig {
  return {
    sandbox: 'enforce',
    workspaceRoot: ROOT,
    allow: [],
    deny: [],
    shellEnabled: true,
    shellDeny: ['rm\\s+-rf\\s+/'],
    network: 'enabled',
    maxOutput: 50,
    ...over,
  };
}

test('isWithin: confinement check handles escapes and absolutes', () => {
  assert.equal(isWithin(ROOT, resolve(ROOT, 'src/a.ts')), true);
  assert.equal(isWithin(ROOT, ROOT), true);
  assert.equal(isWithin(ROOT, resolve(ROOT, '../other/x')), false);
  assert.equal(isWithin(ROOT, resolve('/etc/passwd')), false);
});

test('deny list blocks in any mode', () => {
  const p = createPolicy(cfg({ sandbox: 'off', deny: ['shell'] }));
  assert.equal(p.check('shell', { command: 'echo hi' }).ok, false);
  assert.equal(p.check('glob', { pattern: '*' }).ok, true);
});

test('allow list permits only listed tools', () => {
  const p = createPolicy(cfg({ allow: ['glob', 'grep'] }));
  assert.equal(p.check('glob', { pattern: '*' }).ok, true);
  assert.equal(p.check('shell', { command: 'echo hi' }).ok, false);
});

test('enforce: filesystem path confinement', () => {
  const p = createPolicy(cfg());
  assert.equal(p.check('file_read', { path: resolve(ROOT, 'src/a.ts') }).ok, true);
  const escaped = p.check('file_write', { path: resolve(ROOT, '../secret.txt') });
  assert.equal(escaped.ok, false);
  assert.match((escaped as { reason: string }).reason, /超出 workspace/);
  // Optional path (glob default cwd) is allowed through.
  assert.equal(p.check('glob', { pattern: '**/*' }).ok, true);
});

test('materialized agent resource directories are readonly for file writes', () => {
  const p = createPolicy(cfg({ sandbox: 'off' }));
  const blockedSkill = p.check('file_write', { path: resolve(ROOT, '.agents/skills/database-access/SKILL.md') });
  assert.equal(blockedSkill.ok, false);
  assert.match((blockedSkill as { reason: string }).reason, /只读/);
  const blockedWorkflow = p.check('file_write', { path: resolve(ROOT, '.agents/workflows/software-development/WORKFLOW.md') });
  assert.equal(blockedWorkflow.ok, false);
  assert.match((blockedWorkflow as { reason: string }).reason, /只读/);
});

test('off mode skips path confinement but still caps/denies', () => {
  const p = createPolicy(cfg({ sandbox: 'off' }));
  assert.equal(p.check('file_read', { path: resolve('/etc/passwd') }).ok, true);
});

test('enforce: shell denylist and disable', () => {
  assert.equal(createPolicy(cfg()).check('shell', { command: 'rm -rf /' }).ok, false);
  assert.equal(createPolicy(cfg()).check('shell', { command: 'ls -la' }).ok, true);
  assert.equal(createPolicy(cfg({ shellEnabled: false })).check('shell', { command: 'ls' }).ok, false);
});

test('enforce: network switch gates web tools', () => {
  assert.equal(createPolicy(cfg({ network: 'enabled' })).check('web_fetch', { url: 'https://example.com/x' }).ok, true);
  assert.equal(createPolicy(cfg({ network: 'enabled' })).check('web_search', { query: 'x' }).ok, true);
  const blocked = createPolicy(cfg({ network: 'disabled' })).check('web_fetch', { url: 'https://example.com/x' });
  assert.equal(blocked.ok, false);
  assert.match((blocked as { reason: string }).reason, /网络访问已禁用/);
});

test('capOutput truncates oversized results', () => {
  const p = createPolicy(cfg({ maxOutput: 50 }));
  assert.equal(p.capOutput('short'), 'short');
  const out = p.capOutput('x'.repeat(90));
  assert.match(out, /已截断 40 个字符/);
  assert.ok(out.length <= 50);
});

test('capOutput removes NUL characters before persistence', () => {
  const p = createPolicy(cfg({ maxOutput: 50 }));
  assert.equal(p.capOutput('a\u0000b'), 'ab');
});
