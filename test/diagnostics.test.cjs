'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DiagnosticStore, sanitizeEvent, summarizeReceipts } = require('../src/diagnostics.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-diagnostics-'));
const usage = (input, output, total = input + output) => ({
  totalTokens: total,
  inputTokens: input,
  cachedInputTokens: 2,
  cacheWriteInputTokens: 1,
  outputTokens: output,
  reasoningOutputTokens: 3
});

test('events use an explicit whitelist and redact paths, emails and bearer-like secrets', () => {
  const event = sanitizeEvent({
    actionId: 'action-1', stage: 'prepare', status: 'blocked',
    reason: 'C:\\Users\\name\\note.md notes/private.md user@example.com Bearer abcdefghijklmnop',
    counts: { pending: 2, bad: 'two', '../path': 9 },
    elapsedMs: 12, model: 'gpt-test', effort: 'high',
    usage: { last: usage(10, 4), secret: 'drop' },
    prompt: 'private body', path: 'C:\\secret.md', email: 'other@example.com', token: 'secret'
  }, Date.parse('2026-09-18T00:00:00Z'));
  assert.equal(event.schemaVersion, 1);
  assert.equal(event.at, '2026-09-18T00:00:00.000Z');
  assert.equal(event.actionId, 'action-1');
  assert.match(event.reason, /\[path\]/);
  assert.equal(event.reason.includes('notes/private.md'), false);
  assert.match(event.reason, /\[email\]/);
  assert.match(event.reason, /Bearer \[redacted\]/);
  assert.deepEqual(event.counts, { pending: 2 });
  assert.equal(event.usage.last.inputTokens, 10);
  for (const forbidden of ['prompt', 'path', 'email', 'token']) assert.equal(event[forbidden], undefined);
  assert.equal(JSON.stringify(event).includes('private body'), false);
});

test('hotkey diagnostics retain only safe event metadata', () => {
  const event = sanitizeEvent({
    stage: 'hotkey_event', key: 'Enter', code: 'NumpadEnter', modifiers: 'Alt', scope: 'pdf_popover',
    defaultPrevented: true, repeat: false, isComposing: false, commentText: '@chat private body'
  }, Date.parse('2026-09-18T00:00:00Z'));
  assert.deepEqual({ key: event.key, code: event.code, modifiers: event.modifiers, scope: event.scope }, {
    key: 'Enter', code: 'NumpadEnter', modifiers: 'Alt', scope: 'pdf_popover'
  });
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.commentText, undefined);
  assert.equal(JSON.stringify(event).includes('private body'), false);
});

test('store batches JSONL, reads recent events in order and flushes on close', () => {
  const root = temp();
  let now = Date.parse('2026-09-18T01:00:00Z');
  const store = new DiagnosticStore(root, { now: () => now });
  store.record({ id: 'one', stage: 'trigger' });
  now += 1000;
  store.record({ id: 'two', stage: 'prepare' });
  assert.equal(fs.existsSync(root), true);
  assert.deepEqual(store.readRecent(1).map(item => item.id), ['two']);
  store.close();
  assert.deepEqual(store.readRecent(10).map(item => item.id), ['one', 'two']);
  assert.equal(store.error, null);
});

test('retention and total size rotation remove old segments while keeping recent data', () => {
  const root = temp();
  const store = new DiagnosticStore(root, { maxBytes: 1500, maxFiles: 2 });
  for (let index = 0; index < 24; index++) store.record({ id: `old-${index}`, reason: 'x'.repeat(220) });
  store.flush();
  assert.equal(fs.readFileSync(path.join(root, '.gitignore'), 'utf8'), '*\n');
  const first = fs.readdirSync(root).filter(name => name.endsWith('.jsonl')).map(name => path.join(root, name))[0];
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  fs.utimesSync(first, old, old);
  store.record({ id: 'recent', stage: 'done' });
  store.flush();
  const files = fs.readdirSync(root).filter(name => name.endsWith('.jsonl'));
  assert.ok(files.length <= 2);
  assert.ok(store.readRecent(50).some(item => item.id === 'recent'));
  assert.equal(fs.existsSync(first), false);
});

test('write failures set error and never throw into the caller', () => {
  const root = temp();
  const notDirectory = path.join(root, 'file');
  fs.writeFileSync(notDirectory, 'occupied');
  const store = new DiagnosticStore(notDirectory);
  assert.doesNotThrow(() => {
    store.record({ stage: 'trigger' });
    store.flush();
    store.close();
  });
  assert.ok(store.error instanceof Error);
});

test('lost buffered events remain counted after storage recovers', () => {
  const root = temp(), directory = path.join(root, 'blocked');
  fs.writeFileSync(directory, 'occupied');
  const store = new DiagnosticStore(directory, { maxBytes: 1024 });
  for (let i = 0; i < 100; i++) store.record({ stage: 'failure', reason: 'x'.repeat(1000) });
  assert.ok(store.droppedEvents > 0);
  const dropped = store.droppedEvents;
  fs.renameSync(directory, path.join(root, 'obstruction'));
  store.flush();
  assert.equal(store.error, null);
  assert.equal(store.droppedEvents, dropped);
});

test('receipt summary deduplicates recovery, prefers cumulative deltas and never adds total snapshots', () => {
  const common = {
    threadId: 'thread-1',
    accountScope: { key: 'scope-1', stable: true },
    threadScope: { modelProvider: 'openai' },
    provider: { model: 'gpt-test', effort: 'high' }
  };
  const jobs = [
    { ...common, id: 'job-a', turnId: 'turn-1', status: 'failed', createdAt: '2026-09-18T00:00:00Z', usage: { last: usage(10, 4), total: usage(10, 4) } },
    { ...common, id: 'job-b', turnId: 'turn-1', status: 'applied', createdAt: '2026-09-18T00:01:00Z', result: { usage: { last: usage(12, 5), total: usage(12, 5) }, model: 'gpt-test' } },
    { ...common, id: 'job-c', turnId: 'turn-2', status: 'applied', createdAt: '2026-09-18T00:02:00Z', aggregateUsage: usage(20, 6), usageCompleteness: 'cumulative-delta-sample', usage: { last: usage(7, 2), total: usage(32, 11) } },
    { id: 'job-d', threadId: 'thread-2', turnId: 'turn-x', status: 'failed', threadScope: { accountScopeKey: 'scope-2', accountScopeStable: true } }
  ];
  const summary = summarizeReceipts(jobs);
  assert.equal(summary.summary.receiptCount, 4);
  assert.equal(summary.summary.deduplicatedRows, 3);
  assert.equal(summary.summary.withSample, 2);
  assert.equal(summary.summary.missingUsage, 1);

  const recovered = summary.rows.find(row => row.turnId === 'turn-1');
  assert.deepEqual(recovered.jobIds, ['job-a', 'job-b']);
  assert.equal(recovered.usage.kind, 'last-sample-only');
  assert.equal(recovered.usage.sample.inputTokens, 12);

  const delta = summary.rows.find(row => row.turnId === 'turn-2');
  assert.equal(delta.usage.kind, 'cumulative-delta-sample');
  assert.equal(delta.usage.completeness, 'cumulative-delta-sample');
  assert.equal(delta.usage.sample.inputTokens, 20);
  assert.equal(delta.usage.total.inputTokens, 32);

  assert.equal(summary.summary.sampleSums.inputTokens, 32);
  assert.match(summary.summary.sampleSumsKind, /not-guaranteed/);
  assert.equal(summary.latestThreadTotals.length, 1);
  assert.equal(summary.latestThreadTotals[0].tokens.inputTokens, 32);
  assert.match(summary.latestThreadTotals[0].note, /not added/);
  assert.equal(summary.summary.unknownByField.inputTokens, 1);
});

test('same turn in different account scopes remains separate and missing usage is never zero-filled', () => {
  const summary = summarizeReceipts([
    { id: 'a', threadId: 'thread', turnId: 'turn', accountScope: { key: 'one' } },
    { id: 'b', threadId: 'thread', turnId: 'turn', accountScope: { key: 'two' } }
  ]);
  assert.equal(summary.rows.length, 2);
  assert.equal(summary.summary.missingUsage, 2);
  for (const row of summary.rows) {
    assert.equal(row.usage.sample, null);
    assert.equal(row.usage.kind, 'unknown');
    assert.deepEqual(row.usage.unknownFields.sort(), [...row.usage.unknownFields].sort());
  }
  assert.deepEqual(summary.summary.sampleSums, {});
});
