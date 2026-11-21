'use strict';
const { randomUUID } = require('node:crypto');
const C = require('./comments.cjs');
const marker = /^<!-- ipc-message:([A-Za-z0-9+/=]+) -->\r?\n## (?:me|chat)\r?\n\r?\n/gm;
const enc = value => Buffer.from(JSON.stringify(value)).toString('base64');
function metadata(raw) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!head || !/^inplace-chat: 1\r?$/m.test(head[1])) return null;
  const value = /^chat-binding: (.+)\r?$/m.exec(head[1]);
  if (!value) throw Error('聊天文件缺少来源信息。');
  const meta = JSON.parse(JSON.parse(value[1]));
  if (!meta.source || !/^[A-Za-z0-9]+$/.test(meta.commentId) || !meta.documentId || typeof meta.quote !== 'string') throw Error('聊天文件的来源信息损坏。');
  return meta;
}
function parse(raw) {
  const meta = metadata(raw);
  if (!meta) throw Error('不是独立聊天文件。');
  const matches = [...raw.matchAll(marker)], ids = new Set();
  const messages = matches.map((m, i) => {
    const info = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    if (!info.id || ids.has(info.id) || !['me', 'chat'].includes(info.author) || typeof info.timestamp !== 'string') throw Error('聊天消息标记损坏或重复。');
    ids.add(info.id);
    return { ...info, text: raw.slice(m.index + m[0].length, matches[i + 1]?.index ?? raw.length).trimEnd() };
  });
  // Opening a highlight before asking creates this valid empty conversation.
  // Still reject files whose message markers or body were damaged.
  if (!messages.length && raw.replace(/\r\n?/g, '\n').trim() !== create(meta, []).trim()) throw Error('聊天文件没有有效消息，已停止发送。');
  return { meta, messages };
}
function message(entry) {
  if (/^<!-- ipc-message:/m.test(entry.text)) throw Error('消息包含保留的聊天分隔标记。');
  const { text, ...info } = entry;
  return `<!-- ipc-message:${enc(info)} -->\n## ${info.author}\n\n${text.trim()}\n\n`;
}
function create(meta, entries) {
  return `---\ninplace-chat: 1\nchat-binding: ${JSON.stringify(JSON.stringify(meta))}\n---\n\n[[${meta.source}|返回原文]]\n\n> ${meta.quote.replace(/\n/g, '\n> ')}\n\n` + entries.map(e => message({ id: randomUUID(), author: C.isChat(e) ? 'chat' : 'me', timestamp: e.timestamp || '', text: e.text })).join('');
}
function append(raw, entry) {
  const doc = parse(raw);
  if (doc.messages.some(m => m.id === entry.id)) return raw;
  return raw.trimEnd() + '\n\n' + message(entry);
}
const clean = text => C.bodyContext(text.replace(/\r\n?/g, '\n')).replace(/<!--/g, '&lt;!--');
const encode = text => text.replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/-->/g, '--&gt;');
function projection(raw) {
  const { meta, messages } = parse(raw);
  const lines = messages.map(m => {
    let body = clean(m.text);
    if (m.author === 'me') body = '@chat ' + body;
    return `${m.author} (${m.id}): ${encode(body)}`;
  });
  const quote = meta.quote.replace(/<!--/g, '&lt;!--');
  return `<!--c:${meta.commentId}-->${quote}<!--/c:${meta.commentId}-->\n<!--co:${meta.commentId}\n${lines.join('\n')}\n-->`;
}
function applyProjection(raw, updated) {
  const before = C.parse(projection(raw))[0], after = C.parse(updated)[0];
  if (!after || after.id !== before.id || after.quote !== before.quote || after.entries.length < before.entries.length || before.entries.some((m,i)=>JSON.stringify(m)!==JSON.stringify(after.entries[i]))) throw Error('聊天更新不能覆盖已有正文。');
  for (const entry of after.entries.slice(before.entries.length)) {
    if (!C.isChat(entry)) throw Error('只能追加模型回答。');
    raw = append(raw, { id: entry.timestamp, timestamp: entry.timestamp, author: 'chat', text: entry.text });
  }
  return raw;
}
function references(raw) {
  const comments = C.parse(raw).filter(c => !c.resolved);
  return comments.map(c => ({ id:c.id, quote:clean(c.quote), comments:c.entries.filter(e=>!C.isChat(e)).map(e=>({text:e.text,author:e.author})) })).filter(c=>c.comments.length);
}
function submission(raw, input) {
  const { messages } = parse(raw);
  const previous = Object.assign({}, ...messages.filter(m=>m.author==='me').map(m=>m.references || {}));
  const refs = references(raw), hashes = Object.fromEntries(refs.map(r=>[r.id,C.hash(JSON.stringify(r))]));
  const changed = refs.filter(r=>previous[r.id]!==hashes[r.id]);
  const text = input.trim() + (changed.length ? '\n\n### 本次引用与批注\n\n' + changed.map((r,i)=>`**引用 ${i+1}**\n\n> ${r.quote.replace(/\n/g,'\n> ')}\n\n${r.comments.map(e=>e.text).join('\n\n')}`).join('\n\n') : '');
  return { id:randomUUID(), timestamp:new Date().toISOString(), author:'me', text, references:hashes, submissionKey:C.hash(JSON.stringify([input.trim(),hashes])) };
}
function shouldSend(event) {
  return event.key==='Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey && !event.repeat && !event.isComposing && event.keyCode!==229;
}
module.exports = { metadata, parse, create, append, projection, applyProjection, submission, shouldSend };
