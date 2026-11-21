'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { describeSource } = require('../src/source-document.cjs');

test('Markdown source changes are distinguishable while appended comments do not change its version', () => {
  const file = { path: 'nested/article.md', extension: 'md' }, root = path.resolve('fixture');
  const a = describeSource(root, file, '全文内容', 'doc-id');
  const b = describeSource(root, file, '全文内容\n<!--co:a by:me status:open\nme: @chat 问题\n-->\n', 'doc-id');
  const c = describeSource(root, file, '修改后的全文', 'doc-id');
  assert.equal(a.path, path.join(root, file.path));
  assert.equal(a.version, b.version);
  assert.notEqual(a.version, c.version);
});
