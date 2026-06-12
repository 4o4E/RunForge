import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newId, newRunId, newStepId, newThreadId } from './id.js';

test('newId: returns compact base62 snowflake ids', () => {
  const ids = Array.from({ length: 128 }, () => newId());
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[0-9A-Za-z]+$/);
    assert.doesNotMatch(id, /^[0-9a-f]{8}-/i);
  }
});

test('entity ids: include stable two-letter prefixes', () => {
  assert.match(newRunId(), /^ru_[0-9A-Za-z]+$/);
  assert.match(newThreadId(), /^th_[0-9A-Za-z]+$/);
  assert.match(newStepId(), /^st_[0-9A-Za-z]+$/);
});
