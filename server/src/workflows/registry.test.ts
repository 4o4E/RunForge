import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowIndex, readWorkflow, renderWorkflowCatalog } from './registry.js';

let workspaceRoot = '';
let builtinRoot = '';

before(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'runforge-workflows-workspace-'));
  builtinRoot = await mkdtemp(join(tmpdir(), 'runforge-workflows-builtin-'));

  const builtin = join(builtinRoot, 'sample-flow');
  await mkdir(builtin, { recursive: true });
  await writeFile(
    join(builtin, 'WORKFLOW.md'),
    [
      '---',
      'name: sample-flow',
      'description: Builtin workflow for tests.',
      '---',
      '',
      '# Builtin Flow',
      '',
      '<!-- @internal hidden -->',
      '## design',
    ].join('\n'),
    'utf8',
  );

  const user = join(workspaceRoot, '.workflows', 'sample-flow');
  await mkdir(user, { recursive: true });
  await writeFile(
    join(user, 'WORKFLOW.md'),
    ['---', 'name: sample-flow', 'description: User workflow wins.', '---', '', '# User Flow'].join('\n'),
    'utf8',
  );
});

after(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(builtinRoot, { recursive: true, force: true });
});

test('workflow registry materializes builtin workflows and prefers user workflow by name', async () => {
  const items = await loadWorkflowIndex(workspaceRoot, builtinRoot);
  assert.equal(items.length, 2);
  assert.equal(items.some((item) => item.id === 'builtin:sample-flow' && item.readonly), true);
  assert.equal(items.some((item) => item.id === 'user:sample-flow' && !item.readonly), true);
  assert.match(renderWorkflowCatalog(items), /sample-flow: Builtin workflow for tests/);

  const selected = await readWorkflow(workspaceRoot, 'sample-flow', builtinRoot);
  assert.equal(selected.workflow.id, 'user:sample-flow');
  assert.match(selected.body, /# User Flow/);

  const builtin = await readWorkflow(workspaceRoot, 'builtin:sample-flow', builtinRoot);
  assert.equal(builtin.workflow.id, 'builtin:sample-flow');
  assert.match(builtin.body, /# Builtin Flow/);
  assert.doesNotMatch(builtin.body, /@internal/);
});
