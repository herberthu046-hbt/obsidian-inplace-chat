const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/comments.cjs');
const note = (entry = 'me (2026-09-18T00:00:00Z): @chat 为什么？', id = 'a1') => `# 文章\n\n之前\n<!--c:${id}-->能量守恒<!--/c:${id}-->\n之后\n\n<!--co:${id} by:me status:open\n${entry}\n-->\n`;
test('any case-insensitive @chat in a human entry is pending; bot entries do not trigger', () => {
  assert.equal(C.pending(note()).length, 1);
  for (const entry of ['me: 你好@chat，这是个测试', 'me: 请@chat解释', 'me: user@chat.com', 'me: @chatgpt', 'me: @@chat', 'me: foo-@CHAT', 'me: /@chat/path', 'me: `你好@chat，请触发`']) assert.equal(C.pending(note(entry)).length, 1);
  for (const entry of ['me: hello', 'chat: @chat hi']) assert.equal(C.pending(note(entry)).length, 0);
  assert.equal(C.pending('```md\n' + note() + '\n```').length, 0);
  assert.equal(C.pending(note().replace('status:open', 'status:resolved')).length, 0);
});
test('no repeated generation after reply, edit to requested human text creates new request', () => {
  const pending = C.pending(note()); const keys = pending.flatMap(c => c.keys);
  const replied = C.appendReplies(note(), [{ commentId: 'a1', text: 'chat 的回复 @chat 不应触发' }], 't', pending);
  assert.equal(C.pending(replied, keys).length, 0);
  assert.equal(C.pending(replied.replace('为什么？', '怎么证明？'), keys).length, 1);
});
test('append preserves original Markdown, reactions, line endings and native multiline entries', () => {
  const original = note('me: @chat why\n+ 👍 me').replaceAll('\n', '\r\n');
  const after = C.appendReplies(original, [{ commentId: 'a1', text: '第一行\n第二行：$x$\\n' }], 't');
  const entries = C.parse(after)[0].entries;
  assert.equal(entries.at(-1).text, '第一行\n第二行：$x$\\n');
  assert.ok(after.includes('+ 👍 me\r\n')); assert.ok(after.startsWith(original.slice(0, -5)));
  assert.equal(C.appendReplies(after, [{ commentId: 'a1', text: 'repeat' }], 't'), after);
});
test('response cannot write to wrong, removed, edited or duplicate comment', () => {
  const targets = C.pending(note());
  assert.throws(() => C.appendReplies('', [{ commentId: 'a1', text: 'x' }], 't', targets));
  assert.throws(() => C.appendReplies(note().replace('为什么', '为什么不是'), [{ commentId: 'a1', text: 'x' }], 't', targets));
  assert.throws(() => C.parse(note() + note()));
  assert.throws(() => C.validateReplies({ replies: [{ commentId: 'wrong', text: 'x' }] }, targets));
});
test('unrelated edit and full article never enter local-context prompt', () => {
  const text = 'UNRELATED START' + '甲'.repeat(3000) + note() + '乙'.repeat(3000) + 'UNRELATED END';
  const targets = C.pending(text), first = C.prepare('a.md', text, targets, {}, 16000, 50);
  assert.ok(!first.prompt.includes('UNRELATED')); assert.ok(first.prompt.length < 1500);
  const edited = text.replace('UNRELATED START', 'CHANGED ELSEWHERE');
  const second = C.prepare('a.md', edited, C.pending(edited), first.next, 16000, 50);
  const request = JSON.parse(second.prompt.slice(second.prompt.indexOf('{')));
  assert.equal(request.excerpts.length, 0); assert.equal(request.requests[0].discussionDelta.length, 0);
  assert.throws(() => C.prepare('a.md', text, targets, {}, 30));
});
test('same document sends new discussion only and relevant changed excerpt', () => {
  const text = note(), first = C.prepare('a.md', text, C.pending(text));
  const next = text.replace('\n-->\n', '\nme (later): @chat 请举例\n-->\n');
  const second = C.prepare('a.md', next, C.pending(next), first.next);
  const data = JSON.parse(second.prompt.slice(second.prompt.indexOf('{')));
  assert.equal(data.excerpts.length, 0); assert.equal(data.requests[0].discussionDelta.length, 1);
  assert.equal(data.requests[0].discussionDelta[0].text, '@chat 请举例');
  const updated = next.replace('能量守恒', '质量守恒');
  assert.ok(C.prepare('a.md', updated, C.pending(updated), first.next).prompt.includes('质量守恒'));
});
test('body projection preserves comment-like literals inside code fences', () => {
  const fenced = '```md\n<!--c:fake-->literal<!--/c:fake-->\n<!--co:broken\n```\n';
  const text = fenced + note();
  const body = C.bodyContext(text);
  assert.ok(body.includes('<!--c:fake-->literal<!--/c:fake-->'));
  assert.ok(body.includes('<!--co:broken'));
  assert.equal(C.inspect(text).ok, true);
});
test('duplicate quote context is selected by the actual anchor offset', () => {
  const text = `FIRST duplicate\n${'x'.repeat(80)}\nSECOND <!--c:a1-->duplicate<!--/c:a1--> tail\n<!--co:a1 by:me status:open\nme: @chat why\n-->\n`;
  const prepared = C.prepare('a.md', text, C.pending(text), {}, 16000, 16);
  const data = JSON.parse(prepared.prompt.slice(prepared.prompt.indexOf('{')));
  assert.match(data.excerpts[0].text, /SECOND/);
  assert.doesNotMatch(data.excerpts[0].text, /FIRST/);
});
test('anchorless native quote fallback remains parseable and prepares quote-only context', () => {
  const text = '正文\n<!--co:a1 by:me status:open quote:"离线高亮"\nme: @chat why\n-->\n';
  const comment = C.parse(text)[0];
  assert.equal(comment.anchor, -1);
  assert.equal(comment.quote, '离线高亮');
  const prepared = C.prepare('a.md', text, C.pending(text));
  assert.match(prepared.prompt, /离线高亮/);
});
test('requests accept different output order but reject empty, missing and duplicate replies', () => {
  const targets = C.pending(note() + note('me: @chat 另一个', 'b2'));
  assert.equal(C.validateReplies({ replies: [{ commentId: 'b2', text: 'b' }, { commentId: 'a1', text: 'a' }] }, targets).length, 2);
  for (const replies of [[], [{ commentId: 'a1', text: '' }], [{ commentId: 'a1', text: 'a' }, { commentId: 'a1', text: 'b' }]]) assert.throws(() => C.validateReplies({ replies }, targets));
});

test('a pure connectivity comment skips full-document work without weakening real questions', () => {
  const testNote = note('me (2026-09-18T00:00:00Z): @chat hi，test');
  const target = C.pending(testNote);
  const quick = C.prepare('paper.md', testNote, target, {}, 16000, 500, { path: 'paper.md' });
  assert.match(quick.prompt, /无需读取全文或安装工具/);
  const realNote = note('me (2026-09-18T00:00:00Z): @chat 为什么这是强关联体系？');
  const full = C.prepare('paper.md', realNote, C.pending(realNote), {}, 16000, 500, { path: 'paper.md' });
  assert.match(full.prompt, /请先阅读全文/);
});
