'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

class TFile {
  constructor(filePath) {
    this.path = filePath;
    this.extension = filePath.split('.').at(-1);
    this.name = filePath.split('/').at(-1);
    this.basename = this.name.replace(/\.[^.]+$/, '');
  }
}
class MarkdownView {
  constructor(file) { this.file = file; }
}
class EventBus {
  constructor() { this.listeners = new Map(); }
  on(name, callback) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(callback);
    this.listeners.set(name, listeners);
    return () => listeners.delete(callback);
  }
  trigger(name, ...args) {
    for (const callback of [...(this.listeners.get(name) || [])]) callback(...args);
  }
  count(name) { return this.listeners.get(name)?.size || 0; }
}
class Component {
  constructor() { this.events = []; this.loaded = false; this.unloaded = false; }
  load() { this.loaded = true; }
  registerEvent(event) { this.events.push(event); return event; }
  unload() {
    this.unloaded = true;
    for (const event of this.events.splice(0)) if (typeof event === 'function') event();
  }
}
class ItemView extends Component {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.contentEl = leaf.contentEl;
  }
}
class Notice {}

function selectorMatches(element, selector) {
  selector = selector.trim();
  if (/^[a-z]+$/i.test(selector)) return element.tagName === selector.toUpperCase();
  const className = selector.match(/^\.([\w-]+)/)?.[1];
  return !!className && element.classes.has(className);
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classes = new Set();
    this.attributes = {};
    this.dataset = {};
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this.disabled = false;
  }
  addClass(...names) { for (const name of names) this.classes.add(name); }
  empty() { for (const child of this.children) child.parentNode = null; this.children = []; this.textContent = ''; }
  createEl(tagName, options = {}) {
    const child = new FakeElement(tagName);
    child.parentNode = this;
    if (options.cls) for (const name of options.cls.split(/\s+/).filter(Boolean)) child.classes.add(name);
    if (options.text !== undefined) child.textContent = options.text;
    for (const [name, value] of Object.entries(options.attr || {})) child.attributes[name] = String(value);
    this.children.push(child);
    return child;
  }
  createDiv(options = {}) { return this.createEl('div', options); }
  createSpan(options = {}) { return this.createEl('span', options); }
  addEventListener(name, callback) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
  }
  async click() {
    if (typeof this.onclick === 'function') await this.onclick({ target: this });
    for (const callback of this.listeners.get('click') || []) await callback({ target: this });
  }
  input(value) { this.value = value; return this.oninput?.({ target: this }); }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    const found = [];
    const visit = parent => {
      for (const child of parent.children) {
        if (selectors.some(value => selectorMatches(child, value))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const markdownRenders = [];
const MarkdownRenderer = {
  async render(_app, source, target, sourcePath, component) {
    markdownRenders.push({ source, sourcePath, component });
    target.textContent = source;
  }
};

const filename = path.resolve(__dirname, '../src/reader.cjs');
const moduleUnderTest = new Module(filename, module);
moduleUnderTest.paths = Module._nodeModulePaths(path.dirname(filename));
moduleUnderTest.filename = filename;
const originalRequire = moduleUnderTest.require.bind(moduleUnderTest);
moduleUnderTest.require = name => name === 'obsidian' ? {
  Component,
  ItemView,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  TFile
} : originalRequire(name);
moduleUnderTest._compile(fs.readFileSync(filename, 'utf8'), filename);
const R = moduleUnderTest.exports;

function pluginWith(files, activeView) {
  const byPath = new Map(files.map(file => [file.path, file]));
  return {
    app: {
      vault: { getAbstractFileByPath: filePath => byPath.get(filePath) || null },
      workspace: {
        activeLeaf: activeView ? { view: activeView } : null,
        getActiveViewOfType: type => activeView instanceof type ? activeView : null,
        getLeavesOfType: () => []
      }
    }
  };
}

test('source resolution accepts only the active Markdown view or the file actually bound to the active Comments sidebar', () => {
  const a = new TFile('notes/a.md');
  const b = new TFile('notes/b.md');
  assert.equal(R.sourceFileForCommand(pluginWith([a, b], new MarkdownView(a))), a);

  const sidebar = { getViewType: () => R.NATIVE_COMMENTS_VIEW_TYPE, file: b };
  assert.equal(R.sourceFileForCommand(pluginWith([a, b], sidebar)), b);

  const unrelated = pluginWith([a, b], { getViewType: () => 'search' });
  unrelated.app.workspace.getLeavesOfType = () => [{ view: new MarkdownView(a) }];
  assert.equal(R.sourceFileForCommand(unrelated), null);

  const staleSidebar = pluginWith([a], { getViewType: () => R.NATIVE_COMMENTS_VIEW_TYPE, file: b });
  assert.equal(R.sourceFileForCommand(staleSidebar), null);
});

test('reader state remains document-bound across exact file and folder renames', () => {
  assert.equal(R.renamedPath('notes/a.md', 'notes/a.md', 'archive/a.md'), 'archive/a.md');
  assert.equal(R.renamedPath('notes/sub/a.md', 'notes', 'archive'), 'archive/sub/a.md');
  assert.equal(R.renamedPath('notes-2/a.md', 'notes', 'archive'), 'notes-2/a.md');
});

test('opening reuses only an exact-path reader and creates a new tab for another document', async () => {
  const a = new TFile('a.md');
  const b = new TFile('b.md');
  const focused = [];
  const exact = { view: { getViewType: () => R.VIEW_TYPE, path: a.path, focusThread: id => focused.push(id) } };
  const other = { getViewState: () => ({ state: { path: b.path } }) };
  const revealed = [];
  let created = 0;
  const plugin = pluginWith([a, b], new MarkdownView(a));
  plugin.app.workspace.getLeavesOfType = () => [other, exact];
  plugin.app.workspace.revealLeaf = async leaf => { revealed.push(leaf); };
  plugin.app.workspace.getLeaf = () => { created++; throw new Error('must not create'); };

  assert.equal(await R.openCommentReader(plugin, a.path), exact);
  assert.deepEqual(revealed, [exact]);
  assert.equal(created, 0);
  await R.openCommentReader(plugin, a.path, 'discussion-2');
  assert.deepEqual(focused, ['discussion-2']);

  const fresh = { setViewState: async state => { fresh.state = state; } };
  plugin.app.workspace.getLeavesOfType = () => [exact];
  plugin.app.workspace.getLeaf = type => { assert.equal(type, 'tab'); created++; return fresh; };
  assert.equal(await R.openCommentReader(plugin, b.path), fresh);
  assert.deepEqual(fresh.state, { type: R.VIEW_TYPE, active: true, state: { path: b.path } });
  assert.equal(revealed.at(-1), fresh);
});

test('registration exposes one shared opener and the requested command without opening anything eagerly', () => {
  const a = new TFile('a.md');
  const plugin = pluginWith([a], new MarkdownView(a));
  let factory, command, cleanup;
  plugin.registerView = (type, value) => { assert.equal(type, R.VIEW_TYPE); factory = value; };
  plugin.addCommand = value => { command = value; };
  plugin.register = value => { cleanup = value; };

  const open = R.registerCommentReader(plugin);
  assert.equal(plugin.openCommentReader, open);
  assert.equal(typeof factory, 'function');
  assert.equal(command.id, 'open-comment-reader');
  assert.equal(command.name, '在新标签页阅读当前文档的完整评论');
  assert.deepEqual(command.hotkeys, [{ modifiers: ['Alt', 'Shift'], key: 'C' }]);
  assert.equal(typeof cleanup, 'function');
});

test('PDF reader renders discussion text, uses the bridge composer contract, syncs draft events, and unloads listeners', async () => {
  markdownRenders.length = 0;
  const file = new TFile('papers/research.pdf');
  const threadId = 'p' + '1'.repeat(31);
  const source = [
    `<!--c:${threadId}-->p.3 · highlighted **quote**<!--/c:${threadId}-->`,
    `<!--co:${threadId}`,
    'me (native): 原始批注',
    'chat (reply): **模型回答**',
    '-->'
  ].join('\n');
  const workspace = new EventBus();
  workspace.getLeavesOfType = () => [];
  const vault = new EventBus();
  vault.getAbstractFileByPath = filePath => filePath === file.path ? file : null;
  const contentEl = new FakeElement();
  const app = { vault, workspace };
  const context = { file, bundleId: 'a'.repeat(64) };
  let draft = 'bridge 初始草稿';
  const draftWrites = [];
  const additions = [];
  const notices = [];
  const plugin = {
    app,
    textFor: async target => { assert.equal(target, file); return source; },
    notice: error => notices.push(error),
    pdf: {
      contextFor: target => { assert.equal(target, file); return context; },
      getDraft: (target, id) => { assert.equal(target, context); assert.equal(id, threadId); return draft; },
      setDraft: (target, id, value) => {
        assert.equal(target, context); assert.equal(id, threadId);
        draft = value;
        draftWrites.push(value);
      },
      addMessage: async (target, id, value, options) => {
        assert.equal(target, context); assert.equal(id, threadId);
        additions.push([value, options]);
        draft = '';
      }
    }
  };
  const leaf = { app, contentEl, updateHeader() {} };
  const view = new R.CommentReaderView(leaf, plugin);
  view.path = file.path;
  await view.onOpen();

  assert.deepEqual(markdownRenders.map(item => item.source), [
    'p.3 · highlighted **quote**',
    '原始批注',
    '**模型回答**'
  ]);
  assert.ok(markdownRenders.every(item => item.sourcePath === file.path));
  assert.equal(contentEl.querySelectorAll('.ipc-reader-entry-body').map(element => element.textContent).join('|'), '原始批注|**模型回答**');
  let scrolled = false, focused = false;
  contentEl.querySelector('.ipc-reader-thread').scrollIntoView = () => { scrolled = true; };
  contentEl.querySelector('textarea').focus = () => { focused = true; };
  view.focusThread(threadId);
  assert.equal(scrolled, true);
  assert.equal(focused, true);
  assert.equal(workspace.count('inplace-chat:pdf-draft'), 1);

  let input = contentEl.querySelector('.ipc-pdf-input');
  assert.equal(input.value, 'bridge 初始草稿');
  workspace.trigger('inplace-chat:pdf-draft', context.bundleId, threadId, '完整评论外更新');
  assert.equal(input.value, '完整评论外更新');
  workspace.trigger('inplace-chat:pdf-draft', 'b'.repeat(64), threadId, '其他 PDF');
  assert.equal(input.value, '完整评论外更新');

  input.input('只保存这条追问');
  assert.deepEqual(draftWrites, ['只保存这条追问']);
  const firstComponent = view.renderComponent;
  const save = contentEl.querySelectorAll('button').find(button => button.textContent === '保存');
  await save.click();
  assert.deepEqual(additions[0], ['只保存这条追问', { send: false }]);
  assert.equal(firstComponent.unloaded, true);
  assert.equal(workspace.count('inplace-chat:pdf-draft'), 1);

  input = contentEl.querySelector('.ipc-pdf-input');
  input.input('保存并发送这条追问');
  const send = contentEl.querySelectorAll('button').find(button => button.textContent === '发送');
  await send.click();
  assert.deepEqual(additions[1], ['保存并发送这条追问', { send: true }]);
  assert.equal(workspace.count('inplace-chat:pdf-draft'), 1);
  assert.deepEqual(notices, []);

  const finalInput = contentEl.querySelector('.ipc-pdf-input');
  const finalComponent = view.renderComponent;
  await view.onClose();
  assert.equal(finalComponent.unloaded, true);
  assert.equal(view.renderComponent, null);
  assert.equal(workspace.count('inplace-chat:pdf-draft'), 0);
  workspace.trigger('inplace-chat:pdf-draft', context.bundleId, threadId, '关闭后不得更新');
  assert.notEqual(finalInput.value, '关闭后不得更新');
});
