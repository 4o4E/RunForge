import { randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readdir, realpath, rename, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { validateHeaderValue } from 'node:http';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { McpServerSettings } from '@runforge/contracts';
import { CordisRuntimeManager } from '../plugins/runtime.js';
import type { SpaceRuntimeLock } from '../plugins/types.js';
import { readSkillIndexItem, type SkillIndexItem } from '../skills/registry.js';
import { createBusinessPluginCordisDefinition } from './cordis.js';
import { BusinessPluginError } from './errors.js';
import { loadBusinessPlugin } from './registry.js';
import type {
  BusinessMcpServerDeclaration,
  BusinessPluginExecutable,
  BusinessPluginDefinition,
} from './types.js';

export interface TenantSecretRequest {
  stepId?: string | null,
  workloadToken?: string | null,
  keys: readonly string[],
}

export type TenantSecretResolver = (
  request: TenantSecretRequest,
) => Promise<Readonly<Record<string, string>>>;

export interface BusinessPluginRuntimeInput {
  runId: string;
  workspaceRoot: string;
  /** 空间内按版本保存链接；不包含会话文件。 */
  spaceRoot?: string;
  definitions: readonly BusinessPluginDefinition[];
  lock: SpaceRuntimeLock;
  /** tenant 级非敏感配置；空间不能覆盖。 */
  tenantConfig?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  resolveSecrets?: TenantSecretResolver;
}

export interface BusinessPluginRunHandle {
  skills: SkillIndexItem[];
  executables: BusinessPluginExecutable[];
  pluginRoots: string[];
  mcpServers: McpServerSettings[];
  refreshMcpServers(stepId?: string | null): Promise<McpServerSettings[]>;
  dispose(): Promise<void>;
}

interface SkillContributionValue {
  businessPluginId: string;
  definition: { id: string; path: string };
}

interface McpContributionValue {
  businessPluginId: string;
  definition: BusinessMcpServerDeclaration;
}

function snapshotPluginRoot(
  candidateRoot: string,
  pluginId: string,
  contentHash: string,
): string {
  const normalized = resolve(candidateRoot);
  const snapshotSuffix = join('.runforge-snapshots', pluginId, contentHash, 'plugin');
  if (normalized.endsWith(`${sep}${snapshotSuffix}`)) return normalized;
  return resolve(
    dirname(normalized),
    '.runforge-snapshots',
    pluginId,
    contentHash,
    'plugin',
  );
}

function linkedPluginRoot(workspaceRoot: string, pluginId: string): string {
  return resolve(workspaceRoot, 'plugins', pluginId);
}

async function isSymbolicLinkTo(target: string, source: string): Promise<boolean> {
  try {
    if (!(await lstat(target)).isSymbolicLink()) return false;
    return await realpath(target) === await realpath(source);
  } catch {
    return false;
  }
}

/**
 * thread 只保留指向内容哈希快照的相对符号链接。相对链接不固化容器内绝对路径，
 * 同一目录树整体迁移后仍然有效；快照本身继续由 plugin_lock 固定版本。
 */
async function ensureWorkspaceLink(source: string, target: string): Promise<void> {
  if (await isSymbolicLinkTo(target, source)) return;
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  if (await realpath(parent) !== resolve(parent)) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_PATH_INVALID', `业务插件链接上级目录经过符号链接：${target}`);
  }
  const staging = `${target}.tmp-${process.pid}-${randomUUID()}`;
  const backup = `${target}.old-${process.pid}-${randomUUID()}`;
  let movedExisting = false;
  try {
    const linkTarget = relative(parent, resolve(source));
    if (!linkTarget || isAbsolute(linkTarget)) {
      throw new BusinessPluginError('BUSINESS_PLUGIN_PATH_INVALID', `无法为业务插件创建相对链接：${source}`);
    }
    await symlink(linkTarget, staging, 'dir');
    try {
      await rename(target, backup);
      movedExisting = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(staging, target);
    if (movedExisting) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (movedExisting && !existsSync(target)) await rename(backup, target);
    throw error;
  } finally {
    await rm(staging, { recursive: true, force: true });
    if (existsSync(target)) await rm(backup, { recursive: true, force: true });
  }
}

async function ensureSnapshot(source: string, target: string): Promise<void> {
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const staging = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await cp(source, staging, { recursive: true });
    try {
      await rename(staging, target);
    } catch (error) {
      if (!existsSync(target)) throw error;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function expectedPlugin(root: string, pluginId: string, contentHash: string): Promise<BusinessPluginDefinition | null> {
  if (!existsSync(root)) return null;
  try {
    const definition = await loadBusinessPlugin(root);
    return definition.manifest.id === pluginId && definition.contentHash === contentHash ? definition : null;
  } catch {
    return null;
  }
}

async function removeUnselectedPluginLinks(workspaceRoot: string, selectedIds: ReadonlySet<string>): Promise<void> {
  const root = resolve(workspaceRoot, 'plugins');
  if (!existsSync(root)) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (selectedIds.has(entry.name)) continue;
    await rm(join(root, entry.name), { recursive: true, force: true });
  }
}

async function materializePlugin(
  workspaceRoot: string,
  spaceRoot: string,
  pluginId: string,
  contentHash: string,
  candidate?: BusinessPluginDefinition,
): Promise<BusinessPluginDefinition> {
  const target = linkedPluginRoot(workspaceRoot, pluginId);
  const existing = await expectedPlugin(target, pluginId, contentHash);
  const spaceLink = resolve(spaceRoot, '.plugins', pluginId, contentHash);
  const linkedVersion = await expectedPlugin(spaceLink, pluginId, contentHash);

  if (!candidate || candidate.manifest.id !== pluginId) {
    // 部署目录更新后，已接纳 run 仍可通过空间内的版本化链接使用锁定的旧快照。
    if (linkedVersion) {
      await ensureWorkspaceLink(spaceLink, target);
      return { ...linkedVersion, root: target, manifestPath: resolve(target, relative(linkedVersion.root, linkedVersion.manifestPath)) };
    }
    if (existing && !(await lstat(target)).isSymbolicLink()) return existing;
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_NOT_READY',
      `业务插件部署和运行链接均不可用：${pluginId} (${contentHash})`,
    );
  }

  const snapshotRoot = snapshotPluginRoot(candidate.root, pluginId, contentHash);
  let snapshot = await expectedPlugin(snapshotRoot, pluginId, contentHash);
  if (!snapshot) {
    // 部署目录可能在索引后被原子替换；创建链接前重新计算 hash，不能把新内容写进旧 hash 路径。
    const fresh = await loadBusinessPlugin(candidate.root);
    if (fresh.contentHash !== contentHash || fresh.manifest.id !== pluginId) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_NOT_READY',
        `业务插件 ${pluginId} 已更新，当前 run 需要的内容 ${contentHash} 不再可用`,
      );
    }
    if (existsSync(snapshotRoot)) await rm(snapshotRoot, { recursive: true });
    await ensureSnapshot(fresh.root, snapshotRoot);
    snapshot = await expectedPlugin(snapshotRoot, pluginId, contentHash);
  }
  if (!snapshot) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_NOT_READY', `业务插件快照创建失败：${pluginId} (${contentHash})`);
  }

  await ensureWorkspaceLink(snapshot.root, spaceLink);
  await ensureWorkspaceLink(spaceLink, target);
  if (!(await isSymbolicLinkTo(spaceLink, snapshot.root)) || !(await isSymbolicLinkTo(target, snapshot.root))) {
    await rm(target, { recursive: true, force: true });
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_NOT_READY',
      `业务插件 ${pluginId} 的空间或会话链接创建失败，拒绝启动 run`,
    );
  }
  // 校验使用快照真实路径；提供给 Skill、脚本和工具的仍是 thread 内稳定逻辑路径。
  return {
    ...snapshot,
    root: target,
    manifestPath: resolve(target, relative(snapshot.root, snapshot.manifestPath)),
  };
}

function stringConfig(config: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = config[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredSecret(
  secrets: Readonly<Record<string, string>>,
  pluginId: string,
  key: string,
): string {
  const value = Object.hasOwn(secrets, key) ? secrets[key] : undefined;
  if (!value?.trim()) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_SECRET_UNAVAILABLE',
      `业务插件 ${pluginId} 缺少 tenant Secret：${key}`,
    );
  }
  return value;
}

function baseMcpServer(
  contribution: McpContributionValue,
  config: Readonly<Record<string, unknown>>,
): McpServerSettings {
  const { businessPluginId, definition } = contribution;
  const url = definition.url ?? (definition.urlConfigKey ? stringConfig(config, definition.urlConfigKey) : null);
  if (!url) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_CONFIG_INVALID',
      `业务插件 ${businessPluginId} 的 MCP ${definition.id} 缺少 tenant 配置 ${definition.urlConfigKey ?? 'url'}`,
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(url);
  } catch (error) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_CONFIG_INVALID',
      `业务插件 ${businessPluginId} 的 MCP ${definition.id} URL 无效`,
      { cause: error },
    );
  }
  if (!/^https?:$/.test(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_CONFIG_INVALID',
      `业务插件 ${businessPluginId} 的 MCP ${definition.id} URL 必须是无凭证的 HTTP/HTTPS 地址`,
    );
  }
  return {
    id: `business-${businessPluginId}-${definition.id}`,
    label: definition.label,
    description: definition.description,
    enabled: true,
    url,
    bearerToken: '',
    headers: definition.headers.map((header) => ({
      name: header.name,
      value: header.value ?? '',
    })),
    timeoutMs: definition.timeoutMs,
    maxOutput: definition.maxOutput,
  };
}

function resolveMcpServer(
  contribution: McpContributionValue,
  config: Readonly<Record<string, unknown>>,
  secrets: Readonly<Record<string, string>>,
): McpServerSettings {
  const { businessPluginId, definition } = contribution;
  const server = baseMcpServer(contribution, config);
  const bearerToken = definition.bearerSecretKey
    ? requiredSecret(secrets, businessPluginId, definition.bearerSecretKey)
    : '';
  if (bearerToken) {
    try {
      validateHeaderValue('Authorization', `Bearer ${bearerToken.trim()}`);
    } catch (error) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_SECRET_UNAVAILABLE',
        `业务插件 ${businessPluginId} 的 MCP ${definition.id} bearer Secret 不是有效的 HTTP Header 值`,
        { cause: error },
      );
    }
  }
  const headers = definition.headers.map((header) => ({
    name: header.name,
    value: header.secretKey
      ? requiredSecret(secrets, businessPluginId, header.secretKey)
      : header.value ?? '',
  }));
  for (const header of headers) {
    try {
      validateHeaderValue(header.name, header.value);
    } catch (error) {
      throw new BusinessPluginError(
        'BUSINESS_PLUGIN_SECRET_UNAVAILABLE',
        `业务插件 ${businessPluginId} 的 MCP ${definition.id} header ${header.name} 值无效`,
        { cause: error },
      );
    }
  }
  return {
    ...server,
    bearerToken,
    headers,
  };
}

export function resolveBusinessPluginMcpServer(
  definition: BusinessPluginDefinition,
  serverId: string,
  config: Readonly<Record<string, unknown>>,
  secrets: Readonly<Record<string, string>>,
): McpServerSettings {
  const mcp = definition.manifest.mcpServers.find((server) => server.id === serverId);
  if (!mcp) {
    throw new BusinessPluginError(
      'BUSINESS_PLUGIN_NOT_READY',
      `业务插件 ${definition.manifest.id} 没有声明 MCP ${serverId}`,
    );
  }
  return resolveMcpServer({ businessPluginId: definition.manifest.id, definition: mcp }, config, secrets);
}

export class BusinessPluginRuntimeService {
  private readonly manager = new CordisRuntimeManager();
  private readonly registered = new Set<string>();

  async syncWorkspace(workspaceRoot: string, selectedPluginIds: ReadonlySet<string>): Promise<void> {
    await removeUnselectedPluginLinks(workspaceRoot, selectedPluginIds);
  }

  async startRun(input: BusinessPluginRuntimeInput): Promise<BusinessPluginRunHandle> {
    const candidates = new Map(input.definitions.map((definition) => [definition.manifest.id, definition]));
    const selections = input.lock.plugins.map((plugin) => ({
      id: businessPluginId(plugin.id),
      contentHash: plugin.contentHash,
    }));
    await this.syncWorkspace(input.workspaceRoot, new Set(selections.map((selection) => selection.id)));
    const definitions = await Promise.all(selections.map((selection) => materializePlugin(
      input.workspaceRoot,
      input.spaceRoot ?? input.workspaceRoot,
      selection.id,
      selection.contentHash,
      candidates.get(selection.id),
    )));

    for (const definition of definitions) {
      const key = `${definition.manifest.id}\u0000${definition.contentHash}`;
      if (this.registered.has(key)) continue;
      this.manager.registerPlugin(createBusinessPluginCordisDefinition(definition));
      this.registered.add(key);
    }
    const runtime = await this.manager.startRun(input.runId, input.lock);

    try {
      const definitionsById = new Map(definitions.map((item) => [item.manifest.id, item]));
      const executables: BusinessPluginExecutable[] = [];
      const commandNames = new Set<string>();
      for (const plugin of definitions) {
        for (const executable of plugin.manifest.executables ?? []) {
          if (commandNames.has(executable.name)) continue;
          commandNames.add(executable.name);
          executables.push({
            pluginId: plugin.manifest.id,
            name: executable.name,
            path: resolve(plugin.root, executable.path),
          });
        }
      }
      const skills = await Promise.all(runtime.catalog.skills.map(async (contribution) => {
        const value = contribution.value as SkillContributionValue;
        const plugin = definitionsById.get(value.businessPluginId);
        if (!plugin) throw new Error(`Cordis catalog 引用了未选择的业务插件：${value.businessPluginId}`);
        const root = resolve(plugin.root, value.definition.path);
        return readSkillIndexItem(
          root,
          'business',
          true,
          `business:${value.businessPluginId}/${value.definition.id}`,
          value.definition.id,
        );
      }));
      const refreshMcpServers = async (stepId?: string | null) => {
        if (!runtime.catalog.mcpServers.length) return [];
        // 一次刷新只读取一次 tenant Secret 快照，避免同一 MCP 调用按 key 重复访问数据库，
        // 也避免同次装配混用管理员更新前后的两组值。插件声明用于收集所需 key，不是授权。
        const secretKeys = [...new Set(runtime.catalog.mcpServers.flatMap((contribution) => {
          const value = contribution.value as McpContributionValue;
          return [
            value.definition.bearerSecretKey,
            ...value.definition.headers.map((header) => header.secretKey),
          ].filter((key): key is string => Boolean(key));
        }))];
        const secrets = await input.resolveSecrets?.({
          stepId,
          keys: secretKeys,
        }) ?? {};
        return Promise.all(runtime.catalog.mcpServers.map((contribution) => {
          const value = contribution.value as McpContributionValue;
          return resolveMcpServer(
            value,
            input.tenantConfig?.[value.businessPluginId] ?? {},
            secrets,
          );
        }));
      };
      // 初始目录只需要 ID/说明和非敏感 endpoint；Secret 到激活或真实调用前才读取。
      const mcpServers = runtime.catalog.mcpServers.map((contribution) => {
        const value = contribution.value as McpContributionValue;
        return baseMcpServer(value, input.tenantConfig?.[value.businessPluginId] ?? {});
      });
      let disposed = false;
      return {
        skills,
        executables,
        pluginRoots: definitions.map((definition) => definition.root),
        mcpServers,
        refreshMcpServers,
        dispose: async () => {
          if (disposed) return;
          disposed = true;
          await runtime.dispose();
        },
      };
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    await this.manager.dispose();
  }
}

function businessPluginId(runtimePluginId: string): string {
  if (!runtimePluginId.startsWith('business.')) {
    throw new BusinessPluginError('BUSINESS_PLUGIN_NOT_READY', `运行锁包含非业务插件：${runtimePluginId}`);
  }
  return runtimePluginId.slice('business.'.length);
}

export const businessPluginRuntime = new BusinessPluginRuntimeService();
