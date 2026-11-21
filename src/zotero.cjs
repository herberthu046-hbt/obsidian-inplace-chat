'use strict';
const http = require('node:http');
const { fileURLToPath } = require('node:url');

const LOCAL_HOST = 'http://127.0.0.1:23119';
const LOCAL_API = 'http://127.0.0.1:23119/api';
const EVIDENCE_OPEN_ENDPOINT = '/inplace-chat/evidence/open';
const SAFE_KEY = /^[A-Z0-9]{8}$/i;

function frontmatter(markdown) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/.exec(String(markdown || ''));
  return match?.[1] || '';
}

function unquote(value) {
  const text = String(value || '').trim();
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text.replace(/\s+#.*$/, '').trim();
}

function scalar(header, names) {
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`^\\s*["']?${escaped}["']?\\s*:\\s*(.*?)\\s*$`, 'mi').exec(header);
    if (match) return unquote(match[1]);
  }
  return '';
}

function identityFromMarkdown(markdown) {
  const header = frontmatter(markdown);
  if (!header) return null;
  const noteKey = scalar(header, ['$itemKey', 'zotero-note-key', 'zotero_note_key']);
  const parentKey = scalar(header, ['zotero-parent-key', 'zotero_parent_key']);
  const attachmentKey = scalar(header, ['zotero-attachment-key', 'zotero_attachment_key']);
  if (![noteKey, parentKey, attachmentKey].some(key => SAFE_KEY.test(key))) return null;
  return {
    betterNotesLibraryId: scalar(header, ['$libraryID']),
    ...(SAFE_KEY.test(noteKey) ? { noteKey: noteKey.toUpperCase() } : {}),
    ...(SAFE_KEY.test(parentKey) ? { parentKey: parentKey.toUpperCase() } : {}),
    ...(SAFE_KEY.test(attachmentKey) ? { attachmentKey: attachmentKey.toUpperCase() } : {})
  };
}

function zoteroScope(library = {}) {
  return library.type === 'group' && library.id != null ? `groups/${encodeURIComponent(library.id)}` : 'library';
}

function selectUri(scope, itemKey) {
  if (!SAFE_KEY.test(itemKey || '')) throw new Error('无效的 Zotero 条目 Key。');
  return `zotero://select/${scope}/items/${itemKey.toUpperCase()}`;
}

function openPdfUri(scope, attachmentKey, { page, annotationKey } = {}) {
  if (!SAFE_KEY.test(attachmentKey || '')) throw new Error('无效的 Zotero 附件 Key。');
  const query = new URLSearchParams();
  if (Number.isInteger(Number(page)) && Number(page) > 0) query.set('page', String(Number(page)));
  if (SAFE_KEY.test(annotationKey || '')) query.set('annotation', annotationKey.toUpperCase());
  const suffix = query.size ? `?${query}` : '';
  return `zotero://open-pdf/${scope}/items/${attachmentKey.toUpperCase()}${suffix}`;
}

function requestLocal(pathname, { timeoutMs = 1200, text = false } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(`${LOCAL_API}${pathname}`, {
      headers: {
        'Zotero-API-Version': '3',
        'Zotero-Allowed-Request': 'true',
        'User-Agent': 'In-place-Chat/0.9.1'
      }
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if ((response.statusCode || 500) >= 400) {
          const error = new Error(`Zotero Local API ${response.statusCode}`);
          error.statusCode = response.statusCode;
          reject(error);
          return;
        }
        if (text) return resolve(body.trim());
        try { resolve(body ? JSON.parse(body) : null); }
        catch (cause) { reject(new Error('Zotero Local API 返回了无效 JSON。', { cause })); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Zotero Local API 超时。')));
    request.on('error', reject);
  });
}

function requestLocalPost(pathname, value, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const url = new URL(pathname, LOCAL_HOST);
    const request = http.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Zotero-Allowed-Request': 'true',
        'X-Inplace-Chat': 'evidence-open',
        'User-Agent': 'In-place-Chat/0.9.1'
      }
    }, response => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { responseBody += chunk; });
      response.on('end', () => {
        if ((response.statusCode || 500) >= 400) {
          const error = new Error(`Zotero evidence bridge ${response.statusCode}`);
          error.statusCode = response.statusCode;
          error.responseBody = responseBody;
          reject(error);
          return;
        }
        try { resolve(responseBody ? JSON.parse(responseBody) : {}); }
        catch (cause) { reject(new Error('Zotero 证据定位端点返回了无效 JSON。', { cause })); }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Zotero 证据定位超时。')));
    request.on('error', reject);
    request.end(body);
  });
}

async function optional(get, pathname, options) {
  try { return await get(pathname, options); }
  catch { return null; }
}

async function findItem(key, get) {
  if (!SAFE_KEY.test(key || '')) return null;
  const user = await optional(get, `/users/0/items/${key}?format=json`);
  if (user) return { item: user, apiScope: 'users/0' };
  const groups = await optional(get, '/users/0/groups?format=json');
  for (const group of Array.isArray(groups) ? groups.slice(0, 50) : []) {
    const id = group.id ?? group.data?.id ?? group.data?.groupID;
    if (id == null) continue;
    const apiScope = `groups/${encodeURIComponent(id)}`;
    const item = await optional(get, `/${apiScope}/items/${key}?format=json`);
    if (item) return { item, apiScope };
  }
  return null;
}

function filePathFromUrl(value) {
  if (!String(value || '').startsWith('file:')) return null;
  try { return fileURLToPath(value.trim()); }
  catch { return null; }
}

async function resolveZoteroContext(markdown, { get = requestLocal } = {}) {
  const identity = identityFromMarkdown(markdown);
  if (!identity) return null;
  const seedKey = identity.noteKey || identity.parentKey || identity.attachmentKey;
  const located = await findItem(seedKey, get);
  if (!located) return { source: 'better-notes', readOnly: true, available: false, ...identity };

  const { item, apiScope } = located;
  const library = item.library || { type: apiScope.startsWith('groups/') ? 'group' : 'user' };
  const scope = zoteroScope(library);
  const noteKey = item.data?.itemType === 'note' ? item.key : identity.noteKey;
  const parentKey = identity.parentKey || item.data?.parentItem || (item.data?.itemType === 'attachment' ? item.data?.parentItem : item.key);
  const children = parentKey ? await optional(get, `/${apiScope}/items/${parentKey}/children?format=json`) : [];
  let pdfs = (Array.isArray(children) ? children : []).filter(child =>
    child.data?.itemType === 'attachment' && (child.data?.contentType === 'application/pdf' || /\.pdf$/i.test(child.data?.filename || '')));
  if (item.data?.itemType === 'attachment' && item.data?.contentType === 'application/pdf') pdfs = [item, ...pdfs.filter(pdf => pdf.key !== item.key)];
  if (identity.attachmentKey) pdfs.sort((a, b) => (b.key === identity.attachmentKey) - (a.key === identity.attachmentKey));

  const attachments = await Promise.all(pdfs.slice(0, 8).map(async attachment => {
    const fileUrl = await optional(get, `/${apiScope}/items/${attachment.key}/file/view/url`, { text: true });
    const endpoint = `${LOCAL_API}/${apiScope}/items/${attachment.key}/children?itemType=annotation&format=json`;
    return {
      key: attachment.key,
      title: attachment.data?.title || attachment.data?.filename || 'PDF',
      openUri: openPdfUri(scope, attachment.key),
      openPageUriTemplate: `${openPdfUri(scope, attachment.key)}?page={page}`,
      annotationsEndpoint: endpoint,
      ...(fileUrl ? { fileUrl, path: filePathFromUrl(fileUrl) || undefined } : {})
    };
  }));

  return {
    source: 'better-notes',
    readOnly: true,
    available: true,
    library: { type: library.type || 'user', id: library.id ?? null, uriScope: scope },
    ...identity,
    ...(noteKey && SAFE_KEY.test(noteKey) ? { noteKey: noteKey.toUpperCase(), noteUri: selectUri(scope, noteKey) } : {}),
    ...(parentKey && SAFE_KEY.test(parentKey) ? { parentKey: parentKey.toUpperCase(), itemUri: selectUri(scope, parentKey) } : {}),
    attachments
  };
}

function zoteroUriFromTarget(target) {
  const anchor = target?.closest?.('a');
  if (!anchor) return null;
  for (const raw of [anchor.getAttribute?.('data-href'), anchor.getAttribute?.('href')]) {
    if (!raw) continue;
    let value = raw.trim();
    try { value = decodeURIComponent(value); } catch { /* keep original */ }
    const match = value.match(/zotero:\/\/(?:open-pdf|select)\/[^\s"'<>]+/i);
    if (match) return match[0];
  }
  return null;
}

async function openZoteroUri(uri, shell) {
  if (!/^zotero:\/\/(?:open-pdf|select)\/[A-Za-z0-9/?=&._%-]+$/i.test(String(uri || ''))) {
    throw new Error('已阻止无效的 Zotero 链接。');
  }
  const targetShell = shell || require('electron').shell;
  await targetShell.openExternal(uri);
}

function evidenceScope(target = {}) {
  if (target.api_scope) return String(target.api_scope);
  return target.library_type === 'group' && target.library_id != null
    ? `groups/${encodeURIComponent(target.library_id)}`
    : 'users/0';
}

function evidenceUriScope(target = {}) {
  return target.library_type === 'group' && target.library_id != null
    ? `groups/${encodeURIComponent(target.library_id)}`
    : 'library';
}

async function resolveZoteroEvidenceAttachment(target, { get = requestLocal } = {}) {
  if (!SAFE_KEY.test(target?.attachment_key || '')) throw new Error('证据缺少有效的 Zotero 附件 Key。');
  const apiScope = evidenceScope(target);
  const fileUrl = await get(`/${apiScope}/items/${target.attachment_key}/file/view/url`, { text: true });
  const path = filePathFromUrl(fileUrl);
  if (!path) throw new Error('Zotero 没有返回可核验的本地 PDF 路径。');
  return {
    path,
    apiScope,
    uriScope: evidenceUriScope(target),
    attachmentKey: target.attachment_key.toUpperCase()
  };
}

async function openZoteroEvidence(payload, { post = requestLocalPost, shell } = {}) {
  const target = payload?.zotero;
  if (!SAFE_KEY.test(target?.attachment_key || '')) throw new Error('证据缺少有效的 Zotero 附件 Key。');
  const pageIndex = Number(payload?.page_index);
  const fallbackUri = openPdfUri(evidenceUriScope(target), target.attachment_key, {
    page: Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex + 1 : undefined
  });
  try {
    const result = await post(EVIDENCE_OPEN_ENDPOINT, payload);
    return { ...result, fallbackUri };
  } catch (error) {
    if (![404, 405].includes(error?.statusCode)) throw error;
    await openZoteroUri(fallbackUri, shell);
    return { status: 'page-only', reason: 'zotero-evidence-bridge-unavailable', fallbackUri };
  }
}

module.exports = {
  LOCAL_HOST,
  LOCAL_API,
  EVIDENCE_OPEN_ENDPOINT,
  identityFromMarkdown,
  zoteroScope,
  selectUri,
  openPdfUri,
  requestLocal,
  requestLocalPost,
  resolveZoteroContext,
  resolveZoteroEvidenceAttachment,
  openZoteroEvidence,
  zoteroUriFromTarget,
  openZoteroUri
};
