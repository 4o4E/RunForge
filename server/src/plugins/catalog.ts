import { PluginRuntimeError } from './errors.js';
import { contributionKey } from './graph.js';
import type {
  CapabilityCatalogSnapshot,
  PluginContribution,
  PluginContributionKind,
} from './types.js';

function freezeList(values: Iterable<PluginContribution>): readonly PluginContribution[] {
  return Object.freeze([...values].map((item) => Object.freeze({ ...item })));
}
export class DynamicCapabilityCatalog {
  private readonly entries = new Map<string, PluginContribution>();

  register<T>(kind: PluginContributionKind, id: string, ownerPluginId: string, value: T): () => void {
    const key = contributionKey(kind, id);
    const existing = this.entries.get(key);
    if (existing) {
      throw new PluginRuntimeError(
        'CONTRIBUTION_CONFLICT',
        `${kind} 能力 ${id} 已由插件 ${existing.ownerPluginId} 注册，插件 ${ownerPluginId} 不能重复注册`,
      );
    }
    const contribution = Object.freeze({ kind, id, ownerPluginId, value });
    this.entries.set(key, contribution);
    return () => {
      if (this.entries.get(key) === contribution) this.entries.delete(key);
    };
  }

  snapshot(): CapabilityCatalogSnapshot {
    const byKind = (kind: PluginContributionKind) =>
      freezeList([...this.entries.values()].filter((item) => item.kind === kind));
    return Object.freeze({
      tools: byKind('tool'),
      skills: byKind('skill'),
      mcpServers: byKind('mcp'),
      capabilities: byKind('capability'),
    });
  }
}
