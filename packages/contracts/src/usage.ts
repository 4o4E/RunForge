export interface UsageScopeOption {
  id: string;
  label: string;
  tenantId?: string;
}

export interface TokenUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  attemptedTokens: number;
  effectiveTokens: number;
  attempts: number;
  attemptsWithUsage: number;
  attemptsWithoutUsage: number;
}

export interface TokenUsagePoint extends TokenUsageTotals {
  date: string;
}

export interface TokenUsageBreakdown extends TokenUsageTotals {
  id: string;
  label: string;
  tenantId?: string;
}

export interface StorageUsageTotals {
  logicalBytes: number;
  allocatedBytes: number;
  fileCount: number;
  symlinkCount: number;
}

export interface StorageUsagePoint extends StorageUsageTotals {
  at: string;
  period: 'hour' | 'day';
}

export interface StorageUsageBreakdown extends StorageUsageTotals {
  id: string;
  label: string;
  tenantId?: string;
}

export interface UsageAggregateResponse {
  generatedAt: string;
  filters: {
    from: string;
    to: string;
    tenantId: string | null;
    userId: string | null;
    spaceId: string | null;
  };
  options: {
    tenants: UsageScopeOption[];
    users: UsageScopeOption[];
    spaces: UsageScopeOption[];
  };
  tokens: {
    totals: TokenUsageTotals;
    daily: TokenUsagePoint[];
    byTenant: TokenUsageBreakdown[];
    byUser: TokenUsageBreakdown[];
    bySpace: TokenUsageBreakdown[];
    byModel: TokenUsageBreakdown[];
    byPurpose: TokenUsageBreakdown[];
  };
  storage: {
    capturedAt: string | null;
    totals: StorageUsageTotals;
    history: StorageUsagePoint[];
    byTenant: StorageUsageBreakdown[];
    byUser: StorageUsageBreakdown[];
    bySpace: StorageUsageBreakdown[];
    byCategory: StorageUsageBreakdown[];
  };
}
