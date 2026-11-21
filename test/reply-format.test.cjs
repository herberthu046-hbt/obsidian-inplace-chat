'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { REPLY_FORMAT } = require('../src/reply-format.cjs');
const C = require('../src/comments.cjs');

test('formula instructions contain literal TeX and JSON examples, not control characters', () => {
  assert.doesNotMatch(REPLY_FORMAT, /[\x00-\x1f]/);
  for (const command of ['mathbf', 'frac', 'beta', 'int']) {
    assert.ok(REPLY_FORMAT.includes('\\' + command));
    assert.ok(REPLY_FORMAT.includes('\\\\' + command));
    assert.equal(JSON.parse('"\\\\' + command + '"'), '\\' + command);
  }
  assert.match(REPLY_FORMAT, /U\+0000/);
});

test('every request includes formula instructions, including reused sessions', () => {
  const result = C.prepare('a.md', '', [], {}, 16000);
  assert.ok(result.prompt.includes(REPLY_FORMAT));
  assert.deepEqual(JSON.parse(result.prompt.slice(result.prompt.indexOf('{'))).requests, []);
});
