import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import type { SpaceRuntimeLock } from '../plugins/types.js';
import { parseSkillDocument } from '../skills/registry.js';
import { BusinessPluginError } from './errors.js';
import { parseBusinessPluginManifest } from './manifest.js';
import type { BusinessPluginDefinition } from './types.js';

const MANIFEST_FILE = 'runforge.plugin.yaml';

function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('/'));
}

async function assertSafeTree(root: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stats = await lstat(path);
      if (stats.isSymbolicLink()) {
        throw new BusinessPluginError(
          'BUSINESS_PLUGIN_PATH_INVALID',
          `业务插件不允许 symlink：${path}`,
        );
      }
      if (stats.isDirectory()) await walk(path);
      else if (!stats.isFile()) {
        throw new BusinessPluginError(
          'BUSINESS_PLUGIN_PATH_INVALID',
          `业务插件只允许普通文件和目录：${path}`,
        );
      }
    }
  };
  await walk(root);
}

async function hashTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        const rel = relative(root, path).split(sep).join('/');
        const mode = (await lstat(path)).mode & 0o777;
        const content = await readFile(path);
        hash.update(`${rel.length}:${rel}:${mode.toString(8)}:${content.length}:`);
        hash.update(content);
      }
    }
  };
  await walk(root);
  return hash.digest('hex');
}

async function validateSkills(definition: BusinessPluginDefinition): Promise<void> {
  for (const skill of definition.manifest.skills) {
    const root = resolve(definition.root, skill.path);
    if (!isWithin(definition.root, root)) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_PATH_INVALID',
        `业务插件 ${definition.manifest.id} 的 Skill ${skill.id} 路径越界：${skill.path}`,
      );
    }
    const entry = join(root, 'SKILL.md');
    if (!existsSync(entry)) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_PATH_INVALID',
        `业务插件 ${definition.manifest.id} 的 Skill ${skill.id} 缺少 SKILL.md：${skill.path}`,
      );
    }
    const parsed = parseSkillDocument(await readFile(entry, 'utf8'), entry);
    if (parsed.frontmatter.name !== skill.id) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_MANIFEST_INVALID',
        `业务插件 ${definition.manifest.id} 的 Skill ${skill.id} 与 SKILL.md name ${parsed.frontmatter.name} 不一致`,
      );
    }
  }
}

export async function loadBusinessPlugin(root: string): Promise<BusinessPluginDefinition> {
  const resolved = resolve(root);
  const canonical = await realpath(resolved).catch((error) => {
    throw new BusinessPluginError('BUSINESS_PLUGIN_PATH_INVALID', `业务插件目录不存在：${resolved}`, { cause: error });
  });
  const stats = await lstat(canonical);
  if (!stats.isDirectory()) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_PATH_INVALID', `业务插件根路径不是目录：${canonical}`);
  }
  await assertSafeTree(canonical);
  const manifestPath = join(canonical, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_MANIFEST_INVALID', `业务插件缺少 ${MANIFEST_FILE}：${canonical}`);
  }
  // 调用方业务包不能把服务端代码伪装成声明式插件；需要运行时能力时由 RunForge Cordis 插件提供。
  if (existsSync(join(canonical, 'dist', 'index.js'))) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_MANIFEST_INVALID',
      `业务插件不能包含 RunForge/Cordis 运行时入口：${join(canonical, 'dist', 'index.js')}`,
    );
  }
  const manifest = parseBusinessPluginManifest(await readFile(manifestPath, 'utf8'), manifestPath);
  const definition = {
    root: canonical,
    manifestPath,
    contentHash: await hashTree(canonical),
    manifest,
  } satisfies BusinessPluginDefinition;
  await validateSkills(definition);
  return definition;
}

export async function loadBusinessPluginIndex(roots: readonly string[]): Promise<BusinessPluginDefinition[]> {
  const definitions: BusinessPluginDefinition[] = [];
  const owners = new Map<string, string>();
  for (const configuredRoot of roots) {
    const sourceRoot = resolve(configuredRoot);
    if (!existsSync(sourceRoot)) continue;
    for (const entry of (await readdir(sourceRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const pluginRoot = join(sourceRoot, entry.name);
      if (!existsSync(join(pluginRoot, MANIFEST_FILE))) continue;
      const definition = await loadBusinessPlugin(pluginRoot);
      const owner = owners.get(definition.manifest.id);
      if (owner) {
        throw new BusinessPluginError(
          'BUSINESS_PLUGIN_DUPLICATE_ID',
          `业务插件 ID ${definition.manifest.id} 同时出现在 ${owner} 和 ${definition.root}`,
        );
      }
      owners.set(definition.manifest.id, definition.root);
      definitions.push(definition);
    }
  }
  return definitions.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

async function tenantSourceRoots(roots: readonly string[], tenantId: string): Promise<string[]> {
  if (!tenantId || tenantId === '.' || tenantId === '..' || basename(tenantId) !== tenantId) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_PATH_INVALID', `tenant ID 不能用于业务插件目录：${tenantId}`);
  }
  const tenantRoots: string[] = [];
  for (const configuredRoot of roots) {
    const configured = resolve(configuredRoot);
    if (!existsSync(configured)) continue;
    const canonicalConfigured = await realpath(configured);
    const candidate = join(canonicalConfigured, tenantId);
    if (!existsSync(candidate)) {
      tenantRoots.push(candidate);
      continue;
    }
    const canonicalTenant = await realpath(candidate);
    if (!isWithin(canonicalConfigured, canonicalTenant)) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_PATH_INVALID',
        `tenant 业务插件目录越界：${candidate}`,
      );
    }
    tenantRoots.push(canonicalTenant);
  }
  return tenantRoots;
}

function deploymentKey(definition: BusinessPluginDefinition): string {
  const version = definition.manifest.version ?? `local-${definition.contentHash.slice(0, 12)}`;
  return `business.${definition.manifest.id}\u0000${version}\u0000${definition.contentHash}`;
}

/**
 * 业务插件目录按 `<configured-root>/<tenantId>/<plugin>/` 隔离。索引只在首次访问或显式
 * reload 时扫描；旧 definition 会在当前进程保留，供已经接纳的 run 按 plugin_lock 恢复。
 */
export class BusinessPluginRegistry {
  private readonly currentByTenant = new Map<string, BusinessPluginDefinition[]>();
  private readonly deploymentsByTenant = new Map<string, Map<string, BusinessPluginDefinition>>();
  private readonly loadingByTenant = new Map<string, Promise<BusinessPluginDefinition[]>>();

  constructor(private readonly roots: readonly string[]) {}

  async list(tenantId: string): Promise<BusinessPluginDefinition[]> {
    const cached = this.currentByTenant.get(tenantId);
    if (cached) return cached;
    const loading = this.loadingByTenant.get(tenantId);
    if (loading) return loading;
    const pending = this.load(tenantId);
    this.loadingByTenant.set(tenantId, pending);
    try {
      return await pending;
    } finally {
      this.loadingByTenant.delete(tenantId);
    }
  }

  async reload(tenantId: string): Promise<BusinessPluginDefinition[]> {
    const loading = this.loadingByTenant.get(tenantId);
    if (loading) await loading;
    return this.load(tenantId);
  }

  async resolveLock(tenantId: string, lock: SpaceRuntimeLock): Promise<BusinessPluginDefinition[]> {
    if (lock.tenantId !== tenantId) {
      throw new BusinessPluginError('BUSINESS_PLUGIN_NOT_READY', '业务插件运行锁不属于当前 tenant');
    }
    await this.list(tenantId);
    const deployments = this.deploymentsByTenant.get(tenantId) ?? new Map();
    return lock.plugins.map((plugin) => {
      const definition = deployments.get(`${plugin.id}\u0000${plugin.version}\u0000${plugin.contentHash}`);
      if (!definition) {
        throw new BusinessPluginError(
          'BUSINESS_PLUGIN_NOT_READY',
          `业务插件部署不可用：${plugin.id}@${plugin.version} (${plugin.contentHash})`,
        );
      }
      return definition;
    });
  }

  private async load(tenantId: string): Promise<BusinessPluginDefinition[]> {
    const definitions = await loadBusinessPluginIndex(await tenantSourceRoots(this.roots, tenantId));
    const deployments = this.deploymentsByTenant.get(tenantId) ?? new Map<string, BusinessPluginDefinition>();
    for (const definition of definitions) deployments.set(deploymentKey(definition), definition);
    this.deploymentsByTenant.set(tenantId, deployments);
    this.currentByTenant.set(tenantId, definitions);
    return definitions;
  }
}

export const businessPluginRegistry = new BusinessPluginRegistry(config.businessPlugins.roots);
