'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { prepareHome, importThread } = require('../src/codex-home.cjs');

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-home-'));
  const source = path.join(root, 'desktop'), home = path.join(root, 'plugin');
  fs.mkdirSync(source);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { source, home };
}

test('config refresh keeps plugin sessions independent and never copies managed login tokens', t => {
  const { source, home } = setup(t);
  fs.writeFileSync(path.join(source, 'config.toml'), 'model="first"');
  for (const dir of ['sessions', 'thread-writer-locks', 'skills']) fs.mkdirSync(path.join(source, dir));
  fs.writeFileSync(path.join(source, 'state_5.sqlite'), 'desktop-db');
  prepareHome(home, source);
  assert.equal(fs.existsSync(path.join(home, 'auth.json')), false);
  assert.equal(fs.existsSync(path.join(home, 'state_5.sqlite')), false);
  assert.equal(fs.existsSync(path.join(home, 'thread-writer-locks')), false);
  assert.equal(fs.existsSync(path.join(home, 'sessions')), false);
  assert.equal(fs.realpathSync(path.join(home, 'skills')), fs.realpathSync(path.join(source, 'skills')));
  fs.writeFileSync(path.join(home, 'state_5.sqlite'), 'plugin-db');
  fs.writeFileSync(path.join(source, 'config.toml'), 'model="next"');
  prepareHome(home, source);
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'model="next"');
  assert.equal(fs.readFileSync(path.join(home, 'state_5.sqlite'), 'utf8'), 'plugin-db');
  fs.writeFileSync(path.join(source, 'auth.json'), 'managed-login');
  assert.throws(() => prepareHome(home, source), /一次性设置/);
  assert.equal(fs.existsSync(path.join(home, 'auth.json')), false);
});

test('existing thread history imports once and later plugin turns never overwrite the desktop history', t => {
  const { source, home } = setup(t), id = '01234567-89ab-cdef-0123-456789abcdef';
  const dir = path.join(source, 'sessions', '2026', '11', '13');
  fs.mkdirSync(dir, { recursive: true });
  const name = `rollout-2026-11-13T15-20-56-${id}.jsonl`, original = path.join(dir, name);
  fs.writeFileSync(original, 'original history\n');
  importThread(home, source, id);
  const migrated = path.join(home, 'sessions', name);
  assert.equal(fs.readFileSync(migrated, 'utf8'), 'original history\n');
  fs.appendFileSync(migrated, 'plugin reply\n');
  fs.appendFileSync(original, 'desktop turn\n');
  importThread(home, source, id);
  assert.equal(fs.readFileSync(migrated, 'utf8'), 'original history\nplugin reply\n');
  assert.equal(fs.readFileSync(original, 'utf8'), 'original history\ndesktop turn\n');
});
