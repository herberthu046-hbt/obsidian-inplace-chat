'use strict';

const {
  Component,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  TFile
} = require('obsidian');
const C = require('./comments.cjs');

const VIEW_TYPE = 'inplace-chat-comment-reader';
const NATIVE_COMMENTS_VIEW_TYPE = 'document-comments-sidebar';

function isMarkdownFile(file) {
  return file instanceof TFile && ['md', 'pdf'].includes(file.extension);
}

function fileAtPath(plugin, filePath) {
  if (typeof filePath !== 'string' || !filePath) return null;
  const file = plugin.app.vault.getAbstractFileByPath(filePath);
  return isMarkdownFile(file) ? file : null;
}

function sourceFileForCommand(plugin) {
  const workspace = plugin.app.workspace;
  const activeView = workspace.activeLeaf?.view;

  if (activeView instanceof MarkdownView && isMarkdownFile(activeView.file)) return activeView.file;
  if (['pdf', 'local-pdf-annotator-view'].includes(activeView?.getViewType?.()) && isMarkdownFile(activeView.file)) return activeView.file;

  if (activeView?.getViewType?.() === NATIVE_COMMENTS_VIEW_TYPE) {
    const file = activeView.file;
    return isMarkdownFile(file) && fileAtPath(plugin, file.path) ? file : null;
  }

  if (activeView?.getViewType?.() === VIEW_TYPE) return fileAtPath(plugin, activeView.path);

  // The command palette does not normally replace the active leaf, but this
  // documented API is a safe fallback when no activeLeaf property is exposed.
  const markdownView = workspace.getActiveViewOfType?.(MarkdownView);
  return isMarkdownFile(markdownView?.file) ? markdownView.file : null;
}

function renamedPath(currentPath, oldPath, newPath) {
  if (currentPath === oldPath) return newPath;
  return currentPath.startsWith(`${oldPath}/`) ? newPath + currentPath.slice(oldPath.length) : currentPath;
}

function pathForReaderLeaf(leaf) {
  const viewPath = leaf?.view?.getViewType?.() === VIEW_TYPE ? leaf.view.path : null;
  const statePath = leaf?.getViewState?.().state?.path;
  return typeof viewPath === 'string' && viewPath ? viewPath : statePath;
}

async function openSourceFile(view, file) {
  const workspace = view.app.workspace;
  const existing = ['markdown', 'pdf', 'local-pdf-annotator-view'].flatMap(type => workspace.getLeavesOfType(type)).find(leaf => leaf.view.file?.path === file.path);
  if (existing) return workspace.revealLeaf(existing);
  const leaf = workspace.getLeaf('tab');
  await leaf.openFile(file, { active: true });
  return workspace.revealLeaf(leaf);
}

class CommentReaderView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.path = '';
    this.opened = false;
    this.generation = 0;
    this.renderComponent = null;
  }

  getViewType() { return VIEW_TYPE; }
  getIcon() { return 'messages-square'; }
  getDisplayText() {
    const name = this.path.split('/').at(-1)?.replace(/\.(md|pdf)$/i, '') || '完整评论';
    return `${name} · 完整评论`;
  }
  getState() { return { path: this.path }; }

  async setState(state) {
    this.path = typeof state?.path === 'string' ? state.path : '';
    this.leaf.updateHeader?.();
    if (this.opened) await this.refreshSafely();
  }

  async onOpen() {
    this.opened = true;
    this.contentEl.addClass('ipc-reader');
    this.registerEvent(this.app.workspace.on('inplace-chat:updated', filePath => {
      if (filePath === this.path) this.refreshSafely();
    }));
    this.registerEvent(this.app.vault.on('modify', file => {
      if (file.path === this.path) this.refreshSafely();
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      const next = renamedPath(this.path, oldPath, file.path);
      if (next === this.path) return;
      this.path = next;
      this.leaf.updateHeader?.();
      this.app.workspace.requestSaveLayout?.();
      this.refreshSafely();
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      if (this.path === file.path || this.path.startsWith(`${file.path}/`)) this.refreshSafely();
    }));
    await this.refreshSafely();
  }

  async onClose() {
    this.opened = false;
    this.generation++;
    this.disposeRenderComponent();
  }

  disposeRenderComponent() {
    this.renderComponent?.unload();
    this.renderComponent = null;
  }

  replaceContent() {
    this.disposeRenderComponent();
    this.contentEl.empty();
    this.contentEl.addClass('ipc-reader');
  }

  renderState(message, detail) {
    this.replaceContent();
    const state = this.contentEl.createDiv({ cls: 'ipc-reader-state' });
    state.createEl('h2', { text: message });
    if (detail) state.createEl('p', { text: detail });
  }

  refreshSafely() {
    return this.refresh().catch(error => this.report(error));
  }

  async refresh() {
    const generation = ++this.generation;
    const file = fileAtPath(this.plugin, this.path);
    if (!file) {
      if (generation === this.generation) this.renderState('源文档不存在', this.path || '这个阅读标签页还没有绑定文档。');
      return;
    }

    let text;
    try {
      text = await (typeof this.plugin.textFor === 'function'
        ? this.plugin.textFor(file)
        : (this.app.vault.cachedRead?.(file) ?? this.app.vault.read(file)));
    } catch (error) {
      if (generation === this.generation) this.renderState('无法读取源文档', error.message || String(error));
      return;
    }
    if (generation !== this.generation || !this.opened) return;

    let comments;
    try {
      comments = C.parse(text);
    } catch (error) {
      this.renderState('无法解析评论', error.message || String(error));
      return;
    }

    this.replaceContent();
    const component = new Component();
    component.load();
    this.renderComponent = component;

    const header = this.contentEl.createDiv({ cls: 'ipc-reader-header' });
    const heading = header.createDiv({ cls: 'ipc-reader-heading' });
    heading.createEl('h2', { text: file.basename || file.name || file.path });
    heading.createEl('div', { cls: 'ipc-reader-path', text: file.path });
    heading.createEl('div', { cls: 'ipc-reader-mode', text: file.extension === 'pdf' ? '发送快捷键（默认 Alt+S）发送当前追问 · 在输入框外可批量发送待答' : '只读评论视图' });
    const actions = header.createDiv({ cls: 'ipc-reader-actions' });
    const source = actions.createEl('button', { text: '返回源文档' });
    source.addEventListener('click', () => openSourceFile(this, file).catch(error => this.report(error)));
    if (typeof this.plugin.markRead === 'function') {
      const read = actions.createEl('button', { text: '将回复标为已读' });
      read.addEventListener('click', async () => {
        read.disabled = true;
        try {
          await this.plugin.markRead(file.path);
          new Notice('已将当前文档的 chat 回复标为已读。');
        } catch (error) {
          this.report(error);
        } finally {
          read.disabled = false;
        }
      });
    }

    if (!comments.length) {
      this.contentEl.createDiv({ cls: 'ipc-reader-state', text: '当前文档没有评论。' });
      return;
    }

    const list = this.contentEl.createDiv({ cls: 'ipc-reader-threads' });
    try {
      for (const [index, comment] of comments.entries()) {
        if (generation !== this.generation || this.renderComponent !== component) return;
        const thread = list.createEl('section', { cls: 'ipc-reader-thread' });
        thread.dataset.threadId = comment.id;
        const threadHead = thread.createDiv({ cls: 'ipc-reader-thread-head' });
        threadHead.createEl('h3', { text: `评论 ${index + 1}` });
        threadHead.createSpan({
          cls: `ipc-reader-status ${comment.resolved ? 'is-resolved' : 'is-open'}`,
          text: comment.resolved ? '已解决' : '进行中'
        });

        const quote = thread.createEl('blockquote', { cls: 'ipc-reader-quote markdown-rendered' });
        if (comment.quote) await MarkdownRenderer.render(this.app, comment.quote, quote, file.path, component);
        else quote.createSpan({ text: '（无高亮文本）' });

        const entries = thread.createDiv({ cls: 'ipc-reader-entries' });
        if (!comment.entries.length) entries.createDiv({ cls: 'ipc-reader-state', text: '这个讨论还没有消息。' });
        for (const entry of comment.entries) {
          if (generation !== this.generation || this.renderComponent !== component) return;
          const row = entries.createEl('article', { cls: 'ipc-reader-entry' });
          const meta = row.createDiv({ cls: 'ipc-reader-entry-head' });
          meta.createEl('strong', { cls: 'ipc-reader-author', text: entry.author || '—' });
          if (entry.timestamp) meta.createSpan({ cls: 'ipc-reader-time', text: entry.timestamp });
          const body = row.createDiv({ cls: 'ipc-reader-entry-body markdown-rendered' });
          await MarkdownRenderer.render(this.app, entry.text, body, file.path, component);
        }
        if (file.extension === 'pdf' && this.plugin.pdf) {
          const context = this.plugin.pdf.contextFor(file);
          const composer = thread.createDiv({ cls: 'ipc-pdf-composer' });
          const input = composer.createEl('textarea', { cls: 'ipc-pdf-input', attr: { placeholder: '继续追问（支持 Markdown）', 'aria-label': 'PDF 追问' } });
          input.value = this.plugin.pdf.getDraft(context, comment.id);
          input.oninput = () => this.plugin.pdf.setDraft(context, comment.id, input.value);
          component.registerEvent(this.app.workspace.on('inplace-chat:pdf-draft', (bundleId, threadId, value) => {
            if (bundleId === context.bundleId && threadId === comment.id && input.value !== value) input.value = value;
          }));
          const actions = composer.createDiv({ cls: 'ipc-pdf-actions' });
          for (const [label, send] of [['保存', false], ['发送', true]]) {
            const button = actions.createEl('button', { text: label });
            button.onclick = async () => {
              button.disabled = true;
              try { await this.plugin.pdf.addMessage(context, comment.id, input.value, { send }); await this.refreshSafely(); }
              catch (error) { this.report(error); }
              finally { button.disabled = false; }
            };
          }
        }
      }
    } catch (error) {
      if (generation === this.generation && this.renderComponent === component) this.renderState('无法渲染评论', error.message || String(error));
    }
  }

  focusThread(threadId) {
    const thread = [...this.contentEl.querySelectorAll('.ipc-reader-thread')].find(element => element.dataset.threadId === threadId);
    thread?.scrollIntoView?.({ block: 'start' });
    thread?.querySelector('textarea')?.focus?.({ preventScroll: true });
  }

  report(error) {
    if (typeof this.plugin.notice === 'function') this.plugin.notice(error);
    else new Notice(error.message || String(error), 10000);
  }
}

async function openCommentReader(plugin, filePath, threadId) {
  const file = filePath ? fileAtPath(plugin, filePath) : sourceFileForCommand(plugin);
  if (!file) throw new Error(filePath ? '指定的文档不存在。' : '请先打开 Markdown 评论或 PDF Annotator 批注。');

  const workspace = plugin.app.workspace;
  const existing = workspace.getLeavesOfType(VIEW_TYPE).find(leaf => pathForReaderLeaf(leaf) === file.path);
  if (existing) {
    await workspace.revealLeaf(existing);
    if (threadId) {
      await existing.view.refreshSafely?.();
      existing.view.focusThread?.(threadId);
    }
    return existing;
  }

  const leaf = workspace.getLeaf('tab');
  await leaf.setViewState({ type: VIEW_TYPE, active: true, state: { path: file.path } });
  await workspace.revealLeaf(leaf);
  if (threadId) leaf.view?.focusThread?.(threadId);
  return leaf;
}

function registerCommentReader(plugin) {
  plugin.registerView(VIEW_TYPE, leaf => new CommentReaderView(leaf, plugin));
  const open = (filePath, threadId) => openCommentReader(plugin, filePath, threadId);
  plugin.openCommentReader = open;
  plugin.register?.(() => {
    if (plugin.openCommentReader === open) delete plugin.openCommentReader;
  });
  plugin.addCommand({
    id: 'open-comment-reader',
    name: '在新标签页阅读当前文档的完整评论',
    hotkeys: [{ modifiers: ['Alt', 'Shift'], key: 'C' }],
    callback: () => {
      plugin.lastCommandDispatchAt = Date.now();
      plugin.trace?.({ stage: 'hotkey_command', source: 'obsidian_command', status: 'received', scope: 'reader' });
      return open().catch(error => {
        if (typeof plugin.notice === 'function') plugin.notice(error);
        else new Notice(error.message || String(error), 10000);
      });
    }
  });
  return open;
}

module.exports = {
  CommentReaderView,
  NATIVE_COMMENTS_VIEW_TYPE,
  VIEW_TYPE,
  openCommentReader,
  pathForReaderLeaf,
  registerCommentReader,
  renamedPath,
  sourceFileForCommand
};
