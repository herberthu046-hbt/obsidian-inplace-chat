'use strict';

const { createHash } = require('node:crypto');
const C = require('./comments.cjs');

const VERSION = 2;
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value));
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
// Saving a follow-up can normalize an older answer's line endings in Obsidian.
const signature = entry => JSON.stringify([entry.author, entry.timestamp, entry.text.replace(/\r\n?/g, '\n')]);
const authorTime = entry => entry.timestamp ? JSON.stringify([entry.author, entry.timestamp]) : '';
const requestKey = message => `${message.id}@${message.revision}`;
const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const invalidState = path => { throw new Error(`状态结构无效：${path}`); };

function validateRevisionMap(value, path) {
  if (!isPlainObject(value)) invalidState(path);
  for (const [id, revision] of Object.entries(value)) {
    if (!id || !Number.isInteger(revision) || revision < 1) invalidState(`${path}.${id || '<empty>'}`);
  }
}

function validateV2Document(doc, path) {
  if (!isPlainObject(doc) || doc.version !== VERSION || typeof doc.id !== 'string' || !doc.id) invalidState(path);
  if (!Number.isInteger(doc.nextMessageSeq) || doc.nextMessageSeq < 1) invalidState(`${path}.nextMessageSeq`);
  if (!isPlainObject(doc.baseline) || !isPlainObject(doc.submitted)) invalidState(`${path}.baseline/submitted`);
  validateRevisionMap(doc.baseline.messages, `${path}.baseline.messages`);
  validateRevisionMap(doc.baseline.replies, `${path}.baseline.replies`);
  validateRevisionMap(doc.submitted.messages, `${path}.submitted.messages`);
  for (const field of ['pending', 'unread']) {
    if (!isPlainObject(doc[field])) invalidState(`${path}.${field}`);
    for (const [id, item] of Object.entries(doc[field])) {
      if (!isPlainObject(item) || item.messageId !== id || typeof item.threadId !== 'string' || !Number.isInteger(item.revision) || item.revision < 1) invalidState(`${path}.${field}.${id}`);
    }
  }
  if (!Array.isArray(doc.ambiguities) || doc.ambiguities.some(item => !isPlainObject(item) || !Array.isArray(item.messageIds))) invalidState(`${path}.ambiguities`);
  if (doc.job != null && (typeof doc.job !== 'string' || !doc.job)) invalidState(`${path}.job`);
  if (doc.needsBaseline != null && doc.needsBaseline !== true) invalidState(`${path}.needsBaseline`);
  if (doc.legacy != null && !isPlainObject(doc.legacy)) invalidState(`${path}.legacy`);
  if (doc.observed != null) {
    if (!isPlainObject(doc.observed) || typeof doc.observed.sourceHash !== 'string' || !isPlainObject(doc.observed.threads)) invalidState(`${path}.observed`);
    for (const [threadId, thread] of Object.entries(doc.observed.threads)) {
      if (!isPlainObject(thread) || thread.id !== threadId || typeof thread.quote !== 'string' || typeof thread.resolved !== 'boolean' || !Array.isArray(thread.messages)) invalidState(`${path}.observed.threads.${threadId}`);
      for (const message of thread.messages) {
        if (!isPlainObject(message) || typeof message.id !== 'string' || !message.id || typeof message.author !== 'string' || typeof message.timestamp !== 'string' || typeof message.text !== 'string' || !['human', 'chat'].includes(message.role) || typeof message.mentionsChat !== 'boolean' || !Number.isInteger(message.revision) || message.revision < 1) invalidState(`${path}.observed.threads.${threadId}.messages`);
      }
    }
  }
}

function createDocument(id) {
  return {
    version: VERSION,
    id,
    nextMessageSeq: 1,
    observed: null,
    baseline: { messages: {}, replies: {} },
    submitted: { messages: {} },
    pending: {},
    unread: {},
    ambiguities: []
  };
}

function normalizeDocument(input, fallbackId) {
  const doc = clone(input || createDocument(fallbackId));
  doc.version = VERSION;
  doc.id ||= fallbackId;
  doc.nextMessageSeq = Number.isInteger(doc.nextMessageSeq) && doc.nextMessageSeq > 0 ? doc.nextMessageSeq : 1;
  doc.observed ??= null;
  doc.baseline = { messages: {}, replies: {}, ...(doc.baseline || {}) };
  doc.baseline.messages ||= {};
  doc.baseline.replies ||= {};
  doc.submitted = { messages: {}, ...(doc.submitted || {}) };
  doc.submitted.messages ||= {};
  doc.pending ||= {};
  doc.unread ||= {};
  doc.ambiguities ||= [];
  return doc;
}

function migrateState(raw) {
  if (!raw) return { version: VERSION, documents: {} };
  if (!isPlainObject(raw) || !Number.isInteger(raw.version) || !isPlainObject(raw.documents)) invalidState('root');
  if (raw.version === VERSION) {
    const result = clone(raw);
    for (const [path, doc] of Object.entries(result.documents)) {
      validateV2Document(doc, `documents.${path}`);
      result.documents[path] = normalizeDocument(doc, doc.id);
    }
    return result;
  }
  if (raw.version !== 1) throw new Error(`不支持的 In-place Chat 状态版本：${raw.version}`);
  const result = { version: VERSION, documents: {}, migration: { from: 1 } };
  for (const [path, old] of Object.entries(raw.documents || {})) {
    if (!isPlainObject(old) || (old.id != null && (typeof old.id !== 'string' || !old.id)) || (old.job != null && (typeof old.job !== 'string' || !old.job)) || (old.handled != null && !Array.isArray(old.handled))) invalidState(`documents.${path}`);
    const doc = createDocument(old.id || path);
    if (old.job) doc.job = old.job;
    doc.needsBaseline = true;
    doc.legacy = { version: 1, handled: clone(old.handled || []), recovery: clone(old) };
    result.documents[path] = doc;
  }
  return result;
}

function allocateId(doc) {
  const id = `m${String(doc.nextMessageSeq).padStart(8, '0')}`;
  doc.nextMessageSeq++;
  return id;
}

function snapshotMessage(doc, entry, id, revision = 1) {
  return {
    id: id || allocateId(doc),
    author: entry.author,
    timestamp: entry.timestamp,
    text: entry.text,
    role: C.isChat(entry) ? 'chat' : 'human',
    mentionsChat: !C.isChat(entry) && C.mentionsChat(entry.text),
    revision
  };
}

function snapshotThread(comment, messages) {
  return { id: comment.id, quote: comment.quote, resolved: comment.resolved, messages };
}

function groupIndexes(items, keyOf, indexes) {
  const groups = new Map();
  for (const index of indexes) {
    const key = keyOf(items[index]);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  }
  return groups;
}

function matchMessages(doc, threadId, previous, entries) {
  const oldFree = new Set(previous.map((_m, i) => i));
  const newFree = new Set(entries.map((_e, i) => i));
  const matches = new Map();
  const ambiguousIds = new Set();
  const ambiguousNewIndexes = new Set();
  const ambiguities = [];

  const connect = (oldIndex, newIndex) => {
    matches.set(newIndex, oldIndex);
    oldFree.delete(oldIndex);
    newFree.delete(newIndex);
  };

  const exactOld = groupIndexes(previous, signature, oldFree);
  const exactNew = groupIndexes(entries, signature, newFree);
  for (const [key, oldIndexes] of exactOld) {
    const newIndexes = exactNew.get(key) || [];
    if (oldIndexes.length === 1 && newIndexes.length === 1) connect(oldIndexes[0], newIndexes[0]);
  }

  // Two freshly observed identical messages have no defensible individual
  // identity, even though both are new. Block them on this first observation.
  for (const [key, newIndexes] of exactNew) {
    if (newIndexes.length < 2 || (exactOld.get(key) || []).length) continue;
    newIndexes.forEach(index => ambiguousNewIndexes.add(index));
    ambiguities.push({
      threadId,
      kind: 'duplicate-identity',
      signature: digest(key),
      previousMessageIds: [],
      observedIndexes: [...newIndexes],
      observedCount: newIndexes.length,
      previousCount: 0
    });
  }

  // Equal duplicate groups can be carried forward deterministically, but their
  // individual identity is unknowable. Keep them blocked and make that explicit.
  for (const [key, oldIndexes] of exactOld) {
    const remainingOld = oldIndexes.filter(i => oldFree.has(i));
    const remainingNew = (exactNew.get(key) || []).filter(i => newFree.has(i));
    if (!remainingOld.length || !remainingNew.length || (remainingOld.length === 1 && remainingNew.length === 1)) continue;
    const count = Math.min(remainingOld.length, remainingNew.length);
    for (let i = 0; i < count; i++) {
      connect(remainingOld[i], remainingNew[i]);
      ambiguousIds.add(previous[remainingOld[i]].id);
    }
    remainingNew.forEach(index => ambiguousNewIndexes.add(index));
    ambiguities.push({
      threadId,
      kind: 'duplicate-identity',
      signature: digest(key),
      previousMessageIds: remainingOld.map(i => previous[i].id),
      observedIndexes: [...remainingNew],
      observedCount: remainingNew.length,
      previousCount: remainingOld.length
    });
  }

  // A non-empty native timestamp plus author is the strongest edit identity
  // available without writing unsupported metadata into Document Comments.
  const timeOld = groupIndexes(previous, authorTime, oldFree);
  const timeNew = groupIndexes(entries, authorTime, newFree);
  for (const [key, oldIndexes] of timeOld) {
    const newIndexes = timeNew.get(key) || [];
    if (oldIndexes.length === 1 && newIndexes.length === 1) connect(oldIndexes[0], newIndexes[0]);
  }

  // A single unmatched message on each side is a conservative edit match. With
  // more candidates there is no sound positional identity, so leave it explicit.
  const oldByAuthor = groupIndexes(previous, m => !m.timestamp ? m.author : '', oldFree);
  const newByAuthor = groupIndexes(entries, e => !e.timestamp ? e.author : '', newFree);
  for (const [author, oldIndexes] of oldByAuthor) {
    const newIndexes = newByAuthor.get(author) || [];
    if (oldIndexes.length === 1 && newIndexes.length === 1) connect(oldIndexes[0], newIndexes[0]);
  }

  const uncertainIdentity = [...oldFree].some(i => !previous[i].timestamp) || [...newFree].some(i => !entries[i].timestamp);
  if (oldFree.size && newFree.size && uncertainIdentity) {
    const ids = [...oldFree].map(i => previous[i].id);
    ids.forEach(id => ambiguousIds.add(id));
    newFree.forEach(index => ambiguousNewIndexes.add(index));
    ambiguities.push({
      threadId,
      kind: 'unmatched-identity',
      previousMessageIds: ids,
      observedIndexes: [...newFree],
      previousCount: oldFree.size,
      observedCount: newFree.size
    });
  }

  const messages = entries.map((entry, newIndex) => {
    const oldIndex = matches.get(newIndex);
    if (oldIndex == null) return snapshotMessage(doc, entry);
    const old = previous[oldIndex];
    const changed = signature(old) !== signature(entry);
    return snapshotMessage(doc, entry, old.id, old.revision + (changed ? 1 : 0));
  });
  // New candidates in an ambiguous edit group must not be auto-sent.
  ambiguousNewIndexes.forEach(index => ambiguousIds.add(messages[index].id));
  for (const ambiguity of ambiguities) {
    ambiguity.messageIds = [...new Set((ambiguity.observedIndexes || []).map(index => messages[index]?.id).filter(Boolean))];
    ambiguity.revisions = Object.fromEntries(ambiguity.messageIds.map(id => [id, messages.find(message => message.id === id)?.revision]));
    delete ambiguity.observedIndexes;
  }
  return {
    messages,
    removed: [...oldFree].map(i => previous[i]),
    ambiguities,
    ambiguousIds
  };
}

function pendingBaseRevision(doc, message) {
  return Math.max(doc.baseline.messages[message.id] || 0, doc.submitted.messages[message.id] || 0);
}

function currentMessages(doc) {
  return Object.values(doc.observed?.threads || {}).flatMap(thread => thread.messages.map(message => ({ thread, message })));
}

function reconcile(input, text, options = {}) {
  const original = normalizeDocument(input, input?.id);
  const inspected = C.inspect(text);
  if (!inspected.ok) {
    return {
      status: 'invalid',
      document: clone(original),
      comments: [],
      changes: [],
      pending: pending(original),
      unread: unread(original),
      ambiguities: clone(original.ambiguities),
      diagnostics: inspected.diagnostics
    };
  }

  const doc = clone(original);
  const mode = options.mode || (doc.needsBaseline || !doc.observed ? 'import' : 'observe');
  if (!['import', 'observe'].includes(mode)) throw new Error(`未知核对模式：${mode}`);
  const priorThreads = doc.observed?.threads || {};
  const nextThreads = {};
  const changes = [];
  const allAmbiguities = [];
  const ambiguousIds = new Set();

  for (const comment of inspected.comments) {
    const prior = priorThreads[comment.id];
    const matched = matchMessages(doc, comment.id, prior?.messages || [], comment.entries);
    nextThreads[comment.id] = snapshotThread(comment, matched.messages);
    matched.ambiguities.forEach(a => allAmbiguities.push(a));
    matched.ambiguousIds.forEach(id => ambiguousIds.add(id));
    if (!prior) changes.push({ type: 'thread-added', threadId: comment.id });
    else {
      if (prior.quote !== comment.quote) changes.push({ type: 'quote-updated', threadId: comment.id });
      if (prior.resolved !== comment.resolved) changes.push({ type: comment.resolved ? 'thread-resolved' : 'thread-reopened', threadId: comment.id });
      const oldOrder = prior.messages.map(m => m.id).filter(id => matched.messages.some(m => m.id === id));
      const newOrder = matched.messages.map(m => m.id).filter(id => prior.messages.some(m => m.id === id));
      if (oldOrder.length > 1 && oldOrder.join('\0') !== newOrder.join('\0')) changes.push({ type: 'messages-reordered', threadId: comment.id });
    }
    const priorById = new Map((prior?.messages || []).map(m => [m.id, m]));
    for (const message of matched.messages) {
      const old = priorById.get(message.id);
      if (!old) changes.push({ type: 'message-added', threadId: comment.id, messageId: message.id, revision: message.revision });
      else if (old.revision !== message.revision) changes.push({ type: 'message-updated', threadId: comment.id, messageId: message.id, revision: message.revision });
    }
    for (const removed of matched.removed) changes.push({ type: 'message-removed', threadId: comment.id, messageId: removed.id, revision: removed.revision });
  }
  for (const [threadId, thread] of Object.entries(priorThreads)) {
    if (nextThreads[threadId]) continue;
    changes.push({ type: 'thread-removed', threadId });
    for (const message of thread.messages) changes.push({ type: 'message-removed', threadId, messageId: message.id, revision: message.revision });
  }

  // An ambiguity is sticky while all affected current messages remain byte-for-
  // byte at the same revisions. Otherwise a no-op save could unblock a request.
  const currentById = new Map(Object.values(nextThreads).flatMap(thread => thread.messages).map(message => [message.id, message]));
  for (const prior of original.ambiguities || []) {
    const ids = prior.messageIds || [];
    const unchanged = ids.length && ids.every(id => currentById.has(id) && (!prior.revisions || prior.revisions[id] === currentById.get(id).revision));
    if (!unchanged) continue;
    const duplicate = allAmbiguities.some(item => item.kind === prior.kind && item.threadId === prior.threadId && item.messageIds?.some(id => ids.includes(id)));
    if (!duplicate) allAmbiguities.push(clone(prior));
    ids.forEach(id => ambiguousIds.add(id));
  }

  doc.observed = { sourceHash: digest(text), threads: nextThreads };
  doc.ambiguities = allAmbiguities;
  const nextPending = {};
  const nextUnread = { ...doc.unread };
  const liveIds = new Set();

  for (const thread of Object.values(nextThreads)) {
    for (const message of thread.messages) {
      liveIds.add(message.id);
      if (mode === 'import') {
        if (message.role === 'human' && message.mentionsChat) doc.baseline.messages[message.id] = message.revision;
        if (message.role === 'chat') doc.baseline.replies[message.id] = message.revision;
        continue;
      }
      if (message.role === 'human' && message.mentionsChat && !thread.resolved) {
        const oldPending = doc.pending[message.id];
        const keepRequeue = oldPending?.action === 'requeue' && oldPending.revision === message.revision && !ambiguousIds.has(message.id);
        if (keepRequeue || message.revision > pendingBaseRevision(doc, message)) {
          const action = keepRequeue ? 'requeue' : oldPending && oldPending.revision !== message.revision ? 'update' : oldPending?.action || (pendingBaseRevision(doc, message) ? 'update' : 'add');
          nextPending[message.id] = {
            messageId: message.id,
            threadId: thread.id,
            revision: message.revision,
            requestKey: requestKey(message),
            action,
            blocked: ambiguousIds.has(message.id) ? 'ambiguous' : undefined
          };
        }
      }
      if (message.role === 'chat' && message.revision > (doc.baseline.replies[message.id] || 0)) {
        const prior = Object.values(priorThreads).flatMap(t => t.messages).find(m => m.id === message.id);
        if (!prior || prior.revision !== message.revision) nextUnread[message.id] = { messageId: message.id, threadId: thread.id, revision: message.revision };
      }
    }
  }
  for (const id of Object.keys(nextUnread)) if (!liveIds.has(id)) delete nextUnread[id];
  if (mode === 'import') {
    doc.pending = {};
    doc.unread = {};
    delete doc.needsBaseline;
  } else {
    doc.pending = nextPending;
    doc.unread = nextUnread;
  }
  if (mode === 'observe') {
    const oldPending = original.pending || {};
    for (const [id, item] of Object.entries(doc.pending)) {
      if (!oldPending[id]) changes.push({ type: 'pending-added', threadId: item.threadId, messageId: id, revision: item.revision, action: item.action, blocked: item.blocked });
      else if (oldPending[id].revision !== item.revision || oldPending[id].action !== item.action || oldPending[id].blocked !== item.blocked) {
        changes.push({ type: 'pending-updated', threadId: item.threadId, messageId: id, revision: item.revision, action: item.action, blocked: item.blocked });
      }
    }
    for (const [id, item] of Object.entries(oldPending)) if (!doc.pending[id]) changes.push({ type: 'pending-removed', threadId: item.threadId, messageId: id, revision: item.revision });
  }
  return {
    status: 'ok',
    document: doc,
    comments: inspected.comments,
    changes,
    pending: pending(doc, text),
    unread: unread(doc),
    ambiguities: clone(doc.ambiguities),
    diagnostics: []
  };
}

function materializeThread(thread, parsed) {
  const raw = parsed || { id: thread.id, quote: thread.quote, resolved: thread.resolved, from: -1, to: -1, anchor: -1, raw: '', entries: [] };
  const bySignature = new Map();
  for (const message of thread.messages) {
    const key = signature(message);
    if (!bySignature.has(key)) bySignature.set(key, []);
    bySignature.get(key).push(message);
  }
  const entries = (parsed ? parsed.entries : thread.messages).map(entry => {
    const list = bySignature.get(signature(entry)) || [];
    const message = list.shift();
    return message ? { ...entry, messageId: message.id, revision: message.revision, requestKey: requestKey(message) } : { ...entry };
  });
  return { ...raw, entries };
}

function pending(input, text) {
  const doc = normalizeDocument(input, input?.id);
  let parsedById = new Map();
  if (typeof text === 'string') {
    const inspected = C.inspect(text);
    if (!inspected.ok) return [];
    if (doc.observed?.sourceHash !== digest(text)) throw new Error('文档内容尚未核对，不能选择待答。');
    parsedById = new Map(inspected.comments.map(c => [c.id, c]));
  }
  const grouped = new Map();
  for (const item of Object.values(doc.pending)) {
    if (item.blocked) continue;
    if (!grouped.has(item.threadId)) grouped.set(item.threadId, []);
    grouped.get(item.threadId).push(item);
  }
  const targets = [];
  for (const [threadId, items] of grouped) {
    const thread = doc.observed?.threads?.[threadId];
    if (!thread || thread.resolved) continue;
    const materialized = materializeThread(thread, parsedById.get(threadId));
    const messages = items.map(item => {
      const message = thread.messages.find(m => m.id === item.messageId);
      return message && { messageId: message.id, revision: message.revision, author: message.author, timestamp: message.timestamp, text: message.text };
    }).filter(Boolean);
    targets.push({
      ...materialized,
      keys: messages.map(m => `${m.messageId}@${m.revision}`),
      messageIds: messages.map(m => m.messageId),
      targetSnapshot: { threadId, quote: thread.quote, messages }
    });
  }
  return targets;
}

function acknowledge(input, targets) {
  const doc = normalizeDocument(input, input?.id);
  for (const target of targets || []) {
    for (const sent of target.targetSnapshot?.messages || []) {
      doc.submitted.messages[sent.messageId] = Math.max(doc.submitted.messages[sent.messageId] || 0, sent.revision);
      if (doc.pending[sent.messageId]?.revision <= sent.revision) delete doc.pending[sent.messageId];
    }
  }
  return doc;
}

function requeue(input, threadIds) {
  const doc = normalizeDocument(input, input?.id);
  const selected = threadIds == null ? null : new Set(Array.isArray(threadIds) ? threadIds : [threadIds]);
  const ambiguous = new Set(doc.ambiguities.flatMap(item => item.messageIds || []));
  for (const thread of Object.values(doc.observed?.threads || {})) {
    if (thread.resolved || (selected && !selected.has(thread.id))) continue;
    for (const message of thread.messages) {
      if (message.role !== 'human' || !message.mentionsChat || ambiguous.has(message.id)) continue;
      doc.pending[message.id] = {
        messageId: message.id,
        threadId: thread.id,
        revision: message.revision,
        requestKey: requestKey(message),
        action: 'requeue'
      };
    }
  }
  return doc;
}

function unread(input) {
  const doc = normalizeDocument(input, input?.id);
  const grouped = new Map();
  for (const item of Object.values(doc.unread)) {
    if (!grouped.has(item.threadId)) grouped.set(item.threadId, []);
    const message = doc.observed?.threads?.[item.threadId]?.messages.find(m => m.id === item.messageId);
    if (message) grouped.get(item.threadId).push(clone(message));
  }
  return [...grouped].map(([threadId, messages]) => ({ threadId, messages }));
}

function markRead(input, threadId) {
  const doc = normalizeDocument(input, input?.id);
  for (const [id, item] of Object.entries(doc.unread)) if (!threadId || item.threadId === threadId) delete doc.unread[id];
  return doc;
}

function validateTargets(input, latestText, targets) {
  const result = reconcile(input, latestText, { mode: 'observe' });
  if (result.status !== 'ok') return { ok: false, document: result.document, comments: [], targets: [], reasons: result.diagnostics };
  const reasons = [];
  const resolved = [];
  const ambiguousIds = new Set(result.document.ambiguities.flatMap(a => a.messageIds || []));
  const parsedById = new Map(result.comments.map(c => [c.id, c]));
  for (const target of targets || []) {
    const snap = target.targetSnapshot || { threadId: target.id, quote: target.quote, messages: [] };
    const thread = result.document.observed.threads[snap.threadId];
    if (!thread) { reasons.push(`批注 ${snap.threadId} 已删除。`); continue; }
    if (thread.resolved) { reasons.push(`批注 ${snap.threadId} 已解决。`); continue; }
    if (thread.quote !== snap.quote) { reasons.push(`批注 ${snap.threadId} 的高亮内容已更改。`); continue; }
    if (!target.targetSnapshot) {
      // v1 receipts have positional hashes. Keep their stricter validation;
      // an empty v2 snapshot would skip checking the original human request.
      const parsed = parsedById.get(thread.id);
      const keys = new Set(parsed.entries.map((entry, index) => C.entryKey(parsed, entry, index)));
      if (!target.keys?.length || !target.keys.every(key => keys.has(key))) {
        reasons.push(`批注 ${snap.threadId} 的旧版目标消息已更改，无法安全恢复。`);
      } else resolved.push({ ...parsed, keys: target.keys });
      continue;
    }
    let valid = true;
    for (const sent of snap.messages) {
      const current = thread.messages.find(m => m.id === sent.messageId);
      if (!current) { reasons.push(`批注 ${snap.threadId} 的目标消息已删除。`); valid = false; break; }
      if (ambiguousIds.has(sent.messageId)) { reasons.push(`批注 ${snap.threadId} 的消息身份有歧义。`); valid = false; break; }
      if (current.revision !== sent.revision || signature(current) !== signature(sent)) {
        reasons.push(`批注 ${snap.threadId} 的目标消息已更改。`); valid = false; break;
      }
    }
    if (valid) resolved.push({ ...materializeThread(thread, parsedById.get(thread.id)), keys: target.keys, messageIds: target.messageIds, targetSnapshot: clone(snap) });
  }
  return { ok: reasons.length === 0, document: result.document, comments: result.comments, targets: resolved, reasons };
}

module.exports = {
  VERSION,
  createDocument,
  migrateState,
  reconcile,
  pending,
  acknowledge,
  requeue,
  unread,
  markRead,
  validateTargets,
  requestKey
};
