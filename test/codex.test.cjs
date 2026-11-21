'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexProvider, BASE, PROJECT_NAME, finalText } = require('../src/codex.cjs');
const { REPLY_FORMAT } = require('../src/reply-format.cjs');

const fake = path.resolve(__dirname, 'fake-app-server.cjs');
function setup(scenario = 'normal', options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-codex-'));
  const log = path.join(root, 'protocol.jsonl'), state = path.join(root, 'state.json');
  const provider = new CodexProvider({ executable: process.execPath, executableArgs: [fake, scenario, log, state], cwd: root,
    model: 'gpt-test', timeoutMs: 1000, ...options });
  return { root, log, state, provider, messages: () => fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map(JSON.parse) };
}
async function cleanup(...setups) {
  await Promise.all(setups.map(setup => setup.provider.close()));
  for (const setup of setups) fs.rmSync(setup.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

test('isolated provider launches with separate session, SQLite and log paths', async t => {
  const s = setup(); t.after(() => cleanup(s));
  s.provider.codexHome = path.join(s.root, 'plugin-home');
  s.provider.sourceCodexHome = path.join(s.root, 'desktop-home');
  fs.mkdirSync(s.provider.sourceCodexHome);
  await s.provider.start();
  const launch = s.messages()[0];
  assert.equal(launch.codexHome, s.provider.codexHome);
  assert.equal(launch.sqliteHome, s.provider.codexHome);
  assert.ok(launch.startup.includes(`sqlite_home=${JSON.stringify(s.provider.codexHome)}`));
  assert.ok(launch.startup.includes(`log_dir=${JSON.stringify(path.join(s.provider.codexHome, 'log'))}`));
});

test('uses full access, inherits tools, creates the named project, and exposes token-free account scope', async t => {
  const s = setup(); t.after(() => cleanup(s));
  const scope = await s.provider.getAccountScope();
  assert.equal(scope.type, 'chatgpt'); assert.equal(scope.stable, true);
  assert.ok(!JSON.stringify(scope).includes('reader@example.com'));
  const id = await s.provider.thread(null, 'article');
  const saved = s.provider.getThreadScope(id);
  assert.deepEqual(saved, { accountScopeKey: scope.key, accountScopeStable: true, model: 'gpt-test', modelProvider: 'openai' });
  const messages = s.messages(), start = messages.find(m => m.method === 'thread/start');
  assert.equal(messages.find(m => m.method === 'project/create').params.name, PROJECT_NAME);
  assert.equal(start.params.baseInstructions, BASE + '\n' + REPLY_FORMAT); assert.equal(start.params.developerInstructions, '');
  assert.equal(start.params.sandbox, 'danger-full-access'); assert.equal(start.params.approvalPolicy, 'never');
  assert.equal(start.params.config['mcp_servers.personal.enabled'], undefined);
  assert.equal(start.params.config['skills.config'], undefined);
  assert.equal(start.params.config['features.shell_tool'], true);
  assert.equal(start.params.config['features.view_image'], true);
  assert.equal(start.params.environments, undefined);
  assert.doesNotMatch(JSON.stringify(messages[0]), /features\.[^=]+=false|web_search=.*disabled/);
});

test('answers and recovers one validated final answer', async t => {
  const s = setup(); t.after(() => cleanup(s));
  const id = await s.provider.thread(); let receipt;
  const answer = await s.provider.answer(id, 'prompt', turn => { receipt = turn; });
  assert.equal(answer.turnId, receipt); assert.equal(answer.model, 'gpt-test'); assert.match(answer.text, /commentId/);
  const recovered = await s.provider.recover(id, receipt, s.provider.getThreadScope(id));
  assert.equal(recovered.text, answer.text);
  const sent = s.messages().find(m => m.method === 'turn/start');
  assert.equal(sent.params.sandboxPolicy.type, 'dangerFullAccess');
  assert.equal(sent.params.approvalPolicy, 'never');
  assert.deepEqual(sent.params.environments, [{ environmentId: 'local', cwd: s.provider.cwd }]);
});

test('standalone Codex without desktop projects can start and answer', async t => {
  const s = setup('no-projects'); t.after(() => cleanup(s));
  const id = await s.provider.thread(null, 'standalone');
  assert.match((await s.provider.answer(id, 'prompt')).text, /commentId/);
  assert.equal(s.messages().some(m => m.method === 'project/create'), false);
});

test('explicit model changes preserve the same existing thread', async t => {
  const s = setup(); t.after(() => cleanup(s));
  const id = await s.provider.thread('old-document-thread', 'document', { model: 'gpt-old', modelProvider: 'openai' });
  assert.equal(id, 'old-document-thread');
  assert.equal(s.messages().filter(m => m.method === 'thread/start').length, 0);
  const resume = s.messages().find(m => m.method === 'thread/resume');
  assert.equal(resume.params.model, 'gpt-test');
  assert.equal(resume.params.sandbox, 'danger-full-access');
});

for (const [status, code] of [['interrupted', 'TURN_INTERRUPTED'], ['failed', 'TURN_FAILED'], ['inProgress', 'TURN_NOT_RECOVERABLE']]) {
  test(`recovery classifies ${status} without starting or resuming a turn`, async t => {
    const s = setup(`recover-${status}`); t.after(() => cleanup(s));
    await assert.rejects(s.provider.recover('old-thread', 'old-turn'), error =>
      error.code === code && error.ambiguous === (status === 'inProgress'));
    assert.equal(s.messages().filter(m => ['turn/start', 'thread/start', 'thread/resume'].includes(m.method)).length, 0);
  });
}

test('answer emits isolated lifecycle and repeated raw usage events with a known cumulative baseline', async t => {
  const s = setup('slow'); t.after(() => cleanup(s));
  const id = await s.provider.thread();
  const events = [];
  const answer = await s.provider.answer(id, 'private prompt', turnId => {
    for (const tokenUsage of [
      { total: { totalTokens: 10, inputTokens: 8, outputTokens: 2 }, last: { totalTokens: 10 }, modelContextWindow: 100 },
      { total: { totalTokens: 14, inputTokens: 11, outputTokens: 3 }, last: { totalTokens: 14 }, modelContextWindow: 100 }
    ]) s.provider.handleLine(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: id, turnId, tokenUsage } }), s.provider.activeGeneration);
  }, event => {
    events.push(event);
    if (event.stage === 'usage' && event.sequence === 1) throw new Error('observer failure');
    if (event.stage === 'usage' && event.sequence === 2) return Promise.reject(new Error('async observer failure'));
  });
  assert.deepEqual(events.map(event => event.stage), ['started', 'usage', 'usage', 'completed']);
  assert.deepEqual(events.filter(event => event.stage === 'usage').map(event => event.sequence), [1, 2]);
  assert.deepEqual(events[1].usage.total, { totalTokens: 10, inputTokens: 8, outputTokens: 2 });
  assert.deepEqual(events[2].aggregateUsage, { totalTokens: 14, inputTokens: 11, outputTokens: 3 });
  assert.equal(events[2].completeness, 'cumulative-delta-sample');
  assert.deepEqual(answer.usage, events[2].usage);
  assert.ok(!JSON.stringify(events).includes('private prompt'));
});

test('unknown resume baseline reports only last sample and failure still emits the latest usage', async t => {
  const s = setup('reroute'); t.after(() => cleanup(s));
  const id = await s.provider.thread('thread-existing');
  const events = [];
  await assert.rejects(s.provider.answer(id, 'prompt', turnId => {
    const tokenUsage = { total: { totalTokens: 100 }, last: { totalTokens: 7, outputTokens: 2 } };
    s.provider.handleLine(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: id, tokenUsage } }), s.provider.activeGeneration);
  }, event => events.push(event)), error => error.code === 'MODEL_REROUTED');
  const usage = events.find(event => event.stage === 'usage'), failed = events.at(-1);
  assert.equal(usage.completeness, 'last-sample-only');
  assert.equal(usage.attribution, 'active-turn-assumed');
  assert.equal(usage.aggregateUsage, null);
  assert.equal(failed.stage, 'failed'); assert.equal(failed.code, 'MODEL_REROUTED');
  assert.deepEqual(failed.usage, usage.usage);
});

test('usage arriving after one answer updates only the next same-connection baseline', async t => {
  const s = setup(); t.after(() => cleanup(s));
  const id = await s.provider.thread(), firstEvents = [];
  const first = await s.provider.answer(id, 'first', undefined, event => firstEvents.push(event));
  s.provider.handleLine(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: id, turnId: first.turnId,
    tokenUsage: { total: { totalTokens: 20 }, last: { totalTokens: 20 } } } }), s.provider.activeGeneration);
  assert.equal(firstEvents.filter(event => event.stage === 'usage').length, 0);
  const secondEvents = [];
  await s.provider.answer(id, 'second', turnId => {
    s.provider.handleLine(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: id, turnId,
      tokenUsage: { total: { totalTokens: 27 }, last: { totalTokens: 7 } } } }), s.provider.activeGeneration);
  }, event => secondEvents.push(event));
  const usage = secondEvents.find(event => event.stage === 'usage');
  assert.equal(usage.completeness, 'cumulative-delta-sample');
  assert.deepEqual(usage.aggregateUsage, { totalTokens: 7 });

  const resetEvents = [];
  await s.provider.answer(id, 'after reset', turnId => {
    s.provider.handleLine(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: id, turnId,
      tokenUsage: { total: { totalTokens: 3 }, last: { totalTokens: 3 } } } }), s.provider.activeGeneration);
  }, event => resetEvents.push(event));
  const reset = resetEvents.find(event => event.stage === 'usage');
  assert.equal(reset.completeness, 'last-sample-only');
  assert.equal(reset.aggregateUsage, null);
});

test('late usage from a prior turn invalidates the active turn cumulative baseline', async t => {
  const s = setup('slow'); t.after(() => cleanup(s));
  const id = await s.provider.thread(); let priorTurn;
  await s.provider.answer(id, 'first', turnId => { priorTurn = turnId; });
  s.provider.handleLine(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: id, turnId: priorTurn,
    tokenUsage: { total: { totalTokens: 20 }, last: { totalTokens: 20 } } } }), s.provider.activeGeneration);

  const events = [];
  await s.provider.answer(id, 'second', currentTurn => {
    s.provider.handleLine(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: id, turnId: priorTurn,
      tokenUsage: { total: { totalTokens: 25 }, last: { totalTokens: 5 } } } }), s.provider.activeGeneration);
    s.provider.handleLine(JSON.stringify({ method: 'thread/tokenUsage/updated', params: { threadId: id, turnId: currentTurn,
      tokenUsage: { total: { totalTokens: 30 }, last: { totalTokens: 5 } } } }), s.provider.activeGeneration);
  }, event => events.push(event));
  const usage = events.find(event => event.stage === 'usage');
  assert.equal(events.filter(event => event.stage === 'usage').length, 1);
  assert.equal(usage.completeness, 'last-sample-only');
  assert.equal(usage.aggregateUsage, null);
  assert.deepEqual(usage.usage.last, { totalTokens: 5 });
});

test('supports different threads concurrently and rejects same-thread overlap', async t => {
  const s = setup('slow'); t.after(() => cleanup(s));
  const first = await s.provider.thread(), second = await s.provider.thread();
  const running = s.provider.answer(first, 'one');
  await assert.rejects(s.provider.answer(first, 'duplicate'), error => error.code === 'THREAD_BUSY');
  const pair = s.provider.answer(second, 'two');
  assert.equal((await Promise.all([running, pair])).length, 2);
});

test('resumes the original thread across account changes while retaining model validation', async t => {
  const s = setup();
  await s.provider.start();
  assert.equal(await s.provider.thread('thread-old', null, { accountScopeKey: 'other' }), 'thread-old');
  const result = await s.provider.answer('thread-old', 'next question');
  assert.equal((await s.provider.recover('thread-old', result.turnId, { accountScopeKey: 'other' })).turnId, result.turnId);
  assert.equal(s.messages().filter(m => m.method === 'thread/resume').length, 1);
  assert.equal(s.messages().filter(m => m.method === 'thread/start').length, 0);
  const mismatch = setup('model-mismatch'); t.after(() => cleanup(s, mismatch));
  await assert.rejects(mismatch.provider.thread(), error => error.code === 'MODEL_MISMATCH');
});

test('model reroutes are rejected rather than silently accepted', async t => {
  const s = setup('reroute'); t.after(() => cleanup(s));
  const id = await s.provider.thread(); let turn;
  await assert.rejects(s.provider.answer(id, 'prompt', value => { turn = value; }), error => error.code === 'MODEL_REROUTED');
  await assert.rejects(s.provider.recover(id, turn), error => error.code === 'MODEL_REROUTED');
});

test('turn timeout resets the connection and preserves recoverability without resending', async t => {
  const s = setup('timeout', { timeoutMs: 40 }); t.after(() => cleanup(s));
  const id = await s.provider.thread(); let turn;
  await assert.rejects(s.provider.answer(id, 'prompt', value => { turn = value; }), error => error.code === 'TURN_TIMEOUT' && error.ambiguous);
  const recovered = await s.provider.recover(id, turn);
  assert.match(recovered.text, /commentId/);
  assert.equal(s.messages().filter(m => m.method === 'turn/start').length, 1);
});

test('a delayed old-process exit cannot corrupt a new connection', async t => {
  const s = setup(); t.after(() => cleanup(s));
  await s.provider.start(); s.provider.close();
  const scope = await s.provider.getAccountScope();
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await s.provider.getAccountScope()).key, scope.key);
});

test('diagnostics never retain bearer credentials', async t => {
  const s = setup('stderr-secret'); t.after(() => cleanup(s));
  await s.provider.start();
  assert.ok(!s.provider.stderr.includes('secret-token-value'));
  assert.match(s.provider.stderr, /\[redacted\]/);
});

test('recovery rejects missing, empty, and duplicate final outputs', async t => {
  assert.throws(() => finalText([]), error => error.code === 'INVALID_FINAL_OUTPUT');
  assert.throws(() => finalText([{ id: 'a', type: 'agentMessage', phase: 'final_answer', text: '' }]), /唯一/);
  const s = setup('malformed-recover'); t.after(() => cleanup(s));
  await assert.rejects(s.provider.recover('thread-old', 'turn-bad'), error => error.code === 'INVALID_FINAL_OUTPUT');
});
