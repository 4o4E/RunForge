import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isExplicitImageRejection, omitImagesForTextContinuation } from './mediaFallback.js';

test('仅明确拒绝图片输入时才允许纯文本重试', () => {
  assert.equal(isExplicitImageRejection({ statusCode: 400, responseBody: '{"error":{"message":"This model does not support image inputs"}}' }), true);
  assert.equal(isExplicitImageRejection({ statusCode: 422, responseBody: 'unsupported image format' }), true);
  assert.equal(isExplicitImageRejection({ statusCode: 401, responseBody: 'This model does not support image inputs' }), false);
  assert.equal(isExplicitImageRejection({ statusCode: 400, responseBody: 'invalid image payload' }), false);
  assert.equal(isExplicitImageRejection(new Error('This model does not support image inputs')), false);
});

test('图片降级保留原始请求，并向模型标明图片内容不可见', () => {
  const original = [{
    role: 'user' as const,
    content: '这个按钮在哪里？',
    contentParts: [
      { type: 'text' as const, text: '这个按钮在哪里？' },
      { type: 'image' as const, data: 'aW1hZ2U=', mimeType: 'image/png', path: 'screen.png' },
    ],
  }];
  const result = omitImagesForTextContinuation(original);
  assert.equal(result.messages[0]?.contentParts, undefined);
  assert.match(result.messages[0]?.content ?? '', /请勿推断图片中的具体内容/);
  assert.equal(original[0].contentParts[1].type, 'image');
  assert.deepEqual(result.omitted, [{ path: 'screen.png', name: 'screen.png' }]);
});
