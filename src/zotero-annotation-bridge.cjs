'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const C = require('./comments.cjs');
const S = require('./state.cjs');
const { openPdfUri } = require('./zotero.cjs');

const LOCAL_API = 'http://127.0.0.1:23119/api';
const SAFE_KEY = /^[A-Z0-9]{8}$/i;
const ANSWER_MARKER = '\n\n—— chat 首答 ——\n';

function request(pathname, { method = 'GET', headers = {}, body, timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(LOCAL_API + pathname);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(target, {
      method,
      headers: {
        'Zotero-API-Version': '3',
        'Zotero-Allowed-Request': 'true',
        'User-Agent': 'Obsidian-In-place-Chat/0.9.1',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...headers
      }
    }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        let data = raw;
        if (/json/i.test(String(response.headers['content-type'] || '')) && raw) {
          try { data = JSON.parse(raw); }
          catch (cause) { return reject(new Error('Zotero Local API 返回了无效 JSON。', { cause })); }
        }
        resolve({ status: response.statusCode || 0, headers: response.headers, data, raw });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Zotero Local API 超时。')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requireOk(response, context) {
  if (response.status >= 200 && response.status < 300) return response;
  const error = new Error(`${context}失败：Zotero Local API ${response.status}`);
  error.statusCode = response.status;
  error.response = response.data;
  throw error;
}

function readCredentials(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value?.serverId && value?.key ? value : null;
  } catch { return null; }
}

function writeCredentials(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs are inherited from the profile. */ }
}

function questionFromComment(value) {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!/@chat\b/iu.test(text) || text.includes(ANSWER_MARKER.trim())) return null;
  return text;
}

function answerComment(question, answer, chatUri) {
  const link = chatUri ? `\n\n完整讨论：${chatUri}` : '';
  return `${question.trim()}${ANSWER_MARKER}${String(answer || '').trim()}${link}`;
}

function safeName(value) {
  const clean = String(value || '未命名文献').replace(/[<>:"/\\|?*\x00-\x1F]/g, ' ').replace(/\s+/g, ' ').trim();
  return (clean || '未命名文献').slice(0, 100);
}

function yamlText(value) {
  return JSON.stringify(String(value == null ? '' : value));
}

function commentText(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/-->/g, '--&gt;');
}

function managedHeader({ title, parentKey, attachmentKey }) {
  return [
    '---',
    'zotero-managed: inplace-chat',
    `zotero-parent-key: ${parentKey}`,
    `zotero-attachment-key: ${attachmentKey}`,
    `title: ${yamlText(title)}`,
    '---',
    '',
    `# ${title}`,
    '',
    `[在 Zotero 中打开文献](zotero://select/library/items/${parentKey})`,
    '',
    '> 此文件保存 Zotero 高亮对应的讨论入口；书目、PDF 与批注仍以 Zotero 为准。',
    ''
  ].join('\n');
}

function annotationBlock({ annotationKey, attachmentKey, pageLabel, pageIndex, quote, question, timestamp, scope = 'library' }) {
  const page = Number.isInteger(Number(pageIndex)) && Number(pageIndex) >= 0 ? Number(pageIndex) + 1 : Number(pageLabel);
  const uri = openPdfUri(scope, attachmentKey, { page, annotationKey });
  const label = pageLabel && String(pageLabel) !== String(page)
    ? `PDF 第 ${page} 页（文献页码 ${pageLabel}）`
    : `PDF 第 ${page || '?'} 页`;
  return [
    `## Zotero 批注 · ${label}`,
    '',
    `[回到原文](${uri})`,
    '',
    `<!--c:${annotationKey}-->${String(quote || '').replace(/<!--/g, '&lt;!--')}<!--/c:${annotationKey}-->`,
    `<!--co:${annotationKey} by:me status:open`,
    `me (${timestamp || new Date().toISOString()}): ${commentText(question)}`,
    '-->',
    ''
  ].join('\n');
}

function obsidianOpenUri(vaultName, filePath) {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`;
}

class ZoteroLocalClient {
  constructor({ credentialsFile = path.join(os.homedir(), '.obsidian-inplace-chat', 'zotero-local-api.json'), transport = request } = {}) {
    this.credentialsFile = credentialsFile;
    this.transport = transport;
  }

  async server() {
    const response = requireOk(await this.transport('/'), '连接 Zotero');
    const version = String(response.headers['x-zotero-version'] || '');
    const serverId = String(response.headers['zotero-server-id'] || '');
    if (!serverId) throw new Error('当前 Zotero 未提供写入身份；请确认已升级到 Zotero 10。');
    return { version, serverId };
  }

  async authorize() {
    const server = await this.server();
    const response = await this.transport('/local/authorize', {
      method: 'POST', timeoutMs: 120000,
      headers: { 'Zotero-Server-ID': server.serverId },
      body: { appName: 'Obsidian In-place Chat' }
    });
    if (response.status === 403 && response.data?.denied) throw new Error('Zotero 写入授权已拒绝。');
    requireOk(response, '授权 Zotero 写入');
    if (!response.data?.key) throw new Error('Zotero 没有返回本地写入密钥。');
    const credentials = { serverId: server.serverId, key: response.data.key, remember: !!response.data.remember, authorizedAt: new Date().toISOString() };
    if (credentials.remember) writeCredentials(this.credentialsFile, credentials);
    else this.sessionCredentials = credentials;
    return credentials;
  }

  async credentials({ prompt = false } = {}) {
    const server = await this.server();
    const saved = this.sessionCredentials || readCredentials(this.credentialsFile);
    if (saved?.serverId === server.serverId && saved.key) return saved;
    if (!prompt) return null;
    return this.authorize();
  }

  async json(pathname) {
    return requireOk(await this.transport(pathname), '读取 Zotero').data;
  }

  async item(key, scope = 'users/0') {
    if (!SAFE_KEY.test(key || '')) throw new Error('无效的 Zotero Key。');
    return this.json(`/${scope}/items/${key}?format=json`);
  }

  async annotations(limit = 100) {
    return this.json(`/users/0/items?itemType=annotation&sort=dateModified&direction=desc&limit=${Math.max(1, Math.min(100, limit))}&format=json`);
  }

  async updateAnnotation(item, annotationComment) {
    const credentials = await this.credentials({ prompt: true });
    const server = await this.server();
    const data = { ...item.data, annotationComment };
    const response = await this.transport(`/users/0/items/${item.key}`, {
      method: 'PUT', timeoutMs: 10000,
      headers: {
        'Zotero-Server-ID': server.serverId,
        'Zotero-API-Key': credentials.key
      },
      body: data
    });
    if (response.status === 401) {
      this.sessionCredentials = null;
      const renewed = await this.authorize();
      return requireOk(await this.transport(`/users/0/items/${item.key}`, {
        method: 'PUT', timeoutMs: 10000,
        headers: { 'Zotero-Server-ID': server.serverId, 'Zotero-API-Key': renewed.key },
        body: data
      }), '写回 Zotero 批注').data;
    }
    return requireOk(response, '写回 Zotero 批注').data;
  }
}

class ZoteroAnnotationBridge {
  constructor(plugin, options = {}) {
    this.p = plugin;
    this.client = options.client || new ZoteroLocalClient(options);
    this.running = new Set();
    this.batching = false;
  }

  state() {
    this.p.zoteroBridgeState ||= { version: 1, initialized: false, seen: {}, processed: {} };
    this.p.zoteroBridgeState.seen ||= {};
    this.p.zoteroBridgeState.processed ||= {};
    return this.p.zoteroBridgeState;
  }

  async authorize() { return this.client.authorize(); }

  async initialize() {
    if (!this.p.settings.zoteroBridgeEnabled) return { status: 'disabled' };
    const state = this.state();
    if (state.initialized) return { status: 'ready' };
    const annotations = await this.client.annotations();
    for (const item of annotations) {
      const question = questionFromComment(item.data?.annotationComment);
      if (question) state.seen[item.key] = C.hash(question);
    }
    state.initialized = true;
    state.baselinedAt = new Date().toISOString();
    await this.p.saveLocal();
    return { status: 'baselined', count: Object.keys(state.seen).length };
  }

  async sendPending() {
    if (!this.p.settings.zoteroBridgeEnabled) return { status: 'disabled', pending: 0, answered: 0, failed: [] };
    if (this.batching) return { status: 'running', pending: 0, answered: 0, failed: [] };
    this.batching = true;
    try {
      const state = this.state();
      if (!state.initialized) {
        const baseline = await this.initialize();
        return { ...baseline, pending: 0, answered: 0, failed: [] };
      }
      const annotations = await this.client.annotations();
      const pending = [];
      for (const item of annotations) {
        const question = questionFromComment(item.data?.annotationComment);
        if (!question) continue;
        const fingerprint = C.hash(question);
        if (state.seen[item.key] === fingerprint || this.running.has(item.key)) continue;
        pending.push([item, fingerprint]);
      }
      let answered = 0;
      const failed = [];
      for (const [item, fingerprint] of pending) {
        try {
          const result = await this.process(item, fingerprint);
          if (result.status === 'answered') answered++;
        } catch (error) {
          failed.push({ key: item.key, message: error?.message || String(error) });
        }
      }
      return { status: 'done', pending: pending.length, answered, failed };
    } finally { this.batching = false; }
  }

  async processKey(key) {
    if (!SAFE_KEY.test(key || '')) throw new Error('无效的 Zotero 批注 Key。');
    const item = await this.client.item(key.toUpperCase());
    const question = questionFromComment(item.data?.annotationComment);
    if (!question) throw new Error('该 Zotero 批注没有尚未回答的 @chat。');
    return this.process(item, C.hash(question), { force: true });
  }

  async process(item, fingerprint, { force = false } = {}) {
    const key = item.key?.toUpperCase();
    if (!SAFE_KEY.test(key || '') || item.data?.itemType !== 'annotation') throw new Error('不是有效的 Zotero 批注。');
    if (this.running.has(key)) return { status: 'running' };
    const question = questionFromComment(item.data.annotationComment);
    if (!question) return { status: 'not-pending' };
    const state = this.state();
    if (!force && state.seen[key] === fingerprint) return { status: 'seen' };
    this.running.add(key);
    try {
      const source = await this.ensureSource(item, question);
      let answer = source.comment.entries.filter(C.isChat).at(-1)?.text;
      if (!answer) {
        const observed = await this.p.refreshFile(source.file, 'import');
        this.p.state.documents[source.file.path] = S.requeue(observed.document, [key]);
        this.p.saveState();
        const info = this.p.cache.get(source.file.path);
        if (info) info.pending = S.pending(this.p.state.documents[source.file.path]);
        await this.p.send(source.file.path, [key], 'zotero_annotation');
        const raw = await this.p.app.vault.read(source.file);
        answer = C.parse(raw).find(comment => comment.id === key)?.entries.filter(C.isChat).at(-1)?.text;
      }
      if (!answer) throw new Error('回答没有成功写入 Obsidian；Zotero 批注保持不变。');
      const documentId = this.p.state.documents[source.file.path]?.id;
      const chat = documentId && this.p.chatFiles.find(documentId, key);
      const chatUri = chat ? obsidianOpenUri(this.p.app.vault.getName(), chat.path) : '';
      await this.client.updateAnnotation(item, answerComment(question, answer, chatUri));
      state.seen[key] = fingerprint;
      state.processed[key] = { fingerprint, sourcePath: source.file.path, chatPath: chat?.path || '', processedAt: new Date().toISOString() };
      await this.p.saveLocal();
      return { status: 'answered', sourcePath: source.file.path, chatPath: chat?.path || '', answer };
    } finally { this.running.delete(key); }
  }

  async ensureSource(annotation, question) {
    const attachmentKey = annotation.data.parentItem?.toUpperCase();
    if (!SAFE_KEY.test(attachmentKey || '')) throw new Error('Zotero 批注缺少 PDF 附件身份。');
    const attachment = await this.client.item(attachmentKey);
    const parentKey = attachment.data?.parentItem?.toUpperCase();
    if (!SAFE_KEY.test(parentKey || '')) throw new Error('Zotero PDF 缺少父文献条目。');
    const parent = await this.client.item(parentKey);
    const title = parent.data?.title || attachment.data?.title || parentKey;
    const folder = String(this.p.settings.zoteroFolder || '文献/Zotero').replace(/^\/+|\/+$/g, '');
    await this.p.chatFiles.ensureFolder(folder);
    let file = this.p.app.vault.getMarkdownFiles().find(candidate => {
      if (!candidate.path.startsWith(folder + '/')) return false;
      const absolute = path.join(this.p.root, candidate.path);
      try { return new RegExp(`^zotero-parent-key:\\s*${parentKey}\\s*$`, 'mi').test(fs.readFileSync(absolute, 'utf8')); }
      catch { return false; }
    });
    if (!file) {
      const destination = `${folder}/${safeName(title)} [${parentKey}].md`;
      const existing = this.p.app.vault.getAbstractFileByPath(destination);
      if (existing) throw new Error(`Zotero 文献节点路径已被占用：${destination}`);
      file = await this.p.app.vault.create(destination, managedHeader({ title, parentKey, attachmentKey }));
    }
    let raw = await this.p.app.vault.read(file);
    let comment = C.parse(raw).find(candidate => candidate.id === annotation.key);
    if (!comment) {
      const scope = annotation.library?.type === 'group' ? `groups/${annotation.library.id}` : 'library';
      const block = annotationBlock({
        annotationKey: annotation.key,
        attachmentKey,
        pageLabel: annotation.data.annotationPageLabel,
        pageIndex: (() => { try { return JSON.parse(annotation.data.annotationPosition || '{}').pageIndex; } catch { return null; } })(),
        quote: annotation.data.annotationText,
        question,
        timestamp: annotation.data.dateModified,
        scope
      });
      await this.p.app.vault.process(file, current => current.trimEnd() + '\n\n' + block);
      raw = await this.p.app.vault.read(file);
      comment = C.parse(raw).find(candidate => candidate.id === annotation.key);
    }
    if (!comment) throw new Error('无法在 Obsidian 创建 Zotero 批注讨论。');
    return { file, comment, parent, attachment };
  }
}

module.exports = {
  ANSWER_MARKER,
  ZoteroLocalClient,
  ZoteroAnnotationBridge,
  questionFromComment,
  answerComment,
  safeName,
  managedHeader,
  annotationBlock,
  obsidianOpenUri,
  readCredentials,
  writeCredentials
};
