'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scanChangedFiles } = require('../src/git.cjs');

function git(cwd, ...args) { return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }).trim(); }
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-git-'));
  git(root, 'init', '-b', 'main'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
  for (const [name, text] of [['keep.md', 'keep'], ['修改.md', 'one'], ['delete.md', 'delete'], ['旧名.md', 'rename']]) {
    fs.writeFileSync(path.join(root, name), text);
  }
  git(root, 'add', '--', '.'); git(root, 'commit', '-m', 'baseline');
  return { root, baseline: git(root, 'rev-parse', 'HEAD') };
}

test('returns deterministic Unicode-safe candidates across baseline, staged, unstaged, untracked, delete, and rename', async t => {
  const { root, baseline } = repository(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'mv', '--', '旧名.md', '新名字.md');
  fs.writeFileSync(path.join(root, '修改.md'), 'staged'); git(root, 'add', '--', '修改.md');
  fs.appendFileSync(path.join(root, '修改.md'), '-unstaged');
  fs.rmSync(path.join(root, 'delete.md'));
  fs.writeFileSync(path.join(root, '暂存.md'), 'staged'); git(root, 'add', '--', '暂存.md');
  fs.writeFileSync(path.join(root, '未跟踪.md'), 'untracked');
  const before = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root });
  const result = await scanChangedFiles({ cwd: root, baseline });
  const after = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root });
  assert.equal(result.ok, true); assert.equal(result.baseline, baseline); assert.deepEqual(after, before);
  assert.deepEqual(result.candidates.map(item => item.path), [...result.candidates.map(item => item.path)].sort());
  const byPath = new Map(result.candidates.map(item => [item.path, item]));
  assert.equal(byPath.get('delete.md').status, 'deleted');
  assert.deepEqual(byPath.get('新名字.md'), { path: '新名字.md', oldPath: '旧名.md', status: 'renamed', sources: ['baseline', 'staged'] });
  assert.equal(byPath.get('暂存.md').status, 'added');
  assert.equal(byPath.get('未跟踪.md').status, 'added');
  assert.deepEqual(byPath.get('修改.md').sources, ['baseline', 'staged', 'unstaged']);
});

test('limits paths to a nested cwd and keeps paths relative to that cwd', async t => {
  const { root, baseline } = repository(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nested = path.join(root, '课程'); fs.mkdirSync(nested); fs.writeFileSync(path.join(nested, '讲义.md'), 'x');
  fs.writeFileSync(path.join(root, 'outside.md'), 'outside');
  const result = await scanChangedFiles({ cwd: nested, baseline });
  assert.equal(result.ok, true); assert.deepEqual(result.candidates.map(item => item.path), ['讲义.md']);
});

test('returns explicit fallback signals without touching repository state', async t => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-git-plain-'));
  t.after(() => fs.rmSync(plain, { recursive: true, force: true }));
  assert.equal((await scanChangedFiles({ cwd: plain, baseline: '0'.repeat(40), executable: path.join(plain, 'missing-git') })).reason, 'git-unavailable');
  assert.equal((await scanChangedFiles({ cwd: plain, baseline: '0'.repeat(40) })).reason, 'not-repository');

  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-git-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true })); git(empty, 'init', '-b', 'main');
  assert.equal((await scanChangedFiles({ cwd: empty, baseline: '0'.repeat(40) })).reason, 'no-history');

  const { root, baseline } = repository(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal((await scanChangedFiles({ cwd: root })).reason, 'baseline-missing');
  assert.equal((await scanChangedFiles({ cwd: root, baseline: '0'.repeat(40) })).reason, 'baseline-missing');
  git(root, 'checkout', '--orphan', 'rewritten'); git(root, 'commit', '--allow-empty', '-m', 'rewritten');
  const rewritten = await scanChangedFiles({ cwd: root, baseline });
  assert.equal(rewritten.reason, 'history-rewritten');
});
