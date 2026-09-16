export type SpaceMode = 'web' | 'external';

export interface SpaceSummary {
  id: string;
  tenantId: string;
  mode: SpaceMode;
  name: string;
  executionUserId: string | null;
  config: Record<string, unknown>;
  configVersion: number;
  createdByUserId: string | null;
  visibleUserIds: string[];
  isDefault: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSpaceInput {
  mode: SpaceMode;
  name: string;
  executionUserId?: string | null;
  config?: Record<string, unknown>;
  visibleUserIds?: string[];
}

export interface UpdateSpaceInput {
  name?: string;
  executionUserId?: string | null;
  config?: Record<string, unknown>;
  visibleUserIds?: string[];
}
