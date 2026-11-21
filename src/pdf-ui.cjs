'use strict';

const { Component, MarkdownRenderer, SuggestModal } = require('obsidian');

const CARD_SELECTOR = '.lpa-margin-card[data-annotation-id], .lpa-roll-item[data-annotation-id]';
const ANNOTATION_SELECTOR = '[data-hl-id], [data-hl-ids], [data-annotation-id]';

function text(value) {
  return typeof value === 'string' ? value : '';
}

function isChatAuthor(author) {
  return /^(chat|assistant)$/i.test(text(author).trim());
}

function panelEntries(thread) {
  return Array.isArray(thread?.ownEntries) ? thread.ownEntries : [];
}

function relativeTime(value, now = Date.now()) {
  const timestamp = Date.parse(text(value));
  if (!Number.isFinite(timestamp)) return '';
  const difference = timestamp - now;
  const future = difference > 0;
  const elapsed = Math.abs(difference);
  if (elapsed < 60_000) return '刚刚';
  const units = [
    [365 * 24 * 60 * 60_000, '年'],
    [30 * 24 * 60 * 60_000, '个月'],
    [7 * 24 * 60 * 60_000, '周'],
    [24 * 60 * 60_000, '天'],
    [60 * 60_000, '小时'],
    [60_000, '分钟']
  ];
  const [size, label] = units.find(([size]) => elapsed >= size);
  return `${Math.floor(elapsed / size)}${label}${future ? '后' : '前'}`;
}

function annotationIdFor(element) {
  return text(element?.dataset?.annotationId || element?.dataset?.hlId);
}

function annotationIdsFor(element) {
  return [...new Set([annotationIdFor(element), ...text(element?.dataset?.hlIds).split(/\s+/)].filter(Boolean))];
}

function threadSignature(thread) {
  return {
    id: text(thread?.id),
    annotationId: text(thread?.annotationId),
    setId: text(thread?.setId),
    entries: panelEntries(thread).map(entry => ({
      author: text(entry?.author),
      timestamp: text(entry?.timestamp),
      text: text(entry?.text)
    }))
  };
}

function surfaceSignature(threads) {
  return JSON.stringify(threads.map(threadSignature));
}

function createElement(parent, tag, className, value) {
  const element = parent.ownerDocument.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined) element.textContent = value;
  parent.appendChild(element);
  return element;
}

function contextKey(context) {
  return `${text(context?.file?.path)}\u0000${text(context?.bundleId)}`;
}

class PdfUi {
  constructor(plugin) {
    this.plugin = plugin;
    this.cards = new Map();
    this.readBindings = new Map();
    this.readWindows = new Map();
    this.contexts = [];
    this.destroyed = false;
    this.decoration = Promise.resolve();
  }

  decorate() {
    if (this.destroyed) return Promise.resolve();
    this.decoration = this.decoration
      .catch(error => this.report(error))
      .then(() => this.destroyed ? undefined : this.decorateNow())
      .catch(error => this.report(error));
    return this.decoration;
  }

  async decorateNow() {
    const bridge = this.plugin.pdf;
    if (!bridge || typeof bridge.contexts !== 'function' || typeof bridge.threads !== 'function') {
      this.contexts = [];
      this.cleanupMissing(new Set(), new Set());
      return;
    }

    const contexts = await bridge.contexts() || [];
    const nextContexts = [];
    const liveCards = new Set();
    const liveReadElements = new Set();

    for (const context of contexts) {
      const root = context?.root;
      if (!root?.querySelectorAll || !context?.file?.path) continue;
      const threads = await bridge.threads(context) || [];
      nextContexts.push({ context, threads });
      const byAnnotation = new Map();
      for (const thread of threads) {
        const id = text(thread?.annotationId);
        if (!id || !thread?.id) continue;
        const group = byAnnotation.get(id) || [];
        group.push(thread);
        byAnnotation.set(id, group);
      }

      for (const card of root.querySelectorAll(CARD_SELECTOR)) {
        const annotationId = annotationIdFor(card);
        const group = byAnnotation.get(annotationId);
        if (!group?.length) continue;
        if (!group.some(thread => panelEntries(thread).length)) continue;
        liveCards.add(card);
        if (group.length === 1) await this.renderCard(context, card, annotationId, group);
        else this.renderAmbiguousCard(context, card, annotationId, group);
      }

      for (const element of root.querySelectorAll(ANNOTATION_SELECTOR)) {
        const group = annotationIdsFor(element).flatMap(id => byAnnotation.get(id) || []);
        if (!group.length) continue;
        liveReadElements.add(element);
        const unread = group.some(thread => thread.unread);
        element.classList?.toggle('ipc-pdf-unread', unread);
        this.bindRead(element, context, group);
      }
    }

    this.contexts = nextContexts;
    this.cleanupMissing(liveCards, liveReadElements);
  }

  async renderCard(context, card, annotationId, threads) {
    const signature = surfaceSignature(threads);
    const previous = this.cards.get(card);
    if (previous?.signature === signature && previous.panel?.parentNode === card) {
      previous.context = context;
      previous.threads = threads;
      this.refreshTimes(previous.panel);
      return;
    }
    this.disposeCard(card);

    const component = new Component();
    component.load();
    const panel = createElement(card, 'section', 'ipc-pdf-chat');
    panel.dataset.ipcAnnotationId = annotationId;
    panel.setAttribute('aria-label', '批注讨论');
    panel.addEventListener('click', event => {
      event.stopPropagation();
      this.markThreadsRead(context, this.cards.get(card)?.threads || []);
    });
    for (const type of ['dblclick', 'pointerdown', 'keydown', 'keyup']) panel.addEventListener(type, event => event.stopPropagation());

    const record = { signature, panel, component, context, threads };
    this.cards.set(card, record);

    try {
      for (const thread of threads) {
        if (this.cards.get(card) !== record) return;
        await this.renderThread(context, panel, component, thread);
      }
    } catch (error) {
      if (this.cards.get(card) === record) {
        const failure = createElement(panel, 'div', 'ipc-pdf-chat-error', '无法渲染讨论');
        failure.title = error.message || String(error);
      }
      this.report(error);
    }
  }

  renderAmbiguousCard(context, card, annotationId, threads) {
    const signature = `ambiguous:${surfaceSignature(threads)}`;
    const previous = this.cards.get(card);
    if (previous?.signature === signature && previous.panel?.parentNode === card) return;
    this.disposeCard(card);
    const panel = createElement(card, 'section', 'ipc-pdf-chat ipc-pdf-chat-ambiguous');
    panel.dataset.ipcAnnotationId = annotationId;
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-label', '批注讨论归属不明');
    createElement(panel, 'div', 'ipc-pdf-ambiguity', '此处关联多个批注集中的问答。点击后选择要打开的一条。');
    for (const type of ['click', 'dblclick', 'pointerdown', 'keydown', 'keyup']) panel.addEventListener(type, event => event.stopPropagation());
    this.cards.set(card, { signature, panel, component: null, context, threads });
  }

  async renderThread(context, panel, component, thread) {
    const section = createElement(panel, 'section', 'ipc-pdf-thread');
    section.dataset.threadId = text(thread.id);

    const entries = panelEntries(thread).filter(entry => isChatAuthor(entry.author)).slice(0, 1);
    const list = createElement(section, 'div', 'ipc-pdf-entries');

    for (const entry of entries) {
      const row = createElement(list, 'article', `ipc-pdf-entry ${isChatAuthor(entry.author) ? 'is-chat' : 'is-human'}`);
      const head = createElement(row, 'div', 'ipc-pdf-entry-head');
      createElement(head, 'strong', 'ipc-pdf-author', text(entry.author) || '—');
      if (entry.timestamp) {
        const time = createElement(head, 'span', 'ipc-pdf-time', relativeTime(entry.timestamp));
        time.title = text(entry.timestamp);
      }
      const body = createElement(row, 'div', 'ipc-pdf-entry-body markdown-rendered');
      await MarkdownRenderer.render(this.plugin.app, text(entry.text), body, context.file.path, component);
    }
    if (this.plugin.chatFiles) {
      const file = await this.plugin.chatFiles.ensure(context.file, thread.id);
      const link = createElement(section, 'button', 'ipc-full-chat-link ipc-full-chat-button', '完整回答');
      link.setAttribute('type', 'button');
      link.setAttribute('data-chat-path', file.path);
      link.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        this.plugin.openCommentReader(context.file.path, thread.id).catch(error => this.report(error));
      });
    }
  }

  refreshTimes(panel) {
    for (const time of panel.querySelectorAll?.('.ipc-pdf-time') || []) {
      const label = relativeTime(time.title);
      if (time.textContent !== label) time.textContent = label;
    }
  }

  bindRead(element, context, threads) {
    const signature = `${contextKey(context)}\u0000${threads.map(thread => `${thread.id}:${!!thread.unread}`).join('\u0000')}`;
    const previous = this.readBindings.get(element);
    if (previous?.signature === signature) return;
    if (previous) {
      element.removeEventListener('click', previous.listener, true);
      element.removeEventListener('dblclick', previous.openListener, true);
    }
    const listener = event => this.handleInteraction(context, threads, event, false);
    const openListener = event => this.handleInteraction(context, threads, event, true);
    element.addEventListener('click', listener, true);
    element.addEventListener('dblclick', openListener, true);
    this.readBindings.set(element, { signature, listener, openListener, root: context.root, filePath: context.file.path, threads });
    const win = element.ownerDocument?.defaultView;
    if (win && !this.readWindows.has(win)) {
      const route = event => {
        for (let node = event.target; node; node = node.parentElement || node.parentNode) {
          const binding = this.readBindings.get(node);
          if (binding) return event.type === 'dblclick' ? binding.openListener(event) : binding.listener(event);
        }
        if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
        for (const { context: current, threads: currentThreads } of this.contexts) {
          if (!current.root.contains?.(event.target)) continue;
          const hits = this.plugin.pdf.threadsAtPoint(current, event.clientX, event.clientY, currentThreads);
          if (hits.length) return this.handleInteraction(current, hits, event, event.type === 'dblclick');
        }
      };
      win.addEventListener('click', route, true);
      win.addEventListener('dblclick', route, true);
      this.readWindows.set(win, () => {
        win.removeEventListener('click', route, true);
        win.removeEventListener('dblclick', route, true);
      });
    }
  }

  handleInteraction(context, threads, event, open) {
    if (event?.target?.closest?.('textarea, input, button, a, [contenteditable="true"]') || event?.button > 0) return;
    event.preventDefault?.();
    event.stopImmediatePropagation?.();
    event.stopPropagation?.();
    if (threads.length > 1) {
      if (this.threadChoice) return this.threadChoice;
      this.threadChoice = this.chooseThread(context, threads).then(async thread => {
        if (!thread) return;
        await this.markThreadsRead(context, [thread]);
        await this.plugin.openCommentReader(context.file.path, thread.id);
      }).catch(error => this.report(error)).finally(() => { this.threadChoice = null; });
      return this.threadChoice;
    }
    if (!open) return this.markThreadsRead(context, threads);
    this.plugin.trace?.({ stage: 'reader_open', source: 'pdf_double_click', status: 'received' });
    return Promise.resolve().then(() => this.plugin.openCommentReader(context.file.path, threads[0].id)).catch(error => this.report(error));
  }

  chooseThread(context, threads) {
    return new Promise(resolve => {
      const distinguishSets = new Set(threads.map(thread => thread.setId)).size > 1;
      const modal = new class extends SuggestModal {
        getSuggestions(query) {
          return threads.filter(thread => thread.quote.toLowerCase().includes(query.toLowerCase()));
        }
        renderSuggestion(thread, element) {
          const label = thread.quote.replace(/\s+/g, ' ').slice(0, 100);
          const set = context.store.setMeta?.(thread.setId)?.name || thread.setId;
          element.textContent = distinguishSets ? `${label} · ${set}` : label;
        }
        onChooseSuggestion(thread) { resolve(thread); }
        onClose() { queueMicrotask(() => resolve(null)); }
      }(this.plugin.app);
      this.threadPicker = modal;
      modal.setPlaceholder('此处有多条问答，选择要打开的一条');
      modal.open();
    });
  }

  markThreadsRead(context, threads) {
    const unread = threads.filter(thread => thread.unread);
    if (!unread.length) return Promise.resolve();
    for (const thread of unread) thread.unread = false;
    for (const [surface, binding] of this.readBindings) {
      surface.classList?.toggle('ipc-pdf-unread', binding.threads.some(thread => thread.unread));
    }
    return Promise.all(unread.map(thread => this.plugin.markRead(context.file.path, thread.id)))
      .then(() => this.decorate())
      .catch(error => this.report(error));
  }

  cleanupMissing(liveCards, liveReadElements) {
    for (const card of [...this.cards.keys()]) if (!liveCards.has(card)) this.disposeCard(card);
    for (const [element, binding] of [...this.readBindings]) {
      if (liveReadElements.has(element)) continue;
      element.removeEventListener('click', binding.listener, true);
      element.removeEventListener('dblclick', binding.openListener, true);
      element.classList?.remove('ipc-pdf-unread');
      this.readBindings.delete(element);
    }
  }

  disposeCard(card) {
    const record = this.cards.get(card);
    if (!record) return;
    record.component?.unload();
    record.panel?.remove();
    this.cards.delete(card);
  }

  destroy() {
    this.destroyed = true;
    this.threadPicker?.close();
    for (const remove of this.readWindows.values()) remove();
    this.readWindows.clear();
    for (const card of [...this.cards.keys()]) this.disposeCard(card);
    for (const [element, binding] of this.readBindings) {
      element.removeEventListener('click', binding.listener, true);
      element.removeEventListener('dblclick', binding.openListener, true);
      element.classList?.remove('ipc-pdf-unread');
    }
    this.readBindings.clear();
  }

  report(error) {
    if (!error) return;
    if (typeof this.plugin.notice === 'function') this.plugin.notice(error);
    else console.error('[inplace-chat] PDF UI:', error);
  }
}

module.exports = {
  ANNOTATION_SELECTOR,
  CARD_SELECTOR,
  PdfUi,
  annotationIdFor,
  annotationIdsFor,
  panelEntries,
  relativeTime,
  surfaceSignature
};
