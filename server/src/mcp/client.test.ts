import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { renderToolResult } from './client.js';

test('renderToolResult: saves MCP image content and returns a markdown image link', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-mcp-image-'));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const result: CallToolResult = {
      content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }],
    };

    const text = await renderToolResult(result, {
      workspaceRoot: root,
      runId: 'ru_test',
      serverId: 'brix',
      toolName: 'run_file_get',
      args: { name: 'starry-bowl.png' },
    });

    const remotePath = 'artifacts/mcp/ru_test/brix/run_file_get/starry-bowl.png';
    assert.match(text, new RegExp(`MCP 返回图片已保存：\\[${remotePath}\\]\\(${remotePath}\\)`));
    assert.match(text, new RegExp(`!\\[MCP 返回图片\\]\\(${remotePath}\\)`));
    assert.deepEqual(await readFile(join(root, remotePath)), png);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('renderToolResult: saves MCP binary resources with the resource file name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-mcp-resource-'));
  try {
    const body = Buffer.from('hello');
    const result: CallToolResult = {
      content: [{
        type: 'resource',
        resource: {
          uri: 'brix://runs/r1/downloads/report.pdf',
          mimeType: 'application/pdf',
          blob: body.toString('base64'),
        },
      }],
    };

    const text = await renderToolResult(result, {
      workspaceRoot: root,
      runId: 'ru_test',
      serverId: 'brix',
      toolName: 'run_file_get',
    });

    const remotePath = 'artifacts/mcp/ru_test/brix/run_file_get/report.pdf';
    assert.match(text, new RegExp(`\\[${remotePath}\\]\\(${remotePath}\\)`));
    assert.deepEqual(await readFile(join(root, remotePath)), body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('renderToolResult: keeps repeated MCP file names unique', async () => {
  const root = await mkdtemp(join(tmpdir(), 'runforge-mcp-unique-'));
  try {
    const first = Buffer.from([1]);
    const second = Buffer.from([2]);
    const result: CallToolResult = {
      content: [
        { type: 'image', mimeType: 'image/png', data: first.toString('base64') },
        { type: 'image', mimeType: 'image/png', data: second.toString('base64') },
      ],
    };

    const text = await renderToolResult(result, {
      workspaceRoot: root,
      runId: 'ru_test',
      serverId: 'brix',
      toolName: 'run_file_get',
      args: { name: 'image.png' },
    });

    const firstPath = 'artifacts/mcp/ru_test/brix/run_file_get/image.png';
    const secondPath = 'artifacts/mcp/ru_test/brix/run_file_get/image-2.png';
    assert.match(text, new RegExp(firstPath));
    assert.match(text, new RegExp(secondPath));
    assert.deepEqual(await readFile(join(root, firstPath)), first);
    assert.deepEqual(await readFile(join(root, secondPath)), second);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
