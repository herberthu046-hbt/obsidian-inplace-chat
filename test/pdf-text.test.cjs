const test = require('node:test');
const assert = require('node:assert/strict');
const { excerpt, pageText, clip } = require('../src/pdf-text.cjs');
const C = require('../src/comments.cjs');
test('PDF Chinese text uses anchored pages, caches overlapping requests, and never scans full document', async () => {
  const calls = [];
  const pdf = { numPages: 20, async getPage(n) { calls.push(n); return { async getTextContent() { return { items: [{ str: `中文第${n}页`, hasEOL: true }, { str: '编织与置换：为什么二维特殊' }] }; } }; } };
  const a = await excerpt(pdf, { page: 4 }, '编织与置换');
  await excerpt(pdf, { page: 5 }, '相位约定');
  assert.deepEqual(calls, [4,5,6,7]);
  assert.match(a, /第 5 页（批注所在页）/);
  assert.match(a, /编织与置换：为什么二维特殊/);
  await assert.rejects(excerpt(pdf, { page: 20 }, ''), /页码/);
  await assert.rejects(excerpt(null, { page: 0 }, ''), /尚未就绪/);
});
test('failed page extraction retries and a different PDF does not share cache', async () => {
  let calls = 0;
  const pdf = { async getPage() { if (++calls === 1) throw Error('temporary'); return { async getTextContent() { return { items: [{str:'中文'}] }; } }; } };
  await assert.rejects(pageText(pdf,1));
  assert.equal(await pageText(pdf,1), '中文');
  assert.equal(calls,2);
});
test('excerpt finds Chinese quotes despite PDF whitespace and prepares context deltas', () => {
  const text = '前'.repeat(5000) + '编 织 与 置 换' + '后'.repeat(5000);
  assert.match(clip(text, 'p.5 · 编织与置换', 200), /编 织 与 置 换/);
  const source = '<!--c:a-->标题<!--/c:a-->\n<!--co:a\nme: @chat 为什么\n-->';
  const targets = C.pending(source);
  targets[0].sourceExcerpt = 'PDF 第 5 页：完整中文上下文';
  const first = C.prepare('a.pdf', source, targets);
  assert.match(first.prompt, /完整中文上下文/);
  const second = C.prepare('a.pdf', source, targets, first.next);
  assert.doesNotMatch(second.prompt, /完整中文上下文/);
  targets[0].sourceExcerpt += '，修改';
  assert.match(C.prepare('a.pdf', source, targets, first.next).prompt, /完整中文上下文，修改/);
});
