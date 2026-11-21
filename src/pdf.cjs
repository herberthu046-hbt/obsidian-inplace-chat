'use strict';

const { createHash } = require('node:crypto');
const Comments = require('./comments.cjs');

const VERSION = 1;
const KIND = 'pdf-discussion';
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const fail = (code, message) => { const error = new Error(message); error.code = code; throw error; };
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const entrySignature = entry => JSON.stringify([entry.author, entry.timestamp, entry.text]);
const encodeCommentText = text => String(text).replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/-->/g, '--&gt;');
const readable = text => String(text).replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n');

function validateBundleHash(bundleHash) {
  if (typeof bundleHash !== 'string' || !/^[a-f0-9]{64}$/i.test(bundleHash)) {
    fail('PDF_INVALID_BUNDLE', 'PDF bundle hash must be a 64-character SHA-256 hex string.');
  }
  return bundleHash.toLowerCase();
}

function annotationIdentity(bundleHash, setId, annotationId) {
  bundleHash = validateBundleHash(bundleHash);
  if (typeof setId !== 'string' || !setId || typeof annotationId !== 'string' || !annotationId) {
    fail('PDF_INVALID_IDENTITY', 'PDF annotation identity requires non-empty set and annotation ids.');
  }
  const key = `${bundleHash}\0${setId}\0${annotationId}`;
  return { key, threadId: `p${hash(key).slice(0, 31)}` };
}

function geometryOf(annotation) {
  return {
    rects: Array.isArray(annotation.rects) ? annotation.rects : [],
    tagX: annotation.tagX ?? null,
    tagY: annotation.tagY ?? null,
    tagWidth: annotation.tagWidth ?? null,
    tagHeight: annotation.tagHeight ?? null
  };
}

function quoteOf(annotation) {
  const source = typeof annotation.text === 'string' && annotation.text.trim()
    ? annotation.text.trim()
    : 'Page note';
  return `p.${Number(annotation.page) + 1} · ${source}`;
}

function anchorOf(annotation) {
  const quote = quoteOf(annotation);
  return {
    page: annotation.page,
    rectsHash: hash(geometryOf(annotation)),
    quoteHash: hash(quote)
  };
}

function validateAnchor(expected, current) {
  if (!isObject(expected) || !isObject(current) ||
      expected.page !== current.page ||
      expected.rectsHash !== current.rectsHash ||
      expected.quoteHash !== current.quoteHash) {
    fail('PDF_ANCHOR_CHANGED', 'PDF annotation position or quoted text changed; the reply was preserved but not written.');
  }
  return true;
}

function createDiscussion(bundleHash) {
  return { version: VERSION, kind: KIND, bundleHash: validateBundleHash(bundleHash), threads: {} };
}

function validateEntry(entry, path) {
  if (!isObject(entry) || typeof entry.author !== 'string' || !entry.author ||
      typeof entry.timestamp !== 'string' || typeof entry.text !== 'string') {
    fail('PDF_INVALID_DISCUSSION', `Invalid PDF discussion entry at ${path}.`);
  }
}

function validateDiscussion(input, expectedBundleHash) {
  if (!isObject(input) || input.version !== VERSION || input.kind !== KIND || !isObject(input.threads)) {
    fail('PDF_INVALID_DISCUSSION', 'PDF discussion source has an unsupported or invalid structure.');
  }
  input.bundleHash = validateBundleHash(input.bundleHash);
  if (expectedBundleHash && input.bundleHash !== validateBundleHash(expectedBundleHash)) {
    fail('PDF_BUNDLE_MISMATCH', 'PDF discussion belongs to a different bundle.');
  }
  for (const [threadId, thread] of Object.entries(input.threads)) {
    if (!isObject(thread) || thread.threadId !== threadId || typeof thread.setId !== 'string' || !thread.setId ||
        typeof thread.annotationId !== 'string' || !thread.annotationId || typeof thread.quote !== 'string' ||
        !isObject(thread.anchor) || !Number.isInteger(thread.anchor.page) || thread.anchor.page < 0 ||
        typeof thread.anchor.rectsHash !== 'string' || typeof thread.anchor.quoteHash !== 'string' ||
        !Array.isArray(thread.entries)) {
      fail('PDF_INVALID_DISCUSSION', `Invalid PDF discussion thread ${threadId}.`);
    }
    const expected = annotationIdentity(input.bundleHash, thread.setId, thread.annotationId).threadId;
    if (expected !== threadId) fail('PDF_IDENTITY_MISMATCH', `PDF discussion thread ${threadId} has inconsistent identity.`);
    thread.entries.forEach((entry, index) => validateEntry(entry, `${threadId}.entries[${index}]`));
  }
  return input;
}

function parseDiscussion(markdown, expectedBundleHash) {
  if (!String(markdown || '').trim()) {
    if (!expectedBundleHash) fail('PDF_MISSING_DISCUSSION', 'An empty PDF discussion requires an expected bundle hash.');
    return createDiscussion(expectedBundleHash);
  }
  // Readable message bodies are blockquoted. Only a fence that starts at
  // column zero can be the managed source, so a message containing its own
  // ```json example cannot confuse the parser.
  const fences = [...String(markdown).matchAll(/^```json[ \t]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm)];
  if (!fences.length) fail('PDF_MISSING_SOURCE', 'PDF discussion has no JSON source-of-truth block.');
  let parsed;
  try { parsed = JSON.parse(fences.at(-1)[1]); }
  catch { fail('PDF_INVALID_JSON', 'PDF discussion JSON source-of-truth is invalid.'); }
  return validateDiscussion(parsed, expectedBundleHash);
}

function serializeDiscussion(input, options = {}) {
  const doc = validateDiscussion(clone(input));
  const lines = [
    '---',
    'inplace-chat-pdf: 1',
    `bundle: ${doc.bundleHash}`,
    '---',
    '',
    `# ${options.title || 'PDF discussion'}`,
    '',
    '<!-- Managed by In-place Chat. The final JSON block is the machine source of truth. -->',
    ''
  ];
  const threads = Object.values(doc.threads).sort((a, b) => a.anchor.page - b.anchor.page || a.threadId.localeCompare(b.threadId));
  if (!threads.length) lines.push('_No discussion yet._', '');
  for (const thread of threads) {
    lines.push(`## p.${thread.anchor.page + 1} · ${thread.setId}/${thread.annotationId}`, '', readable(thread.quote), '');
    if (!thread.entries.length) lines.push('_No messages yet._', '');
    for (const entry of thread.entries) {
      lines.push(`### ${entry.author}${entry.timestamp ? ` · ${entry.timestamp}` : ''}`, '', readable(entry.text), '');
    }
  }
  lines.push('```json', JSON.stringify(doc, null, 2), '```', '');
  return lines.join('\n');
}

function nativeEntry(annotation) {
  const note = typeof annotation.note === 'string' ? annotation.note : '';
  const side = typeof annotation.noteContentCJK === 'string' ? annotation.noteContentCJK : '';
  const text = [note, side ? `侧注：${side}` : ''].filter(Boolean).join('\n\n');
  return text ? { author: 'me', timestamp: typeof annotation.created === 'string' ? annotation.created : '', text, native: true } : null;
}

function virtualComment(thread) {
  const lines = thread.entries.map(entry => `${entry.author} (${entry.timestamp || ''}): ${encodeCommentText(entry.text)}`);
  return `<!--c:${thread.threadId}-->${thread.quote}<!--/c:${thread.threadId}-->\n<!--co:${thread.threadId}\n${lines.join('\n')}\n-->`;
}

function validateProjectionRoundTrip(text, threads) {
  const reserved = /<!--\s*(?:\/?c|co):/i;
  for (const thread of threads) {
    if (reserved.test(thread.quote) || thread.entries.some(entry => reserved.test(entry.text))) {
      fail('PDF_UNSAFE_PROJECTION', `PDF annotation ${thread.setId}/${thread.annotationId} contains reserved native comment syntax.`);
    }
  }
  const inspected = Comments.inspect(text);
  if (!inspected.ok) {
    const detail = inspected.diagnostics.map(item => item.code).filter(Boolean).join(', ') || 'parse-failed';
    fail('PDF_UNSAFE_PROJECTION', `PDF annotation text cannot be represented safely as a chat projection (${detail}).`);
  }
  if (inspected.comments.length !== threads.length) {
    fail('PDF_UNSAFE_PROJECTION', 'PDF annotation text changed the number of projected chat threads.');
  }
  const parsed = new Map(inspected.comments.map(comment => [comment.id, comment]));
  if (parsed.size !== inspected.comments.length) {
    fail('PDF_UNSAFE_PROJECTION', 'PDF annotation text produced duplicate projected chat thread ids.');
  }
  for (const thread of threads) {
    const comment = parsed.get(thread.threadId);
    if (!comment || comment.quote !== thread.quote || comment.entries.length !== thread.entries.length) {
      fail('PDF_UNSAFE_PROJECTION', `PDF annotation ${thread.setId}/${thread.annotationId} did not round-trip safely.`);
    }
    for (let index = 0; index < thread.entries.length; index++) {
      const expected = thread.entries[index];
      const actual = comment.entries[index];
      if (actual.author !== expected.author || actual.timestamp !== expected.timestamp || actual.text !== expected.text) {
        fail('PDF_UNSAFE_PROJECTION', `PDF annotation ${thread.setId}/${thread.annotationId} changed a projected message.`);
      }
    }
  }
}

function project({ bundleHash, pdfPath = '', annotations = [], discussion }) {
  bundleHash = validateBundleHash(bundleHash);
  const doc = discussion ? validateDiscussion(clone(discussion), bundleHash) : createDiscussion(bundleHash);
  if (!Array.isArray(annotations)) fail('PDF_INVALID_ANNOTATIONS', 'PDF annotations must be an array.');
  const seen = new Set();
  const threads = annotations.map(annotation => {
    if (!isObject(annotation) || typeof annotation.id !== 'string' || !annotation.id ||
        typeof annotation.setId !== 'string' || !annotation.setId || !Number.isInteger(annotation.page) || annotation.page < 0) {
      fail('PDF_INVALID_ANNOTATION', 'PDF annotation projection requires id, setId, and a zero-based page.');
    }
    const { threadId } = annotationIdentity(bundleHash, annotation.setId, annotation.id);
    if (seen.has(threadId)) fail('PDF_DUPLICATE_ANNOTATION', `Duplicate projected PDF annotation ${annotation.setId}/${annotation.id}.`);
    seen.add(threadId);
    const anchor = anchorOf(annotation);
    const stored = doc.threads[threadId];
    const native = nativeEntry(annotation);
    const ownEntries = stored ? clone(stored.entries) : [];
    const entries = native ? [native, ...ownEntries] : ownEntries;
    return {
      threadId,
      annotationId: annotation.id,
      setId: annotation.setId,
      pdfPath,
      quote: quoteOf(annotation),
      anchor,
      entries,
      nativeEntryCount: native ? 1 : 0,
      ownEntries
    };
  }).sort((a, b) => a.anchor.page - b.anchor.page || a.threadId.localeCompare(b.threadId));
  const text = threads.map(virtualComment).join('\n\n');
  validateProjectionRoundTrip(text, threads);
  return { text, threads };
}

function containsSnapshot(entries, snapshot) {
  if (!snapshot?.messages) return true;
  const counts = new Map();
  for (const entry of entries) counts.set(entrySignature(entry), (counts.get(entrySignature(entry)) || 0) + 1);
  for (const message of snapshot.messages) {
    const key = entrySignature(message);
    const count = counts.get(key) || 0;
    if (!count) return false;
    counts.set(key, count - 1);
  }
  return true;
}

function appendFromProjection(input, originalThread, updatedThread, expected = {}) {
  const doc = validateDiscussion(clone(input));
  if (!isObject(originalThread) || !isObject(updatedThread) || updatedThread.id !== originalThread.threadId) {
    fail('PDF_PROJECTION_MISMATCH', 'Updated PDF discussion does not match its projected thread.');
  }
  if (expected.anchor) validateAnchor(expected.anchor, originalThread.anchor);
  const current = doc.threads[originalThread.threadId];
  if (!containsSnapshot(originalThread.entries || [], expected.targetSnapshot)) {
    fail('PDF_TARGET_CHANGED', 'Target PDF messages changed while a reply was being prepared.');
  }
  const before = originalThread.entries || [];
  const after = updatedThread.entries || [];
  if (after.length < before.length || before.some((entry, index) => entrySignature(entry) !== entrySignature(after[index]))) {
    fail('PDF_PROJECTION_REWRITE', 'PDF callback rewrote existing projected messages instead of appending.');
  }
  const suffix = after.slice(before.length).map(entry => ({
    author: String(entry.author || ''),
    timestamp: String(entry.timestamp || ''),
    text: String(entry.text ?? '')
  }));
  suffix.forEach((entry, index) => validateEntry(entry, `appended[${index}]`));
  if (current && JSON.stringify(current.entries) !== JSON.stringify(originalThread.ownEntries || [])) {
    const replayed = [...(originalThread.ownEntries || []), ...suffix];
    if (JSON.stringify(current.entries) === JSON.stringify(replayed)) return doc;
    fail('PDF_DISCUSSION_CHANGED', 'PDF discussion changed while a reply was being prepared.');
  }
  if (!current && !suffix.length) return doc;
  doc.threads[originalThread.threadId] = {
    threadId: originalThread.threadId,
    annotationId: originalThread.annotationId,
    setId: originalThread.setId,
    quote: originalThread.quote,
    anchor: clone(originalThread.anchor),
    entries: [...(current?.entries || []), ...suffix]
  };
  return doc;
}

module.exports = {
  KIND,
  VERSION,
  annotationIdentity,
  appendFromProjection,
  createDiscussion,
  parseDiscussion,
  project,
  serializeDiscussion,
  validateAnchor
};
