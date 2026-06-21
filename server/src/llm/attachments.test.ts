import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hydrateImageAttachments } from './attachments.js';
import type { LlmMessage } from './types.js';

test('hydrateImageAttachments: turns file tokens into image parts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'my-agent-images-'));
  try {
    await writeFile(join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const token = `[[file:${JSON.stringify({ kind: 'local', path: 'photo.png', name: 'photo.png' })}]]`;
    const messages: LlmMessage[] = [{ role: 'user', content: `请读取这张图\n\n${token}` }];

    const hydrated = await hydrateImageAttachments(messages, root);
    assert.equal(hydrated[0].content, messages[0].content);
    assert.equal(hydrated[0].contentParts?.length, 2);
    assert.deepEqual(hydrated[0].contentParts?.[1], {
      type: 'image',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
      mimeType: 'image/png',
      path: 'photo.png',
      name: 'photo.png',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hydrateImageAttachments: leaves non-image attachments as text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'my-agent-files-'));
  try {
    await writeFile(join(root, 'note.txt'), 'hello');
    const token = `[[file:${JSON.stringify({ kind: 'local', path: 'note.txt', name: 'note.txt' })}]]`;
    const messages: LlmMessage[] = [{ role: 'user', content: `读文件\n${token}` }];

    const hydrated = await hydrateImageAttachments(messages, root);
    assert.equal(hydrated[0].contentParts, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
