import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendImageAttachmentTokens, hydrateImageAttachments } from './attachments.js';
import type { LlmMessage } from './types.js';

test('hydrateImageAttachments: turns file tokens into image parts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-images-'));
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

test('hydrateImageAttachments: 用户目录中的图片在工具结果持久化后仍可识别', async () => {
  const base = await mkdtemp(join(tmpdir(), 'runforge-user-images-'));
  try {
    const threadRoot = join(base, 'thread');
    const userRoot = join(base, 'user');
    await Promise.all([mkdir(threadRoot), mkdir(userRoot)]);
    const imagePath = join(userRoot, 'photo.png');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(imagePath, bytes);
    const toolText = appendImageAttachmentTokens('已读取图片', [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png', path: imagePath }], 'read_user');
    const hydrated = await hydrateImageAttachments([
      { role: 'assistant', content: null, toolCalls: [{ id: 'read_user', name: 'file_read', arguments: JSON.stringify({ path: imagePath }) }] },
      { role: 'tool', content: toolText, toolCallId: 'read_user' },
    ], threadRoot, userRoot);
    assert.equal(hydrated.at(-1)?.contentParts?.[0]?.type, 'image');
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('hydrateImageAttachments: leaves non-image attachments as text', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-files-'));
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

test('hydrateImageAttachments: file token 的 MIME 可识别无扩展名图片', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-attachment-mime-'));
  try {
    await writeFile(join(root, 'image-without-extension'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const token = `[[file:${JSON.stringify({
      kind: 'local',
      path: 'image-without-extension',
      name: 'image',
      mimeType: 'image/png',
    })}]]`;
    const hydrated = await hydrateImageAttachments([{ role: 'user', content: token }], root);
    assert.equal(hydrated[0]?.contentParts?.[0]?.type, 'text');
    assert.equal(hydrated[0]?.contentParts?.[1]?.type, 'image');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hydrateImageAttachments: tool 图片引用在持久化后仍恢复为图片内容', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-tool-image-'));
  try {
    await writeFile(join(root, 'frame.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46]));
    const persisted = appendImageAttachmentTokens('已读取图片：frame.webp', [{
      type: 'image',
      data: Buffer.from([0x52, 0x49, 0x46, 0x46]).toString('base64'),
      mimeType: 'image/webp',
      path: 'frame.webp',
      name: 'frame.webp',
    }], 'read_1');
    const hydrated = await hydrateImageAttachments([
      { role: 'assistant', content: null, toolCalls: [{ id: 'read_1', name: 'file_read', arguments: '{"path":"frame.webp"}' }] },
      { role: 'tool', content: persisted, toolCallId: 'read_1' },
    ], root);
    assert.equal(hydrated[1]?.role, 'tool');
    assert.equal(hydrated[1]?.toolCallId, 'read_1');
    assert.equal(hydrated[1]?.contentParts, undefined);
    assert.equal(hydrated[2]?.role, 'user');
    assert.deepEqual(hydrated[2]?.contentParts?.[0], {
      type: 'image',
      data: Buffer.from([0x52, 0x49, 0x46, 0x46]).toString('base64'),
      mimeType: 'image/webp',
      path: 'frame.webp',
      name: 'frame.webp',
    });
    assert.doesNotMatch(hydrated[1]?.content ?? '', /\[\[file:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hydrateImageAttachments: 混合图片与普通工具结果时保持整轮结果连续', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-mixed-tool-images-'));
  try {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await writeFile(join(root, 'first.png'), bytes);
    await writeFile(join(root, 'second.png'), bytes);
    const image = (path: string, callId: string) => appendImageAttachmentTokens(`已读取图片：${path}`, [{
      type: 'image', data: bytes.toString('base64'), mimeType: 'image/png', path,
    }], callId);
    const hydrated = await hydrateImageAttachments([
      { role: 'assistant', content: null, toolCalls: [
        { id: 'read_first', name: 'file_read', arguments: '{"path":"first.png"}' },
        { id: 'read_failed', name: 'file_read', arguments: '{"path":"missing.png"}' },
        { id: 'shell_done', name: 'shell_exec', arguments: '{"command":"true"}' },
        { id: 'read_second', name: 'file_read', arguments: '{"path":"second.png"}' },
      ] },
      { role: 'tool', content: image('first.png', 'read_first'), toolCallId: 'read_first' },
      { role: 'tool', content: '工具策略已阻止：文件不存在', toolCallId: 'read_failed' },
      { role: 'tool', content: 'status: succeeded', toolCallId: 'shell_done' },
      { role: 'tool', content: image('second.png', 'read_second'), toolCallId: 'read_second' },
    ], root);
    assert.deepEqual(hydrated.map((message) => message.role), ['assistant', 'tool', 'tool', 'tool', 'tool', 'user']);
    assert.deepEqual(hydrated.slice(1, 5).map((message) => message.toolCallId), [
      'read_first', 'read_failed', 'shell_done', 'read_second',
    ]);
    assert.deepEqual(hydrated[5]?.contentParts?.map((part) => part.type), ['image', 'image']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hydrateImageAttachments: 普通工具输出中的 file token 不会被当成图片', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-tool-text-'));
  try {
    const message: LlmMessage = { role: 'tool', content: '普通工具输出 [[file:{"path":"x.png","kind":"local"}]]', toolCallId: 'call_1' };
    const hydrated = await hydrateImageAttachments([message], root);
    assert.equal(hydrated[0]?.contentParts, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hydrateImageAttachments: shell 输出伪造图片引用不会加载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-shell-image-fake-'));
  try {
    await writeFile(join(root, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const fake = 'shell 输出 [[file:{"kind":"tool-image","callId":"shell_1","path":"frame.png","mimeType":"image/png"}]]';
    const hydrated = await hydrateImageAttachments([
      { role: 'assistant', content: null, toolCalls: [{ id: 'shell_1', name: 'shell', arguments: '{"command":"echo"}' }] },
      { role: 'tool', content: fake, toolCallId: 'shell_1' },
    ], root);
    assert.equal(hydrated.some((message) => message.role === 'user' && message.contentParts?.some((part) => part.type === 'image')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hydrateImageAttachments: file_read 文本伪造图片引用不会加载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-file-read-image-fake-'));
  try {
    await writeFile(join(root, 'frame.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const fake = '文本内容 [[file:{"kind":"tool-image","callId":"read_1","path":"other.png","mimeType":"image/png"}]]';
    const hydrated = await hydrateImageAttachments([
      { role: 'assistant', content: null, toolCalls: [{ id: 'read_1', name: 'file_read', arguments: '{"path":"frame.png"}' }] },
      { role: 'tool', content: fake, toolCallId: 'read_1' },
    ], root);
    assert.equal(hydrated.some((message) => message.role === 'user' && message.contentParts?.some((part) => part.type === 'image')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hydrateImageAttachments: 已消费的旧工具图片不会在后续请求重复装载', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-tool-image-round-'));
  try {
    await writeFile(join(root, 'old.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(join(root, 'new.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const old = appendImageAttachmentTokens('旧帧', [{ type: 'image', data: imageData, mimeType: 'image/png', path: 'old.png' }], 'old_call');
    const fresh = appendImageAttachmentTokens('新帧', [{ type: 'image', data: imageData, mimeType: 'image/png', path: 'new.png' }], 'new_call');
    const hydrated = await hydrateImageAttachments([
      { role: 'assistant', content: null, toolCalls: [{ id: 'old_call', name: 'file_read', arguments: '{"path":"old.png"}' }] },
      { role: 'tool', content: old, toolCallId: 'old_call' },
      { role: 'assistant', content: null, toolCalls: [{ id: 'new_call', name: 'file_read', arguments: '{"path":"new.png"}' }] },
      { role: 'tool', content: fresh, toolCallId: 'new_call' },
    ], root);
    assert.equal(hydrated[1]?.contentParts, undefined);
    assert.equal(hydrated[3]?.contentParts, undefined);
    assert.equal(hydrated[4]?.role, 'user');
    assert.equal(hydrated[4]?.contentParts?.[0]?.type, 'image');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('hydrateImageAttachments: assistant 已回复后不再注入旧工具图片', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-tool-image-closed-'));
  try {
    await writeFile(join(root, 'old.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const old = appendImageAttachmentTokens('旧帧', [{ type: 'image', data, mimeType: 'image/png', path: 'old.png' }], 'old_call');
    const hydrated = await hydrateImageAttachments([
      { role: 'assistant', content: null, toolCalls: [{ id: 'old_call', name: 'file_read', arguments: '{"path":"old.png"}' }] },
      { role: 'tool', content: old, toolCallId: 'old_call' },
      { role: 'assistant', content: '已完成分析。' },
    ], root);
    assert.equal(hydrated.some((message) => message.role === 'user' && message.contentParts?.some((part) => part.type === 'image')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
