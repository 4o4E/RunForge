import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatHexRows, parseByteRange, previewTextLines } from './files.js';
import { signFileShare, verifyFileShare } from './auth.js';
import { config } from '../config.js';
import { isOfficeConvertiblePath, officePdfCacheKey } from '../files/officePreview.js';

test('render preview keeps long lines intact', () => {
  const longLine = `const DATA = ${'x'.repeat(13_000)};`;

  const sourceLines = previewTextLines(longLine);
  assert.match(sourceLines[0], /预览已截断/);

  const renderLines = previewTextLines(longLine, { truncateLongLines: false });
  assert.equal(renderLines[0], longLine);
});

test('hex preview formats offset, bytes and ascii columns', () => {
  const rows = formatHexRows(Buffer.from([0x00, 0x20, 0x41, 0x7e, 0x7f]), 16);
  assert.deepEqual(rows, [
    {
      offset: 16,
      hex: '00 20 41 7E 7F',
      ascii: '. A~.',
    },
  ]);
});

test('byte range parser supports browser media requests', () => {
  assert.deepEqual(parseByteRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseByteRange('bytes=90-', 100), { start: 90, end: 99 });
  assert.deepEqual(parseByteRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.equal(parseByteRange('bytes=100-', 100), 'invalid');
});

test('file share signature binds path and expiry', () => {
  const previousAccessToken = config.auth.accessToken;
  const previousShareSecret = config.auth.shareSecret;
  config.auth.accessToken = 'test-access-token';
  config.auth.shareSecret = 'test-share-secret';
  try {
    const expires = 2000;
    const sig = signFileShare('artifacts/report.html', 'default', expires);

    assert.equal(verifyFileShare('artifacts/report.html', 'default', String(expires), sig, 1000), true);
    assert.equal(verifyFileShare('artifacts/other.html', 'default', String(expires), sig, 1000), false);
    assert.equal(verifyFileShare('artifacts/report.html', 'default', String(expires + 1), sig, 1000), false);
    assert.equal(verifyFileShare('artifacts/report.html', 'default', String(expires), sig, 2001), false);
    assert.equal(verifyFileShare('artifacts/report.html', 'other-tenant', String(expires), sig, 1000), false);
  } finally {
    config.auth.accessToken = previousAccessToken;
    config.auth.shareSecret = previousShareSecret;
  }
});

test('office pdf preview only accepts office documents', () => {
  assert.equal(isOfficeConvertiblePath('demo.pptx'), true);
  assert.equal(isOfficeConvertiblePath('demo.xlsx'), true);
  assert.equal(isOfficeConvertiblePath('demo.docx'), true);
  assert.equal(isOfficeConvertiblePath('demo.pdf'), false);
});

test('office pdf cache key changes when source metadata changes', () => {
  const base = { tenantId: 'default', remotePath: 'artifacts/demo.pptx', size: 10, mtimeMs: 100, converterUrl: 'http://converter:3000' };
  assert.equal(officePdfCacheKey(base), officePdfCacheKey(base));
  assert.notEqual(officePdfCacheKey(base), officePdfCacheKey({ ...base, mtimeMs: 101 }));
  assert.notEqual(officePdfCacheKey(base), officePdfCacheKey({ ...base, cacheVersion: 'fonts-v2' }));
  assert.notEqual(officePdfCacheKey(base), officePdfCacheKey({ ...base, tenantId: 'other-tenant' }));
});
