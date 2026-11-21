'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openVaultFile } = require('../src/navigation.cjs');

for (const extension of ['md', 'pdf']) test(`opening an existing ${extension} explicitly reveals and focuses its tab`, async () => {
  const file = { path: `course/file.${extension}`, extension }, calls = [];
  const leaf = { view: { file } };
  const app = { vault: { getAbstractFileByPath: name => name === file.path ? file : null }, workspace: {
    iterateAllLeaves: cb => { cb({ view: {} }); cb(leaf); },
    getLeaf: () => { throw Error('must reuse existing tab'); },
    revealLeaf: async l => calls.push(['reveal', l]),
    setActiveLeaf: (l, options) => calls.push(['activate', l, options])
  } };
  assert.equal(await openVaultFile(app, file.path), leaf);
  assert.deepEqual(calls, [['reveal', leaf], ['activate', leaf, { focus: true }]]);
  await assert.rejects(openVaultFile(app, 'missing.md'), /不存在或已移动/);
});

test('unopened file gets a new tab without replacing current file', async () => {
  const file = { path: 'chat/a.md', extension: 'md' }, calls = [];
  const leaf = { openFile: async (...args) => calls.push(['open', ...args]) };
  const app = { vault: { getAbstractFileByPath: () => file }, workspace: {
    iterateAllLeaves: () => {},
    getLeaf: type => { assert.equal(type, 'tab'); return leaf; },
    revealLeaf: async l => calls.push(['reveal', l]),
    setActiveLeaf: (l, opts) => calls.push(['activate', l, opts])
  } };
  await openVaultFile(app, file.path);
  assert.deepEqual(calls, [['open', file, { active: true }], ['reveal', leaf], ['activate', leaf, { focus: true }]]);
});
