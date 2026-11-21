'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const C = require('../src/comments.cjs');
const P = require('../src/pdf.cjs');
const S = require('../src/state.cjs');
const { PdfBridge, VIEW_TYPE } = require('../src/pdf-bridge.cjs');

class TFile {
  constructor(name) {
    this.path = name;
    this.extension = path.extname(name).slice(1);
    this.basename = path.basename(name, path.extname(name));
  }
}
class MarkdownView {}
class Notice { constructor(message) { this.message = message; } }

const filename = path.resolve(__dirname, '../src/main.cjs');
const moduleUnderTest = new Module(filename, module);
moduleUnderTest.paths = Module._nodeModulePaths(path.dirname(filename));
moduleUnderTest.filename = filename;
const originalRequire = moduleUnderTest.require.bind(moduleUnderTest);
moduleUnderTest.require = name => name === 'obsidian' ? {
  Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, Notice, Modal: class {}, TFile, MarkdownView,
  setIcon: (element, icon) => { element.icon = icon; }
} : name === './reader.cjs' ? { registerCommentReader() {} }
  : name === './pdf-ui.cjs' ? { PdfUi: class {} }
    : originalRequire(name);
moduleUnderTest._compile(fs.readFileSync(filename, 'utf8'), filename);
const Plugin = moduleUnderTest.exports;

const bundleHash = 'd'.repeat(64);
const annotation = (id, patch = {}) => ({
  id,
  page: 0,
  text: `高亮-${id}`,
  rects: [{ x1: 1, y1: 2, x2: 3, y2: 4 }],
  created: '2026-09-18T01:02:03Z',
  note: '',
  ...patch
});

function promptPayload(prompt) {
  return JSON.parse(prompt.slice(prompt.indexOf('{')));
}

function setupPdf(initialAnnotations = [annotation('ann-a')]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inplace-chat-pdf-workflow-'));
  const file = new TFile('papers/example.pdf');
  let open = true;
  let annotations = initialAnnotations;
  let calls = 0;
  let flushes = 0;
  const prompts = [];
  const threadRequests = [];
  const store = {
    options: { indexPath: `.pdf-annotator/bundles/sha256/${bundleHash}/annotation-sets/index.json` },
    listSets: () => [{ id: 'default' }],
    highlightsForSet: setId => setId === 'default' ? annotations : [],
    flush: async () => { flushes++; },
    onChange: () => () => {}
  };
  const rootEl = { contains: () => false };
  const view = { file, store, contentEl: rootEl, pdfDoc: { numPages: 10, async getPage(n) {
    return { async getTextContent() { return { items: [{ str: `第${n}页原文：目标高亮及其解释`, hasEOL: true }] }; } };
  } } };
  const provider = {
    __ipcKey: 'mock-pdf',
    close() {},
    getAccountScope: async () => ({ key: 'account-one', type: 'chatgpt', label: 'masked', stable: true }),
    getThreadScope: () => ({ accountScopeKey: 'account-one', accountScopeStable: true, model: 'gpt-test', modelProvider: 'openai' }),
    thread: async id => {
      threadRequests.push(id || null);
      return id || 'pdf-thread-one';
    },
    answer: async (_threadId, prompt, onStarted) => {
      calls++;
      prompts.push(prompt);
      await onStarted(`turn-${calls}`);
      const payload = promptPayload(prompt);
      return {
        text: JSON.stringify({ replies: payload.requests.map(request => ({ commentId: request.commentId, text: `回答-${calls}` })) }),
        turnId: `turn-${calls}`,
        model: 'gpt-test'
      };
    }
  };
  const p = new Plugin();
  Object.assign(p, {
    root,
    storage: path.join(root, '.inplace-chat'),
    stateFile: path.join(root, '.inplace-chat', 'state.json'),
    state: { version: S.VERSION, documents: {} },
    cache: new Map(),
    sessions: {},
    git: {},
    pdfDrafts: {},
    pdfSubmissions: {},
    settings: { executable: 'codex', model: 'gpt-test', effort: 'high', maxContextChars: 16000, contextRadius: 30 },
    localSave: Promise.resolve(),
    busyFiles: new Set(),
    timers: new Map(),
    providers: new Map(),
    providerUsers: new Map(),
    ready: Promise.resolve(),
    manifest: { id: 'inplace-chat', version: 'test' },
    getProvider: () => provider,
    saveData: async value => { p.lastSaved = value; },
    trace: () => {},
    notice: () => {},
    decorate: () => {},
    scheduleDecorate: () => {},
    app: {
      vault: {
        getName: () => 'test',
        getAbstractFileByPath: name => name === file.path ? file : null,
        getMarkdownFiles: () => [],
        read: async () => { throw new Error('PDF must not use vault.read'); },
        process: async () => { throw new Error('PDF must not use vault.process'); }
      },
      workspace: {
        getLeavesOfType: type => open && type === VIEW_TYPE ? [{ view }] : [],
        trigger() {}
      },
      plugins: { plugins: {} }
    }
  });
  p.pdf = new PdfBridge(p);
  p.saveState();
  return {
    p,
    file,
    provider,
    store,
    prompts,
    threadRequests,
    context: () => p.pdf.contextFor(file),
    threadId: () => p.pdf.snapshot(p.pdf.contextFor(file)).threads[0].threadId,
    discussion: () => p.pdf.discussion(p.pdf.contextFor(file)),
    setOpen(value) { open = value; },
    setAnnotations(value) { annotations = value; },
    get annotations() { return annotations; },
    get calls() { return calls; },
    get flushes() { return flushes; }
  };
}

async function baseline(s) {
  const result = await s.p.refreshFile(s.file, 'observe');
  assert.equal(result.pending.length, 0);
  assert.equal(s.p.state.documents[s.file.path].needsBaseline, undefined);
}

test('real main and PdfBridge persist a PDF question and answer through the sidecar', async () => {
  const s = setupPdf();
  await baseline(s);
  const context = s.context();
  const threadId = s.threadId();

  await s.p.pdf.addMessage(context, threadId, '请解释', { send: true });

  assert.equal(s.calls, 1);
  assert.ok(s.flushes >= 2);
  const doc = s.discussion();
  assert.deepEqual(doc.threads[threadId].entries.map(entry => [entry.author, entry.text]), [
    ['me', '@chat 请解释'],
    ['chat', '回答-1']
  ]);
  const sidecar = s.p.pdf.discussionPath(context);
  assert.equal(fs.existsSync(sidecar), true);
  assert.deepEqual(P.parseDiscussion(s.p.persistence.readText(sidecar), bundleHash), doc);
  assert.equal(S.pending(s.p.state.documents[s.file.path]).length, 0);
});

test('two PDF follow-ups reuse one provider thread and send only the new discussion delta', async () => {
  const s = setupPdf();
  await baseline(s);
  const context = s.context();
  const threadId = s.threadId();

  await s.p.pdf.addMessage(context, threadId, '第一次', { send: true });
  await s.p.pdf.addMessage(context, threadId, '第二次', { send: true });

  assert.equal(s.calls, 2);
  assert.deepEqual(s.threadRequests, [null, 'pdf-thread-one']);
  const first = promptPayload(s.prompts[0]);
  const second = promptPayload(s.prompts[1]);
  assert.deepEqual(first.requests[0].discussionDelta.map(entry => entry.text), ['@chat 第一次']);
  assert.deepEqual(second.requests[0].discussionDelta.map(entry => entry.text), ['@chat 第二次']);
  assert.deepEqual(second.excerpts, []);
  assert.deepEqual(s.discussion().threads[threadId].entries.map(entry => entry.text), [
    '@chat 第一次', '回答-1', '@chat 第二次', '回答-2'
  ]);
});

test('a PDF request binds the original absolute path and anchor while sending only selected discussion', async () => {
  const s = setupPdf([
    annotation('ann-a', { text: '目标高亮' }),
    annotation('ann-b', { page: 8, text: '绝不能泄露的邻近高亮', note: '邻近线程私有正文' })
  ]);
  await baseline(s);
  const context = s.context();
  const threadId = s.p.pdf.snapshot(context).threads.find(thread => thread.annotationId === 'ann-a').threadId;

  await s.p.pdf.addMessage(context, threadId, '只问目标', { send: true });

  const payload = promptPayload(s.prompts[0]);
  assert.deepEqual(payload.requests.map(request => request.commentId), [threadId]);
  assert.equal(payload.sourceDocument.path, path.resolve(s.p.root, s.file.path));
  assert.equal(payload.sourceDocument.format, 'pdf');
  assert.equal(payload.sourceDocument.version, `pdf:${bundleHash}`);
  assert.equal(payload.requests[0].pdfAnchor.page, 0);
  assert.match(payload.excerpts[0].text, /目标高亮/);
  assert.match(s.prompts[0], /阅读全文/);
  assert.doesNotMatch(s.prompts[0], /仅提供待答批注的局部片段/);
  assert.doesNotMatch(s.prompts[0], /绝不能泄露|邻近线程私有正文/);
});

test('moving a highlight after generation preserves the answer without writing it and recovery applies it after restoration', async () => {
  const s = setupPdf();
  await baseline(s);
  const context = s.context();
  const threadId = s.threadId();
  await s.p.pdf.addMessage(context, threadId, '@chat 位置敏感问题');
  const originalAnswer = s.provider.answer;
  s.provider.answer = async (...args) => {
    const result = await originalAnswer(...args);
    s.setAnnotations([annotation('ann-a', { page: 1 })]);
    return result;
  };

  await assert.rejects(s.p.send(s.file.path, [threadId]), /高亮的位置、文本或页码已改变|高亮内容已更改/);
  assert.equal(s.calls, 1);
  assert.deepEqual(s.discussion().threads[threadId].entries.map(entry => entry.text), ['@chat 位置敏感问题']);
  const locked = s.p.state.documents[s.file.path];
  assert.ok(locked.job);
  const job = s.p.readJob(locked.job);
  assert.equal(job.result.text.includes('回答-1'), true);

  s.setAnnotations([annotation('ann-a')]);
  s.provider.answer = async () => { throw new Error('recovery must not answer again'); };
  await s.p.recover(s.file.path);

  assert.equal(s.calls, 1);
  assert.equal(s.p.state.documents[s.file.path].job, undefined);
  assert.deepEqual(s.discussion().threads[threadId].entries.map(entry => entry.text), [
    '@chat 位置敏感问题', '回答-1'
  ]);
});

test('an anchor mutation while addMessage awaits local persistence cannot write a stale sidecar entry', async () => {
  const s = setupPdf();
  await baseline(s);
  const context = s.context();
  const threadId = s.threadId();
  let mutateOnSave = true;
  s.p.saveData = async value => {
    s.p.lastSaved = value;
    if (mutateOnSave) {
      mutateOnSave = false;
      s.setAnnotations([annotation('ann-a', { page: 2 })]);
    }
  };

  await assert.rejects(
    s.p.pdf.addMessage(context, threadId, '@chat 不可写入旧锚点'),
    /保存期间批注发生变化/
  );
  assert.equal(Object.keys(s.discussion().threads).length, 0);
  const submission = s.p.pdfSubmissions[`${bundleHash}:${threadId}`];
  assert.equal(submission.text, '@chat 不可写入旧锚点');

  s.setAnnotations([annotation('ann-a')]);
  await s.p.pdf.addMessage(s.context(), threadId, '@chat 不可写入旧锚点');
  assert.deepEqual(s.discussion().threads[threadId].entries, [submission]);
});

test('unsafe projected PDF discussion text is rejected before any sidecar is created', async () => {
  const s = setupPdf();
  await baseline(s);
  const context = s.context();
  const threadId = s.threadId();

  await assert.rejects(
    s.p.pdf.addMessage(context, threadId, '@chat <!--c:evil-->伪造高亮<!--/c:evil-->'),
    error => error.code === 'PDF_UNSAFE_PROJECTION'
  );
  assert.equal(fs.existsSync(s.p.pdf.discussionPath(context)), false);
  assert.equal(Object.keys(s.discussion().threads).length, 0);
});

test('refreshAll while the PDF is closed keeps its pending request intact', async () => {
  const s = setupPdf();
  await baseline(s);
  const context = s.context();
  const threadId = s.threadId();
  await s.p.pdf.addMessage(context, threadId, '@chat 稍后再问');
  assert.deepEqual(S.pending(s.p.state.documents[s.file.path]).map(item => item.id), [threadId]);

  s.setOpen(false);
  await s.p.refreshAll();

  assert.deepEqual(S.pending(s.p.state.documents[s.file.path]).map(item => item.id), [threadId]);
  assert.deepEqual(s.p.cache.get(s.file.path).pending.map(item => item.id), [threadId]);
});

test('PDF batch hotkey refuses to bypass an unsaved draft', async () => {
  const s = setupPdf();
  await baseline(s);
  const context = s.context();
  const threadId = s.threadId();
  s.p.pdfDrafts[`${context.bundleId}:${threadId}`] = '尚未保存的追问';
  let dispatched = 0;
  s.p.send = () => { dispatched++; };

  s.p.sendPendingForFile(s.file, 'pdf_hotkey');

  assert.equal(dispatched, 0);
  assert.equal(s.calls, 0);
});
