'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ANSWER_MARKER,
  questionFromComment,
  answerComment,
  safeName,
  managedHeader,
  annotationBlock,
  obsidianOpenUri
} = require('../src/zotero-annotation-bridge.cjs');
const C = require('../src/comments.cjs');

test('recognizes only unanswered Zotero @chat comments', () => {
  assert.equal(questionFromComment('@chat 为什么？'), '@chat 为什么？');
  assert.equal(questionFromComment('普通批注'), null);
  assert.equal(questionFromComment(`@chat 为什么？${ANSWER_MARKER}因为如此。`), null);
});

test('formats one inline answer and a stable Obsidian link', () => {
  const uri = obsidianOpenUri('研究课题', '文献/Zotero/chat/Paper - chat - U9XZAYAN.md');
  const text = answerComment('@chat hi', '**回答**', uri);
  assert.match(text, /—— chat 首答 ——/);
  assert.match(text, /obsidian:\/\/open\?vault=/);
  assert.equal(questionFromComment(text), null);
});

test('creates a managed literature node with a valid Document Comments thread', () => {
  const header = managedHeader({ title: 'A/B: paper', parentKey: 'JU826CEX', attachmentKey: '8LGSRZIK' });
  const block = annotationBlock({
    annotationKey: 'U9XZAYAN', attachmentKey: '8LGSRZIK', pageLabel: '1121', pageIndex: 0,
    quote: '高亮文字', question: '@chat 为什么？', timestamp: '2026-09-26T00:00:00Z'
  });
  const parsed = C.parse(header + '\n' + block);
  assert.equal(parsed[0].id, 'U9XZAYAN');
  assert.equal(parsed[0].quote, '高亮文字');
  assert.equal(parsed[0].entries[0].text, '@chat 为什么？');
  assert.match(block, /PDF 第 1 页（文献页码 1121）/);
  assert.match(block, /zotero:\/\/open-pdf\/library\/items\/8LGSRZIK\?page=1&annotation=U9XZAYAN/);
  assert.equal(safeName('A/B: paper'), 'A B paper');
});

test('an initialized bridge stays idle until the user submits a batch', async () => {
  let reads = 0;
  const plugin = {
    settings: { zoteroBridgeEnabled: true },
    zoteroBridgeState: { version: 1, initialized: true, seen: {}, processed: {} },
    saveLocal: async () => {}
  };
  const client = { annotations: async () => { reads++; return []; } };
  const bridge = new (require('../src/zotero-annotation-bridge.cjs').ZoteroAnnotationBridge)(plugin, { client });
  assert.deepEqual(await bridge.initialize(), { status: 'ready' });
  assert.equal(reads, 0);
  assert.deepEqual(await bridge.sendPending(), { status: 'done', pending: 0, answered: 0, failed: [] });
  assert.equal(reads, 1);
});

test('manual batch answers every new question and continues past one failure', async () => {
  const old = { key: 'OLDOLD12', data: { annotationComment: '@chat old' } };
  const good = { key: 'GOODGOOD', data: { annotationComment: '@chat new' } };
  const bad = { key: 'BADBAD12', data: { annotationComment: '@chat broken' } };
  const plugin = {
    settings: { zoteroBridgeEnabled: true },
    zoteroBridgeState: { version: 1, initialized: true, seen: { OLDOLD12: C.hash('@chat old') }, processed: {} },
    saveLocal: async () => {}
  };
  const bridge = new (require('../src/zotero-annotation-bridge.cjs').ZoteroAnnotationBridge)(plugin, { client: { annotations: async () => [old, good, bad] } });
  const handled = [];
  bridge.process = async item => {
    handled.push(item.key);
    if (item.key === 'BADBAD12') throw new Error('test failure');
    return { status: 'answered' };
  };
  const result = await bridge.sendPending();
  assert.deepEqual(handled, ['GOODGOOD', 'BADBAD12']);
  assert.equal(result.pending, 2);
  assert.equal(result.answered, 1);
  assert.deepEqual(result.failed, [{ key: 'BADBAD12', message: 'test failure' }]);
});
