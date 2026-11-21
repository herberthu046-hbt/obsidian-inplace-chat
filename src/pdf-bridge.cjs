'use strict';
const path = require('node:path');
const P = require('./pdf.cjs');
const C = require('./comments.cjs');
const S = require('./state.cjs');
const pdfText = require('./pdf-text.cjs');
const { PortableStore } = require('./portable-store.cjs');

const VIEW_TYPE = 'local-pdf-annotator-view';
const pdfFile = file => file?.extension === 'pdf';
const signature = entry => JSON.stringify([entry.author, entry.timestamp, entry.text]);

class PdfBridge {
  constructor(plugin) {
    this.plugin = plugin;
    this.subscriptions = new Map();
    this.projections = new Map();
    this.errors = new Map();
    this.writing = new Set();
    this.adding = new Set();
    this.invalidated = new WeakSet();
  }

  contexts() {
    const app = this.plugin.app, result = [];
    const add = (view, root) => {
      const store = view?.store, file = view?.file;
      if (store && this.invalidated.has(store)) return;
      if (!pdfFile(file) || !store || !root || typeof store.listSets !== 'function' || typeof store.highlightsForSet !== 'function' || typeof store.flush !== 'function') return;
      const indexPath = String(store.options?.indexPath || '').replace(/\\/g, '/');
      const bundleId = /(?:^|\/)\.pdf-annotator\/bundles\/sha256\/([a-f0-9]{64})\/annotation-sets\/index\.json$/.exec(indexPath)?.[1];
      if (!bundleId) return;
      this.plugin.registerHotkeyWindow?.(root.ownerDocument?.defaultView);
      result.push({ view, root, store, file, bundleId });
    };
    for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE)) add(leaf.view, leaf.view.contentEl || leaf.view.containerEl);
    const overlays = app.plugins?.plugins?.['local-pdf-annotator']?.nativeOverlays?.overlays;
    if (overlays instanceof Map) for (const view of overlays.values()) if (!view.destroyed && !view.isDestroyed) add(view, view.contentRoot || view.rootEl);
    const live = new Set(result.map(context => context.store));
    for (const [store, subscription] of this.subscriptions) if (!live.has(store)) { subscription.cleanup(); this.subscriptions.delete(store); }
    for (const context of result) {
      const previous = this.subscriptions.get(context.store);
      if (previous?.filePath === context.file.path) continue;
      previous?.cleanup();
      const refresh = () => {
        this.plugin.scheduleFile(context.file, this.plugin.state.documents[context.file.path] ? 'observe' : 'import');
        this.plugin.scheduleDecorate();
      };
      this.subscriptions.set(context.store, { filePath: context.file.path, cleanup: context.store.onChange?.(refresh) || (() => {}) });
      refresh();
    }
    return result;
  }

  contextFor(fileOrPath) {
    const filePath = typeof fileOrPath === 'string' ? fileOrPath : fileOrPath.path;
    const contexts = this.contexts();
    const context = contexts.find(item => item.file.path === filePath);
    if (!context) throw new Error('请先在 PDF Annotator 中打开此 PDF，或在原生 PDF 阅读器开启 Annotate。');
    if (contexts.some(other => other.file.path === filePath && other.store !== context.store)) throw new Error('此 PDF 有多个独立批注视图，无法确定最新备注；请保留一个批注视图，完整评论标签页可以保留。');
    if (contexts.some(other => other.bundleId === context.bundleId && other.file.path !== filePath)) throw new Error('同一 PDF 的多个副本同时打开，无法唯一确定讨论归属；请保留一个副本的批注视图。');
    return context;
  }

  fileForTarget(target, activeFile = null) {
    const contexts = this.contexts();
    const direct = contexts.find(context => context.root.contains?.(target));
    if (direct) return direct.file;
    // Native annotation edit popovers are appended to ownerDocument.body, not
    // below the PDF overlay root. Resolve them only when exactly one context in
    // that document is the currently active PDF.
    const ownerDocument = target?.ownerDocument;
    const nativePopover = target?.closest?.('.lpa-mark-popover, .lpa-selection-popover');
    if (!ownerDocument || !nativePopover || activeFile?.extension !== 'pdf') return null;
    const candidates = contexts.filter(context => context.file.path === activeFile.path && context.root.ownerDocument === ownerDocument);
    return candidates.length === 1 ? candidates[0].file : null;
  }

  invalidate(file) {
    // A loaded store describes the old bytes. Only a freshly opened store may
    // establish a new bundle after the PDF itself is replaced externally.
    for (const context of this.contexts()) if (context.file.path === file.path) this.invalidated.add(context.store);
  }

  files() { return [...new Map(this.contexts().map(context => [context.file.path, context.file])).values()]; }
  discussionPath(context) { return path.join(this.plugin.storage, 'pdf', `${context.bundleId}.md`); }
  discussion(context) {
    const file = this.discussionPath(context);
    const text = (this.plugin.persistence ||= new PortableStore()).readText(file);
    return text === undefined ? P.createDiscussion(context.bundleId) : P.parseDiscussion(text, context.bundleId);
  }

  annotations(context) {
    return context.store.listSets().flatMap(set => context.store.highlightsForSet(set.id).map(annotation => ({ ...annotation, setId: set.id })));
  }

  snapshot(context) {
    const projection = P.project({ bundleHash: context.bundleId, pdfPath: context.file.path, annotations: this.annotations(context), discussion: this.discussion(context) });
    projection.threads = projection.threads.map(thread => ({ ...thread, id: thread.threadId }));
    return projection;
  }

  bind(context) {
    const documents = this.plugin.state.documents, filePath = context.file.path, id = `pdf:${context.bundleId}`;
    if (documents[filePath]?.id === id) return;
    if (documents[filePath]?.job) throw new Error('PDF 内容或绑定已改变，仍有旧回答待恢复；未切换会话。');
    const prior = Object.entries(documents).find(([, doc]) => doc.id === id);
    if (prior && prior[0] !== filePath) {
      if (this.plugin.app.vault.getAbstractFileByPath(prior[0])) throw new Error('此 PDF 的另一个副本已有问答状态，请使用原副本，或先移动原文件。');
      documents[filePath] = prior[1]; delete documents[prior[0]];
    } else documents[filePath] = { ...S.createDocument(id), needsBaseline: true };
    this.plugin.saveState();
  }

  async textFor(file) {
    const context = this.contextFor(file);
    this.bind(context);
    return this.snapshot(context).text;
  }
  async flush(file) { await this.contextFor(file).store.flush(); }

  enrichTargets(file, targets) {
    const threads = this.snapshot(this.contextFor(file)).threads;
    for (const target of targets) {
      const current = threads.find(thread => thread.id === target.id);
      if (!current) throw new Error('PDF 批注已删除，未发送。');
      target.pdfAnchor = current.anchor;
    }
    return targets;
  }

  async enrichContext(file, targets) {
    const context = this.contextFor(file);
    const pdf = context.view.pdfDoc;
    this.enrichTargets(file, targets);
    await Promise.all(targets.map(async target => {
      target.sourceExcerpt = await pdfText.excerpt(pdf, target.pdfAnchor, target.quote);
    }));
    if (this.contextFor(file).view.pdfDoc !== pdf) throw new Error('PDF 阅读器已切换，请重新发送。');
    return targets;
  }

  writeDiscussion(context, doc) {
    // Refuse content that cannot round-trip through the shared comment engine.
    P.project({ bundleHash: context.bundleId, pdfPath: context.file.path, annotations: this.annotations(context), discussion: doc });
    const destination = this.discussionPath(context);
    (this.plugin.persistence ||= new PortableStore()).writeText(destination,
      P.serializeDiscussion(doc, { title: context.file.basename || context.file.path }));
  }

  async process(file, callback, targets = []) {
    const context = this.contextFor(file);
    if (this.writing.has(context.bundleId)) throw new Error('PDF 讨论正在保存，请稍后重试。');
    this.writing.add(context.bundleId);
    try {
      const discussion = this.discussion(context), before = this.snapshot(context);
      for (const target of targets) {
        const thread = before.threads.find(item => item.id === target.id);
        if (!thread || !target.pdfAnchor || JSON.stringify(target.pdfAnchor) !== JSON.stringify(thread.anchor)) throw new Error('PDF 高亮的位置、文本或页码已改变；回答已保留，未写回。');
      }
      const updated = callback(before.text);
      if (typeof updated !== 'string') throw new Error('PDF 讨论更新必须同步返回文本。');
      let next = discussion;
      for (const thread of C.parse(updated)) {
        const original = before.threads.find(item => item.id === thread.id);
        if (!original || thread.entries.length < original.entries.length || original.entries.some((entry, index) => signature(entry) !== signature(thread.entries[index]))) throw new Error('PDF 讨论更新试图覆盖已有消息，已停止。');
        const additions = thread.entries.slice(original.entries.length);
        if (additions.length) next = P.appendFromProjection(next, original, thread, { anchor: original.anchor });
      }
      if (next !== discussion) this.writeDiscussion(context, next);
      this.plugin.scheduleDecorate();
    } finally { this.writing.delete(context.bundleId); }
  }

  threads(context) {
    const info = this.plugin.cache.get(context.file.path);
    const pending = new Set(info?.pending.map(item => item.id) || []);
    const unread = new Set([...(info?.unread.map(item => item.threadId || item.id) || []),...(this.plugin.chatFiles?.unreadIds(context.file.path) || [])]);
    return this.snapshot(context).threads.map(thread => ({ ...thread, pending: pending.has(thread.id), unread: unread.has(thread.id) }));
  }

  threadsAtPoint(context, clientX, clientY, threads = this.threads(context)) {
    const view = context.view;
    let page, point;
    if (typeof view.pageViewAtPoint === 'function') {
      const pageView = view.pageViewAtPoint(clientX, clientY);
      if (!pageView?.page) return [];
      const viewport = pageView.page.getViewport({ scale: view.scale });
      const box = pageView.el.getBoundingClientRect();
      page = pageView.index;
      point = viewport.convertToPdfPoint(
        (clientX - box.left) / box.width * viewport.width,
        (clientY - box.top) / box.height * viewport.height
      );
    } else {
      let pageBox = view.pageBoxAtPoint?.(clientX, clientY);
      if (!pageBox) {
        // The native reader can have a zero-sized text layer while its
        // canvas is visible. Annotator's helper stops there; use the first
        // rendered page surface instead of treating that page as absent.
        for (const element of context.root.querySelectorAll('.page[data-page-number]')) {
          const surfaces = [element.querySelector(':scope > .textLayer'), element.querySelector(':scope > .canvasWrapper'),
            element.querySelector(':scope > .lpa-native-hl-layer'), element];
          const box = surfaces.filter(Boolean).map(surface => surface.getBoundingClientRect()).find(rect => rect.width >= 2 && rect.height >= 2);
          if (box && clientX >= box.left && clientX <= box.right && clientY >= box.top && clientY <= box.bottom) {
            pageBox = { idx: Number(element.dataset.pageNumber) - 1, box };
            break;
          }
        }
      }
      const geometry = pageBox && view.geoms?.get(pageBox.idx);
      if (!geometry) return [];
      const aspect = geometry.w / geometry.h;
      if (Math.abs(pageBox.box.width / pageBox.box.height - aspect) / aspect > 0.04) return [];
      page = pageBox.idx;
      point = geometry.vp1.convertToPdfPoint(
        (clientX - pageBox.box.left) / pageBox.box.width * geometry.w,
        (clientY - pageBox.box.top) / pageBox.box.height * geometry.h
      );
    }
    // Use the visible annotation data, not the merged or clipped paint layer.
    const annotations = context.store.byPage(page);
    const hits = annotations.filter(annotation => annotation.type !== 'tag' && annotation.rects.some(rect =>
      point[0] >= Math.min(rect.x1, rect.x2) && point[0] <= Math.max(rect.x1, rect.x2) &&
      point[1] >= Math.min(rect.y1, rect.y2) && point[1] <= Math.max(rect.y1, rect.y2)
    ));
    return threads.filter(thread => hits.some(annotation => annotation.setId === thread.setId && annotation.id === thread.annotationId));
  }

  draftKey(context, threadId) { return `${context.bundleId}:${threadId}`; }
  getDraft(context, threadId) { return this.plugin.pdfDrafts?.[this.draftKey(context, threadId)] || ''; }
  setDraft(context, threadId, text) {
    this.plugin.pdfDrafts ||= {};
    const key = this.draftKey(context, threadId);
    if (text) this.plugin.pdfDrafts[key] = text; else delete this.plugin.pdfDrafts[key];
    this.plugin.app.workspace.trigger?.('inplace-chat:pdf-draft', context.bundleId, threadId, text);
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => this.plugin.saveLocal().catch(error => this.plugin.notice(error)), 300);
  }

  async addMessage(context, threadId, text, { send = false } = {}) {
    if (!text?.trim()) throw new Error('请输入追问内容。');
    const key = this.draftKey(context, threadId);
    if (this.adding.has(key)) throw new Error('这条追问正在保存，请稍候。');
    this.adding.add(key);
    try {
    const current = this.contextFor(context.file);
    if (current.bundleId !== context.bundleId) throw new Error('PDF 绑定已改变，草稿已保留。');
    await current.store.flush();
    await this.plugin.refreshFile(current.file, 'observe');
    const snapshot = this.snapshot(current), thread = snapshot.threads.find(item => item.id === threadId);
    if (!thread) throw new Error('这处高亮已删除或归档，草稿已保留。');
    const content = send && !C.mentionsChat(text) ? `@chat ${text.trim()}` : text.trim();
    this.plugin.pdfSubmissions ||= {};
    let entry = this.plugin.pdfSubmissions[key];
    if (!entry || entry.text !== content) {
      entry = { author: 'me', timestamp: new Date().toISOString(), text: content };
      this.plugin.pdfSubmissions[key] = entry;
      await this.plugin.saveLocal();
    }
    const latest = this.snapshot(this.contextFor(current.file)).threads.find(item => item.id === threadId);
    if (!latest || JSON.stringify(latest.anchor) !== JSON.stringify(thread.anchor) ||
        JSON.stringify(latest.entries.map(signature)) !== JSON.stringify(thread.entries.map(signature))) {
      throw new Error('保存期间批注发生变化，草稿已保留；请检查后重试。');
    }
    if (!thread.ownEntries.some(existing => signature(existing) === signature(entry))) {
      const next = P.appendFromProjection(this.discussion(current), thread, { id: threadId, entries: [...thread.entries, entry] }, { anchor: thread.anchor });
      this.writeDiscussion(current, next);
    }
    this.setDraft(current, threadId, '');
    delete this.plugin.pdfSubmissions[key];
    await this.plugin.saveLocal();
    await this.plugin.refreshFile(current.file, 'observe');
    this.plugin.trace({ documentId: `pdf:${current.bundleId}`, stage: 'pdf_comment_saved', source: 'pdf_ui', status: 'not_called' });
    this.plugin.scheduleDecorate();
    if (send) await this.plugin.send(current.file.path, [threadId], 'pdf_ui');
    } finally { this.adding.delete(key); }
  }

  poll() {
    for (const context of this.contexts()) {
      try {
        const hash = C.hash(this.snapshot(context).text);
        if (this.projections.get(context.file.path) !== hash) {
          this.projections.set(context.file.path, hash);
          this.plugin.scheduleFile(context.file, this.plugin.state.documents[context.file.path] ? 'observe' : 'import');
          this.plugin.scheduleDecorate();
        }
        this.errors.delete(context.file.path);
      } catch (error) {
        if (this.errors.get(context.file.path) !== error.message) { this.errors.set(context.file.path, error.message); this.plugin.notice(error); }
      }
    }
  }

  close() {
    clearTimeout(this.draftTimer);
    for (const subscription of this.subscriptions.values()) subscription.cleanup();
    this.subscriptions.clear();
  }
}

module.exports = { PdfBridge, VIEW_TYPE, pdfFile };
