'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { applyPendingSettings } = require('../src/settings-update.cjs');
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.installation'));
  const file = path.join(dir, '.installation/settings-on-reload.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, model: 'gpt-5.6-sol', effort: 'high' }));
  return { dir, file };
}
test('staged explicit model setting survives old data and is consumed only after persistence', async t => {
  const { dir, file } = fixture(t); let saved;
  const plugin = { settings: { model: 'gpt-5.6-luna', effort: 'low', autoMention: false }, sessions: { a: { threadId: 'same-thread' } },
    async saveLocal() { assert.equal(fs.existsSync(file), true); saved = { settings: { ...this.settings }, sessions: this.sessions }; } };
  assert.equal(await applyPendingSettings(plugin, dir), true);
  assert.deepEqual(saved.settings, { model: 'gpt-5.6-sol', effort: 'high', autoMention: false });
  assert.equal(saved.sessions.a.threadId, 'same-thread'); assert.equal(fs.existsSync(file), false);
  assert.equal(await applyPendingSettings(plugin, dir), false);
});
test('failed persistence keeps the staged change for next reload', async t => {
  const { dir, file } = fixture(t);
  await assert.rejects(applyPendingSettings({ settings: {}, saveLocal: async () => { throw new Error('disk error'); } }, dir), /disk error/);
  assert.equal(fs.existsSync(file), true);
});
test('a newer concurrent model choice is not deleted', async t => {
  const { dir, file } = fixture(t), replacement = JSON.stringify({ version: 1, model: 'gpt-5.6-sol', effort: 'medium' });
  await applyPendingSettings({ settings: {}, saveLocal: async () => fs.writeFileSync(file, replacement) }, dir);
  assert.equal(fs.readFileSync(file, 'utf8'), replacement);
});
