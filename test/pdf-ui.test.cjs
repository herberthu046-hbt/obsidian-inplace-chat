'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

class FakeClassList {
  constructor(element) { this.element = element; }
  values() { return this.element._classes; }
  add(...names) { for (const name of names) this.values().add(name); }
  remove(...names) { for (const name of names) this.values().delete(name); }
  contains(name) { return this.values().has(name); }
  toggle(name, force) {
    const next = force === undefined ? !this.contains(name) : !!force;
    if (next) this.add(name); else this.remove(name);
    return next;
  }
}

function matches(element, selector) {
  selector = selector.trim();
  const classMatch = selector.match(/^\.([\w-]+)/);
  if (classMatch && !element.classList.contains(classMatch[1])) return false;
  const attrMatch = selector.match(/\[data-([\w-]+)\]/);
  if (attrMatch) {
    const key = attrMatch[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in element.dataset)) return false;
  }
  if (!classMatch && !attrMatch && /^[a-z]+$/i.test(selector)) return element.tagName === selector.toUpperCase();
  return !!(classMatch || attrMatch);
}

class FakeElement {
  constructor(tagName, ownerDocument) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = new Map();
    this._classes = new Set();
    this.classList = new FakeClassList(this);
    this.textContent = '';
    this.value = '';
    this.disabled = false;
    this._isRoot = false;
  }
  set className(value) { this._classes = new Set(String(value).split(/\s+/).filter(Boolean)); }
  get className() { return [...this._classes].join(' '); }
  get isConnected() { return this._isRoot || !!this.parentNode?.isConnected; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, listener, capture = false) {
    this.captures ||= new Map();
    this.captures.set(listener, capture);
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener, capture = false) {
    assert.equal(this.captures.get(listener), capture);
    this.captures.delete(listener);
    this.listeners.set(type, (this.listeners.get(type) || []).filter(value => value !== listener));
  }
  async dispatch(type) {
    const event = { target: this, stopped: false, preventDefault() {}, stopPropagation() { this.stopped = true; } };
    await Promise.all((this.listeners.get(type) || []).map(listener => listener(event)));
  }
  click() { return this.dispatch('click'); }
  matches(selector) { return selector.split(',').some(value => matches(this, value)); }
  closest(selector) {
    for (let element = this; element; element = element.parentNode) if (element.matches(selector)) return element;
    return null;
  }
  querySelectorAll(selector) {
    const selectors = selector.split(',').map(value => value.trim());
    const found = [];
    const visit = element => {
      for (const child of element.children) {
        if (selectors.some(value => matches(child, value))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

class FakeDocument {
  createElement(tagName) { return new FakeElement(tagName, this); }
  root() { const root = this.createElement('div'); root._isRoot = true; return root; }
}

const rendered = [];
const components = [];
class Component {
  constructor() { this.loaded = false; this.unloaded = false; components.push(this); }
  load() { this.loaded = true; }
  unload() { this.unloaded = true; }
}
const MarkdownRenderer = {
  async render(_app, source, target, sourcePath, component) {
    rendered.push({ source, sourcePath, component });
    target.textContent = source;
  }
};

const filename = path.resolve(__dirname, '../src/pdf-ui.cjs');
const moduleUnderTest = new Module(filename, module);
moduleUnderTest.paths = Module._nodeModulePaths(path.dirname(filename));
moduleUnderTest.filename = filename;
const originalRequire = moduleUnderTest.require.bind(moduleUnderTest);
moduleUnderTest.require = name => name === 'obsidian' ? { Component, MarkdownRenderer } : originalRequire(name);
moduleUnderTest._compile(fs.readFileSync(filename, 'utf8'), filename);
const { PdfUi, panelEntries, relativeTime } = moduleUnderTest.exports;

function element(document, parent, className, annotationId) {
  const value = document.createElement('div');
  value.className = className;
  if (annotationId) {
    value.dataset.annotationId = annotationId;
    value.dataset.hlId = annotationId;
  }
  parent.appendChild(value);
  return value;
}

function setup({ pending = true, unread = true, ownEntries } = {}) {
  rendered.length = 0;
  components.length = 0;
  const document = new FakeDocument();
  const root = document.root();
  const margin = element(document, root, 'lpa-margin-card', 'ann-1');
  const roll = element(document, root, 'lpa-roll-item', 'ann-1');
  const highlight = element(document, root, 'lpa-highlight', 'ann-1');
  const context = { root, file: { path: 'papers/a.pdf' }, bundleId: 'bundle-a' };
  const native = { author: 'me', timestamp: 't0', text: '原生 textarea 中的首条备注', native: true };
  ownEntries ||= [
    { author: 'chat', timestamp: '2026-09-18T08:00:00.000Z', text: '**回答**' },
    { author: 'me', timestamp: '2026-09-18T08:05:00.000Z', text: '后续人工消息' }
  ];
  let threads = [{
    id: 'set-a:ann-1', annotationId: 'ann-1', setId: 'set-a', quote: '原文', pending, unread,
    entries: [native, ...ownEntries], ownEntries
  }];
  let contexts = [context];
  const calls = { read: [], notices: [], open: [] };
  const plugin = {
    app: {},
    pdf: {
      contexts: () => contexts,
      threads: () => threads
    },
    markRead: async (...args) => calls.read.push(args),
    openCommentReader: async (...args) => calls.open.push(args),
    notice: error => calls.notices.push(error)
  };
  return {
    document, root, margin, roll, highlight, context, plugin, calls,
    get threads() { return threads; },
    set threads(value) { threads = value; },
    get contexts() { return contexts; },
    set contexts(value) { contexts = value; }
  };
}

test('panel entries are limited to sidecar-owned messages', () => {
  const source = [
    { author: 'me', text: 'original' },
    { author: 'chat', text: 'reply' },
    { author: 'me', text: 'follow-up' }
  ];
  assert.deepEqual(panelEntries({ entries: source }), []);
  assert.deepEqual(panelEntries({ entries: source, ownEntries: source.slice(1) }), source.slice(1));
  assert.deepEqual(panelEntries({ ownEntries: [] }), []);
});

test('relative timestamps stay compact while the exact ISO value remains available separately', () => {
  const now = Date.parse('2026-09-18T08:10:00.000Z');
  assert.equal(relativeTime('2026-09-18T08:09:40.000Z', now), '刚刚');
  assert.equal(relativeTime('2026-09-18T08:05:00.000Z', now), '5分钟前');
  assert.equal(relativeTime('2026-09-18T10:10:00.000Z', now), '2小时后');
  assert.equal(relativeTime('not-a-time', now), '');
});

test('decorate renders own messages as Markdown in a compact read-only panel', async () => {
  const s = setup();
  const ui = new PdfUi(s.plugin);
  await ui.decorate();

  assert.equal(s.margin.querySelectorAll('.ipc-pdf-chat').length, 1);
  assert.equal(s.roll.querySelectorAll('.ipc-pdf-chat').length, 1);
  assert.deepEqual(rendered.map(item => item.source), ['**回答**', '**回答**']);
  assert.equal(rendered.some(item => item.source.includes('首条备注')), false);
  assert.equal(components.length, 2);
  assert.ok(components.every(component => component.loaded && !component.unloaded));
  for (const panel of [s.margin, s.roll]) {
    assert.equal(panel.querySelectorAll('textarea').length, 0);
    assert.equal(panel.querySelectorAll('button').length, 0);
    assert.equal(panel.querySelector('.ipc-pdf-composer'), null);
    const time = panel.querySelector('.ipc-pdf-time');
    assert.notEqual(time.textContent, time.title);
    assert.equal(time.title, '2026-09-18T08:00:00.000Z');
  }

  await ui.decorate();
  assert.equal(rendered.length, 2);
  assert.equal(components.length, 2);
});

test('threads without own messages create no panel but remain unread and clickable', async () => {
  const s = setup({ ownEntries: [] });
  const ui = new PdfUi(s.plugin);
  await ui.decorate();
  assert.equal(s.margin.querySelector('.ipc-pdf-chat'), null);
  assert.equal(s.roll.querySelector('.ipc-pdf-chat'), null);
  assert.equal(s.margin.classList.contains('ipc-pdf-unread'), true);
  assert.equal(s.roll.classList.contains('ipc-pdf-unread'), true);
  assert.equal(s.highlight.classList.contains('ipc-pdf-unread'), true);

  await s.highlight.click();
  await ui.decoration;
  assert.deepEqual(s.calls.read, [['papers/a.pdf', 'set-a:ann-1']]);
  for (const card of [s.highlight, s.margin, s.roll]) {
    const handler = card.listeners.get('click')[0];
    assert.equal(card.captures.get(handler), true, 'acknowledge before native handlers stop bubbling');
  }
});

test('compact PDF reply links to exactly one standalone chat file', async()=>{
 const s=setup();
 s.plugin.chatFiles={ensure:async(file,id)=>{assert.equal(file.path,'papers/a.pdf');assert.equal(id,'set-a:ann-1');return {path:'papers/a-chat.md'};}};
 const ui=new PdfUi(s.plugin);await ui.decorate();
 const link=s.margin.querySelector('.ipc-full-chat-link');
 assert.equal(link.tagName,'BUTTON');
 assert.equal(link.attributes.type,'button');
 assert.equal(link.attributes['data-chat-path'],'papers/a-chat.md');
 assert.equal(s.margin.querySelectorAll('.ipc-pdf-entry').length,1);
 await link.click();
 assert.deepEqual(s.calls.open,[['papers/a.pdf','set-a:ann-1']]);
 ui.destroy();
});

test('duplicate annotation ids across sets ask for a discussion and clear only the chosen one', async () => {
  const s = setup();
  const ui = new PdfUi(s.plugin);
  await ui.decorate();
  assert.equal(s.highlight.classList.contains('ipc-pdf-unread'), true);

  s.threads = [
    s.threads[0],
    { ...s.threads[0], id: 'set-b:ann-1', setId: 'set-b' }
  ];
  await ui.decorate();

  const panel = s.margin.querySelector('.ipc-pdf-chat-ambiguous');
  assert.ok(panel);
  assert.match(panel.textContent + panel.children.map(child => child.textContent).join(''), /多个批注集/);
  assert.equal(s.margin.querySelector('.ipc-pdf-thread'), null);
  assert.equal(s.margin.querySelectorAll('button').length, 0);
  assert.equal(s.highlight.classList.contains('ipc-pdf-unread'), true);
  assert.equal(s.margin.classList.contains('ipc-pdf-unread'), true);

  ui.chooseThread = async () => s.threads[1];
  await s.highlight.click();
  assert.deepEqual(s.calls.read, [['papers/a.pdf', 'set-b:ann-1']]);
  assert.deepEqual(s.calls.open, [['papers/a.pdf', 'set-b:ann-1']]);
  assert.equal(s.highlight.classList.contains('ipc-pdf-unread'), true);
});

test('missing contexts and destroy both clean panels, components, unread classes, and click bindings', async () => {
  const s = setup();
  const ui = new PdfUi(s.plugin);
  await ui.decorate();
  assert.equal(s.margin.classList.contains('ipc-pdf-unread'), true);
  assert.equal(s.roll.classList.contains('ipc-pdf-unread'), true);
  assert.equal(s.highlight.classList.contains('ipc-pdf-unread'), true);

  s.contexts = [];
  await ui.decorate();
  assert.equal(s.margin.querySelector('.ipc-pdf-chat'), null);
  assert.ok(components.every(component => component.unloaded));
  assert.equal(s.margin.classList.contains('ipc-pdf-unread'), false);
  assert.equal(s.roll.classList.contains('ipc-pdf-unread'), false);
  assert.equal(s.highlight.classList.contains('ipc-pdf-unread'), false);
  await s.highlight.click();
  assert.deepEqual(s.calls.read, []);

  s.contexts = [s.context];
  await ui.decorate();
  ui.destroy();
  assert.equal(s.margin.querySelector('.ipc-pdf-chat'), null);
  assert.ok(components.every(component => component.unloaded));
  assert.equal(s.highlight.classList.contains('ipc-pdf-unread'), false);
  await s.highlight.click();
  await s.highlight.dispatch('dblclick');
  assert.deepEqual(s.calls.read, []);
  assert.deepEqual(s.calls.open, []);
});

test('double click opens the exact PDF discussion, including read annotations, without duplicate bindings', async () => {
  const s = setup({ unread: false });
  const ui = new PdfUi(s.plugin);
  await ui.decorate();
  await ui.decorate();
  for (const element of [s.margin, s.roll, s.highlight]) await element.dispatch('dblclick');
  assert.deepEqual(s.calls.open, Array(3).fill(['papers/a.pdf', 'set-a:ann-1']));
  assert.deepEqual(s.calls.read, []);
  s.threads[0].unread = true;
  await ui.decorate();
  await s.highlight.dispatch('dblclick');
  assert.equal(s.calls.open.length, 4);
  const input = s.document.createElement('textarea');
  s.margin.appendChild(input);
  for (const listener of s.margin.listeners.get('dblclick')) await listener({ target: input });
  assert.equal(s.calls.open.length, 4);
  s.threads.push({ ...s.threads[0], id: 'other-set:ann-1' });
  await ui.decorate();
  await s.highlight.dispatch('dblclick');
  assert.equal(s.calls.open.length, 4);
  ui.destroy();
});

test('window capture clears every surface for the exact PDF thread before native repaint and preserves double click', async () => {
  const s = setup(), handlers = new Map();
  s.document.defaultView = {
    addEventListener(type, handler, capture) { assert.equal(capture, true); handlers.set(type, handler); },
    removeEventListener(type, handler) { assert.equal(handlers.get(type), handler); handlers.delete(type); }
  };
  const ui = new PdfUi(s.plugin);
  await ui.decorate();
  const child = s.document.createElement('span');
  s.highlight.appendChild(child);
  const event = type => ({ type, target: child, button: 0, stopped: false,
    preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() { this.stopped = true; } });
  const click = event('click');
  const reading = handlers.get('click')(click);
  assert.equal(click.stopped, true);
  for (const surface of [s.highlight, s.margin, s.roll]) assert.equal(surface.classList.contains('ipc-pdf-unread'), false);
  await reading;
  const double = event('dblclick');
  await handlers.get('dblclick')(double);
  assert.equal(double.stopped, true);
  assert.deepEqual(s.calls.open, [['papers/a.pdf', 'set-a:ann-1']]);
  ui.destroy();
  assert.equal(handlers.size, 0);
});

test('paint-only PDF highlights resolve through text-layer hit testing, not DOM ancestry', async () => {
  const s = setup(), handlers = new Map();
  s.document.defaultView = { addEventListener:(type,fn)=>handlers.set(type,fn), removeEventListener:type=>handlers.delete(type) };
  const ui = new PdfUi(s.plugin);
  const textLayer = s.document.createElement('span');
  s.context.root.appendChild(textLayer);
  s.context.root.contains = node => node === textLayer;
  s.highlight.getBoundingClientRect = () => ({left:100,right:180,top:200,bottom:220,width:80,height:20});
  s.plugin.pdf.threadsAtPoint = (_context, x, y) => x >= 100 && x <= 180 && y >= 200 && y <= 220 ? s.threads : [];
  await ui.decorate();
  const event = type => ({type,target:textLayer,clientX:120,clientY:210,button:0,preventDefault(){},stopPropagation(){},stopImmediatePropagation(){this.stopped=true;}});
  const click = event('click'); await handlers.get('click')(click);
  assert.equal(click.stopped,true);
  await handlers.get('dblclick')(event('dblclick'));
  assert.deepEqual(s.calls.open,[['papers/a.pdf','set-a:ann-1']]);
  const outside=event('dblclick');outside.clientX=250;await handlers.get('dblclick')(outside);
  assert.equal(s.calls.open.length,1);
  ui.destroy();
});
