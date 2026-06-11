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
  assert.match((escaped as { reason: string }).reason, /outside the workspace/);
  // Optional path (glob default cwd) is allowed through.
  assert.equal(p.check('glob', { pattern: '**/*' }).ok, true);
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
  assert.match((blocked as { reason: string }).reason, /network access is disabled/);
});

test('capOutput truncates oversized results', () => {
  const p = createPolicy(cfg({ maxOutput: 10 }));
  assert.equal(p.capOutput('short'), 'short');
  assert.match(p.capOutput('x'.repeat(50)), /truncated 40 chars/);
});
