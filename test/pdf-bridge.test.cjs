'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const C = require('../src/comments.cjs');
const P = require('../src/pdf.cjs');
const S = require('../src/state.cjs');
const { PdfBridge, VIEW_TYPE } = require('../src/pdf-bridge.cjs');

const BUNDLE = 'd'.repeat(64);

function annotation(patch = {}) {
  return {
    id: 'ann12345', page: 0, text: 'quoted source', note: '@chat old question',
    rects: [{ x1: 1, y1: 2, x2: 3, y2: 4 }], created: '2026-09-18T00:00:00Z',
    source: 'manual', ...patch
  };
}

function setup(t, initial = annotation()) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-pdf-bridge-'));
  t.after(() => fs.rmSync(storage, { recursive: true, force: true }));

  let highlights = [initial];
  let leaves = [];
  let subscribed = null;
  let cleanupCount = 0;
  const scheduled = [], traces = [], notices = [], sends = [];
  const root = { contains: target => target?.root === root };
  const store = {
    options: { indexPath: `.pdf-annotator/bundles/sha256/${BUNDLE}/annotation-sets/index.json` },
    listSets: () => [{ id: 'default', name: 'My notes' }],
    highlightsForSet: id => id === 'default' ? highlights : [],
    flushCalls: 0,
    async flush() { this.flushCalls++; },
    onChange(listener) {
      subscribed = listener;
      return () => { cleanupCount++; if (subscribed === listener) subscribed = null; };
    }
  };
  const oldFile = { path: 'papers/old.pdf', basename: 'old', extension: 'pdf' };
  const files = new Map([[oldFile.path, oldFile]]);
  const view = { store, file: oldFile, contentEl: root };
  leaves = [{ view }];

  const plugin = {
    storage,
    state: { version: S.VERSION, documents: {} },
    cache: new Map(),
    pdfDrafts: {},
    pdfSubmissions: {},
    app: {
      workspace: {
        getLeavesOfType: type => type === VIEW_TYPE ? leaves : [],
        trigger() {}
      },
      plugins: { plugins: {} },
      vault: { getAbstractFileByPath: filePath => files.get(filePath) || null }
    },
    saveState() {},
    async saveLocal() {},
    scheduleFile(file, mode) { scheduled.push([file.path, mode]); },
    scheduleDecorate() {},
    notice(error) { notices.push(error); },
    trace(event) { traces.push(event); },
    async send(...args) { sends.push(args); }
  };
  const bridge = new PdfBridge(plugin);
  plugin.pdf = bridge;
  plugin.refreshFile = async (file, mode = 'observe') => {
    const text = await bridge.textFor(file);
    const current = plugin.state.documents[file.path];
    const actualMode = current?.needsBaseline ? 'import' : mode;
    const result = S.reconcile(current, text, { mode: actualMode });
    assert.equal(result.status, 'ok');
    plugin.state.documents[file.path] = result.document;
    plugin.cache.set(file.path, {
      comments: result.comments, pending: result.pending, unread: result.unread,
      ambiguities: result.ambiguities || [], diagnostics: result.diagnostics || []
    });
    return result;
  };

  return {
    bridge, plugin, store, root, view, oldFile, files, scheduled, traces, notices, sends,
    get highlights() { return highlights; },
    set highlights(value) { highlights = value; },
    get leaves() { return leaves; },
    set leaves(value) { leaves = value; },
    emitStoreChange() { subscribed?.(); },
    get cleanupCount() { return cleanupCount; }
  };
}

test('historical native @chat is baselined quietly, then native note edits add and remove pending', async t => {
  const s = setup(t);
  const imported = await s.plugin.refreshFile(s.oldFile, 'observe');
  assert.equal(imported.pending.length, 0);
  assert.equal(s.plugin.state.documents[s.oldFile.path].needsBaseline, undefined);

  s.highlights[0].note = '@chat changed question';
  const changed = await s.plugin.refreshFile(s.oldFile, 'observe');
  assert.equal(changed.pending.length, 1);
  assert.equal(changed.pending[0].entries.at(-1).text, '@chat changed question');

  s.highlights[0].note = '';
  const removed = await s.plugin.refreshFile(s.oldFile, 'observe');
  assert.equal(removed.pending.length, 0);
});

test('body-mounted native PDF popover resolves only to the active PDF in the same document', t => {
  const s = setup(t);
  const ownerDocument = { defaultView: { addEventListener() {}, removeEventListener() {} } };
  s.root.ownerDocument = ownerDocument;
  const popup = {};
  const popupTarget = { ownerDocument, closest: selector => selector.includes('.lpa-mark-popover') ? popup : null };
  assert.equal(s.bridge.fileForTarget(popupTarget, s.oldFile), s.oldFile);
  assert.equal(s.bridge.fileForTarget(popupTarget, { path: 'other.pdf', extension: 'pdf' }), null);
  assert.equal(s.bridge.fileForTarget({ ownerDocument: {} }, s.oldFile), null);
  assert.equal(s.bridge.fileForTarget({ ownerDocument, closest: () => null }, s.oldFile), null);
});

test('native hit testing uses original visible annotation rectangles, including merged and overlapping paint', t => {
  const s = setup(t);
  const first = { ...annotation(), setId: 'default' };
  const second = { ...annotation({ id: 'second' }), setId: 'other' };
  s.store.byPage = page => page === 0 ? [first, second] : [];
  s.view.pageBoxAtPoint = () => ({ idx: 0, box: { left: 100, top: 200, width: 200, height: 200 } });
  s.view.geoms = new Map([[0, { w: 100, h: 100, vp1: { convertToPdfPoint: (x, y) => [x, y] } }]]);
  const context = s.bridge.contexts()[0];
  const threads = [first, second].map(annotation => ({ id: annotation.id, annotationId: annotation.id, setId: annotation.setId }));
  assert.deepEqual(s.bridge.threadsAtPoint(context, 104, 206, threads), threads);
  assert.deepEqual(s.bridge.threadsAtPoint(context, 120, 206, threads), []);
  s.store.byPage = () => [first];
  assert.deepEqual(s.bridge.threadsAtPoint(context, 104, 206, threads), threads.slice(0, 1));
});

test('custom PDF view hit testing scales client coordinates into its current viewport', t => {
  const s = setup(t);
  const mark = { ...annotation(), setId: 'default' };
  s.store.byPage = () => [mark];
  s.view.scale = 2;
  s.view.pageViewAtPoint = () => ({ index: 0, el: { getBoundingClientRect: () => ({ left: 100, top: 200, width: 100, height: 100 }) },
    page: { getViewport: ({ scale }) => ({ width: 100 * scale, height: 100 * scale, convertToPdfPoint: (x, y) => [x / scale, y / scale] }) } });
  const context = s.bridge.contexts()[0];
  const threads = [{ id: 'one', annotationId: mark.id, setId: 'default' }];
  assert.deepEqual(s.bridge.threadsAtPoint(context, 102, 203, threads), threads);
  assert.deepEqual(s.bridge.threadsAtPoint(context, 110, 203, threads), []);
});

test('native pages remain clickable while an existing text layer has no layout box', t => {
  const s = setup(t);
  const mark = { ...annotation({ page: 53 }), setId: 'default' };
  s.store.byPage = page => page === 53 ? [mark] : [];
  s.view.pageBoxAtPoint = () => null;
  s.view.geoms = new Map([[53, { w: 100, h: 100, vp1: { convertToPdfPoint: (x, y) => [x, y] } }]]);
  let textBox = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  const canvasBox = { left: 100, top: 200, right: 300, bottom: 400, width: 200, height: 200 };
  const page = { dataset: { pageNumber: '54' }, getBoundingClientRect: () => canvasBox,
    querySelector: selector => selector.includes('textLayer') ? { getBoundingClientRect: () => textBox }
      : selector.includes('canvasWrapper') ? { getBoundingClientRect: () => canvasBox } : null };
  s.root.querySelectorAll = () => [page];
  const threads = [{ id: 'one', annotationId: mark.id, setId: 'default' }];
  const context = s.bridge.contexts()[0];
  assert.deepEqual(s.bridge.threadsAtPoint(context, 104, 206, threads), threads);
  assert.deepEqual(s.bridge.threadsAtPoint(context, 500, 206, threads), []);
  // A laid-out text layer keeps priority over a differently sized canvas.
  textBox = { left: 100, top: 200, right: 200, bottom: 300, width: 100, height: 100 };
  assert.deepEqual(s.bridge.threadsAtPoint(context, 102, 203, threads), threads);
  assert.deepEqual(s.bridge.threadsAtPoint(context, 104, 206, threads), []);
});

test('reply writes only the owned discussion sidecar and never mutates native annotation data', async t => {
  const s = setup(t);
  await s.plugin.refreshFile(s.oldFile, 'observe');
  s.highlights[0].note = '@chat fresh question';
  const observed = await s.plugin.refreshFile(s.oldFile, 'observe');
  const target = observed.pending[0];
  s.bridge.enrichTargets(s.oldFile, [target]);
  const nativeBefore = JSON.parse(JSON.stringify(s.highlights[0]));

  await s.bridge.process(s.oldFile, latest => C.appendReplies(
    latest,
    [{ commentId: target.id, text: '**sidecar answer**' }],
    'reply-stamp',
    [target]
  ), [target]);

  assert.deepEqual(s.highlights[0], nativeBefore);
  const context = s.bridge.contextFor(s.oldFile);
  const discussion = s.bridge.discussion(context);
  assert.deepEqual(Object.values(discussion.threads).flatMap(thread => thread.entries), [
    { author: 'chat', timestamp: 'reply-stamp', text: '**sidecar answer**' }
  ]);
  assert.ok(fs.existsSync(s.bridge.discussionPath(context)));
});

test('writeback rejects a moved highlight using the send-time PDF anchor', async t => {
  const s = setup(t);
  await s.plugin.refreshFile(s.oldFile, 'observe');
  s.highlights[0].note = '@chat fresh question';
  const observed = await s.plugin.refreshFile(s.oldFile, 'observe');
  const target = observed.pending[0];
  s.bridge.enrichTargets(s.oldFile, [target]);
  s.highlights[0].page = 1;
  s.highlights[0].rects = [{ x1: 10, y1: 20, x2: 30, y2: 40 }];

  await assert.rejects(
    s.bridge.process(s.oldFile, latest => latest, [target]),
    /位置、文本或页码已改变/
  );
  assert.equal(fs.existsSync(path.join(s.plugin.storage, 'pdf', `${BUNDLE}.md`)), false);
});

test('persisted follow-up replay is idempotent and can send without duplicating the sidecar entry', async t => {
  const s = setup(t, annotation({ note: 'ordinary note' }));
  await s.plugin.refreshFile(s.oldFile, 'observe');
  const context = s.bridge.contextFor(s.oldFile);
  const thread = s.bridge.snapshot(context).threads[0];
  const entry = { author: 'me', timestamp: 'stable-stamp', text: '@chat follow-up' };
  const seeded = P.appendFromProjection(
    s.bridge.discussion(context),
    thread,
    { id: thread.id, entries: [...thread.entries, entry] },
    { anchor: thread.anchor }
  );
  s.bridge.writeDiscussion(context, seeded);
  const key = s.bridge.draftKey(context, thread.id);
  s.plugin.pdfSubmissions[key] = { ...entry };
  const nativeBefore = JSON.parse(JSON.stringify(s.highlights[0]));

  await s.bridge.addMessage(context, thread.id, 'follow-up', { send: true });

  const discussion = s.bridge.discussion(context);
  assert.deepEqual(discussion.threads[thread.id].entries, [entry]);
  assert.deepEqual(s.highlights[0], nativeBefore);
  assert.equal(s.plugin.pdfSubmissions[key], undefined);
  assert.deepEqual(s.sends, [[s.oldFile.path, [thread.id], 'pdf_ui']]);
});

test('writeDiscussion validates the full projection before touching a good sidecar', async t => {
  const s = setup(t, annotation({ note: 'ordinary note' }));
  await s.plugin.refreshFile(s.oldFile, 'observe');
  const context = s.bridge.contextFor(s.oldFile);
  const thread = s.bridge.snapshot(context).threads[0];
  const goodEntry = { author: 'chat', timestamp: 'good', text: 'safe answer' };
  const good = P.appendFromProjection(
    s.bridge.discussion(context), thread,
    { id: thread.id, entries: [...thread.entries, goodEntry] },
    { anchor: thread.anchor }
  );
  s.bridge.writeDiscussion(context, good);
  const destination = s.bridge.discussionPath(context);
  const before = fs.readFileSync(destination, 'utf8');

  const projected = s.bridge.snapshot(context).threads[0];
  const unsafe = P.appendFromProjection(
    good, projected,
    { id: projected.id, entries: [...projected.entries, { author: 'me', timestamp: 'bad', text: '<!--c:evil-->injected<!--/c:evil-->' }] },
    { anchor: projected.anchor }
  );
  assert.throws(() => s.bridge.writeDiscussion(context, unsafe), error => error.code === 'PDF_UNSAFE_PROJECTION');
  assert.equal(fs.readFileSync(destination, 'utf8'), before);
  assert.equal(fs.existsSync(destination + '.previous'), false);
});

test('native edit during awaited local submission save preserves draft and appends nothing', async t => {
  const s = setup(t, annotation({ note: 'ordinary note' }));
  await s.plugin.refreshFile(s.oldFile, 'observe');
  const context = s.bridge.contextFor(s.oldFile);
  const thread = s.bridge.snapshot(context).threads[0];
  const key = s.bridge.draftKey(context, thread.id);
  s.plugin.pdfDrafts[key] = 'follow-up while editing';
  let saves = 0;
  s.plugin.saveLocal = async () => {
    saves++;
    if (saves === 1) s.highlights[0].note = 'native note edited during save';
  };

  await assert.rejects(
    s.bridge.addMessage(context, thread.id, 'follow-up while editing'),
    /保存期间批注发生变化/
  );
  assert.equal(s.plugin.pdfDrafts[key], 'follow-up while editing');
  assert.equal(s.plugin.pdfSubmissions[key].text, 'follow-up while editing');
  assert.equal(fs.existsSync(s.bridge.discussionPath(context)), false);
  assert.equal(s.highlights[0].note, 'native note edited during save');
});

test('rename preserves bundle-scoped state, rebinds store notifications, and closed contexts clean up', async t => {
  const s = setup(t, annotation({ note: 'ordinary note' }));
  await s.plugin.refreshFile(s.oldFile, 'observe');
  const prior = s.plugin.state.documents[s.oldFile.path];
  s.bridge.contexts();

  const renamed = { path: 'papers/renamed.pdf', basename: 'renamed', extension: 'pdf' };
  s.files.delete(s.oldFile.path);
  s.files.set(renamed.path, renamed);
  s.view.file = renamed;
  await s.bridge.textFor(renamed);
  assert.equal(s.plugin.state.documents[renamed.path], prior);
  assert.equal(s.plugin.state.documents[s.oldFile.path], undefined);

  const scheduledBefore = s.scheduled.length;
  s.bridge.contexts();
  s.emitStoreChange();
  assert.ok(s.scheduled.slice(scheduledBefore).some(([filePath]) => filePath === renamed.path));
  assert.equal(s.scheduled.slice(scheduledBefore).some(([filePath]) => filePath === s.oldFile.path), false);

  s.leaves = [];
  assert.deepEqual(s.bridge.contexts(), []);
  assert.equal(s.cleanupCount, 2); // rename rebind + final context close
  assert.throws(() => s.bridge.contextFor(renamed), /请先在 PDF Annotator 中打开/);
  s.bridge.close();
});

test('PDF binary invalidation blocks the loaded store until a fresh store is opened', async t => {
  const s = setup(t, annotation({ note: 'ordinary note' }));
  await s.plugin.refreshFile(s.oldFile, 'observe');
  const staleContext = s.bridge.contextFor(s.oldFile);
  const threadId = s.bridge.snapshot(staleContext).threads[0].id;

  s.bridge.invalidate(s.oldFile);
  assert.throws(() => s.bridge.contextFor(s.oldFile), /请先在 PDF Annotator 中打开/);
  await assert.rejects(
    s.bridge.process(s.oldFile, text => text),
    /请先在 PDF Annotator 中打开/
  );
  assert.equal(fs.existsSync(path.join(s.plugin.storage, 'pdf', `${BUNDLE}.md`)), false);

  const freshStore = {
    options: { ...s.store.options },
    listSets: s.store.listSets,
    highlightsForSet: s.store.highlightsForSet,
    flushCalls: 0,
    async flush() { this.flushCalls++; },
    onChange() { return () => {}; }
  };
  s.view.store = freshStore;
  const freshContext = s.bridge.contextFor(s.oldFile);
  assert.equal(freshContext.store, freshStore);
  await s.bridge.addMessage(freshContext, threadId, 'fresh-store follow-up');

  const discussion = s.bridge.discussion(freshContext);
  assert.deepEqual(discussion.threads[threadId].entries.map(entry => entry.text), ['fresh-store follow-up']);
  assert.equal(freshStore.flushCalls, 1);
});
