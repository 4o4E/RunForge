import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { config } from '../config.js';
import type { SpaceRuntimeLock } from '../plugins/types.js';
import { parseSkillDocument } from '../skills/registry.js';
import { extractBusinessPluginArchive, type BusinessPluginArchiveFormat } from './archive.js';
import { BusinessPluginError } from './errors.js';
import { parseBusinessPluginManifest } from './manifest.js';
import type {
  BusinessPluginDefinition,
  BusinessPluginManifest,
  BusinessSkillEntrySnapshot,
} from './types.js';

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

async function loadSkillEntries(
  pluginRoot: string,
  manifest: BusinessPluginManifest,
): Promise<BusinessSkillEntrySnapshot[]> {
  const entries: BusinessSkillEntrySnapshot[] = [];
  for (const skill of manifest.skills) {
    const root = resolve(pluginRoot, skill.path);
    if (!isWithin(pluginRoot, root)) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_PATH_INVALID',
        `业务插件 ${manifest.id} 的 Skill ${skill.id} 路径越界：${skill.path}`,
      );
    }
    const entry = join(root, 'SKILL.md');
    if (!existsSync(entry)) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_PATH_INVALID',
        `业务插件 ${manifest.id} 的 Skill ${skill.id} 缺少 SKILL.md：${skill.path}`,
      );
    }
    const parsed = parseSkillDocument(await readFile(entry, 'utf8'), entry);
    if (parsed.frontmatter.name !== skill.id) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_MANIFEST_INVALID',
        `业务插件 ${manifest.id} 的 Skill ${skill.id} 与 SKILL.md name ${parsed.frontmatter.name} 不一致`,
      );
    }
    entries.push({
      id: skill.id,
      path: skill.path,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      content: parsed.body.trim(),
    });
  }
  return entries;
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
  const contentHash = await hashTree(canonical);
  const manifest = parseBusinessPluginManifest(await readFile(manifestPath, 'utf8'), manifestPath);
  const skillEntries = await loadSkillEntries(canonical, manifest);
  if (await hashTree(canonical) !== contentHash) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_PATH_INVALID',
      `业务插件在读取期间发生变化，请完整替换目录后重新加载：${canonical}`,
    );
  }
  const definition = {
    root: canonical,
    manifestPath,
    contentHash,
    manifest,
    skillEntries,
  } satisfies BusinessPluginDefinition;
  return definition;
}

export async function loadBusinessPluginIndex(roots: readonly string[]): Promise<BusinessPluginDefinition[]> {
  const definitions: BusinessPluginDefinition[] = [];
  const owners = new Map<string, string>();
  for (const configuredRoot of roots) {
    const sourceRoot = resolve(configuredRoot);
    if (!existsSync(sourceRoot)) continue;
    for (const entry of (await readdir(sourceRoot, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
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

function assertTenantDirectoryName(tenantId: string): void {
  if (!tenantId || tenantId === '.' || tenantId === '..' || basename(tenantId) !== tenantId) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_PATH_INVALID', `tenant ID 不能用于业务插件目录：${tenantId}`);
  }
}

async function tenantSourceRoots(roots: readonly string[], tenantId: string): Promise<string[]> {
  assertTenantDirectoryName(tenantId);
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

export interface BusinessPluginImportResult {
  definition: BusinessPluginDefinition;
  replaced: boolean;
}

/**
 * 业务插件目录按 `<configured-root>/<tenantId>/<plugin>/` 隔离。索引只在首次访问或显式
 * reload 时扫描；旧 definition 会在当前进程保留，供已经接纳的 run 按 plugin_lock 恢复。
 */
export class BusinessPluginRegistry {
  private readonly currentByTenant = new Map<string, BusinessPluginDefinition[]>();
  private readonly deploymentsByTenant = new Map<string, Map<string, BusinessPluginDefinition>>();
  private readonly loadingByTenant = new Map<string, Promise<BusinessPluginDefinition[]>>();
  private readonly mutatingByTenant = new Map<string, Promise<void>>();

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
    const mutating = this.mutatingByTenant.get(tenantId);
    if (mutating) await mutating;
    return this.reloadIndex(tenantId);
  }

  private async reloadIndex(tenantId: string): Promise<BusinessPluginDefinition[]> {
    const loading = this.loadingByTenant.get(tenantId);
    if (loading) await loading;
    return this.load(tenantId);
  }

  async importArchive(
    tenantId: string,
    archive: Buffer,
    format: BusinessPluginArchiveFormat,
  ): Promise<BusinessPluginImportResult> {
    assertTenantDirectoryName(tenantId);
    return this.mutateTenant(tenantId, () => this.installArchive(tenantId, archive, format));
  }

  async uninstall<T = void>(
    tenantId: string,
    pluginId: string,
    beforeRemove?: (
      definition: BusinessPluginDefinition,
      current: readonly BusinessPluginDefinition[],
    ) => Promise<T>,
  ): Promise<T | void> {
    assertTenantDirectoryName(tenantId);
    return this.mutateTenant(tenantId, async () => {
      const current = await this.list(tenantId);
      const definition = current.find((item) => item.manifest.id === pluginId);
      if (!definition) {
        throw new BusinessPluginError('BUSINESS_PLUGIN_NOT_READY', `业务插件不存在：${pluginId}`);
      }
      const result = await beforeRemove?.(definition, current);
      await this.removeDeployment(tenantId, pluginId, current, definition);
      return result;
    });
  }

  async mutateTenant<T>(tenantId: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutatingByTenant.get(tenantId) ?? Promise.resolve();
    const pending = previous.then(mutation);
    const lock = pending.then(() => undefined, () => undefined);
    this.mutatingByTenant.set(tenantId, lock);
    try {
      return await pending;
    } finally {
      if (this.mutatingByTenant.get(tenantId) === lock) this.mutatingByTenant.delete(tenantId);
    }
  }

  async resolveLock(tenantId: string, lock: SpaceRuntimeLock): Promise<BusinessPluginDefinition[]> {
    if (lock.tenantId !== tenantId) {
      throw new BusinessPluginError('BUSINESS_PLUGIN_NOT_READY', '业务插件运行锁不属于当前 tenant');
    }
    await this.list(tenantId);
    const deployments = this.deploymentsByTenant.get(tenantId) ?? new Map();
    const tenantRoots = await tenantSourceRoots(this.roots, tenantId);
    return Promise.all(lock.plugins.map(async (plugin) => {
      let definition = deployments.get(`${plugin.id}\u0000${plugin.version}\u0000${plugin.contentHash}`);
      if (!definition && plugin.id.startsWith('business.')) {
        const manifestId = plugin.id.slice('business.'.length);
        for (const tenantRoot of tenantRoots) {
          const snapshotRoot = join(tenantRoot, '.runforge-snapshots', manifestId, plugin.contentHash, 'plugin');
          if (!existsSync(snapshotRoot)) continue;
          const candidate = await loadBusinessPlugin(snapshotRoot);
          const version = candidate.manifest.version ?? `local-${candidate.contentHash.slice(0, 12)}`;
          if (candidate.manifest.id === manifestId && candidate.contentHash === plugin.contentHash && version === plugin.version) {
            definition = candidate;
            deployments.set(deploymentKey(candidate), candidate);
            break;
          }
        }
      }
      if (!definition) {
        throw new BusinessPluginError(
          'BUSINESS_PLUGIN_NOT_READY',
          `业务插件部署不可用：${plugin.id}@${plugin.version} (${plugin.contentHash})`,
        );
      }
      return definition;
    }));
  }

  private async removeDeployment(
    tenantId: string,
    pluginId: string,
    current: readonly BusinessPluginDefinition[],
    definition: BusinessPluginDefinition,
  ): Promise<void> {
    const tenantRoots = await tenantSourceRoots(this.roots, tenantId);
    const ownsDeployment = tenantRoots.some((tenantRoot) => dirname(definition.root) === tenantRoot);
    if (!ownsDeployment) {
      throw new BusinessPluginError('BUSINESS_PLUGIN_PATH_INVALID', `业务插件目录不属于当前 tenant：${definition.root}`);
    }

    await rm(definition.root, { recursive: true, force: true });
    this.currentByTenant.set(
      tenantId,
      current.filter((item) => item.manifest.id !== pluginId),
    );
  }

  private async installArchive(
    tenantId: string,
    archive: Buffer,
    format: BusinessPluginArchiveFormat,
  ): Promise<BusinessPluginImportResult> {
    const managedRoot = this.roots[0];
    if (!managedRoot) {
      throw new BusinessPluginError('BUSINESS_PLUGIN_PATH_INVALID', '没有可用于导入的业务插件根目录');
    }
    const extracted = await extractBusinessPluginArchive(archive, format, tmpdir());
    try {
      const candidate = await loadBusinessPlugin(extracted.pluginRoot);
      const current = await this.reloadIndex(tenantId);
      const existing = current.find((definition) => definition.manifest.id === candidate.manifest.id);
      if (existing?.contentHash === candidate.contentHash) {
        return { definition: existing, replaced: true };
      }

      const target = existing?.root ?? join(resolve(managedRoot), tenantId, candidate.manifest.id);
      const parent = dirname(target);
      await mkdir(parent, { recursive: true });
      const staging = join(parent, `.runforge-import-${candidate.manifest.id}-${randomUUID()}`);
      const backup = join(parent, `.runforge-backup-${candidate.manifest.id}-${randomUUID()}`);
      let movedExisting = false;
      let installed = false;
      try {
        await cp(candidate.root, staging, { recursive: true, errorOnExist: true });
        const staged = await loadBusinessPlugin(staging);
        if (staged.manifest.id !== candidate.manifest.id || staged.contentHash !== candidate.contentHash) {
          throw new BusinessPluginError('BUSINESS_PLUGIN_ARCHIVE_INVALID', '业务插件复制后的内容校验失败');
        }
        if (existsSync(target)) {
          if (!existing) {
            throw new BusinessPluginError('BUSINESS_PLUGIN_PATH_INVALID', `业务插件目标目录已经存在：${target}`);
          }
          await rename(target, backup);
          movedExisting = true;
        }
        await rename(staging, target);
        installed = true;
        const definition = await loadBusinessPlugin(target);
        if (definition.manifest.id !== candidate.manifest.id || definition.contentHash !== candidate.contentHash) {
          throw new BusinessPluginError('BUSINESS_PLUGIN_ARCHIVE_INVALID', '业务插件安装后的内容校验失败');
        }
        if (movedExisting) await rm(backup, { recursive: true, force: true });

        const next = [
          ...current.filter((item) => item.manifest.id !== definition.manifest.id),
          definition,
        ].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
        const deployments = this.deploymentsByTenant.get(tenantId) ?? new Map<string, BusinessPluginDefinition>();
        deployments.set(deploymentKey(definition), definition);
        this.deploymentsByTenant.set(tenantId, deployments);
        this.currentByTenant.set(tenantId, next);
        return { definition, replaced: Boolean(existing) };
      } catch (error) {
        if (installed) await rm(target, { recursive: true, force: true });
        if (movedExisting) await rename(backup, target);
        throw error;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    } finally {
      await rm(extracted.temporaryRoot, { recursive: true, force: true });
    }
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
