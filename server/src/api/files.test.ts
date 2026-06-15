import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewTextLines } from './files.js';

test('render preview keeps long lines intact', () => {
  const longLine = `const DATA = ${'x'.repeat(13_000)};`;

  const sourceLines = previewTextLines(longLine);
  assert.match(sourceLines[0], /预览已截断/);

  const renderLines = previewTextLines(longLine, { truncateLongLines: false });
  assert.equal(renderLines[0], longLine);
});
