import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finished } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import { BusinessPluginRegistry, loadBusinessPlugin } from '../businessPlugins/registry.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const pluginSourceRoot = join(projectRoot, 'plugins', 'business');
const packageOutputRoot = join(projectRoot, 'build', 'business-plugins');

async function pluginFiles(root: string): Promise<Array<{ path: string; archivePath: string; mode: number }>> {
  const files: Array<{ path: string; archivePath: string; mode: number }> = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push({
        path,
        archivePath: relative(root, path).split(sep).join('/'),
        mode: (await stat(path)).mode,
      });
    }
  };
  await walk(root);
  return files;
}

async function writeZip(root: string, target: string): Promise<void> {
  const zip = new ZipFile();
  for (const file of await pluginFiles(root)) {
    zip.addFile(file.path, file.archivePath, { mode: file.mode });
  }
  const output = createWriteStream(target, { flags: 'wx' });
  zip.outputStream.pipe(output);
  zip.end();
  await finished(output);
}

/**
 * 业务插件交付物统一写入 build/business-plugins/<id>-<version>.zip。
 * 打包前验证源码，打包后再走一次真实导入，避免目录层级或权限错误留到生产才发现。
 */
export async function packageBusinessPlugin(pluginId: string): Promise<{ path: string; sha256: string; bytes: number }> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(pluginId)) throw new Error(`业务插件 ID 无效：${pluginId}`);
  const source = await loadBusinessPlugin(join(pluginSourceRoot, pluginId));
  if (source.manifest.id !== pluginId) throw new Error(`目录名与业务插件 ID 不一致：${pluginId} != ${source.manifest.id}`);
  const version = source.manifest.version?.trim();
  if (!version) throw new Error(`业务插件 ${pluginId} 必须声明 version，才能生成稳定文件名`);

  await mkdir(packageOutputRoot, { recursive: true });
  const target = join(packageOutputRoot, `${pluginId}-${version}.zip`);
  const temporary = join(packageOutputRoot, `.${pluginId}-${randomUUID()}.zip`);
  const validationRoot = join(tmpdir(), `runforge-plugin-package-${randomUUID()}`);
  try {
    await writeZip(source.root, temporary);
    const archive = await readFile(temporary);
    const registry = new BusinessPluginRegistry([validationRoot]);
    const imported = await registry.importArchive('tn_package_validation', archive, 'zip');
    if (imported.definition.manifest.id !== pluginId || imported.definition.manifest.version !== version) {
      throw new Error(`压缩包导入结果不一致：${imported.definition.manifest.id}@${imported.definition.manifest.version ?? ''}`);
    }
    await rm(target, { force: true });
    await rename(temporary, target);
    const bytes = (await stat(target)).size;
    const sha256 = createHash('sha256').update(await readFile(target)).digest('hex').toUpperCase();
    return { path: target, sha256, bytes };
  } finally {
    await rm(temporary, { force: true });
    await rm(validationRoot, { recursive: true, force: true });
  }
}

const pluginId = process.argv.slice(2).find((argument) => argument !== '--');
if (!pluginId) throw new Error('用法：pnpm package:business-plugin <插件ID>');
const result = await packageBusinessPlugin(pluginId);
console.log(`业务插件已打包：${result.path}`);
console.log(`大小：${result.bytes} bytes`);
console.log(`SHA-256：${result.sha256}`);
