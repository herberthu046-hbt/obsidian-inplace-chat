const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/comments.cjs');
const S = require('../src/state.cjs');

const block = (lines, id = 'a1', quote = '高亮', status = 'open') =>
  `正文\n<!--c:${id}-->${quote}<!--/c:${id}-->\n<!--co:${id} by:me status:${status}\n${lines.join('\n')}\n-->\n`;

test('first import baselines historical requests and replies without pretending they were submitted', () => {
  const text = block(['me (one): @chat 历史问题', 'chat (two): 历史回答']);
  const result = S.reconcile(S.createDocument('doc'), text, { mode: 'import' });
  assert.equal(result.status, 'ok');
  assert.equal(result.pending.length, 0);
  assert.equal(result.unread.length, 0);
  assert.deepEqual(result.document.submitted.messages, {});
  assert.equal(Object.keys(result.document.baseline.messages).length, 1);
  assert.equal(Object.keys(result.document.baseline.replies).length, 1);
});

test('new mention, edit, and marker removal update one explicit pending record', () => {
  let doc = S.reconcile(S.createDocument('doc'), block(['me (one): 普通讨论']), { mode: 'import' }).document;
  let text = block(['me (one): 普通讨论', 'me (two): @chat 新问题']);
  let result = S.reconcile(doc, text, { mode: 'observe' });
  assert.equal(result.pending.length, 1);
  assert.ok(result.changes.some(change => change.type === 'pending-added'));
  const id = result.pending[0].messageIds[0];
  assert.equal(result.document.pending[id].action, 'add');

  text = text.replace('@chat 新问题', '@chat 修改后的问题');
  result = S.reconcile(result.document, text, { mode: 'observe' });
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].messageIds[0], id);
  assert.equal(result.document.pending[id].action, 'update');
  assert.equal(result.document.pending[id].revision, 2);
  assert.ok(result.changes.some(change => change.type === 'pending-updated'));

  text = text.replace('@chat 修改后的问题', '撤回标记');
  result = S.reconcile(result.document, text, { mode: 'observe' });
  assert.equal(result.pending.length, 0);
  assert.equal(result.document.pending[id], undefined);
  assert.ok(result.changes.some(change => change.type === 'pending-removed'));
});

test('deleting a preceding message and reordering preserve stable identities', () => {
  const original = block(['me (one): 第一条', 'me (two): 第二条', 'me (three): 第三条']);
  let doc = S.reconcile(S.createDocument('doc'), original, { mode: 'import' }).document;
  const ids = Object.fromEntries(doc.observed.threads.a1.messages.map(m => [m.timestamp, m.id]));

  let result = S.reconcile(doc, block(['me (three): 第三条', 'me (two): 第二条']), { mode: 'observe' });
  assert.equal(result.document.observed.threads.a1.messages[0].id, ids.three);
  assert.equal(result.document.observed.threads.a1.messages[1].id, ids.two);
  assert.ok(result.changes.some(c => c.type === 'message-removed' && c.messageId === ids.one));

  result = S.reconcile(result.document, block(['me (two): 第二条', 'me (three): 第三条']), { mode: 'observe' });
  assert.deepEqual(result.document.observed.threads.a1.messages.map(m => m.id), [ids.two, ids.three]);
  assert.ok(result.changes.some(c => c.type === 'messages-reordered'));
  assert.equal(result.pending.length, 0);
});

test('anchorless quote fallback still keeps message identity across reorder', () => {
  const make = lines => `<!--co:a1 by:me status:open quote:"离线高亮"\n${lines.join('\n')}\n-->\n`;
  let doc = S.reconcile(S.createDocument('doc'), make(['me (one): 第一条', 'me (two): 第二条']), { mode: 'import' }).document;
  const ids = Object.fromEntries(doc.observed.threads.a1.messages.map(message => [message.timestamp, message.id]));
  const result = S.reconcile(doc, make(['me (two): 第二条', 'me (one): 第一条']), { mode: 'observe' });
  assert.deepEqual(result.document.observed.threads.a1.messages.map(message => message.id), [ids.two, ids.one]);
  assert.ok(result.changes.some(change => change.type === 'messages-reordered'));
});

test('fresh identical timestamp-free duplicates are blocked on first observe and remain sticky', () => {
  const text = block(['me: @chat 一样', 'me: @chat 一样']);
  let doc = S.reconcile(S.createDocument('doc'), block([]), { mode: 'import' }).document;
  let result = S.reconcile(doc, text, { mode: 'observe' });
  assert.equal(result.ambiguities.length, 1);
  assert.equal(result.ambiguities[0].kind, 'duplicate-identity');
  assert.equal(result.pending.length, 0);
  assert.equal(Object.values(result.document.pending).filter(item => item.blocked === 'ambiguous').length, 2);
  result = S.reconcile(result.document, text, { mode: 'observe' });
  assert.equal(result.ambiguities.length, 1);
  assert.equal(result.pending.length, 0);
});

test('multi-message no-timestamp ambiguity remains blocked across unchanged reconciles', () => {
  let doc = S.reconcile(S.createDocument('doc'), block(['me: old one', 'me: old two']), { mode: 'import' }).document;
  const changed = block(['me: @chat new one', 'me: @chat new two']);
  let result = S.reconcile(doc, changed, { mode: 'observe' });
  assert.equal(result.ambiguities[0].kind, 'unmatched-identity');
  assert.equal(result.pending.length, 0);
  result = S.reconcile(result.document, changed, { mode: 'observe' });
  assert.equal(result.ambiguities[0].kind, 'unmatched-identity');
  assert.equal(result.pending.length, 0);
});

test('distinct native timestamps make delete plus add a new identity, not an author-only edit', () => {
  let doc = S.reconcile(S.createDocument('doc'), block(['me (old): 普通']), { mode: 'import' }).document;
  const oldId = doc.observed.threads.a1.messages[0].id;
  const result = S.reconcile(doc, block(['me (new): @chat 新消息']), { mode: 'observe' });
  const newId = result.document.observed.threads.a1.messages[0].id;
  assert.notEqual(newId, oldId);
  assert.equal(result.ambiguities.length, 0);
  assert.equal(result.pending.length, 1);
  assert.equal(result.document.pending[newId].action, 'add');
});

test('partial syntax and merge conflict preserve the previous snapshot and queue', () => {
  let doc = S.reconcile(S.createDocument('doc'), block(['me: baseline']), { mode: 'import' }).document;
  doc = S.reconcile(doc, block(['me: baseline', 'me (two): @chat pending']), { mode: 'observe' }).document;
  const before = JSON.parse(JSON.stringify(doc));
  for (const broken of [
    block(['me: baseline']).replace('-->\n', ''),
    `<<<<<<< ours\n${block(['me: baseline'])}=======\nother\n>>>>>>> theirs\n`
  ]) {
    const result = S.reconcile(doc, broken, { mode: 'observe' });
    assert.equal(result.status, 'invalid');
    assert.deepEqual(result.document, before);
    assert.equal(Object.keys(result.document.pending).length, 1);
  }
});

test('v1 migration preserves recovery state and baselines history on first reconcile', () => {
  const migrated = S.migrateState({ version: 1, documents: { 'a.md': { id: 'doc', handled: ['old-key'], job: 'job-id', extra: 'receipt clue' } } });
  const doc = migrated.documents['a.md'];
  assert.equal(doc.job, 'job-id');
  assert.equal(doc.needsBaseline, true);
  assert.deepEqual(doc.legacy.handled, ['old-key']);
  assert.equal(doc.legacy.recovery.extra, 'receipt clue');
  const result = S.reconcile(doc, block(['me: @chat 历史']), {});
  assert.equal(result.pending.length, 0);
  assert.equal(result.document.job, 'job-id');
});

test('portable state migration fails closed on structurally corrupt JSON values', () => {
  const valid = { version: S.VERSION, documents: { 'a.md': S.createDocument('doc') } };
  assert.doesNotThrow(() => S.migrateState(valid));
  const corrupt = [
    { version: S.VERSION, documents: [] },
    { version: S.VERSION, documents: { 'a.md': 'bad' } },
    { version: S.VERSION, documents: { 'a.md': { ...S.createDocument('doc'), pending: 'bad' } } },
    { version: S.VERSION, documents: { 'a.md': { ...S.createDocument('doc'), observed: { sourceHash: 'x', threads: [] } } } },
    { version: S.VERSION, documents: { 'a.md': { ...S.createDocument('doc'), nextMessageSeq: Infinity } } },
    { version: 1, documents: { 'a.md': { id: 'doc', handled: 'bad', job: 'job' } } }
  ];
  for (const raw of corrupt) assert.throws(() => S.migrateState(raw), /状态结构无效/);
});

test('only newly observed chat replies are unread and read state survives refresh', () => {
  let doc = S.reconcile(S.createDocument('doc'), block(['chat (old): 历史回答']), { mode: 'import' }).document;
  let result = S.reconcile(doc, block(['chat (old): 历史回答', 'chat (new): 新回答']), { mode: 'observe' });
  assert.equal(result.unread.length, 1);
  assert.equal(result.unread[0].messages.length, 1);
  doc = S.markRead(result.document, 'a1');
  assert.equal(S.unread(doc).length, 0);
  result = S.reconcile(doc, block(['chat (old): 历史回答', 'chat (new): 新回答']), { mode: 'observe' });
  assert.equal(result.unread.length, 0);
});

test('acknowledge advances submitted revision without replacing observed snapshot', () => {
  let doc = S.reconcile(S.createDocument('doc'), block(['me: baseline']), { mode: 'import' }).document;
  let text = block(['me: baseline', 'me (ask): @chat 问题']);
  let result = S.reconcile(doc, text, { mode: 'observe' });
  const target = result.pending[0], messageId = target.messageIds[0];
  const observedHash = result.document.observed.sourceHash;
  doc = S.acknowledge(result.document, [target]);
  assert.equal(doc.observed.sourceHash, observedHash);
  assert.equal(doc.submitted.messages[messageId], 1);
  assert.equal(S.pending(doc, text).length, 0);

  text = text.replace('@chat 问题', '@chat 新版本');
  result = S.reconcile(doc, text, { mode: 'observe' });
  assert.equal(result.pending.length, 1);
  assert.equal(result.pending[0].messageIds[0], messageId);
  assert.equal(result.document.pending[messageId].action, 'update');
});

test('prepare delta uses stable sidecar keys after preceding deletion and reorder', () => {
  const initial = block(['me (old): 旧讨论', 'me (ask1): @chat 第一问']);
  let doc = S.reconcile(S.createDocument('doc'), block(['me (old): 旧讨论']), { mode: 'import' }).document;
  let observed = S.reconcile(doc, initial, { mode: 'observe' });
  const first = C.prepare('a.md', initial, observed.pending);
  doc = S.acknowledge(observed.document, observed.pending);

  const next = block(['me (ask2): @chat 第二问', 'me (ask1): @chat 第一问']);
  observed = S.reconcile(doc, next, { mode: 'observe' });
  const second = C.prepare('a.md', next, observed.pending, first.next);
  const payload = JSON.parse(second.prompt.slice(second.prompt.indexOf('{')));
  assert.deepEqual(payload.requests[0].discussionDelta.map(entry => entry.text), ['@chat 第二问']);
});

test('explicit requeue selects imported historical threads without reviving ambiguities', () => {
  const text = block(['me (old): @chat 历史'], 'a1') + '\n' + block(['me: @chat 一样', 'me: @chat 一样'], 'b2');
  let doc = S.reconcile(S.createDocument('doc'), text, { mode: 'import' }).document;
  // A second observation establishes that b2 has indistinguishable duplicate identities.
  doc = S.reconcile(doc, text, { mode: 'observe' }).document;
  doc = S.requeue(doc, ['a1', 'b2']);
  doc = S.reconcile(doc, text, { mode: 'observe' }).document;
  const targets = S.pending(doc, text);
  assert.deepEqual(targets.map(target => target.id), ['a1']);
  assert.equal(Object.values(doc.pending).filter(item => item.action === 'requeue').length, 1);
  const edited = S.reconcile(doc, text.replace('@chat 历史', '历史'), { mode: 'observe' });
  assert.equal(S.pending(edited.document, text.replace('@chat 历史', '历史')).length, 0);
});

test('v1 receipt recovery preserves legacy target validation after migration', () => {
  const text = block(['me (old): @chat 旧版请求']);
  const legacyTargets = C.pending(text);
  const doc = S.reconcile(S.createDocument('migrated'), text, { mode: 'import' }).document;
  const valid = S.validateTargets(doc, text, legacyTargets);
  assert.equal(valid.ok, true);
  assert.equal(valid.targets[0].targetSnapshot, undefined);
  const changed = S.validateTargets(doc, text.replace('旧版请求', '用户修改过'), legacyTargets);
  assert.equal(changed.ok, false);
  assert.match(changed.reasons.join(' '), /旧版目标消息已更改/);
});

test('late-result validation tolerates unrelated reorder/deletion but rejects target edits', () => {
  let doc = S.reconcile(S.createDocument('doc'), block(['me (one): 前文', 'me (two): 保留']), { mode: 'import' }).document;
  const sentText = block(['me (one): 前文', 'me (two): 保留', 'me (ask): @chat 问题']);
  let result = S.reconcile(doc, sentText, { mode: 'observe' });
  const targets = result.pending;

  const latest = block(['me (two): 保留', 'me (ask): @chat 问题']);
  const validation = S.validateTargets(result.document, latest, targets);
  assert.equal(validation.ok, true);
  const withReply = C.appendReplies(latest, [{ commentId: 'a1', text: '回答' }], 'reply', validation.targets);
  assert.equal(C.parse(withReply)[0].entries.at(-1).text, '回答');

  const changed = S.validateTargets(result.document, latest.replace('@chat 问题', '@chat 已修改'), targets);
  assert.equal(changed.ok, false);
  assert.match(changed.reasons.join(' '), /目标消息已更改/);
});
