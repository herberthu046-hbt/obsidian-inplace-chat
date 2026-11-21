'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  CitationBridge,
  citationLocators,
  choosePdfArtifact,
  compactSegments,
  legacyAgentUseId,
  uniqueCompactMatch,
  vaultPath
} = require('../src/citation-bridge.cjs');

const useId = 'u-' + '1'.repeat(32);
const evidenceId = 'e-' + '4'.repeat(32);
const sourceId = 's-' + '2'.repeat(32);
const pdfSha = '3'.repeat(64);

function fixture({ annotator = true, bundleId = pdfSha, initialAnnotations = [], flashStatus = 'text-flashed', evidence = false, currentZoteroSha = pdfSha } = {}) {
  const root = 'Agent文献库';
  const text = '第一页证据\f第二页前文 Exact quoted evidence. 第二页后文';
  const start = text.indexOf('Exact quoted evidence.');
  const snapshotSha = createHash('sha256').update(text).digest('hex');
  const citationId = evidence ? evidenceId : useId;
  const paths = {
    use: `${root}/${evidence ? '证据' : '引用'}/${citationId}.json`,
    record: `${root}/资料/${sourceId}/record.json`,
    snapshot: `${root}/资料/${sourceId}/快照/${snapshotSha}/text.txt`,
    pdf: `${root}/资料/${sourceId}/附件/${pdfSha}.pdf`
  };
  const use = {
    schema: evidence ? 2 : 1,
    id: citationId,
    source_id: sourceId,
    snapshot: snapshotSha,
    selector: {
      type: 'TextQuoteSelector',
      exact: 'Exact quoted evidence.',
      prefix: '第二页前文 ',
      suffix: ' 第二页后文',
      position: { start, end: start + 'Exact quoted evidence.'.length, unit: 'Unicode code points' }
    },
    ...(evidence ? { locator: { page_index: 1, pdf_sha256: pdfSha, artifact_path: `资料/${sourceId}/附件/${pdfSha}.pdf`, zotero: { library_id: 1, parent_key: 'PARENT01', attachment_key: 'ATTACH01' } } } : {})
  };
  const record = {
    id: sourceId,
    metadata: { capture: { artifact_sha256: pdfSha, text_sha256: snapshotSha } },
    artifacts: [{ sha256: pdfSha, role: 'original', path: `资料/${sourceId}/附件/${pdfSha}.pdf`, ...(evidence ? { zotero: use.locator.zotero } : {}) }],
    snapshots: [{ sha256: snapshotSha, kind: 'pdf-text', text: `资料/${sourceId}/快照/${snapshotSha}/text.txt`, ...(evidence ? { artifact_sha256: pdfSha } : {}) }]
  };
  class File {
    constructor(path) {
      this.path = path;
      this.extension = path.split('.').at(-1);
      this.name = path.split('/').at(-1);
    }
  }
  const files = new Map(Object.values(paths).map(path => [path, new File(path)]));
  const contents = new Map([
    [paths.use, JSON.stringify(use)],
    [paths.record, JSON.stringify(record)],
    [paths.snapshot, text]
  ]);
  let annotations = [...initialAnnotations];
  const calls = [];
  const store = {
    listSets: () => [{ id: 'default' }],
    highlightsForSet: set => set === 'default' ? annotations : [],
    get: id => annotations.find(item => item.id === id),
    remove(id) { calls.push(['remove', id]); annotations = annotations.filter(item => item.id !== id); },
    async flush() { calls.push(['flush']); }
  };
  const view = {
    store,
    file: files.get(paths.pdf),
    renderAnnotationSidebar() { calls.push(['sidebar']); }
  };
  const context = { bundleId, store, view, file: files.get(paths.pdf) };
  const opened = [];
  const workspace = {
    getLeaf: () => ({ openFile: async (...args) => opened.push(args) }),
    revealLeaf: async () => {},
    setActiveLeaf: () => {}
  };
  const plugin = {
    app: {
      vault: {
        getFiles: () => [...files.values()],
        getAbstractFileByPath: path => files.get(path) || null,
        read: async file => contents.get(file.path)
      },
      workspace,
      plugins: { plugins: annotator ? { 'local-pdf-annotator': { openInAnnotator: async file => calls.push(['open', file.path]) } } : {} }
    },
    pdf: {
      contexts: () => annotator ? [context] : [],
      annotations: () => annotations
    },
    scheduleDecorate() { calls.push(['decorate']); }
  };
  const flasher = async (_context, citation) => {
    calls.push(['flash', citation.useId, citation.pageIndex]);
    return flashStatus;
  };
  const options = { delay: async () => {}, flasher };
  if (evidence) {
    options.resolveZoteroAttachment = async target => {
      calls.push(['resolve-zotero', target.attachment_key]);
      return { path: 'D:/Zotero/storage/ATTACH01/paper.pdf' };
    };
    options.hashFile = async path => { calls.push(['hash-zotero', path]); return currentZoteroSha; };
    options.openZoteroEvidence = async payload => {
      calls.push(['open-zotero', payload.evidence_id, payload.page_index, payload.quote]);
      return { status: 'text-flashed' };
    };
  }
  return { bridge: new CitationBridge(plugin, options), plugin, calls, opened, use, record, paths, context };
}

test('resolves a use ID through a verified snapshot and PDF binding', async () => {
  const f = fixture();
  const citation = await f.bridge.resolve(useId);
  assert.equal(citation.pdfFile.path, f.paths.pdf);
  assert.equal(citation.pageIndex, 1);
  assert.equal(citation.selector.exact, f.use.selector.exact);
  assert.equal(citation.artifact.sha256, pdfSha);
});

test('flashes a citation without importing or persisting a PDF annotation', async () => {
  const f = fixture();
  const result = await f.bridge.openUse(useId);
  assert.equal(result.status, 'text-flashed');
  assert.equal(result.removedLegacy, 0);
  assert.deepEqual(f.calls, [
    ['open', f.paths.pdf],
    ['flash', useId, 1],
    ['decorate']
  ]);
});

test('opens schema-2 evidence in Zotero without creating a persistent annotation', async () => {
  const f = fixture({ evidence: true });
  const result = await f.bridge.openUse(evidenceId);
  assert.equal(result.status, 'text-flashed');
  assert.deepEqual(f.calls, [
    ['resolve-zotero', 'ATTACH01'],
    ['hash-zotero', 'D:/Zotero/storage/ATTACH01/paper.pdf'],
    ['open-zotero', evidenceId, 1, 'Exact quoted evidence.']
  ]);
});

test('refuses Zotero navigation when the current attachment version changed', async () => {
  const f = fixture({ evidence: true, currentZoteroSha: '9'.repeat(64) });
  await assert.rejects(f.bridge.openUse(evidenceId), error => error.code === 'CITATION_ZOTERO_PDF_CHANGED');
  assert.equal(f.calls.some(call => call[0] === 'open-zotero'), false);
});

test('removes only old imported Agent citation annotations before flashing', async () => {
  const generated = { id: 'generated', source: 'import', note: `Agent 引用 ${useId}\nwhy` };
  const manual = { id: 'manual', source: 'manual', note: `Agent 引用 ${useId}` };
  const unrelated = { id: 'unrelated', source: 'import', note: 'ordinary imported note' };
  const f = fixture({ initialAnnotations: [generated, manual, unrelated] });
  const result = await f.bridge.openUse(useId);
  assert.equal(result.removedLegacy, 1);
  assert.deepEqual(f.calls, [
    ['open', f.paths.pdf],
    ['remove', 'generated'],
    ['flush'],
    ['sidebar'],
    ['flash', useId, 1],
    ['decorate']
  ]);
  assert.equal(legacyAgentUseId(generated), useId);
  assert.equal(legacyAgentUseId(manual), null);
});

test('compacts PDF text-layer fragments and maps a unique match back to DOM offsets', () => {
  const left = { nodeValue: 'Exact quoted ' };
  const right = { nodeValue: 'evidence.' };
  const index = compactSegments([{ node: left }, { node: right }]);
  const match = uniqueCompactMatch(index, 'Exact   quoted\nevidence.');
  assert.equal(index.text, 'Exactquotedevidence.');
  assert.equal(match.first.node, left);
  assert.equal(match.first.startOffset, 0);
  assert.equal(match.last.node, right);
  assert.equal(match.last.endOffset, right.nodeValue.length);
  assert.equal(uniqueCompactMatch(compactSegments([{ text: 'same same' }]), 'same'), null);
});

test('uses a conservative long fragment before a cross-column full quote', () => {
  const selector = {
    exact: 'Left column has a sufficiently long statement.    Right column has another sufficiently long statement.'
  };
  assert.deepEqual(citationLocators(selector), [
    'Right column has another sufficiently long statement.',
    'Left column has a sufficiently long statement.',
    'Left column has a sufficiently long statement. Right column has another sufficiently long statement.'
  ]);
});

test('refuses a PDF whose live bundle hash differs from the archived artifact', async () => {
  const f = fixture({ bundleId: '4'.repeat(64) });
  await assert.rejects(f.bridge.openUse(useId), error => error.code === 'CITATION_PDF_CHANGED');
  assert.equal(f.calls.some(call => call[0] === 'flash'), false);
});

test('opens the cited page in the native reader when PDF Annotator is unavailable', async () => {
  const f = fixture({ annotator: false });
  const result = await f.bridge.openUse(useId);
  assert.equal(result.status, 'page-only');
  assert.equal(f.opened.length, 1);
  assert.equal(f.opened[0][0].path, f.paths.pdf);
  assert.deepEqual(f.opened[0][1].eState, { subpath: '#page=2' });
});

test('path and artifact helpers reject ambiguous evidence', () => {
  assert.throws(() => vaultPath('Agent文献库', '../outside.pdf'), error => error.code === 'CITATION_PATH_INVALID');
  assert.throws(() => choosePdfArtifact({ snapshots: [{ sha256: pdfSha, kind: 'pdf-text' }], artifacts: [] }, pdfSha),
    error => error.code === 'CITATION_PDF_AMBIGUOUS');
});
