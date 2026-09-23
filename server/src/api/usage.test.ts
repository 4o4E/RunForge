import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UsageFilter } from '../usage/service.js';
import { applyPersonalUsageScope, UsageAccessError } from './usage.js';

function filter(input: Partial<UsageFilter> = {}): UsageFilter {
  return {
    from: new Date('2026-09-01T00:00:00.000Z'),
    to: new Date('2026-09-23T00:00:00.000Z'),
    tenantId: 'tn_usage',
    ...input,
  };
}

test('个人用量只允许当前用户和真正可见的空间', () => {
  const scoped = applyPersonalUsageScope(filter(), 'us_current', ['sp_visible']);
  assert.equal(scoped.userId, 'us_current');
  assert.equal(scoped.availableUserId, 'us_current');
  assert.deepEqual(scoped.availableSpaceIds, ['sp_visible']);

  assert.throws(
    () => applyPersonalUsageScope(filter({ userId: 'us_other' }), 'us_current', ['sp_visible']),
    (error: unknown) => error instanceof UsageAccessError && error.status === 403,
  );
  assert.throws(
    () => applyPersonalUsageScope(filter({ spaceId: 'sp_hidden' }), 'us_current', ['sp_visible']),
    (error: unknown) => error instanceof UsageAccessError && error.status === 403,
  );
});
