'use strict';
const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');
const decode = text => text.replace(/\\(.)/g, (all, ch) => ({ n: '\n', r: '\r', '\\': '\\' }[ch] ?? all));
// Document Comments stores an entire entry on one physical line.
// Escape HTML comment terminators without introducing another body delimiter.
const encode = text => text.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/-->/g, '--&gt;');
function ignoredRanges(text) {
  const ranges = []; let offset = 0, start = -1, fence = '';
  for (const line of text.split('\n')) {
    const token = /^[ \t]*(`{3,}|~{3,})/.exec(line)?.[1];
    if (start < 0 && token) { start = offset; fence = token[0]; }
    else if (start >= 0 && token?.[0] === fence) { ranges.push([start, offset + line.length]); start = -1; }
    offset += line.length + 1;
  }
  if (start >= 0) ranges.push([start, text.length]);
  for (const m of text.matchAll(/`+[^`\n]*`+/g)) ranges.push([m.index, m.index + m[0].length]);
  return ranges;
}
function parseUnchecked(text) {
  const ignored = ignoredRanges(text), skip = index => ignored.some(([a, b]) => index >= a && index < b);
  const comments = [], ids = new Set();
  for (const m of text.matchAll(/<!--co:([A-Za-z0-9]+)[ \t]*([^\n]*)\n?([\s\S]*?)-->/g)) {
    if (skip(m.index)) continue;
    const id = m[1];
    if (ids.has(id)) throw new Error(`Duplicate comment id: ${id}`);
    ids.add(id);
    const entries = [];
    for (const line of m[3].split('\n')) {
      const clean = line.replace(/\r$/, '');
      if (!clean.trim() || /^\+\s*(?:@\d+\s+)?\S+\s+.+$/.test(clean)) continue;
      const entry = /^(.*?)(?:\s\(([^)]*)\))?:\s?([\s\S]*)$/.exec(clean);
      if (entry?.[1].trim()) entries.push({ author: entry[1].trim(), timestamp: entry[2] || '', text: decode(entry[3]) });
      else if (entries.length) entries.at(-1).text += '\n' + decode(clean);
      else entries.push({ author: '', timestamp: '', text: decode(clean) });
    }
    const open = `<!--c:${id}-->`, close = `<!--/c:${id}-->`;
    let from = text.indexOf(open); while (from >= 0 && skip(from)) from = text.indexOf(open, from + 1);
    let to = from >= 0 ? text.indexOf(close, from + open.length) : -1; while (to >= 0 && skip(to)) to = text.indexOf(close, to + 1);
    const quoted = /\bquote:"([^"]*)"/.exec(m[2])?.[1] || '';
    comments.push({ id, entries, resolved: /\bstatus:resolved\b/.test(m[2]),
      quote: from >= 0 && to >= from ? text.slice(from + open.length, to) : quoted,
      from: m.index, to: m.index + m[0].length, anchor: from, anchorClose: to, raw: m[0] });
  }
  return comments;
}
function inspect(text) {
  const diagnostics = [];
  const ignored = ignoredRanges(text), skip = index => ignored.some(([a, b]) => index >= a && index < b);
  for (const m of text.matchAll(/^(?:<<<<<<<(?: .*)?|=======$|>>>>>>>?(?: .*)?)\r?$/gm)) {
    if (!skip(m.index)) diagnostics.push({ code: 'merge-conflict', index: m.index, message: '检测到未解决的合并冲突。' });
  }
  const complete = [...text.matchAll(/<!--co:([A-Za-z0-9]+)[ \t]*([^\n]*)\n?([\s\S]*?)-->/g)].filter(m => !skip(m.index));
  const completeStarts = new Set(complete.map(m => m.index));
  for (const m of text.matchAll(/<!--co:/g)) {
    if (!skip(m.index) && !completeStarts.has(m.index)) diagnostics.push({ code: 'partial-comment', index: m.index, message: '批注讨论语法不完整。' });
  }
  const anchors = new Map();
  const validAnchorStarts = new Set();
  for (const m of text.matchAll(/<!--(\/?)c:([A-Za-z0-9]+)-->/g)) {
    if (skip(m.index)) continue;
    validAnchorStarts.add(m.index);
    if (!anchors.has(m[2])) anchors.set(m[2], { open: [], close: [] });
    anchors.get(m[2])[m[1] ? 'close' : 'open'].push(m.index);
  }
  for (const m of text.matchAll(/<!--\/?c:/g)) {
    if (!skip(m.index) && !validAnchorStarts.has(m.index)) diagnostics.push({ code: 'partial-anchor', index: m.index, message: '批注锚点语法不完整。' });
  }
  for (const [id, pair] of anchors) {
    if (pair.open.length !== pair.close.length || pair.open.some((at, i) => pair.close[i] == null || pair.close[i] < at)) {
      diagnostics.push({ code: 'unpaired-anchor', commentId: id, message: `批注 ${id} 的锚点不完整。` });
    }
  }
  let comments = [];
  try { comments = parseUnchecked(text); }
  catch (error) { diagnostics.push({ code: 'parse-error', message: error.message }); }
  return { ok: diagnostics.length === 0, comments: diagnostics.length ? [] : comments, diagnostics };
}
function parse(text) {
  const result = inspect(text);
  if (!result.ok) throw new Error(result.diagnostics.map(d => d.message).join(' '));
  return result.comments;
}
const isChat = entry => entry.author.toLowerCase() === 'chat';
const mentionsChat = text => /@chat/iu.test(String(text || ''));
function entryKey(comment, entry, index) { return entry.requestKey || hash(JSON.stringify([comment.id, index, entry.author, entry.timestamp, entry.text])); }
function pending(text, handled = []) {
  const done = new Set(handled);
  return parse(text).filter(c => !c.resolved).map(c => ({ ...c,
    keys: c.entries.flatMap((e, i) => !isChat(e) && mentionsChat(e.text) && !done.has(entryKey(c, e, i)) ? [entryKey(c, e, i)] : [])
  })).filter(c => c.keys.length);
}
function bodyProjection(text) {
  const comments = parse(text);
  const ranges = comments.flatMap(c => {
    const own = [[c.from, c.to]];
    if (c.anchor >= 0 && c.anchorClose >= c.anchor) {
      own.push([c.anchor, c.anchor + `<!--c:${c.id}-->`.length]);
      own.push([c.anchorClose, c.anchorClose + `<!--/c:${c.id}-->`.length]);
    }
    return own;
  }).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const prior = merged.at(-1);
    if (prior && range[0] <= prior[1]) prior[1] = Math.max(prior[1], range[1]);
    else merged.push([...range]);
  }
  let raw = '', cursor = 0;
  for (const [from, to] of merged) { raw += text.slice(cursor, from); cursor = to; }
  raw += text.slice(cursor);
  const leading = raw.length - raw.trimStart().length;
  const body = raw.trim();
  const at = position => {
    let removed = 0;
    for (const [from, to] of merged) {
      if (to <= position) removed += to - from;
      else if (from < position) { removed += position - from; break; }
      else break;
    }
    return Math.max(0, Math.min(body.length, position - removed - leading));
  };
  return { text: body, at };
}
function bodyContext(text) {
  return bodyProjection(text).text;
}
function prepare(path, text, targets, previous = {}, maxChars = 16000, radius = 500, sourceDocument) {
  const projection = bodyProjection(text), body = projection.text, contexts = {}, next = { ...previous }, excerpts = [];
  const requests = targets.map(c => {
    const prior = previous[c.id] || {}, sent = new Set(prior.entryKeys || []);
    const entryKeys = c.entries.map((e, i) => entryKey(c, e, i));
    let index = c.anchor >= 0 ? projection.at(c.anchor) : -1;
    // Native quote text can include whitespace normalized by the surrounding
    // document trim. If needed, select the nearest occurrence to the anchor's
    // projected offset rather than an unrelated later duplicate.
    if (index >= 0 && body.slice(index, index + c.quote.length) !== c.quote) {
      const occurrences = [];
      for (let at = body.indexOf(c.quote); at >= 0; at = body.indexOf(c.quote, at + Math.max(1, c.quote.length))) occurrences.push(at);
      if (occurrences.length) index = occurrences.reduce((best, at) => Math.abs(at - index) < Math.abs(best - index) ? at : best, occurrences[0]);
      else index = -1;
    }
    const excerpt = typeof c.sourceExcerpt === 'string' ? c.sourceExcerpt : index >= 0 && c.quote ? body.slice(Math.max(0, index - radius), Math.min(body.length, index + c.quote.length + radius)) : c.quote;
    const contextHash = hash(excerpt);
    const item = { commentId: c.id, discussionDelta: c.entries.filter((_e, i) => !sent.has(entryKeys[i])) };
    if (c.pdfAnchor) item.pdfAnchor = c.pdfAnchor;
    if (prior.contextHash !== contextHash) {
      let excerptId = contexts[contextHash];
      if (!excerptId) { excerptId = `excerpt-${excerpts.length + 1}`; contexts[contextHash] = excerptId; excerpts.push({ id: excerptId, text: excerpt }); }
      item.quote = c.quote; item.excerpt = excerptId;
    } else item.context = '对应高亮及附近上下文未变，沿用本会话该批注已有片段。';
    next[c.id] = { contextHash, entryKeys };
    return item;
  });
  const connectivityOnly = targets.every(comment => comment.entries
    .filter(entry => !isChat(entry) && mentionsChat(entry.text))
    .every(entry => /^(?:@chat\s*)?(?:hi|hello|test|测试|你好)(?:[，,。.!！?？\s]*(?:hi|hello|test|测试|你好))*[，,。.!！?？\s]*$/iu.test(entry.text.trim())));
  const reading = connectivityOnly
    ? '这些批注明确只是连通性测试或问候；无需读取全文或安装工具，简短确认链路即可。'
    : '请先阅读全文，再逐一回答以下批注；原文已读且版本未变时复用已有理解。';
  const prompt = `文档：${path}\n${reading}\n${require('./reply-format.cjs').REPLY_FORMAT}\n` + JSON.stringify({ sourceDocument: sourceDocument || { path }, excerpts, requests });
  if (prompt.length > maxChars) throw new Error(`本次相关片段 ${prompt.length} 字符，超过上限 ${maxChars}；请在设置中提高上限或减少待答批注。尚未调用模型。`);
  return { next, prompt };
}
function validateReplies(raw, targets) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(data?.replies) || data.replies.length !== targets.length) throw new Error('回复数量与发送批注不一致，原始回答已保留。');
  const expected = new Set(targets.map(c => c.id));
  for (const r of data.replies) {
    if (!expected.delete(r.commentId) || typeof r.text !== 'string' || !r.text.trim()) throw new Error('回复格式或批注 ID 不正确，原始回答已保留。');
  }
  return data.replies;
}
function appendReplies(text, replies, stamp, targets) {
  const comments = parse(text), changes = [];
  for (const reply of replies) {
    const c = comments.find(c => c.id === reply.commentId);
    if (!c) throw new Error(`批注 ${reply.commentId} 已删除；回答已保留，未写入文档。`);
    const target = targets?.find(t => t.id === c.id);
    if (target && target.quote !== c.quote) throw new Error(`批注 ${c.id} 的高亮内容已更改；回答已保留，未写入。`);
    if (target?.targetSnapshot) {
      const available = new Map();
      for (const entry of c.entries) {
        const key = JSON.stringify([entry.author, entry.timestamp, entry.text]);
        available.set(key, (available.get(key) || 0) + 1);
      }
      for (const message of target.targetSnapshot.messages) {
        const key = JSON.stringify([message.author, message.timestamp, message.text]);
        const count = available.get(key) || 0;
        if (!count) throw new Error(`批注 ${c.id} 在回答期间已更改；回答已保留，未覆盖新内容。`);
        available.set(key, count - 1);
      }
    } else if (target && !target.keys.every(k => c.entries.some((e, i) => entryKey(c, e, i) === k))) throw new Error(`批注 ${c.id} 在回答期间已更改；回答已保留，未覆盖新内容。`);
    if (c.entries.some(e => isChat(e) && e.timestamp === stamp)) continue; // crash-safe local replay
    const newline = c.raw.includes('\r\n') ? '\r\n' : '\n';
    changes.push({ from: c.to - 3, insert: `${c.raw.slice(0, -3).endsWith('\n') ? '' : newline}chat (${stamp}): ${encode(reply.text)}${newline}` });
  }
  for (const c of changes.sort((a, b) => b.from - a.from)) text = text.slice(0, c.from) + c.insert + text.slice(c.from);
  return text;
}
const outputSchema = { type: 'object', additionalProperties: false, properties: { replies: { type: 'array', items: {
  type: 'object', additionalProperties: false, properties: { commentId: { type: 'string' }, text: { type: 'string' } }, required: ['commentId', 'text']
} } }, required: ['replies'] };
module.exports = { hash, parse, inspect, pending, prepare, appendReplies, validateReplies, outputSchema, entryKey, mentionsChat, isChat, bodyContext };
