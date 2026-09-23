import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { ensureManagedDirectory, ensureManagedLink } from '../files/managedResources.js';

/**
 * 业务插件由调用方维护，不能假设其 workspace 已执行 npm install。RunForge 把自己维护的
 * 零依赖 SDK 入口按内容版本保存在空间，thread 仅保留相对链接；运行 Token 只在环境变量中传递。
 */
export async function materializeWorkloadSdk(workspaceRoot: string, spaceRoot = workspaceRoot): Promise<string> {
  const source = fileURLToPath(import.meta.resolve('@runforge/workload-sdk'));
  const version = createHash('sha256').update(await readFile(source)).digest('hex');
  const sharedRoot = resolve(spaceRoot, '.agents/runforge-workload-sdk', version);
  await ensureManagedDirectory(sharedRoot, async (staging) => {
    await mkdir(staging, { recursive: true });
    await copyFile(source, resolve(staging, 'index.mjs'));
  });
  const linkedRoot = resolve(workspaceRoot, '.agents/runforge-workload-sdk');
  await ensureManagedLink(sharedRoot, linkedRoot);
  return resolve(linkedRoot, 'index.mjs');
}
