'use strict';
const { Plugin, PluginSettingTab, Setting, Notice, Modal, MarkdownView, TFile } = require('obsidian');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const C = require('./comments.cjs');
const S = require('./state.cjs');
const { PortableStore } = require('./portable-store.cjs');
const backend = require('./codex.cjs');
const gitAdapter = require('./git.cjs');
const { DiagnosticStore, summarizeReceipts } = require('./diagnostics.cjs');
const { PdfBridge } = require('./pdf-bridge.cjs');
const { PdfUi } = require('./pdf-ui.cjs');
const { CitationBridge } = require('./citation-bridge.cjs');
const { CodexProvider } = backend;
const { describeSource } = require('./source-document.cjs');
const { DefaultMention } = require('./default-mention.cjs');
const { applyPendingSettings } = require('./settings-update.cjs');
const { ChatFiles } = require('./chat-files.cjs');
const { openVaultFile } = require('./navigation.cjs');
const { resolveZoteroContext, zoteroUriFromTarget, openZoteroUri } = require('./zotero.cjs');
const { ZoteroAnnotationBridge } = require('./zotero-annotation-bridge.cjs');

const defaults = { executable: 'codex', model: '', effort: 'high', maxContextChars: 16000, contextRadius: 500, autoMention: true, zoteroBridgeEnabled: false, zoteroFolder: '文献/Zotero' };
const SEND_PENDING_COMMAND = 'send-pending';
const DEFAULT_SEND_HOTKEYS = [{ modifiers: ['Alt'], key: 'S' }];
const DEFAULT_READER_HOTKEYS = [{ modifiers: ['Alt', 'Shift'], key: 'C' }];
const DEFAULT_ZOTERO_SEND_HOTKEYS = [{ modifiers: ['Alt', 'Shift'], key: 'S' }];

function commandHotkeyId(plugin) {
  return `${plugin.manifest?.id || 'inplace-chat'}:${SEND_PENDING_COMMAND}`;
}

function getCommandHotkeys(app, commandId) {
  const manager = app?.hotkeyManager;
  const custom = manager?.customKeys;
  if (custom instanceof Map && custom.has(commandId)) return custom.get(commandId) || [];
  if (custom && Object.prototype.hasOwnProperty.call(custom, commandId)) return custom[commandId] || [];
  // Obsidian 1.9 exposes getHotkeys(commandId) only. Defaults are a separate
  // lookup; an explicit empty custom binding must continue to mean disabled.
  const resolved = typeof manager?.getHotkeys === 'function' ? manager.getHotkeys(commandId) : null;
  if (Array.isArray(resolved) && resolved.length) return resolved;
  const defaultHotkeys = typeof manager?.getDefaultHotkeys === 'function' ? manager.getDefaultHotkeys(commandId) : null;
  if (Array.isArray(defaultHotkeys) && defaultHotkeys.length) return defaultHotkeys;
  const command = app?.commands?.findCommand?.(commandId) || app?.commands?.commands?.[commandId];
  if (Array.isArray(command?.hotkeys) && command.hotkeys.length) return command.hotkeys;
  if (commandId.endsWith(`:${SEND_PENDING_COMMAND}`)) return DEFAULT_SEND_HOTKEYS;
  if (commandId.endsWith(':open-comment-reader')) return DEFAULT_READER_HOTKEYS;
  return Array.isArray(resolved) ? resolved : [];
}

function eventMatchesCommandHotkey(event, hotkeys, isMac = process.platform === 'darwin') {
  if (!event || !Array.isArray(hotkeys)) return false;
  return hotkeys.some(hotkey => {
    if (!hotkey) return false;
    const wantedKey = String(hotkey.key || '').toLowerCase();
    const eventKey = String(event.key || '').toLowerCase();
    const eventCode = String(event.code || '').toLowerCase();
    const enter = wantedKey === 'enter' && (eventKey === 'enter' || eventKey === 'return' || eventCode === 'enter' || eventCode === 'numpadenter');
    if (!enter && wantedKey !== eventKey) return false;
    const wanted = new Set(hotkey.modifiers || []);
    const wantsCtrl = wanted.has('Ctrl') || (!isMac && wanted.has('Mod'));
    const wantsMeta = wanted.has('Meta') || (isMac && wanted.has('Mod'));
    return !!event.altKey === wanted.has('Alt') && !!event.shiftKey === wanted.has('Shift') &&
      !!event.ctrlKey === wantsCtrl && !!event.metaKey === wantsMeta;
  });
}

function settingsSnapshot(settings) {
  return { executable: settings.executable, model: settings.model, effort: settings.effort };
}

function latestHumanText(comment) {
  return comment.entries.filter(e => e.author.toLowerCase() !== 'chat').at(-1)?.text || comment.quote || '';
}

class Inbox extends Modal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; }
  async onOpen() {
    const p = this.plugin;
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: 'chat · 待答与未读' });
    this.contentEl.createEl('button', { text: '运行记录与用量' }).onclick = () => { this.close(); p.showDiagnostics(); };
    this.contentEl.createEl('p', { text: '勾选要发送的讨论后再发送。发送快捷键（默认 Alt+S）会发送当前文档的全部待答。点击蓝边高亮会将该处标为已读。' });
    const refresh = this.contentEl.createEl('button', { text: '刷新本地变更', cls: 'ipc-refresh' });
    refresh.onclick = async () => {
      refresh.disabled = true;
      try { await p.refreshLocalChanges(true); await this.onOpen(); }
      catch (e) { p.notice(e); }
    };
    await p.ready;
    const readAll = this.contentEl.createEl('button', { text: '全部标为已读' });
    readAll.disabled = !Object.values(p.state.documents).some(doc => S.unread(doc).length);
    readAll.onclick = async () => {
      readAll.disabled = true;
      try { await p.markAllRead(); await this.onOpen(); }
      catch (e) { p.notice(e); readAll.disabled = false; }
    };
    let count = 0;
    for (const [filePath, info] of [...p.cache].sort(([a], [b]) => a.localeCompare(b))) {
      const doc = p.state.documents[filePath];
      const stopped = !doc?.job && doc?.lastStoppedJob && info.pending.length;
      if (!info.pending.length && !info.unread.length && !doc?.job && !info.ambiguities.length) continue;
      count++;
      const row = this.contentEl.createDiv({ cls: 'ipc-inbox-row' });
      row.createEl('strong', { text: filePath });
      row.createEl('div', { text: `${info.pending.length} 条待答 · ${info.unread.length} 处未读${doc?.job ? ' · 有待恢复请求' : ''}${info.ambiguities.length ? ` · ${info.ambiguities.length} 处身份不明确` : ''}` });
      if (stopped) {
        const job = p.readJob(doc.lastStoppedJob);
        row.createEl('p', { cls: 'ipc-warning', text: (job?.originalFailure?.code || job?.errorCode) === 'TURN_TIMEOUT'
          ? '上次回答超过 15 分钟，已中断；问题仍待答。'
          : `上次回答已中断/失败：${job?.error || '未取得完整回答'}；问题仍待答。` });
      }
      const actions = row.createDiv({ cls: 'ipc-actions' });
      const file = p.app.vault.getAbstractFileByPath(filePath);
      const open = actions.createEl('button', { text: p.chatFiles?.isChat(file) ? '打开聊天' : '打开原文' });
      open.onclick = async () => {
        this.close();
        try { await openVaultFile(p.app, filePath); }
        catch (e) { p.notice(e); }
      };
      const reader = actions.createEl('button', { text: '完整评论' });
      reader.onclick = () => {
        this.close();
        p.openCommentReader(filePath).catch(e => p.notice(e));
      };
      const checks = [];
      for (const c of info.pending) {
        const label = row.createEl('label', { cls: 'ipc-choice' });
        const checkbox = label.createEl('input', { type: 'checkbox' });
        checkbox.checked = true;
        checks.push([checkbox, c.id]);
        label.createSpan({ text: latestHumanText(c) });
      }
      if (checks.length && !doc?.job) {
        const send = actions.createEl('button', { text: `发送所选 ${checks.length} 条`, cls: 'mod-cta' });
        const update = () => {
          const n = checks.filter(([box]) => box.checked).length;
          send.disabled = n === 0;
          send.setText(`发送所选 ${n} 条`);
        };
        for (const [box] of checks) box.onchange = update;
        send.onclick = () => {
          const selected = checks.filter(([box]) => box.checked).map(([, id]) => id);
          this.close();
          p.send(filePath, selected, 'inbox').catch(e => p.notice(e));
        };
      }
      if (doc?.job) {
        const recover = actions.createEl('button', { text: '恢复原回答' });
        recover.onclick = () => { this.close(); p.recover(filePath).catch(e => p.notice(e)); };
        const receipt = actions.createEl('button', { text: '查看请求记录' });
        receipt.onclick = () => { this.close(); p.showReceipt(doc.job); };
      }
      if (stopped) {
        const receipt = actions.createEl('button', { text: '查看失败记录' });
        receipt.onclick = () => { this.close(); p.showReceipt(doc.lastStoppedJob); };
      }
      if (info.ambiguities.length) row.createEl('p', { cls: 'ipc-warning', text: '有重复或缺少稳定特征的消息，已保守排除，不会自动发送。' });
    }
    if (!count) this.contentEl.createEl('p', { text: '当前没有待答、未读或待恢复请求。' });
  }
}

class HistoryPicker extends Modal {
  constructor(plugin, filePath) { super(plugin.app); this.plugin = plugin; this.filePath = filePath; }
  async onOpen() {
    const p = this.plugin;
    this.contentEl.empty();
    this.contentEl.createEl('h2', { text: '重新提问历史 @chat' });
    this.contentEl.createEl('p', { text: '这会把所选历史讨论重新加入待答；仍需随后明确点击发送。' });
    const file = p.app.vault.getAbstractFileByPath(this.filePath);
    if (!(file instanceof TFile)) return this.contentEl.createEl('p', { text: '文档不存在。' });
    await p.flush(file);
    const text = await p.readSource(file);
    const observed = await p.refreshFile(file, 'observe', text);
    const already = new Set(observed.pending.map(item => item.id));
    const staged = S.requeue(observed.document);
    const historical = S.pending(staged, text).filter(item => !already.has(item.id));
    if (!historical.length) return this.contentEl.createEl('p', { text: '当前文档没有可重新加入的历史 @chat。身份不明确或已解决的讨论不会列出。' });
    const checks = [];
    for (const item of historical) {
      const label = this.contentEl.createEl('label', { cls: 'ipc-choice' });
      const checkbox = label.createEl('input', { type: 'checkbox' });
      checks.push([checkbox, item.id]);
      label.createSpan({ text: latestHumanText(item) });
    }
    const add = this.contentEl.createEl('button', { text: '加入所选待答', cls: 'mod-cta' });
    add.disabled = true;
    for (const [box] of checks) box.onchange = () => { add.disabled = !checks.some(([input]) => input.checked); };
    add.onclick = async () => {
      const ids = checks.filter(([box]) => box.checked).map(([, id]) => id);
      await p.requeueHistorical(this.filePath, ids);
      this.close();
      new Notice(`已将 ${ids.length} 条历史讨论加入待答；尚未调用模型。`);
    };
  }
}

class ChatSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const p = this.plugin;
    this.containerEl.empty();
    this.containerEl.createEl('h2', { text: 'In-place Chat' });
    this.containerEl.createEl('p', { text: '只有明确发送才会调用 Codex。设置在每次请求开始时固定；修改不会中断正在运行或待恢复的请求。' });
    const save = async () => { await p.saveLocal(); p.retireProviders(); };
    new Setting(this.containerEl).setName('清除新消息提示').setDesc('将本库现有 chat 回复全部标为已读；保留聊天内容、待答问题和正在运行的请求。').addButton(b => b.setButtonText('全部标为已读').onClick(async () => {
      b.setDisabled(true);
      try { await p.markAllRead(); new Notice('已将本库现有 chat 回复全部标为已读。'); }
      catch (e) { p.notice(e); }
      finally { b.setDisabled(false); }
    }));
    new Setting(this.containerEl).setName('评论默认 @chat').setDesc('进入空白评论框时预填；删掉即可普通批注。只有明确发送才调用模型。').addToggle(t => t.setValue(p.settings.autoMention !== false).onChange(async v => { p.settings.autoMention = v; await save(); }));
    new Setting(this.containerEl).setName('Codex 可执行文件').setDesc('默认从 PATH 查找 codex；也可填写完整路径。需先用 codex login 登录。').addText(t => t.setValue(p.settings.executable).onChange(async v => { p.settings.executable = v.trim() || 'codex'; await save(); }));
    new Setting(this.containerEl).setName('模型').setDesc('留空使用本机 Codex 默认模型；填写时请使用自己账户可用的模型名。修改模型仍沿用原文档会话。').addText(t => t.setValue(p.settings.model).onChange(async v => { p.settings.model = v.trim(); await save(); }));
    new Setting(this.containerEl).setName('推理强度').addDropdown(d => d.addOptions({ low: '低', medium: '中', high: '高' }).setValue(p.settings.effort).onChange(async v => { p.settings.effort = v; await save(); }));
    new Setting(this.containerEl).setName('批注提交字符上限').setDesc('限制本次批注消息的大小。原文件另提供完整路径，由模型自行阅读全文。').addText(t => t.setValue(String(p.settings.maxContextChars)).onChange(async v => { const n = Number(v); if (Number.isInteger(n) && n >= 1000 && n <= 500000) { p.settings.maxContextChars = n; await save(); } }));
    new Setting(this.containerEl).setName('高亮前后上下文字符数').setDesc('默认各 500 字符，仅用于定位；不限制模型读取原文。').addText(t => t.setValue(String(p.settings.contextRadius)).onChange(async v => { const n = Number(v); if (Number.isInteger(n) && n >= 0 && n <= 10000) { p.settings.contextRadius = n; await save(); } }));
    new Setting(this.containerEl).setName('Zotero 10 批注桥接').setDesc('允许手动扫描并回答 Zotero 中积攒的 @chat 批注；不会定时访问 Zotero。首次启用只建立安静基线，不发送历史问题。').addToggle(t => t.setValue(!!p.settings.zoteroBridgeEnabled).onChange(async v => {
      p.settings.zoteroBridgeEnabled = v;
      await save();
      if (v) await p.zoteroAnnotations.initialize().catch(e => p.notice(e));
    }));
    new Setting(this.containerEl).setName('回答 Zotero 待答').setDesc('一次扫描并依次回答启用后新保存的全部 @chat；等同于命令“回答 Zotero 中全部 @chat 待答”。').addButton(b => b.setButtonText('扫描并回答').onClick(async () => {
      b.setDisabled(true);
      try { await p.sendPendingZotero('settings_button'); }
      finally { b.setDisabled(false); }
    }));
    new Setting(this.containerEl).setName('Zotero 文献节点目录').setDesc('自动创建的稳定文献节点与 chat/ 子目录所在位置。').addText(t => t.setValue(p.settings.zoteroFolder || '文献/Zotero').onChange(async v => { p.settings.zoteroFolder = v.trim() || '文献/Zotero'; await save(); }));
    new Setting(this.containerEl).setName('授权 Zotero 写回').setDesc('Zotero 10 会弹出一次本地写入授权；建议选择“始终允许”。密钥不写入 Vault。').addButton(b => b.setButtonText('连接并授权').onClick(async () => {
      b.setDisabled(true);
      try { const result = await p.zoteroAnnotations.authorize(); new Notice(result.remember ? 'Zotero 已永久授权此计算机上的 In-place Chat。' : 'Zotero 已完成单次写入授权。'); }
      catch (e) { p.notice(e); }
      finally { b.setDisabled(false); }
    }));
    new Setting(this.containerEl).setName('检查连接').setDesc('只检查 Codex 启动与登录，不发送问答。').addButton(b => b.setButtonText('检查').onClick(async () => {
      let provider;
      try {
        provider = p.leaseProvider(settingsSnapshot(p.settings));
        await provider.start();
        const result = await provider.rpc('account/read', { refreshToken: false });
        new Notice(result.account ? 'Codex 已连接且已登录' : 'Codex 已连接，请先运行 codex login');
      } catch (e) { p.notice(e); }
      finally { p.releaseProvider(provider); }
    }));
  }
}

module.exports = class InplaceChat extends Plugin {
  async onload() {
    this.cache = new Map();
    this.busyFiles = new Set();
    this.recoveringFiles = new Set();
    this.timers = new Map();
    this.providers = new Map();
    this.providerUsers = new Map();
    this.localSave = Promise.resolve();
    this.hotkeyWindows = new WeakSet();
    const local = await this.loadData() || {};
    this.settings = { ...defaults, ...local.settings };
    this.sessions = local.sessions || {};
    this.pdfDrafts = local.pdfDrafts || {};
    this.pdfSubmissions = local.pdfSubmissions || {};
    this.zoteroBridgeState = local.zoteroBridgeState || {};
    this.git = local.git || {};
    if (!this.app.vault.adapter.getBasePath) throw new Error('In-place Chat 目前需要桌面本地仓库。');
    this.root = this.app.vault.adapter.getBasePath();
    await applyPendingSettings(this, path.join(this.root, this.app.vault.configDir || '.obsidian', 'plugins', this.manifest.id));
    this.storage = path.join(this.root, '.inplace-chat');
    this.diagnostics = new DiagnosticStore(path.join(this.root, this.app.vault.configDir || '.obsidian', 'plugins', this.manifest.id, 'diagnostics'));
    this.trace({ stage: 'plugin_loaded', source: 'lifecycle', status: 'ready', version: this.manifest.version });
    this.registerInterval(setInterval(() => this.diagnostics.flush(), 2000));
    this.stateFile = path.join(this.storage, 'state.json');
    this.loadPortableState();
    this.chatFiles = new ChatFiles(this);
    this.pdf = new PdfBridge(this);
    this.pdfUi = new PdfUi(this);
    this.citations = new CitationBridge(this);
    this.zoteroAnnotations = new ZoteroAnnotationBridge(this);
    this.registerObsidianProtocolHandler('inplace-chat', params => {
      if (params?.zoteroBatch || params?.batch === 'zotero') {
        this.sendPendingZotero('obsidian_protocol');
        return;
      }
      if (params?.zotero) {
        this.zoteroAnnotations.processKey(params.zotero).then(result => new Notice(result.status === 'answered' ? 'Zotero 批注已回答并写回。' : `Zotero 批注：${result.status}`)).catch(error => this.notice(error));
        return;
      }
      const useId = params?.evidence || params?.use || params?.id;
      this.trace({ stage: 'citation_open', source: 'obsidian_protocol', status: 'received', useId: String(useId || '') });
      this.citations.openUse(useId).then(result => {
        this.trace({ stage: 'citation_open', source: 'obsidian_protocol', status: result.status, useId: result.citation.useId });
        if (result.status === 'page-flashed') new Notice('已打开引用所在页；文字无法唯一匹配，已用蓝框闪烁整页。', 6000);
        if (result.status === 'page-only') new Notice('已打开引用所在页；当前阅读器未能显示临时闪烁。', 6000);
      }).catch(error => this.notice(error));
    });
    this.registerInterval(setInterval(() => this.pdf.poll(), 1500));
    this.status = this.addStatusBarItem();
    this.status.addClass('ipc-status');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.status.onclick = () => new Inbox(this).open();
    this.addRibbonIcon('messages-square', 'chat · 待答与未读', () => new Inbox(this).open());
    this.addCommand({ id: SEND_PENDING_COMMAND, name: '发送当前文档的全部 @chat 待答', hotkeys: DEFAULT_SEND_HOTKEYS, callback: () => {
      const file = this.activeSourceFile();
      this.trace({ stage: 'hotkey_command', source: 'obsidian_command', status: 'received', scope: file?.extension || 'none' });
      this.sendPendingForFile(file, 'command_hotkey');
    } });
    this.openCommentReader = (filePath, commentId) => this.chatFiles.open(filePath, commentId);
    this.addCommand({ id: 'open-comment-reader', name: '打开当前批注的完整聊天', hotkeys: DEFAULT_READER_HOTKEYS,
      callback: () => this.openCommentReader().catch(e=>this.notice(e)) });
    this.addCommand({ id: 'inbox', name: '打开待答与未读列表', callback: () => new Inbox(this).open() });
    this.addCommand({ id: 'open-zotero-source', name: '在 Zotero 中打开当前文献原文', callback: async () => {
      const file = this.activeSourceFile();
      if (!(file instanceof TFile) || file.extension !== 'md') return new Notice('请先打开由 Better Notes 同步的 Markdown 文献笔记。');
      try {
        const context = await resolveZoteroContext(await this.app.vault.read(file));
        const uri = context?.attachments?.[0]?.openUri || context?.itemUri || context?.noteUri;
        if (!uri) return new Notice('没有识别到 Better Notes 的 Zotero 身份，或 Zotero 本地接口尚未启用。');
        await openZoteroUri(uri);
      } catch (error) { this.notice(error); }
    } });
    this.addCommand({ id: 'authorize-zotero-write', name: '授权 Zotero 10 批注写回', callback: async () => {
      try { const result = await this.zoteroAnnotations.authorize(); new Notice(result.remember ? 'Zotero 已永久授权。' : 'Zotero 已完成单次授权。'); }
      catch (error) { this.notice(error); }
    } });
    this.addCommand({ id: 'send-pending-zotero', name: '回答 Zotero 中全部 @chat 待答', hotkeys: DEFAULT_ZOTERO_SEND_HOTKEYS, callback: () => {
      this.sendPendingZotero('command_hotkey');
    } });
    this.addCommand({ id: 'diagnostics', name: '查看运行记录与用量', callback: () => this.showDiagnostics() });
    this.addCommand({ id: 'requeue-history', name: '选择当前文档的历史 @chat 重新提问', callback: () => {
      const file = this.activeSourceFile();
      if (!this.isSourceFile(file)) return new Notice('请先打开 Markdown 或 PDF 批注。');
      new HistoryPicker(this, file.path).open();
    } });
    this.addCommand({ id: 'refresh-local-changes', name: '刷新本地与 Git 变更', callback: () => this.refreshLocalChanges(true).catch(e => this.notice(e)) });
    this.addCommand({ id: 'mark-read', name: '将当前文档的 chat 回复全部标为已读', callback: async () => {
      const file = this.activeSourceFile(); if (file) await this.markRead(file.path);
    } });
    this.addCommand({ id: 'recover', name: '恢复当前文档的原回答（不重发）', callback: () => {
      const file = this.activeSourceFile(); if (file) this.recover(file.path).catch(e => this.notice(e));
    } });
    this.addCommand({ id: 'new-session', name: '当前文档下一次发送使用新会话', callback: async () => {
      const file = this.activeSourceFile(), doc = file && this.state.documents[file.path];
      if (!file) return;
      if (this.busyFiles.has(file.path)) return new Notice('请等当前文档的回答完成。');
      if (doc?.job) return new Notice('请先恢复或核实未完成的请求。');
      if (doc) { delete this.sessions[this.chatFiles?.owner(file) || doc.id]; await this.saveLocal(); new Notice('下一次发送将新建会话，原评论保持可读。'); }
    } });
    this.addSettingTab(new ChatSettings(this.app, this));
    for (const event of ['modify', 'create']) this.registerEvent(this.app.vault.on(event, file => {
      this.chatFiles.invalidate(file);
      if (file instanceof TFile && this.isSourceFile(file)) {
        if (file.extension === 'pdf' && !this.pdf.files().some(open => open.path === file.path)) return;
        if (file.extension === 'pdf' && event === 'modify') this.pdf.invalidate(file);
        this.scheduleFile(file, 'observe');
        this.scheduleGitScan();
      }
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      this.chatFiles.invalidate({path:oldPath}); this.chatFiles.invalidate(file);
      this.moveDocumentState(oldPath, file.path);
      this.scheduleFile(file, this.state.documents[file.path] ? 'observe' : 'import');
      this.scheduleGitScan();
    }));
    this.registerEvent(this.app.vault.on('delete', file => { this.observeDeletion(file.path); this.scheduleGitScan(); }));
    this.registerEvent(this.app.workspace.on('file-open', file => { if (this.isSourceFile(file) && file.extension !== 'pdf') this.scheduleFile(file, this.state.documents[file.path] ? 'observe' : 'import'); this.scheduleDecorate(); }));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleDecorate()));
    this.registerEvent(this.app.workspace.on('editor-change', (_editor, view) => { if (this.isSourceFile(view.file)) this.scheduleFile(view.file, 'observe'); }));
    this.registerDomEvent(document, 'click', event => {
      const zoteroUri = zoteroUriFromTarget(event.target);
      if (zoteroUri) {
        event.preventDefault(); event.stopImmediatePropagation();
        openZoteroUri(zoteroUri).catch(error => this.notice(error));
        return;
      }
      const anchor = event.target.closest?.('.doc-comment-span[data-cid]'); if (!anchor) return;
      const leaf = this.app.workspace.getLeavesOfType('markdown').find(l => l.view.containerEl.contains(anchor));
      if (leaf?.view.file) this.markRead(leaf.view.file.path, anchor.dataset.cid).catch(e => this.notice(e));
    });
    this.registerHotkeyWindow(window);
    this.observer = new MutationObserver(() => this.scheduleDecorate());
    this.observer.observe(document.body, { subtree: true, childList: true });
    this.register(() => this.observer.disconnect());
    this.ready = new Promise(resolve => this.app.workspace.onLayoutReady(() => {
      this.chatFiles.closeLegacyViews();
      this.initializeCache().then(() => this.zoteroAnnotations.initialize()).catch(e => this.notice(e)).finally(resolve);
    }));
    // Reading the accepted turn never starts a new generation. Keep this separate
    // from ready: recover() itself awaits the initial vault reconciliation.
    this.recoveryReady = this.ready.then(() => this.recoverOutstanding()).catch(e => this.notice(e));
    if (this.registerInterval) this.registerInterval(setInterval(() => this.scanGitChanges(false).catch(e => console.warn('[inplace-chat] Git scan:', e)), 30000));
  }

  async sendPendingZotero(source = 'command') {
    if (!this.settings.zoteroBridgeEnabled) {
      new Notice('请先在 In-place Chat 设置中启用 Zotero 10 批注桥接。');
      return { status: 'disabled', pending: 0, answered: 0, failed: [] };
    }
    new Notice('正在扫描 Zotero 的 @chat 待答…');
    this.trace({ stage: 'zotero_batch', source, status: 'started' });
    try {
      const result = await this.zoteroAnnotations.sendPending();
      const failures = result.failed?.length || 0;
      this.trace({ stage: 'zotero_batch', source, status: failures ? 'partial' : result.status, pending: result.pending, answered: result.answered, failed: failures });
      if (result.status === 'running') new Notice('Zotero 待答正在处理中。');
      else if (result.status === 'baselined') new Notice(`已建立 Zotero 安静基线（${result.count} 条）；之后保存的 @chat 将在下次手动提交时回答。`, 7000);
      else if (!result.pending) new Notice('Zotero 中没有新的 @chat 待答。');
      else if (failures) new Notice(`Zotero 待答完成 ${result.answered}/${result.pending}；${failures} 条失败，可再次提交重试。`, 8000);
      else new Notice(`Zotero 的 ${result.answered} 条 @chat 已全部回答并写回。`, 6000);
      return result;
    } catch (error) {
      this.trace({ stage: 'zotero_batch', source, status: 'failed', error: error?.message || String(error) });
      this.notice(error);
      return { status: 'failed', pending: 0, answered: 0, failed: [{ message: error?.message || String(error) }] };
    }
  }

  trace(event) {
    try { this.diagnostics?.record(event); } catch { /* diagnostics must not affect sending */ }
  }

  registerHotkeyWindow(win) {
    this.chatFiles?.bindCardWindow(win);
    if (!win?.addEventListener || this.hotkeyWindows?.has(win)) return;
    this.hotkeyWindows ||= new WeakSet();
    this.hotkeyWindows.add(win);
    this.defaultMention ||= new DefaultMention(() => this.settings.autoMention !== false && !this.chatFiles?.isChat(this.activeSourceFile()));
    this.register?.(this.defaultMention.attach(win));
    const handler = event => this.handleHotkeyCapture(event);
    win.addEventListener('keydown', handler, true);
    this.register?.(() => win.removeEventListener('keydown', handler, true));
    const select = event => { try { this.chatFiles?.captureTarget(event.target); } catch(error) { this.notice(error); } };
    win.addEventListener('pointerdown', select, true);
    this.register?.(() => win.removeEventListener('pointerdown', select, true));
  }

  hotkeyEventScope(target) {
    if (!target?.closest) return 'unknown';
    if (target.closest('.ipc-reader-thread')) return 'reader';
    if (target.closest('.lpa-mark-popover, .lpa-selection-popover, .lpa-native-margins, .lpa-margin-card')) return 'pdf_popover';
    if (target.closest('.doc-comment-card, .doc-comment-margin, .dc-sidebar-view, .dc-sidebar')) return 'comment';
    if (target.closest('.modal-container')) return 'modal';
    return 'workspace';
  }

  handleHotkeyCapture(event) {
    const sendHotkeys = getCommandHotkeys(this.app, commandHotkeyId(this));
    const readerHotkeys = getCommandHotkeys(this.app, `${this.manifest?.id || 'inplace-chat'}:open-comment-reader`);
    const resemblesConfigured = eventMatchesCommandHotkey(event, sendHotkeys) || eventMatchesCommandHotkey(event, readerHotkeys);
    const resemblesDefault = !!event?.altKey && !event?.ctrlKey && !event?.metaKey &&
      ((!event.shiftKey && ['enter', 'return'].includes(String(event.key || '').toLowerCase())) ||
       (!event.shiftKey && ['enter', 'numpadenter'].includes(String(event.code || '').toLowerCase())) ||
       (event.shiftKey && String(event.key || '').toLowerCase() === 'c'));
    if (!resemblesConfigured && !resemblesDefault) return false;
    const modifiers = [event.ctrlKey && 'Ctrl', event.metaKey && 'Meta', event.altKey && 'Alt', event.shiftKey && 'Shift'].filter(Boolean).join('+') || 'none';
    this.trace({
      stage: 'hotkey_event', source: 'window_capture', status: 'observed',
      key: String(event.key || ''), code: String(event.code || ''), modifiers,
      defaultPrevented: !!event.defaultPrevented, repeat: !!event.repeat, isComposing: !!event.isComposing,
      scope: this.hotkeyEventScope(event.target)
    });
    // Obsidian can dispatch its command earlier on this same event. Respect
    // the event's consumed state, regardless of how long that command took.
    return this.handleCommentHotkey(event);
  }

  notice(error) { this.trace({ stage: 'error', status: 'failed', reason: error.code || 'UNCLASSIFIED_ERROR' }); console.error('[inplace-chat]', error); new Notice(error.message || String(error), 10000); }

  loadPortableState() {
    this.persistence ||= new PortableStore();
    const raw = this.persistence.readJSON(this.stateFile, { version: S.VERSION, documents: {} });
    const wasV1 = raw?.version === 1;
    let migrated;
    try { migrated = S.migrateState(raw); }
    catch (e) { throw new Error(`In-place Chat 状态不兼容：${e.message}。已停止，未按空状态继续。`); }
    if (wasV1) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backup = path.join(this.storage, `state.v1.${stamp}.backup.json`);
      fs.mkdirSync(this.storage, { recursive: true });
      fs.copyFileSync(this.stateFile, backup);
    }
    this.persistence.writeJSON(this.stateFile, migrated);
    this.state = migrated;
  }

  saveState() { return (this.persistence ||= new PortableStore()).writeJSON(this.stateFile, this.state); }

  saveLocal() {
    this.localSave = this.localSave.catch(() => {}).then(() => this.saveData({
      settings: this.settings,
      sessions: this.sessions,
      git: this.git,
      pdfDrafts: this.pdfDrafts || {},
      pdfSubmissions: this.pdfSubmissions || {},
      zoteroBridgeState: this.zoteroBridgeState || {}
    }));
    return this.localSave;
  }

  getProvider(config = settingsSnapshot(this.settings)) {
    // A fresh process reads the current Codex login. Each request owns its
    // process, so a later login never interrupts another document's answer.
    const provider = new CodexProvider({ ...config, cwd: path.join(os.homedir(), '.obsidian-inplace-chat', '问答'),
      codexHome: path.join(os.homedir(), '.obsidian-inplace-chat', 'codex', C.hash(path.resolve(this.root)).slice(0, 16)),
      sourceCodexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex') });
    provider.__ipcKey = randomUUID();
    this.providers.set(provider.__ipcKey, provider);
    return provider;
  }

  leaseProvider(config) {
    const provider = this.getProvider(config), key = provider.__ipcKey;
    this.providerUsers.set(key, (this.providerUsers.get(key) || 0) + 1);
    return provider;
  }

  releaseProvider(provider) {
    const key = provider?.__ipcKey;
    if (!key) return;
    const count = Math.max(0, (this.providerUsers.get(key) || 1) - 1);
    if (count) this.providerUsers.set(key, count); else this.providerUsers.delete(key);
    this.retireProviders();
  }

  retireProviders() {
    for (const [key, provider] of this.providers) if (!this.providerUsers.get(key)) {
      provider.close();
      this.providers.delete(key);
    }
  }

  textFor(file) {
    if (this.chatFiles?.isChat(file)) return this.chatFiles.read(file);
    if (file.extension === 'pdf') return this.pdf.textFor(file);
    const view = this.app.workspace.getLeavesOfType('markdown').map(l => l.view).find(v => v instanceof MarkdownView && v.file?.path === file.path);
    return view ? Promise.resolve(view.getViewData()) : this.app.vault.read(file);
  }

  async flush(file) {
    if (file.extension === 'pdf') return this.pdf.flush(file);
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) if (leaf.view.file?.path === file.path) await leaf.view.save();
  }

  isSourceFile(file) { return !!file && (file.extension === 'pdf' || (file.extension === 'md' && !/^\.(?:inplace-chat|pdf-annotator)\//.test(file.path))); }
  activeSourceFile() {
    const view = this.app.workspace.activeLeaf?.view;
    if (view?.getViewType?.() === 'inplace-chat-comment-reader') return this.app.vault.getAbstractFileByPath(view.path);
    return view?.file || this.app.workspace.getActiveFile?.() || null;
  }
  readSource(file) { return this.chatFiles?.isChat(file) ? this.chatFiles.read(file) : file.extension === 'pdf' ? this.pdf.textFor(file) : this.app.vault.read(file); }
  processSource(file, callback, targets) { return this.chatFiles?.isChat(file) ? this.chatFiles.process(file, callback) : file.extension === 'pdf' ? this.pdf.process(file, callback, targets) : this.app.vault.process(file, callback); }

  scheduleFile(file, mode = 'observe') {
    const prior = this.timers.get(file.path);
    if (prior) clearTimeout(prior.timer);
    const combined = prior?.mode === 'observe' || mode === 'observe' ? 'observe' : 'import';
    const timer = setTimeout(() => {
      this.timers.delete(file.path);
      this.refreshFile(file, combined).catch(e => this.notice(e));
    }, 350);
    this.timers.set(file.path, { timer, mode: combined });
  }

  cacheResult(filePath, result) {
    this.cache.set(filePath, { comments: result.comments, pending: result.pending, unread: result.unread, ambiguities: result.ambiguities || [], diagnostics: result.diagnostics || [] });
    this.scheduleDecorate();
    this.app.workspace.trigger?.('inplace-chat:updated', filePath);
  }

  async refreshFile(file, mode = 'observe', suppliedText) {
    const text = suppliedText ?? await this.textFor(file);
    const existing = this.state.documents[file.path];
    const doc = existing || S.createDocument(randomUUID());
    const actualMode = doc.needsBaseline ? 'import' : mode;
    const result = S.reconcile(doc, text, { mode: actualMode });
    if (result.status !== 'ok') {
      this.trace({ stage: 'reconcile', documentId: doc.id, source: actualMode, status: 'blocked', reason: 'COMMENT_PARSE_FAILED' });
      if (existing) this.cache.set(file.path, { comments: [], pending: S.pending(existing), unread: S.unread(existing), ambiguities: existing.ambiguities || [], diagnostics: result.diagnostics || [] });
      throw new Error(`无法核对 ${file.path} 的评论；已保留上次状态，未清空待答。${result.diagnostics?.[0]?.message ? ` ${result.diagnostics[0].message}` : ''}`);
    }
    this.state.documents[file.path] = result.document;
    this.saveState();
    this.cacheResult(file.path, result);
    const before = S.pending(doc).length;
    if (!existing || before !== result.pending.length || JSON.stringify(doc.observed) !== JSON.stringify(result.document.observed)) {
      this.trace({ stage: 'reconcile', documentId: doc.id, source: actualMode, status: 'ok', counts: { pendingBefore: before, pendingAfter: result.pending.length, unread: result.unread.length, ambiguities: result.ambiguities?.length || 0 } });
    }
    return result;
  }

  async refreshAll() {
    const files = [...this.app.vault.getMarkdownFiles().filter(file => this.isSourceFile(file)), ...(this.pdf?.files() || [])];
    const live = new Set(files.map(file => file.path));
    for (const file of files) {
      const existing = this.state.documents[file.path];
      try { await this.refreshFile(file, existing ? 'observe' : 'import'); }
      catch (e) { this.notice(e); }
    }
    for (const filePath of Object.keys(this.state.documents)) if (!live.has(filePath) && !this.app.vault.getAbstractFileByPath(filePath)) this.observeDeletion(filePath);
    this.decorate();
  }

  async initializeCache() {
    await this.scanGitChanges(false);
    await this.refreshAll();
  }

  observeDeletion(deletedPath) {
    let changed = false;
    for (const filePath of Object.keys(this.state.documents)) if (filePath === deletedPath || filePath.startsWith(deletedPath + '/')) {
      const result = S.reconcile(this.state.documents[filePath], '', { mode: 'observe' });
      if (result.status === 'ok') {
        this.trace({ stage: 'document_deleted', documentId: result.document.id, source: 'vault', status: 'ok' });
        this.state.documents[filePath] = result.document;
        this.cacheResult(filePath, result);
        changed = true;
      }
    }
    if (changed) this.saveState();
    else this.cache.delete(deletedPath);
    this.decorate();
  }

  moveDocumentState(oldPath, newPath) {
    let changed = false;
    for (const key of Object.keys(this.state.documents)) if (key === oldPath || key.startsWith(oldPath + '/')) {
      const next = newPath + key.slice(oldPath.length);
      if (!this.state.documents[next]) this.state.documents[next] = this.state.documents[key];
      this.trace({ stage: 'document_renamed', documentId: this.state.documents[key].id, source: 'vault', status: 'ok' });
      delete this.state.documents[key];
      this.cache.delete(key);
      changed = true;
    }
    if (changed) this.saveState();
  }

  async scanGitChanges(manual = false) {
    if (typeof gitAdapter.scanChangedFiles !== 'function') {
      if (manual) await this.refreshAll();
      return { ok: false, reason: 'adapter-unavailable' };
    }
    const result = await gitAdapter.scanChangedFiles({ cwd: this.root, baseline: this.git.head, executable: 'git' });
    if (manual || result.candidates?.length) this.trace({ stage: 'git_scan', source: manual ? 'manual' : 'git', status: result.ok ? 'ok' : 'fallback', reason: result.reason, counts: { candidates: result.candidates?.length || 0 } });
    if (!result.ok) {
      if (manual || ['baseline-missing', 'history-rewritten'].includes(result.reason)) await this.refreshAll();
      if (result.head) { this.git.head = result.head; await this.saveLocal(); }
      return result;
    }
    for (const candidate of result.candidates) {
      if (candidate.oldPath && candidate.oldPath !== candidate.path) this.moveDocumentState(candidate.oldPath, candidate.path);
      const file = this.app.vault.getAbstractFileByPath(candidate.path);
      if (file instanceof TFile && this.isSourceFile(file) && file.extension === 'md') {
        try { await this.refreshFile(file, this.state.documents[file.path] ? 'observe' : 'import'); }
        catch (error) {
          this.trace({ stage: 'reconcile', documentId: this.state.documents[file.path]?.id, source: 'git', status: 'blocked', reason: 'DOCUMENT_READ_FAILED' });
          console.warn(`[inplace-chat] 无法核对 ${file.path}:`, error);
        }
      }
      else if (file?.extension === 'pdf') continue;
      else if (this.state.documents[candidate.path]) {
        const removed = S.reconcile(this.state.documents[candidate.path], '', { mode: 'observe' });
        if (removed.status === 'ok') {
          this.state.documents[candidate.path] = removed.document;
          this.saveState();
          this.cacheResult(candidate.path, removed);
        }
      } else this.cache.delete(candidate.path);
    }
    this.git.head = result.head;
    await this.saveLocal();
    this.decorate();
    return result;
  }

  scheduleGitScan() {
    clearTimeout(this.gitTimer);
    this.gitTimer = setTimeout(() => this.scanGitChanges(false).catch(e => console.warn('[inplace-chat] Git scan:', e)), 1500);
  }

  async refreshLocalChanges(manual = false) {
    await this.ready;
    if (!this.busyFiles.size) this.loadPortableState();
    const result = await this.scanGitChanges(manual);
    if (manual) new Notice(result.ok ? `已核对 ${result.candidates.length} 个本地 Git 候选文件` : 'Git 不可用，已直接核对库中文档');
  }

  unread(filePath) { return S.unread(this.state.documents[filePath]); }

  sendPendingForFile(file, source = 'command') {
    if (this.chatFiles?.isChat(file) && this.chatFiles.draft(file).trim()) return this.chatFiles.submit(file,this.chatFiles.draft(file)).catch(e=>this.notice(e));
    if (!this.isSourceFile(file)) { this.trace({ stage: 'send_blocked', source, status: 'not_called', reason: 'NO_SOURCE_DOCUMENT' }); return new Notice('请先打开 Markdown 评论或 PDF Annotator 批注。'); }
    if (file.extension === 'pdf') {
      try {
        const context = this.pdf.contextFor(file);
        if (Object.entries(this.pdfDrafts || {}).some(([key, value]) => key.startsWith(context.bundleId + ':') && String(value).trim())) {
          this.trace({ stage: 'send_blocked', source, status: 'not_called', reason: 'UNSAVED_DRAFT' });
          return new Notice('请先保存 PDF 追问草稿，再发送待答。');
        }
      } catch (error) { this.notice(error); return; }
    }
    this.send(file.path, undefined, source).catch(e => this.notice(e));
  }

  handleCommentHotkey(event) {
    if (event.defaultPrevented || event.repeat || event.isComposing) return false;
    const target = event.target;
    if (!target?.closest) return false;
    if (target.closest('.modal-container')) return false;
    const reader = this.app.workspace.getLeavesOfType('inplace-chat-comment-reader').find(leaf => leaf.view.containerEl?.contains(target));
    const readerSource = reader && this.app.vault.getAbstractFileByPath(reader.view.path);
    const activeFile = this.activeSourceFile();
    const pdfFile = this.pdf?.fileForTarget(target, activeFile) || (readerSource?.extension === 'pdf' ? readerSource : null);
    if (pdfFile) {
      const open = eventMatchesCommandHotkey(event, getCommandHotkeys(this.app, `${this.manifest?.id || 'inplace-chat'}:open-comment-reader`));
      const send = eventMatchesCommandHotkey(event, getCommandHotkeys(this.app, commandHotkeyId(this)));
      if (!open && !send) {
        const resemblesDefault = (event.altKey && !event.ctrlKey && !event.metaKey) &&
          ((!event.shiftKey && String(event.key).toLowerCase() === 'enter') || (event.shiftKey && String(event.key).toLowerCase() === 'c'));
        if (resemblesDefault) this.trace({ stage: 'send_blocked', source: 'pdf_hotkey', status: 'not_called', reason: 'HOTKEY_UNBOUND' });
        return false;
      }
      event.preventDefault(); event.stopImmediatePropagation?.();
      if (open && send) { new Notice('打开评论和发送的快捷键重复，请分别绑定。'); return true; }
      if (open) this.openCommentReader(pdfFile.path).catch(error => this.notice(error));
      else {
        const thread = reader && target.closest('.ipc-reader-thread');
        const input = thread && target.matches?.('textarea.ipc-pdf-input') ? target : null;
        if (input?.value?.trim()) {
          const threadId = thread.dataset?.threadId;
          if (!threadId) {
            this.trace({ stage: 'send_blocked', source: 'pdf_reader_hotkey', status: 'not_called', reason: 'PDF_THREAD_UNRESOLVED' });
            new Notice('无法确定当前 PDF 讨论；没有发送。');
          } else {
            let context;
            try { context = this.pdf.contextFor(pdfFile); }
            catch (error) { this.notice(error); return true; }
            this.pdf.addMessage(context, threadId, input.value, { send: true }).catch(error => this.notice(error));
          }
        } else this.sendPendingForFile(pdfFile, 'pdf_hotkey');
      }
      return true;
    }
    const surface = target.closest('.doc-comment-card, .doc-comment-margin, .dc-sidebar-view, .dc-sidebar');
    if (!surface) return false;
    const readerHotkeys = getCommandHotkeys(this.app, `${this.manifest?.id || 'inplace-chat'}:open-comment-reader`);
    const openReader = eventMatchesCommandHotkey(event, readerHotkeys);
    const hotkeys = getCommandHotkeys(this.app, commandHotkeyId(this));
    const sendPending = eventMatchesCommandHotkey(event, hotkeys);
    if (!openReader && !sendPending) return false;
    if (openReader && sendPending) {
      event.preventDefault(); event.stopImmediatePropagation();
      this.trace({ stage: 'send_blocked', source: 'comment_hotkey', status: 'not_called', reason: 'HOTKEY_CONFLICT' });
      new Notice('打开完整评论和发送待答的快捷键重复，请在快捷键设置中分别绑定。');
      return true;
    }
    const card = target.closest('.doc-comment-card');
    const fields = card ? [...card.querySelectorAll('.dc-field--composer textarea, .dc-field--edit textarea')] : [];
    if (target.matches?.('textarea')) fields.push(target);
    const hasDraft = fields.some(field => field.value?.trim());
    event.preventDefault();
    event.stopImmediatePropagation?.();
    if (hasDraft && !openReader) {
      this.trace({ stage: 'send_blocked', source: 'comment_hotkey', status: 'not_called', reason: 'UNSAVED_DRAFT' });
      new Notice('请先保存当前评论草稿，再发送 @chat 待答。');
      return true;
    }
    const markdownLeaves = this.app.workspace.getLeavesOfType('markdown');
    const leaf = markdownLeaves.find(item => item.view?.containerEl?.contains?.(surface)) ||
      this.app.workspace.getLeavesOfType('document-comments-sidebar').find(item => item.view?.containerEl?.contains?.(surface));
    const file = leaf?.view?.file;
    if (file?.extension !== 'md') {
      this.trace({ stage: 'send_blocked', source: 'comment_hotkey', status: 'not_called', reason: 'NO_SOURCE_DOCUMENT' });
      new Notice('无法确定这条评论所属的 Markdown 文档；没有发送。');
      return true;
    }
    if (openReader) {
      this.trace({ stage: 'reader_open', source: 'comment_hotkey', documentId: this.state.documents[file.path]?.id, status: 'ok' });
      this.openCommentReader(file.path).catch(e => this.notice(e));
    } else this.sendPendingForFile(file, 'comment_hotkey');
    return true;
  }

  async markRead(filePath, id) {
    const doc = this.state.documents[filePath];
    if (!doc) return;
    // The source and its standalone chat file represent the same discussion.
    // Discover bindings even when that chat has never been opened this session.
    const bindings = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const meta = this.chatFiles?.meta(file);
      if (meta) bindings.set(file.path, meta);
    }
    const binding = bindings.get(filePath);
    const ownerId = binding?.documentId || doc.id;
    const threadId = binding?.commentId || id;
    const targets = new Map([[filePath, threadId]]);
    for (const [name, candidate] of Object.entries(this.state.documents)) {
      const meta = bindings.get(name);
      if (candidate.id === ownerId || (meta?.documentId === ownerId && (!threadId || meta.commentId === threadId))) {
        targets.set(name, meta?.commentId || threadId);
      }
    }
    this.acknowledgeRead(targets);
  }

  async markAllRead() {
    await this.ready;
    this.acknowledgeRead(new Map(Object.keys(this.state.documents).map(name => [name, undefined])));
  }

  acknowledgeRead(targets) {
    const changed = [];
    for (const [name, id] of targets) {
      const doc = this.state.documents[name];
      if (!doc || !S.unread(doc).some(item => !id || (item.threadId || item.id) === id)) continue;
      this.state.documents[name] = S.markRead(doc, id);
      const info = this.cache.get(name);
      if (info) info.unread = S.unread(this.state.documents[name]);
      changed.push(name);
    }
    if (!changed.length) return;
    this.saveState();
    this.decorate();
    for (const name of changed) this.app.workspace.trigger?.('inplace-chat:updated', name);
  }

  async requeueHistorical(filePath, threadIds) {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error('文档不存在。');
    const observed = await this.refreshFile(file, 'observe');
    const doc = S.requeue(observed.document, threadIds);
    this.state.documents[filePath] = doc;
    this.saveState();
    const info = this.cache.get(filePath);
    if (info) info.pending = S.pending(doc, await this.textFor(file));
    this.decorate();
  }

  scheduleDecorate() {
    if (this.decorating) return;
    this.decorating = setTimeout(() => { this.decorating = null; this.decorate(); }, 100);
  }

  decorate() {
    this.chatFiles?.schedule();
    this.pdfUi?.decorate();
    const active = this.activeSourceFile();
    const owner = file => this.chatFiles?.owner(file) || file?.path;
    const activeOwner = owner(active);
    const empty = () => ({ working: 0, recovering: 0, outstanding: 0, stopped: 0, waiting: 0, unread: 0 });
    const current = empty(), other = empty(), details = [];
    const describe = (value, compact = false) => [
      value.working ? `${value.working} 正在工作…` : '',
      value.recovering ? `${value.recovering} 正在恢复…` : '',
      value.outstanding ? `${value.outstanding} 待恢复` : '',
      value.stopped ? `${value.stopped} 已中断/失败` : '',
      !compact || value.waiting ? `${value.waiting} 待答` : '', !compact || value.unread ? `${value.unread} 未读` : ''
    ].filter(Boolean).join(' · ');
    const paths = new Set([...this.cache.keys(), ...Object.keys(this.state.documents), ...this.busyFiles]);
    for (const name of paths) {
      const info = this.cache.get(name), doc = this.state.documents[name];
      const recovering = this.recoveringFiles?.has(name) || false;
      const value = {
        working: Number(this.busyFiles.has(name) && !recovering), recovering: Number(recovering),
        outstanding: Number(!!doc?.job && !this.busyFiles.has(name)),
        stopped: Number(!doc?.job && !!doc?.lastStoppedJob && !!info?.pending.length),
        waiting: info?.pending.length || 0, unread: info?.unread.length || 0
      };
      const target = !activeOwner || owner(this.app.vault.getAbstractFileByPath(name)) === activeOwner ? current : other;
      for (const key of Object.keys(value)) target[key] += value[key];
      if (Object.values(value).some(Boolean)) details.push(`${name}：${describe(value, true)}`);
    }
    const label = `chat ${activeOwner ? '当前文档' : '全库'} · ${describe(current)}${Object.values(other).some(Boolean) ? ` ｜ 其他文档：${describe(other, true)}` : ''}`;
    const tooltip = `${label}\n${details.join('\n')}\n点击查看待答、未读与失败记录`;
    this.status?.classList.toggle('is-working', current.working + other.working > 0);
    this.status?.setAttribute('aria-label', tooltip);
    this.status?.setAttribute('title', tooltip);
    if (this.status?.textContent !== label) this.status?.setText(label);
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const filePath = leaf.view.file?.path, info = this.cache.get(filePath);
      const ids = new Set([...(info?.unread.map(group => group.threadId || group.id) || []),...(this.chatFiles?.unreadIds(filePath) || [])]);
      for (const el of leaf.view.containerEl.querySelectorAll('.doc-comment-span[data-cid]')) el.classList.toggle('ipc-unread', ids.has(el.dataset.cid));
    }
  }

  async send(filePath, selectedThreadIds, source = 'command') {
    const actionId = randomUUID(), startedAt = Date.now();
    const event = (stage, extra = {}) => this.trace({ actionId, source, documentId: this.state.documents[filePath]?.id, stage, ...extra });
    event('send_requested', { status: 'preflight', counts: { selected: selectedThreadIds?.length ?? -1 } });
    await this.ready;
    if (this.busyFiles.has(filePath)) { event('send_blocked', { status: 'not_called', reason: 'DOCUMENT_BUSY' }); return new Notice('当前文档已有回答正在处理，不会重复发送。'); }
    if (!this.busyFiles.size) this.loadPortableState();
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile) || !this.isSourceFile(file)) { event('send_blocked', { status: 'not_called', reason: 'NO_SOURCE_DOCUMENT' }); throw new Error('文档不存在。'); }
    if (this.chatFiles?.busy(file)) throw new Error('同一原文已有回答正在处理，请稍后发送。');
    const current = this.state.documents[filePath];
    if (current?.job) { event('send_blocked', { status: 'not_called', reason: 'RECOVERY_REQUIRED' }); throw new Error('上次请求有待恢复；请使用“恢复原回答”，不会重复调用。'); }
    this.busyFiles.add(filePath);
    this.decorate();
    let leasedProvider;
    try {
      await this.flush(file);
      const text = await this.readSource(file);
      const observed = await this.refreshFile(file, 'observe', text);
      const selected = selectedThreadIds ? new Set(selectedThreadIds) : null;
      const targets = observed.pending.filter(c => !selected || selected.has(c.id));
      if (file.extension === 'pdf') this.pdf.enrichTargets(file, targets);
      if (!targets.length) { event('send_blocked', { status: 'not_called', reason: 'NO_PENDING' }); return new Notice(selected ? '所选讨论已不再待答，没有调用模型。' : '当前文档没有待答 @chat 评论。'); }
      const doc = observed.document;
      if (doc.job) throw new Error('上次请求有待恢复；不会重复调用。');
      const config = settingsSnapshot(this.settings);
      const binding = this.chatFiles?.meta(file);
      const sessionDocumentId = binding?.documentId || doc.id;
      const session = this.sessions[sessionDocumentId] || {};
      const original = binding ? this.chatFiles.source(binding) : file;
      const originalText = binding && original.extension === 'md' ? await this.app.vault.read(original) : text;
      const sourceDocument = describeSource(this.root, original, originalText, sessionDocumentId);
      if (original.extension === 'md') {
        const zotero = await resolveZoteroContext(originalText).catch(error => ({ source: 'better-notes', readOnly: true, available: false, reason: error.message }));
        if (zotero) sourceDocument.zotero = zotero;
      }
      const prepared = C.prepare(original.path, text, targets, session.contexts, this.settings.maxContextChars, file.extension === 'pdf' ? 0 : this.settings.contextRadius, sourceDocument);
      event('input_prepared', { status: 'not_called', model: config.model, effort: config.effort, counts: { targets: targets.length, promptChars: prepared.prompt.length, promptBytes: Buffer.byteLength(prepared.prompt, 'utf8') } });
      const provider = leasedProvider = this.leaseProvider(config);
      event('connecting', { status: 'connecting' });
      const scope = provider.getAccountScope ? await provider.getAccountScope({ refresh: true }) : null;
      const expected = session.threadScope || (session.scopeKey ? { accountScopeKey: session.scopeKey, model: session.model, modelProvider: session.modelProvider } : undefined);
      session.threadId = await provider.thread(session.threadId, `chat · ${this.app.vault.getName()} · ${filePath}`, expected);
      session.threadScope = provider.getThreadScope?.(session.threadId) || expected || null;
      if (scope) Object.assign(session, { scopeKey: scope.key, scopeType: scope.type, scopeLabel: scope.label });
      session.model = session.threadScope?.model || config.model;
      session.modelProvider = session.threadScope?.modelProvider;
      this.sessions[sessionDocumentId] = session;
      await this.saveLocal();
      const job = {
        version: 2, id: randomUUID(), documentId: doc.id, sessionDocumentId, path: filePath, threadId: session.threadId,
        status: 'sending', createdAt: new Date().toISOString(), targets, prompt: prepared.prompt,
        contexts: prepared.next, provider: config, accountScope: scope, threadScope: session.threadScope,
        sourceDocument, permissions: { sandbox: 'danger-full-access', approvalPolicy: 'never' }, promptTemplateVersion: 'full-document-v2'
      };
      Object.assign(job, { actionId, source, pluginVersion: this.manifest?.version || '0.3.2', usageCompleteness: 'unknown' });
      const lockedDoc = this.state.documents[filePath];
      if (!lockedDoc || lockedDoc.id !== doc.id || lockedDoc.job) throw new Error('文档请求状态已变化，已停止且尚未调用模型。');
      lockedDoc.job = job.id;
      delete lockedDoc.lastStoppedJob;
      this.writeJob(job);
      this.saveState();
      event('request_saved', { jobId: job.id, threadId: session.threadId, status: 'ready' });
      try {
        const result = await provider.answer(session.threadId, prepared.prompt, async turnId => {
          job.turnId = turnId; this.writeJob(job);
          event('turn_accepted', { jobId: job.id, threadId: session.threadId, turnId, status: 'accepted' });
        }, info => this.recordProviderEvent(job, info));
        Object.assign(job, { result, status: 'answered' });
        job.elapsedMs = Date.now() - startedAt;
        this.writeJob(job);
        event('answer_saved', { jobId: job.id, turnId: job.turnId, status: 'answered', elapsedMs: job.elapsedMs });
        await this.applyJob(job);
        new Notice(`chat 已回复 ${targets.length} 条批注`);
      } catch (error) {
        job.error = error.message;
        job.errorCode = error.code;
        job.status = job.result ? 'answered' : 'needs-recovery';
        job.elapsedMs = Date.now() - startedAt;
        if (error.ambiguous != null) job.ambiguous = error.ambiguous;
        this.writeJob(job);
        event('request_failed', { jobId: job.id, turnId: job.turnId, status: job.turnId ? 'accepted' : 'unknown', reason: error.code || 'REQUEST_FAILED', elapsedMs: job.elapsedMs });
        throw error;
      }
    } catch (error) {
      event('send_error', { status: 'failed', reason: error.code || 'PREFLIGHT_OR_WRITE_FAILED', elapsedMs: Date.now() - startedAt });
      throw error;
    } finally {
      this.releaseProvider(leasedProvider);
      this.busyFiles.delete(filePath);
      if (this.app.vault.getAbstractFileByPath(filePath) instanceof TFile) await this.refreshFile(file, 'observe').catch(e => this.notice(e));
      this.decorate();
      this.diagnostics?.flush();
    }
  }

  recordProviderEvent(job, info) {
    this.trace({ actionId: job.actionId, jobId: job.id, documentId: job.documentId, threadId: job.threadId, turnId: info.turnId || job.turnId, source: 'codex', stage: info.stage || info.type || 'provider_event', status: info.status, reason: info.reason || info.code, elapsedMs: info.elapsedMs });
    if (info.usage) {
      job.usage = info.usage;
      job.usageCompleteness = info.completeness || (job.usageCompleteness !== 'unknown' ? job.usageCompleteness : 'partial');
      job.usageObservedAt = new Date().toISOString();
      if (info.attribution) job.usageAttribution = info.attribution;
      if (info.stage === 'usage') job.aggregateUsage = info.aggregateUsage || null;
      // Persist independently of successful generation: failed turns may consume tokens.
      try { this.writeJob(job); }
      catch { job.usagePersistenceFailed = true; this.trace({ jobId: job.id, stage: 'usage_persist_failed', status: 'partial', reason: 'LOCAL_WRITE_FAILED' }); }
    }
    if (info.stage === 'tool_started' || info.stage === 'tool_completed') {
      job.toolActivity ||= [];
      job.toolActivity.push({ at: new Date().toISOString(), ...info });
      this.writeJob(job);
    }
  }

  jobPath(id) { if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效请求 ID'); return path.join(this.storage, 'receipts', id + '.json'); }
  writeJob(job) { (this.persistence ||= new PortableStore()).writeJSON(this.jobPath(job.id), job); }
  readJob(id) { return (this.persistence ||= new PortableStore()).readJSON(this.jobPath(id)); }

  async applyJob(job) {
    const current = Object.entries(this.state.documents).find(([, d]) => d.id === job.documentId);
    if (!current) throw new Error('找不到文档状态，回答已保留。');
    const [filePath, originalDoc] = current, file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) throw new Error('文档已删除或移动，回答已保留。');
    const replies = C.validateReplies(job.result.text, job.targets);
    job.replyAt ||= new Date().toISOString();
    this.writeJob(job);
    await this.flush(file);
    let validatedDoc, appliedText;
    await this.processSource(file, latest => {
      const validation = S.validateTargets(originalDoc, latest, job.targets);
      if (!validation.ok) throw new Error(`${validation.reasons.join('；')}；回答已保留，未写入。`);
      validatedDoc = validation.document;
      appliedText = C.appendReplies(latest, replies, job.replyAt, validation.targets);
      return appliedText;
    }, job.targets);
    let nextDoc = S.acknowledge(validatedDoc, job.targets);
    const observed = S.reconcile(nextDoc, appliedText, { mode: 'observe' });
    if (observed.status !== 'ok') throw new Error('回答已写入，但无法更新观察状态；请求保持锁定，请勿重发。');
    nextDoc = observed.document;
    delete nextDoc.job;
    this.state.documents[filePath] = nextDoc;
    this.saveState();
    const sessionId = job.sessionDocumentId || nextDoc.id;
    if (this.sessions[sessionId]?.threadId === job.threadId) {
      this.sessions[sessionId].contexts = job.contexts;
      for (const target of job.targets) {
        const context = this.sessions[sessionId].contexts?.[target.id];
        const thread = observed.document.observed?.threads?.[target.id];
        if (context && thread) {
          const known = new Set(context.entryKeys || []);
          for (const message of thread.messages) if (message.role === 'chat' && message.timestamp === job.replyAt) known.add(S.requestKey(message));
          context.entryKeys = [...known];
        }
      }
    }
    await this.saveLocal();
    job.status = 'applied';
    this.writeJob(job);
    this.trace({ actionId: job.actionId, jobId: job.id, documentId: job.documentId, threadId: job.threadId, turnId: job.turnId, stage: 'reply_applied', status: 'ok' });
    this.cacheResult(filePath, observed);
    this.app.plugins.plugins['document-comments']?.refreshEditors?.();
    if (this.chatFiles && !this.chatFiles.isChat(file)) {
      for (const reply of replies) await this.chatFiles.ensure(file,reply.commentId).catch(error=>this.notice(error));
    }
  }

  async recoverOutstanding() {
    await this.ready;
    const results = [];
    for (const [filePath, doc] of Object.entries(this.state.documents)) {
      if (this.unloading) break;
      if (!doc.job || this.busyFiles.has(filePath)) continue;
      try { results.push({ filePath, status: await this.recover(filePath, { quiet: true }) }); }
      catch (error) { results.push({ filePath, status: 'needs-recovery', code: error.code }); }
    }
    return results;
  }

  async recover(filePath, { quiet = false } = {}) {
    await this.ready;
    if (this.busyFiles.has(filePath)) return new Notice('请等当前文档的回答完成。');
    if (!this.busyFiles.size) this.loadPortableState();
    const doc = this.state.documents[filePath];
    if (!doc?.job) return new Notice('没有待恢复请求。');
    const job = this.readJob(doc.job);
    this.trace({ jobId: job.id, documentId: job.documentId, turnId: job.turnId, source: 'recovery', stage: 'recovery_started', status: 'reading' });
    this.busyFiles.add(filePath);
    (this.recoveringFiles ||= new Set()).add(filePath);
    this.decorate();
    let leasedProvider;
    try {
      if (!job.result) {
        if (!job.turnId) throw new Error('未取得远端回执，是否发送成功不确定。请查看请求记录并核实 Codex 会话；此处不会自动重发。');
        if (job.errorCode === 'MODEL_REROUTED') throw new Error('该请求的实际模型与指定模型不一致，已停止恢复并保留记录；不会自动接受结果或重新发送。');
        const provider = leasedProvider = this.leaseProvider(job.provider || settingsSnapshot(this.settings));
        job.result = await provider.recover(job.threadId, job.turnId, job.threadScope);
        job.status = 'answered';
        this.writeJob(job);
      }
      if (this.unloading) return 'needs-recovery';
      await this.applyJob(job);
      this.trace({ jobId: job.id, source: 'recovery', stage: 'recovery_completed', status: 'no_new_generation' });
      if (!quiet) new Notice('原回答已恢复，没有再次生成。');
      return 'applied';
    } catch (error) {
      if (this.unloading) return 'needs-recovery';
      if (job.error && !job.originalFailure) job.originalFailure = { message: job.error, code: job.errorCode };
      job.error = error.message;
      job.errorCode = error.code || job.errorCode;
      job.recoveryCheckedAt = new Date().toISOString();
      // Only an authoritative terminal result releases the lock. Missing turns,
      // connectivity/account errors and malformed answers remain recoverable.
      if (!job.result && ['TURN_INTERRUPTED', 'TURN_FAILED'].includes(error.code)) {
        job.status = error.code === 'TURN_INTERRUPTED' ? 'interrupted' : 'failed';
        job.ambiguous = false;
        this.writeJob(job); // receipt first: a crash before unlock is safe to retry
        const current = Object.values(this.state.documents).find(d => d.id === job.documentId && d.job === job.id);
        if (current) { delete current.job; current.lastStoppedJob = job.id; this.saveState(); }
        this.trace({ jobId: job.id, source: 'recovery', stage: 'recovery_stopped', status: job.status, reason: error.code });
        if (!quiet) new Notice(error.message);
        return job.status;
      }
      job.status = job.result ? 'answered' : 'needs-recovery';
      this.trace({ jobId: job.id, source: 'recovery', stage: 'recovery_failed', status: 'failed', reason: error.code || 'RECOVERY_FAILED' });
      if (error.ambiguous != null) job.ambiguous = error.ambiguous;
      this.writeJob(job);
      throw error;
    } finally { this.releaseProvider(leasedProvider); this.busyFiles.delete(filePath); this.recoveringFiles.delete(filePath); this.decorate(); this.diagnostics?.flush(); }
  }

  showReceipt(id) {
    const job = this.readJob(id);
    const modal = new Modal(this.app);
    modal.contentEl.createEl('h2', { text: 'chat 请求记录' });
    modal.contentEl.createEl('p', { text: `状态：${job.status} · 会话：${job.threadId || '尚未建立'} · ${job.error || ''}` });
    if (job.originalFailure) modal.contentEl.createEl('p', { text: `最初失败原因：${job.originalFailure.message}` });
    const area = modal.contentEl.createEl('textarea', { cls: 'ipc-receipt' });
    area.readOnly = true;
    area.value = JSON.stringify(job, null, 2);
    if (!Object.values(this.state.documents).some(doc => doc.job === id)) { modal.open(); return; }
    modal.contentEl.createEl('p', { text: '若请求结果不确定，请先核实该会话。只有确认不需要恢复此请求时，才解除锁定；下次发送可能再次消耗额度。' });
    const release = modal.contentEl.createEl('button', { text: '保留记录并解除此请求锁定' });
    release.onclick = () => {
      const found = Object.values(this.state.documents).find(doc => doc.job === id);
      if (found && this.busyFiles.has(job.path)) return new Notice('该文档正在运行，不能解除锁定。');
      for (const doc of Object.values(this.state.documents)) if (doc.job === id) { delete doc.job; delete this.sessions[doc.id]; }
      job.status = 'released-manually';
      this.writeJob(job);
      this.saveState();
      this.saveLocal().catch(e => this.notice(e));
      modal.close();
      this.decorate();
    };
    modal.open();
  }

  readUsageReceipts() {
    const directory = path.join(this.storage, 'receipts');
    if (!fs.existsSync(directory)) return { jobs: [], unreadable: 0 };
    const jobs = [];
    let unreadable = 0;
    for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const job = this.readJob(name.slice(0, -5));
        if (!job || typeof job !== 'object' || Array.isArray(job) || job.id !== name.slice(0, -5)) { unreadable++; continue; }
        jobs.push(job);
      } catch { unreadable++; }
    }
    return { jobs, unreadable };
  }

  showDiagnostics() {
    const p = this, modal = new Modal(this.app);
    let onlyCurrent = false;
    const active = this.app.workspace.activeLeaf?.view;
    const filePath = active?.getViewType?.() === 'inplace-chat-comment-reader' ? active.path : this.app.workspace.getActiveFile?.()?.path;
    const documentId = this.state.documents[filePath]?.id;
    const render = () => {
      p.diagnostics?.flush();
      modal.contentEl.empty();
      modal.contentEl.addClass('ipc-diagnostics');
      modal.contentEl.createEl('h2', { text: 'chat · 运行记录与用量' });
      modal.contentEl.createEl('p', { text: '本地记录，不调用模型。用量是服务已报告的样本；缺失或迟到的数据不算零，也不等于订阅额度或费用。' });
      const controls = modal.contentEl.createDiv({ cls: 'ipc-actions' });
      controls.createEl('button', { text: '刷新' }).onclick = render;
      const scope = controls.createEl('button', { text: onlyCurrent ? '显示整个库' : '仅当前文档' });
      scope.disabled = !documentId;
      scope.onclick = () => { onlyCurrent = !onlyCurrent; render(); };
      const receipts = p.readUsageReceipts();
      const jobs = receipts.jobs.filter(job => !onlyCurrent || job.documentId === documentId);
      const summary = summarizeReceipts(jobs);
      const totals = summary.summary.sampleSums;
      modal.contentEl.createEl('h3', { text: '已报告用量（去重）' });
      modal.contentEl.createEl('p', { text: `输入 ${totals.inputTokens ?? '未知'} · 输出 ${totals.outputTokens ?? '未知'} · 缓存读取 ${totals.cachedInputTokens ?? '未知'} · 缓存写入 ${totals.cacheWriteInputTokens ?? '未知'} · 推理输出 ${totals.reasoningOutputTokens ?? '未知'} token` });
      modal.contentEl.createEl('p', { text: `${summary.summary.deduplicatedRows} 个去重请求 · ${summary.summary.withSample} 个有用量样本 · ${summary.summary.missingUsage} 个用量未知 · ${summary.summary.partialUsage} 个样本字段不完整` });
      modal.contentEl.createEl('p', { text: '缓存输入包含在输入中，推理输出包含在输出中，不重复加总。每轮的会话累计 total 不相加；恢复原回答不作为新生成。' });
      if (receipts.unreadable) modal.contentEl.createEl('p', { cls: 'ipc-warning', text: `${receipts.unreadable} 条收据无法读取，汇总不完整。` });
      if (p.diagnostics?.error || p.diagnostics?.droppedEvents) modal.contentEl.createEl('p', { cls: 'ipc-warning', text: `操作日志记录可能不完整，本次运行已丢弃 ${p.diagnostics?.droppedEvents || 0} 条积压事件。原请求收据另行保留。` });
      const recent = (p.diagnostics?.readRecent(200) || []).filter(item => !onlyCurrent || item.documentId === documentId);
      controls.createEl('button', { text: '查看脱敏诊断数据' }).onclick = () => {
        const detail = new Modal(p.app);
        detail.contentEl.createEl('h2', { text: '本地诊断数据' });
        detail.contentEl.createEl('p', { text: '仅包含操作元数据与统计，不包含文章正文、提示词、回答、凭据或原始请求收据。可选中复制保存。' });
        const area = detail.contentEl.createEl('textarea', { cls: 'ipc-receipt' });
        area.readOnly = true;
        area.value = JSON.stringify({ version: 1, summary: { ...summary.summary, unreadable: receipts.unreadable, droppedEvents: p.diagnostics?.droppedEvents || 0 }, events: recent }, null, 2);
        detail.open();
      };
      modal.contentEl.createEl('h3', { text: '最近请求' });
      if (!jobs.length) modal.contentEl.createEl('p', { text: '暂无请求收据。' });
      const table = modal.contentEl.createEl('table', { cls: 'ipc-usage-table' });
      const header = table.createEl('tr');
      for (const title of ['时间 / 模型', '状态 / 耗时', '输入 / 输出 token', '数据范围', '详情']) header.createEl('th', { text: title });
      for (const job of [...jobs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 50)) {
        const row = table.createEl('tr');
        const usage = job.aggregateUsage || job.usage?.last || job.result?.usage?.last;
        row.createEl('td', { text: `${job.createdAt || '未知'}\n${job.result?.model || job.provider?.model || '未知'}` });
        row.createEl('td', { text: `${job.status}${job.error ? ' · 有错误' : ''}\n${job.elapsedMs == null ? '耗时未知' : (job.elapsedMs / 1000).toFixed(1) + ' 秒'}` });
        row.createEl('td', { text: usage ? `${usage.inputTokens ?? '未知'} / ${usage.outputTokens ?? '未知'}` : '未知（未报告）' });
        row.createEl('td', { text: job.aggregateUsage ? '累计差值样本' : usage ? '末次调用样本' : '数据缺失' });
        row.createEl('td').createEl('button', { text: '请求记录' }).onclick = () => p.showReceipt(job.id);
      }
      modal.contentEl.createEl('p', { text: '这里只列最近 50 条，汇总读取本库全部收据。一次回答多条评论的用量属于整批请求。' });
      modal.contentEl.createEl('h3', { text: '最近操作' });
      const labels = { send_requested: '收到发送操作', send_blocked: '没有调用模型', input_prepared: '已准备相关输入', connecting: '连接 Codex', request_saved: '已保存请求记录', turn_accepted: '服务已接受', usage: '收到用量', completed: '生成完成', failed: '生成失败', answer_saved: '已保存回答', reply_applied: '已写回评论', request_failed: '请求失败', send_error: '发送或写回错误', reconcile: '本地核对', reader_open: '打开完整评论', recovery_started: '读取原回答', recovery_completed: '恢复完成，未重新生成', recovery_failed: '恢复失败', plugin_loaded: '插件加载', plugin_unloaded: '插件卸载', git_scan: 'Git 变更核对', document_deleted: '文档删除', document_renamed: '文档改名', usage_persist_failed: '用量写盘失败' };
      const reasons = { UNSAVED_DRAFT: '当前有未保存草稿', NO_PENDING: '没有待答', DOCUMENT_BUSY: '文档正在回答', RECOVERY_REQUIRED: '上次请求需要恢复', NO_SOURCE_DOCUMENT: '无法确定源文档', COMMENT_PARSE_FAILED: '评论解析失败', LOCAL_WRITE_FAILED: '本地写盘失败' };
      if (!recent.length) modal.contentEl.createEl('p', { text: '暂无操作记录。更新前的操作日志无法补回，旧收据仍可查看用量。' });
      for (const item of [...recent].reverse()) {
        modal.contentEl.createEl('div', { cls: 'ipc-event', text: `${item.timestamp || item.at || ''} · ${labels[item.stage] || item.stage || '操作'}${item.reason ? ' · ' + (reasons[item.reason] || item.reason) : ''}${item.counts ? ' · ' + JSON.stringify(item.counts) : ''}` });
      }
    };
    render();
    modal.open();
  }

  onunload() {
    this.unloading = true;
    this.chatFiles?.destroy();
    this.pdfUi?.destroy();
    this.pdf?.close();
    this.saveLocal().catch(() => {});
    this.trace({ stage: 'plugin_unloaded', source: 'lifecycle', status: 'closed' });
    this.diagnostics?.close();
    for (const provider of this.providers.values()) provider.close();
    for (const item of this.timers.values()) clearTimeout(item.timer);
    clearTimeout(this.decorating);
    clearTimeout(this.gitTimer);
    document.querySelectorAll('.ipc-unread').forEach(el => el.classList.remove('ipc-unread'));
  }
};

module.exports.getCommandHotkeys = getCommandHotkeys;
module.exports.eventMatchesCommandHotkey = eventMatchesCommandHotkey;
