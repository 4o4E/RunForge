import { readFile, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundledScriptNames, ensureBundledScript } from './bundled-scripts.mjs';
import { createWorkloadBrixClient } from './workload-client.mjs';

function parseJson(value, label) {
  try { return JSON.parse(value); } catch { throw new Error(`${label}必须是有效 JSON`); }
}

function mimeType(path) {
  switch (extname(path).toLowerCase()) {
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    case '.txt': return 'text/plain';
    case '.json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

function required(value, label) {
  if (!value) throw new Error(`${label}不能为空`);
  return value;
}

async function runScript(client, sessionId, name, args) {
  await ensureBundledScript(client, name);
  return sessionId
    ? client.runScriptInSession(sessionId, name, args)
    : client.runScript(name, args);
}

/**
 * 统一命令行入口让 Agent 直接使用 Brix HTTP SDK。大文件只在本地读写，
 * 避免把图片或下载产物的 base64 放进模型工具参数。
 */
export async function execute(argv, client) {
  client ??= await createWorkloadBrixClient();
  const [command, ...args] = argv;
  switch (command) {
    case 'session-open':
      return client.createSession(args[0]);
    case 'session-list':
      return client.listSessions();
    case 'session-close': {
      const sessionId = required(args[0], 'sessionId');
      await client.closeSession(sessionId);
      return { closed: sessionId };
    }
    case 'session-trace':
      return client.trace(required(args[0], 'sessionId'));
    case 'action':
      return client.action(required(args[0], 'sessionId'), parseJson(required(args[1], '操作 JSON'), '操作 JSON'));
    case 'upload': {
      const [sessionId, target, inputPath] = args;
      const path = resolve(required(inputPath, '本地文件路径'));
      const bytes = await readFile(path);
      return client.action(required(sessionId, 'sessionId'), {
        op: 'upload',
        target: required(target, '上传目标'),
        file: { filename: basename(path), mimeType: mimeType(path), base64: bytes.toString('base64') },
      });
    }
    case 'screenshot': {
      const [sessionId, outputPath, fullPage] = args;
      const result = await client.action(required(sessionId, 'sessionId'), {
        op: 'screenshot', fullPage: fullPage === 'true',
      });
      const base64 = result?.result?.base64;
      if (!base64) throw new Error('Brix 截图响应缺少 base64');
      const path = resolve(required(outputPath, '截图输出路径'));
      await writeFile(path, Buffer.from(base64, 'base64'));
      return { runId: result.runId, path, mimeType: result.result.mimeType };
    }
    case 'script-list':
      return { server: await client.listScripts(), bundled: bundledScriptNames() };
    case 'script-run':
      return runScript(
        client,
        null,
        required(args[0], '脚本名'),
        args[1] ? parseJson(args[1], '脚本参数 JSON') : {},
      );
    case 'session-script-run':
      return runScript(
        client,
        required(args[0], 'sessionId'),
        required(args[1], '脚本名'),
        args[2] ? parseJson(args[2], '脚本参数 JSON') : {},
      );
    case 'run-files':
      return client.listRunFiles(required(args[0], 'runId'));
    case 'run-file-get': {
      const [runId, name, outputPath] = args;
      const bytes = await client.downloadRunFile(required(runId, 'runId'), required(name, '产物文件名'));
      const path = resolve(required(outputPath, '本地输出路径'));
      await writeFile(path, bytes);
      return { path, bytes: bytes.length };
    }
    default:
      throw new Error('用法：brix.mjs <session-open|session-list|session-close|session-trace|action|upload|screenshot|script-list|script-run|session-script-run|run-files|run-file-get> ...');
  }
}

async function main() {
  console.log(JSON.stringify(await execute(process.argv.slice(2))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
