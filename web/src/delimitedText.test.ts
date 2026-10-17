import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDelimitedText } from './delimitedText.js';

test('结束换行不增加记录，空文件和仅 BOM 文件没有记录', () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    assert.deepEqual(parseDelimitedText(`name${ending}alice${ending}`, 'csv').data, [['name'], ['alice']]);
  }
  assert.deepEqual(parseDelimitedText('', 'csv').data, []);
  assert.deepEqual(parseDelimitedText('\uFEFF', 'csv').data, []);
});

test('单列空字段和空白记录保持原始次序，包括文件最后的实际空记录', () => {
  assert.deepEqual(parseDelimitedText('label\r\n""\r\n\r\nlast\r\n', 'csv').data, [['label'], [''], [''], ['last']]);
  assert.deepEqual(parseDelimitedText('label\n""', 'csv').data, [['label'], ['']]);
  assert.deepEqual(parseDelimitedText('label\n\n', 'csv').data, [['label'], ['']]);
  assert.deepEqual(parseDelimitedText('\n', 'csv').data, [['']]);
});

test('结束换行处理不会删除多列空字段或修改引号内的换行', () => {
  assert.deepEqual(parseDelimitedText(',\n', 'csv').data, [['', '']]);
  assert.deepEqual(parseDelimitedText('\t\n', 'tsv').data, [['', '']]);
  assert.deepEqual(parseDelimitedText('""\n', 'csv').data, [['']]);
  assert.deepEqual(parseDelimitedText('"多行\n"', 'csv').data, [['多行\n']]);
  assert.deepEqual(parseDelimitedText('"多行\n"\n', 'csv').data, [['多行\n']]);
});
