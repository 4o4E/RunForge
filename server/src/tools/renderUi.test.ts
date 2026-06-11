import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderUiTool } from './renderUi.js';
import { runTool } from './registry.js';
import { executeRun } from '../agent/executor.js';
import { MemoryStore } from '../store/memoryStore.js';
import type { Provider } from '../llm/types.js';
import type { AgentEvent } from '../agent/types.js';

const SAMPLE = {
  root: 'card',
  components: [
    { id: 'card', component: 'Card', title: 'Files', child: 'tbl' },
    { id: 'tbl', component: 'Table', columns: ['name', 'lines'], rows: [['a.ts', '12']] },
  ],
};

test('render_ui returns a ToolResult with an a2ui display', async () => {
  const r = await renderUiTool.run(SAMPLE);
  assert.notEqual(typeof r, 'string');
  const res = r as { text: string; display?: { type: string; message: { surfaceId: string; root: string } } };
  assert.match(res.text, /UI rendered/);
  assert.equal(res.display?.type, 'a2ui');
  assert.equal(res.display?.message.root, 'card');
  assert.equal(res.display?.message.surfaceId, 'ui-card');
});

test('render_ui rejects missing root / empty components', async () => {
  const r = (await renderUiTool.run({ components: [] })) as { text: string; display?: unknown };
  assert.match(r.text, /required/);
  assert.equal(r.display, undefined);
});

test('runTool normalizes render_ui through the policy and keeps the display', async () => {
  const r = await runTool('render_ui', SAMPLE);
  assert.equal(r.display?.type, 'a2ui');
  assert.match(r.text, /UI rendered/);
});

test('executor emits an a2ui event when a tool returns a display', async () => {
  const store = new MemoryStore();
  const thread = await store.createThread();
  const run = await store.createRun(thread.id, 'show files');

  let turn = 0;
  const provider: Provider = {
    name: 'scripted',
    async complete() {
      turn += 1;
      if (turn === 1) {
        return {
          content: null,
          toolCalls: [{ id: 'c1', name: 'render_ui', arguments: JSON.stringify(SAMPLE) }],
        };
      }
      return {
        content: 'done',
        toolCalls: [{
          id: 'f1',
          name: 'finish_conversation',
          arguments: JSON.stringify({ progress: 'done', completed: true }),
        }],
      };
    },
  };

  const published: AgentEvent[] = [];
  await executeRun(run.id, { store, provider, publish: (_id, e) => published.push(e), hardStepCap: 5, stream: false });

  const a2ui = published.find((e) => e.type === 'a2ui');
  assert.ok(a2ui, 'expected an a2ui event');
  assert.equal((a2ui as Extract<AgentEvent, { type: 'a2ui' }>).surfaceId, 'ui-card');
  const dataModel = (a2ui as Extract<AgentEvent, { type: 'a2ui' }>).message.dataModel as {
    _toolCalls?: Array<{ id: string; name: string; args: unknown; result?: string; startedAt?: string; endedAt?: string }>;
  };
  assert.equal(dataModel._toolCalls?.[0]?.id, 'c1');
  assert.equal(dataModel._toolCalls?.[0]?.name, 'render_ui');
  assert.match(dataModel._toolCalls?.[0]?.result ?? '', /UI rendered/);
  assert.ok(dataModel._toolCalls?.[0]?.startedAt);
  assert.ok(dataModel._toolCalls?.[0]?.endedAt);

  // Persisted too (history recovery renders it on reload).
  const stored = await store.getEvents(run.id);
  assert.ok(stored.some((e) => e.type === 'a2ui'));
});
