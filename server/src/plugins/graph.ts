import { PluginRuntimeError } from './errors.js';
import type {
  AnyPluginDefinition,
  PluginContributionKind,
  SpacePluginSelection,
} from './types.js';

const PLUGIN_ID_RE = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;

export function deploymentKey(id: string, version: string, contentHash: string): string {
  return `${id}\u0000${version}\u0000${contentHash}`;
}
export function validatePluginDefinition(definition: AnyPluginDefinition): void {
  const { manifest } = definition;
  if (!PLUGIN_ID_RE.test(manifest.id)) {
    throw new PluginRuntimeError('INVALID_MANIFEST', `插件 ID 无效：${manifest.id}`);
  }
  if (!manifest.version.trim()) {
    throw new PluginRuntimeError('INVALID_MANIFEST', `插件 ${manifest.id} 缺少版本`);
  }
  if (!CONTENT_HASH_RE.test(manifest.contentHash)) {
    throw new PluginRuntimeError('INVALID_MANIFEST', `插件 ${manifest.id} 的 contentHash 必须是 SHA-256`);
  }

  const dependencies = new Set<string>();
  for (const dependency of manifest.dependencies ?? []) {
    if (!PLUGIN_ID_RE.test(dependency.id)) {
      throw new PluginRuntimeError('INVALID_MANIFEST', `插件 ${manifest.id} 的依赖 ID 无效：${dependency.id}`);
    }
    if (dependency.id === manifest.id) {
      throw new PluginRuntimeError('DEPENDENCY_CYCLE', `插件 ${manifest.id} 不能依赖自身`);
    }
    if (dependencies.has(dependency.id)) {
      throw new PluginRuntimeError('INVALID_MANIFEST', `插件 ${manifest.id} 重复声明依赖 ${dependency.id}`);
    }
    dependencies.add(dependency.id);
  }

  const contributions = new Set<string>();
  for (const contribution of manifest.contributions ?? []) {
    if (!contribution.id.trim()) {
      throw new PluginRuntimeError('INVALID_MANIFEST', `插件 ${manifest.id} 声明了空能力 ID`);
    }
    if (contribution.kind === 'capability' && !contribution.id.startsWith(`${manifest.id}.`)) {
      throw new PluginRuntimeError(
        'INVALID_MANIFEST',
        `插件能力 ${contribution.id} 必须使用 ${manifest.id}. 前缀`,
      );
    }
    const key = `${contribution.kind}\u0000${contribution.id}`;
    if (contributions.has(key)) {
      throw new PluginRuntimeError(
        'INVALID_MANIFEST',
        `插件 ${manifest.id} 重复声明 ${contribution.kind} 能力 ${contribution.id}`,
      );
    }
    contributions.add(key);
  }
}

function assertNoContributionConflicts(definitions: readonly AnyPluginDefinition[]): void {
  const owners = new Map<string, string>();
  for (const definition of definitions) {
    for (const contribution of definition.manifest.contributions ?? []) {
      const key = `${contribution.kind}\u0000${contribution.id}`;
      const owner = owners.get(key);
      if (owner) {
        throw new PluginRuntimeError(
          'CONTRIBUTION_CONFLICT',
          `${contribution.kind} 能力 ${contribution.id} 同时由插件 ${owner} 和 ${definition.manifest.id} 声明`,
        );
      }
      owners.set(key, definition.manifest.id);
    }
  }
}

export function resolvePluginGraph(
  selections: readonly SpacePluginSelection[],
  deployments: ReadonlyMap<string, AnyPluginDefinition>,
): AnyPluginDefinition[] {
  const selected = new Map<string, { selection: SpacePluginSelection; definition: AnyPluginDefinition }>();
  for (const selection of selections) {
    if (selected.has(selection.id)) {
      throw new PluginRuntimeError('DUPLICATE_PLUGIN', `空间配置重复选择插件 ${selection.id}`);
    }
    const definition = deployments.get(deploymentKey(selection.id, selection.version, selection.contentHash));
    if (!definition) {
      throw new PluginRuntimeError(
        'DEPLOYMENT_NOT_FOUND',
        `找不到插件部署 ${selection.id}@${selection.version} (${selection.contentHash})`,
      );
    }
    selected.set(selection.id, { selection, definition });
  }

  for (const { definition } of selected.values()) {
    for (const dependency of definition.manifest.dependencies ?? []) {
      const target = selected.get(dependency.id);
      if (!target) {
        if (dependency.optional) continue;
        throw new PluginRuntimeError(
          'MISSING_DEPENDENCY',
          `插件 ${definition.manifest.id} 缺少依赖 ${dependency.id}`,
        );
      }
      if (dependency.version && target.selection.version !== dependency.version) {
        throw new PluginRuntimeError(
          'DEPENDENCY_VERSION_MISMATCH',
          `插件 ${definition.manifest.id} 要求 ${dependency.id}@${dependency.version}，实际为 ${target.selection.version}`,
        );
      }
    }
  }

  assertNoContributionConflicts([...selected.values()].map((item) => item.definition));

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: AnyPluginDefinition[] = [];
  const stack: string[] = [];
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      const cycle = [...stack.slice(start), id].join(' -> ');
      throw new PluginRuntimeError('DEPENDENCY_CYCLE', `插件依赖存在循环：${cycle}`);
    }
    visiting.add(id);
    stack.push(id);
    const item = selected.get(id)!;
    for (const dependency of item.definition.manifest.dependencies ?? []) {
      if (selected.has(dependency.id)) visit(dependency.id);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    ordered.push(item.definition);
  };

  // 保留空间配置中的插件顺序；依赖仍然先于依赖方激活，独立插件按管理员排列顺序激活。
  for (const id of selected.keys()) visit(id);
  return ordered;
}

export function contributionKey(kind: PluginContributionKind, id: string): string {
  return `${kind}\u0000${id}`;
}
