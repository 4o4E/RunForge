import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  newArtifactId,
  newAuthTokenId,
  newDatasourceAccountId,
  newDatasourceId,
  newDatasourceLeaseId,
  newDatasourceProfileId,
  newExternalCallerId,
  newExternalRequestId,
  newExternalTokenId,
  newId,
  newWorkloadSecretAccessId,
  newProviderAttemptId,
  newProviderInvocationId,
  newRunId,
  newRunInputId,
  newRuntimeCapabilityCallId,
  newShellCommandId,
  newShellSessionId,
  newSpaceId,
  newStepId,
  newSubagentRunId,
  newSystemAdminId,
  newSystemAdminTokenId,
  newTenantId,
  newThreadId,
  newUserId,
  newWorkloadTokenId,
} from './id.js';

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
  assert.match(newSpaceId(), /^sp_[0-9A-Za-z]+$/);
  assert.match(newTenantId(), /^tn_[0-9A-Za-z]+$/);
  assert.match(newUserId(), /^us_[0-9A-Za-z]+$/);
  assert.match(newAuthTokenId(), /^at_[0-9A-Za-z]+$/);
  assert.match(newSystemAdminId(), /^sa_[0-9A-Za-z]+$/);
  assert.match(newSystemAdminTokenId(), /^rt_[0-9A-Za-z]+$/);
  assert.match(newDatasourceId(), /^ds_[0-9A-Za-z]+$/);
  assert.match(newDatasourceProfileId(), /^dp_[0-9A-Za-z]+$/);
  assert.match(newDatasourceAccountId(), /^da_[0-9A-Za-z]+$/);
  assert.match(newDatasourceLeaseId(), /^dl_[0-9A-Za-z]+$/);
  assert.match(newWorkloadTokenId(), /^wt_[0-9A-Za-z]+$/);
  assert.match(newRuntimeCapabilityCallId(), /^rc_[0-9A-Za-z]+$/);
  assert.match(newShellSessionId(), /^ss_[0-9A-Za-z]+$/);
  assert.match(newShellCommandId(), /^sc_[0-9A-Za-z]+$/);
  assert.match(newSubagentRunId(), /^sr_[0-9A-Za-z]+$/);
  assert.match(newExternalCallerId(), /^ec_[0-9A-Za-z]+$/);
  assert.match(newExternalTokenId(), /^et_[0-9A-Za-z]+$/);
  assert.match(newExternalRequestId(), /^er_[0-9A-Za-z]+$/);
  assert.match(newRunInputId(), /^ri_[0-9A-Za-z]+$/);
  assert.match(newArtifactId(), /^ar_[0-9A-Za-z]+$/);
  assert.match(newWorkloadSecretAccessId(), /^ws_[0-9A-Za-z]+$/);
  assert.match(newProviderInvocationId(), /^pi_[0-9A-Za-z]+$/);
  assert.match(newProviderAttemptId(), /^pa_[0-9A-Za-z]+$/);
});
