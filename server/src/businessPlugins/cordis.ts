import { z } from 'zod';
import type {
  PluginContributionDeclaration,
  JsonValue,
  RunForgePluginDefinition,
  SpacePluginSelection,
} from '../plugins/types.js';
import type { BusinessPluginDefinition } from './types.js';

function internalPluginId(definition: BusinessPluginDefinition): string {
  return `business.${definition.manifest.id}`;
}

function internalPluginIdByBusinessId(id: string): string {
  return `business.${id}`;
}

function skillContributionId(definition: BusinessPluginDefinition, skillId: string): string {
  return `business:${definition.manifest.id}/skill/${skillId}`;
}

function mcpContributionId(definition: BusinessPluginDefinition, mcpId: string): string {
  return `business:${definition.manifest.id}/mcp/${mcpId}`;
}

function resourceContributionId(definition: BusinessPluginDefinition, type: string): string {
  return `${internalPluginId(definition)}.resource.${type}`;
}

/**
 * 业务插件本身不包含 Cordis 代码。这里把声明式目录转换成 RunForge 维护的通用 Cordis
 * definition，确保生命周期和动态能力注册仍由 RunForge 控制。
 */
export function createBusinessPluginCordisDefinition(
  definition: BusinessPluginDefinition,
): RunForgePluginDefinition<Record<string, unknown>> {
  const contributions: PluginContributionDeclaration[] = [
    ...definition.manifest.skills.map((skill) => ({
      kind: 'skill' as const,
      id: skillContributionId(definition, skill.id),
    })),
    ...definition.manifest.mcpServers.map((server) => ({
      kind: 'mcp' as const,
      id: mcpContributionId(definition, server.id),
    })),
    ...definition.manifest.resources.map((resource) => ({
      kind: 'capability' as const,
      id: resourceContributionId(definition, resource.type),
    })),
  ];
  return {
    manifest: {
      id: internalPluginId(definition),
      version: definition.manifest.version ?? `local-${definition.contentHash.slice(0, 12)}`,
      contentHash: definition.contentHash,
      dependencies: (definition.manifest.dependencies ?? []).map((dependency) => ({
        ...dependency,
        id: internalPluginIdByBusinessId(dependency.id),
      })),
      contributions,
    },
    // JSON Schema 已在 tenant 配置边界校验；Cordis 这里只保证配置是普通 JSON 对象。
    configSchema: z.record(z.string(), z.unknown()),
    setup: (context) => {
      for (const skill of definition.manifest.skills) {
        context.contribute('skill', skillContributionId(definition, skill.id), {
          businessPluginId: definition.manifest.id,
          definition: skill,
        });
      }
      for (const server of definition.manifest.mcpServers) {
        context.contribute('mcp', mcpContributionId(definition, server.id), {
          businessPluginId: definition.manifest.id,
          definition: server,
        });
      }
      for (const resource of definition.manifest.resources) {
        context.contribute('capability', resourceContributionId(definition, resource.type), {
          businessPluginId: definition.manifest.id,
          definition: resource,
        });
      }
    },
  };
}

export function createBusinessPluginSelection(
  definition: BusinessPluginDefinition,
  config: JsonValue = {},
): SpacePluginSelection {
  return {
    id: internalPluginId(definition),
    version: definition.manifest.version ?? `local-${definition.contentHash.slice(0, 12)}`,
    contentHash: definition.contentHash,
    config,
  };
}
