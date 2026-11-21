'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  identityFromMarkdown,
  openPdfUri,
  resolveZoteroContext,
  resolveZoteroEvidenceAttachment,
  openZoteroEvidence,
  zoteroUriFromTarget,
  openZoteroUri
} = require('../src/zotero.cjs');

const synced = `---
tags: []
parent: Example paper
$version: 12
$libraryID: 1
$itemKey: IYI56LU5
---

正文`;

test('recognizes the stable Better Notes note identity without title or path matching', () => {
  assert.deepEqual(identityFromMarkdown(synced), {
    betterNotesLibraryId: '1',
    noteKey: 'IYI56LU5'
  });
  assert.equal(identityFromMarkdown('# ordinary note'), null);
});

test('builds Zotero PDF links with page and existing annotation identity', () => {
  assert.equal(openPdfUri('library', '35CVXIMW', { page: 16, annotationKey: 'ZCABH6W8' }),
    'zotero://open-pdf/library/items/35CVXIMW?page=16&annotation=ZCABH6W8');
  assert.equal(openPdfUri('groups/42', '35CVXIMW'), 'zotero://open-pdf/groups/42/items/35CVXIMW');
});

test('resolves a Better Notes child note to its original Zotero PDF using only read calls', async () => {
  const calls = [];
  const get = async (pathname, options = {}) => {
    calls.push([pathname, options]);
    if (pathname.includes('/items/IYI56LU5')) return {
      key: 'IYI56LU5', library: { type: 'user', id: 16093670 },
      data: { itemType: 'note', parentItem: 'P6J2X2QG' }
    };
    if (pathname.includes('/items/P6J2X2QG/children')) return [{
      key: 'AWT3DX3P', library: { type: 'user', id: 16093670 },
      data: { itemType: 'attachment', contentType: 'application/pdf', title: 'Preprint PDF' }
    }];
    if (pathname.includes('/items/AWT3DX3P/file/view/url')) return 'file:///D:/Zotero/storage/AWT3DX3P/paper.pdf';
    throw new Error(`unexpected request ${pathname}`);
  };
  const context = await resolveZoteroContext(synced, { get });
  assert.equal(context.available, true);
  assert.equal(context.readOnly, true);
  assert.equal(context.parentKey, 'P6J2X2QG');
  assert.equal(context.itemUri, 'zotero://select/library/items/P6J2X2QG');
  assert.equal(context.attachments[0].openUri, 'zotero://open-pdf/library/items/AWT3DX3P');
  assert.match(context.attachments[0].path, /Zotero[\\/]storage[\\/]AWT3DX3P[\\/]paper\.pdf$/);
  assert.ok(calls.every(([pathname]) => !/authorize|POST|PUT|PATCH|DELETE/i.test(pathname)));
});

test('captures and opens only supported Zotero links', async () => {
  const uri = 'zotero://open-pdf/library/items/AWT3DX3P?page=16&annotation=ZCABH6W8';
  const anchor = { getAttribute: name => name === 'data-href' ? uri : null };
  assert.equal(zoteroUriFromTarget({ closest: selector => selector === 'a' ? anchor : null }), uri);
  const opened = [];
  await openZoteroUri(uri, { openExternal: async value => opened.push(value) });
  assert.deepEqual(opened, [uri]);
  await assert.rejects(openZoteroUri('https://example.test', { openExternal: async () => {} }), /无效/);
});

test('resolves a Zotero evidence attachment through the Local API', async () => {
  const calls = [];
  const result = await resolveZoteroEvidenceAttachment({ library_id: 1, attachment_key: 'AWT3DX3P' }, {
    get: async (pathname, options) => {
      calls.push([pathname, options]);
      return 'file:///D:/Zotero/storage/AWT3DX3P/paper.pdf';
    }
  });
  assert.match(result.path, /Zotero[\\/]storage[\\/]AWT3DX3P[\\/]paper\.pdf$/);
  assert.equal(result.apiScope, 'users/0');
  assert.equal(result.uriScope, 'library');
  assert.equal(calls[0][0], '/users/0/items/AWT3DX3P/file/view/url');
});

test('opens evidence through the Zotero companion endpoint with a page fallback', async () => {
  const payload = { zotero: { library_id: 1, attachment_key: 'AWT3DX3P' }, page_index: 15, quote: 'exact text' };
  const calls = [];
  const result = await openZoteroEvidence(payload, { post: async (pathname, body) => {
    calls.push([pathname, body]);
    return { status: 'text-flashed' };
  }});
  assert.equal(result.status, 'text-flashed');
  assert.equal(result.fallbackUri, 'zotero://open-pdf/library/items/AWT3DX3P?page=16');
  assert.equal(calls[0][1], payload);
});

test('falls back to native Zotero page navigation when the companion endpoint is missing', async () => {
  const opened = [];
  const missing = Object.assign(new Error('missing'), { statusCode: 404 });
  const result = await openZoteroEvidence({ zotero: { attachment_key: 'AWT3DX3P' }, page_index: 1, quote: 'text' }, {
    post: async () => { throw missing; },
    shell: { openExternal: async value => opened.push(value) }
  });
  assert.equal(result.status, 'page-only');
  assert.deepEqual(opened, ['zotero://open-pdf/library/items/AWT3DX3P?page=2']);
});
