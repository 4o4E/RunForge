import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerSettings } from '../settings.js';
import { McpClientSession, renderToolResult } from './client.js';

function server(id = 'shared'): McpServerSettings {
  return {
    id,
    label: id,
    description: id,
    enabled: true,
    url: 'https://mcp.example.test',
    bearerToken: 'secret',
    headers: [],
    timeoutMs: 60_000,
    maxOutput: 40_000,
  };
}

test('MCP session: 相同 server ID 在不同 run session 中不共享客户端并各自释放', async () => {
  let connected = 0;
  let closed = 0;
  const connector = async () => {
    connected += 1;
    return {
      listTools: async () => ({ tools: [{ name: 'lookup', inputSchema: { type: 'object' as const } }] }),
      callTool: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }),
      close: async () => { closed += 1; },
    };
  };
  const left = new McpClientSession(connector);
  const right = new McpClientSession(connector);

  await left.activate({ servers: [server()] }, 'shared');
  await left.activate({ servers: [server()] }, 'shared');
  await right.activate({ servers: [server()] }, 'shared');

  assert.equal(connected, 2);
  await Promise.all([left.dispose(), right.dispose()]);
  assert.equal(closed, 2);
});

test('MCP session: 同一 run 中认证配置变化会关闭旧连接并重连', async () => {
  const connectedTokens: string[] = [];
  let closed = 0;
  const session = new McpClientSession(async (settings) => {
    connectedTokens.push(settings.bearerToken);
    return {
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      close: async () => { closed += 1; },
    };
  });

  await session.activate({ servers: [server()] }, 'shared');
  await session.activate({ servers: [{ ...server(), bearerToken: 'rotated' }] }, 'shared');

  assert.deepEqual(connectedTokens, ['secret', 'rotated']);
  assert.equal(closed, 1);
  await session.dispose();
  assert.equal(closed, 2);
});

test('MCP session: 将运行取消信号传给连接、工具目录和工具调用', async () => {
  const controller = new AbortController();
  const signals: Array<AbortSignal | undefined> = [];
  const session = new McpClientSession(async (_settings, signal) => {
    signals.push(signal);
    return {
      listTools: async (_params, options) => {
        signals.push(options?.signal);
        return { tools: [{ name: 'lookup', inputSchema: { type: 'object' as const } }] };
      },
      callTool: async (_params, _schema, options) => {
        signals.push(options?.signal);
        return { content: [{ type: 'text' as const, text: 'ok' }] };
      },
      close: async () => {},
    };
  });

  await session.activate({ servers: [server()] }, 'shared', controller.signal);
  await session.callTool('mcp__shared__lookup', {}, { servers: [server()] }, { abortSignal: controller.signal });
  assert.deepEqual(signals, [controller.signal, controller.signal, controller.signal]);
  await session.dispose();
});

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
