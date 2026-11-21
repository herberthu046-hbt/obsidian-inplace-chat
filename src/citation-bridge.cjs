'use strict';

const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { resolveZoteroEvidenceAttachment, openZoteroEvidence } = require('./zotero.cjs');

const USE_ID = /^u-[a-f0-9]{32}$/;
const EVIDENCE_ID = /^e-[a-f0-9]{32}$/;
const CITATION_ID = /^(?:u|e)-[a-f0-9]{32}$/;
const SOURCE_ID = /^s-[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;

function fail(message, code = 'CITATION_INVALID') {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function slash(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function vaultPath(root, relative) {
  const value = slash(relative);
  if (!value || value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').includes('..')) {
    fail('引用记录包含不安全的库内路径，已停止。', 'CITATION_PATH_INVALID');
  }
  return [slash(root).replace(/\/$/, ''), value].filter(Boolean).join('/');
}

function normalizeQuote(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function citationLocators(selector) {
  const normalized = normalizeQuote(selector?.exact);
  const fragments = [];
  for (const line of String(selector?.exact || '').split(/\r?\n/)) {
    for (const piece of line.split(/\s{4,}/u)) {
      const fragment = normalizeQuote(piece);
      if (fragment.length >= 28 && fragment !== normalized) fragments.push(fragment);
    }
  }
  const ordered = [...new Set(fragments)].sort((left, right) => right.length - left.length);
  if (normalized) ordered.push(normalized);
  return [...new Set(ordered)];
}

function compactSegments(segments) {
  let text = '';
  const map = [];
  for (const segment of segments || []) {
    const value = String(segment?.text ?? segment?.node?.nodeValue ?? '');
    for (let offset = 0; offset < value.length;) {
      const point = value.codePointAt(offset);
      const width = point > 0xffff ? 2 : 1;
      const normalized = String.fromCodePoint(point).normalize('NFKC');
      for (const char of normalized) {
        if (/\s/u.test(char)) continue;
        text += char;
        map.push({ node: segment.node, startOffset: offset, endOffset: offset + width });
      }
      offset += width;
    }
  }
  return { text, map };
}

function compactText(value) {
  return compactSegments([{ text: String(value || '') }]).text;
}

function uniqueCompactMatch(index, quote) {
  const needle = compactText(quote);
  if (!needle) return null;
  const start = index.text.indexOf(needle);
  if (start < 0 || index.text.indexOf(needle, start + 1) >= 0) return null;
  const first = index.map[start];
  const last = index.map[start + needle.length - 1];
  return first && last ? { first, last } : null;
}

function collectTextNodes(root) {
  const nodes = [];
  const visit = node => {
    if (!node) return;
    if (node.nodeType === 3) {
      if (node.nodeValue) nodes.push({ node, text: node.nodeValue });
      return;
    }
    for (const child of Array.from(node.childNodes || [])) visit(child);
  };
  visit(root);
  return nodes;
}

function rangeForLocators(textLayer, locators) {
  const index = compactSegments(collectTextNodes(textLayer));
  for (const locator of locators) {
    const match = uniqueCompactMatch(index, locator);
    if (!match) continue;
    const range = textLayer.ownerDocument.createRange();
    range.setStart(match.first.node, match.first.startOffset);
    range.setEnd(match.last.node, match.last.endOffset);
    return range;
  }
  return null;
}

function removeAfterAnimation(element, duration = 1900) {
  const remove = () => element?.remove?.();
  element?.addEventListener?.('animationend', remove, { once: true });
  setTimeout(remove, duration + 300);
}

function paintPageFlash(page, useId, duration) {
  const root = page?.el;
  const doc = root?.ownerDocument;
  if (!root || !doc) return false;
  root.querySelectorAll?.('.ipc-citation-flash').forEach(element => element.remove());
  const element = doc.createElement('div');
  element.className = 'ipc-citation-flash ipc-citation-page-flash';
  element.dataset.useId = useId;
  root.appendChild(element);
  removeAfterAnimation(element, duration);
  return true;
}

function paintRangeFlash(page, range, useId, duration) {
  const root = page?.el;
  const doc = root?.ownerDocument;
  if (!root || !doc || !range) return false;
  const rootRect = root.getBoundingClientRect();
  const rects = Array.from(range.getClientRects?.() || []).filter(rect => rect.width > 0.5 && rect.height > 0.5);
  if (!rects.length) return false;
  root.querySelectorAll?.('.ipc-citation-flash').forEach(element => element.remove());
  for (const rect of rects) {
    const element = doc.createElement('div');
    element.className = 'ipc-citation-flash ipc-citation-text-flash';
    element.dataset.useId = useId;
    Object.assign(element.style, {
      left: `${rect.left - rootRect.left}px`,
      top: `${rect.top - rootRect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
    root.appendChild(element);
    removeAfterAnimation(element, duration);
  }
  return true;
}

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch { fail(`${label} 不是有效 JSON，已停止。`, 'CITATION_JSON_INVALID'); }
}

function choosePdfArtifact(record, snapshotSha) {
  const snapshots = Array.isArray(record?.snapshots) ? record.snapshots : [];
  const snapshot = snapshots.find(item => item?.sha256 === snapshotSha);
  if (!snapshot) fail('引用指向的固定文本快照不存在。', 'CITATION_SNAPSHOT_MISSING');
  if (snapshot.kind !== 'pdf-text') fail('这条引用不是从 PDF 文本快照生成的，只能打开证据 Markdown。', 'CITATION_NOT_PDF');

  const artifacts = (Array.isArray(record?.artifacts) ? record.artifacts : [])
    .filter(item => item?.role === 'original' && SHA256.test(String(item?.sha256 || '')) && /\.pdf$/i.test(String(item?.path || '')));
  const capture = record?.metadata?.capture;
  const artifactSha = SHA256.test(String(snapshot?.artifact_sha256 || ''))
    ? snapshot.artifact_sha256
    : capture?.text_sha256 === snapshotSha && SHA256.test(String(capture?.artifact_sha256 || ''))
      ? capture.artifact_sha256
      : null;
  if (artifactSha) {
    const bound = artifacts.filter(item => item.sha256 === artifactSha);
    if (bound.length === 1) return { snapshot, artifact: bound[0] };
    fail('快照登记了 PDF SHA，但库内没有唯一匹配的原始附件。', 'CITATION_PDF_AMBIGUOUS');
  }
  const pdfSnapshots = snapshots.filter(item => item?.kind === 'pdf-text');
  if (artifacts.length === 1 && pdfSnapshots.length === 1) return { snapshot, artifact: artifacts[0] };
  fail('文本快照与原始 PDF 没有唯一绑定，不能猜测要打开哪一份附件。', 'CITATION_PDF_AMBIGUOUS');
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function legacyAgentUseId(annotation) {
  if (annotation?.source !== 'import') return null;
  const firstLine = String(annotation?.note || '').split(/\r?\n/, 1)[0].trim();
  return /^Agent 引用 (u-[a-f0-9]{32})$/u.exec(firstLine)?.[1] || null;
}

class CitationBridge {
  constructor(plugin, options = {}) {
    this.plugin = plugin;
    this.delay = options.delay || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.flasher = options.flasher || ((context, citation) => this.flashCitation(context, citation));
    this.flashDuration = options.flashDuration || 1600;
    this.resolveZoteroAttachment = options.resolveZoteroAttachment || resolveZoteroEvidenceAttachment;
    this.openZoteroEvidence = options.openZoteroEvidence || openZoteroEvidence;
    this.hashFile = options.hashFile || sha256File;
    this.opening = new Map();
  }

  async readFile(file, label) {
    if (!file || typeof file.path !== 'string') fail(`${label}不存在或已移动。`, 'CITATION_FILE_MISSING');
    return this.plugin.app.vault.read(file);
  }

  findUniqueUseFile(useId) {
    if (!CITATION_ID.test(String(useId || ''))) fail('引用 ID 格式无效。', 'CITATION_ID_INVALID');
    const suffix = EVIDENCE_ID.test(useId) ? `/证据/${useId}.json` : `/引用/${useId}.json`;
    const matches = (this.plugin.app.vault.getFiles?.() || []).filter(file => slash(file.path).endsWith(suffix));
    if (matches.length !== 1) {
      fail(matches.length ? '当前 Vault 中存在重复的引用 ID，无法安全定位。' : '当前 Vault 中找不到这条 Agent 引用。',
        matches.length ? 'CITATION_ID_AMBIGUOUS' : 'CITATION_USE_MISSING');
    }
    return matches[0];
  }

  async resolve(useId) {
    const useFile = this.findUniqueUseFile(useId);
    const marker = EVIDENCE_ID.test(useId) ? `/证据/${useId}.json` : `/引用/${useId}.json`;
    const libraryRoot = slash(useFile.path).slice(0, -marker.length);
    const use = parseJson(await this.readFile(useFile, '引用记录'), '引用记录');
    if (use.id !== useId || !SOURCE_ID.test(String(use.source_id || '')) || !SHA256.test(String(use.snapshot || '')) ||
        (EVIDENCE_ID.test(useId) && use.schema !== 2)) {
      fail('引用记录身份字段无效。', 'CITATION_IDENTITY_INVALID');
    }
    const selector = use.selector;
    const position = selector?.position;
    if (selector?.type !== 'TextQuoteSelector' || typeof selector.exact !== 'string' || !selector.exact ||
        position?.unit !== 'Unicode code points' || !Number.isInteger(position.start) || !Number.isInteger(position.end)) {
      fail('引用记录缺少可核验的 TextQuoteSelector。', 'CITATION_SELECTOR_INVALID');
    }

    const recordPath = vaultPath(libraryRoot, `资料/${use.source_id}/record.json`);
    const recordFile = this.plugin.app.vault.getAbstractFileByPath(recordPath);
    const record = parseJson(await this.readFile(recordFile, '文献身份记录'), '文献身份记录');
    if (record.id !== use.source_id) fail('引用记录与文献身份不一致。', 'CITATION_IDENTITY_INVALID');
    const { snapshot, artifact } = choosePdfArtifact(record, use.snapshot);

    const snapshotFile = this.plugin.app.vault.getAbstractFileByPath(vaultPath(libraryRoot, snapshot.text));
    const rawText = await this.readFile(snapshotFile, '固定文本快照');
    const text = String(rawText).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    if (createHash('sha256').update(text, 'utf8').digest('hex') !== snapshot.sha256) {
      fail('固定文本快照的 SHA-256 已改变，拒绝定位。', 'CITATION_SNAPSHOT_CHANGED');
    }
    if (!(position.start >= 0 && position.end > position.start && position.end <= text.length) ||
        text.slice(position.start, position.end) !== selector.exact) {
      fail('引用位置与固定快照原文不一致，拒绝定位。', 'CITATION_POSITION_CHANGED');
    }

    const pdfPath = vaultPath(libraryRoot, artifact.path);
    const pdfFile = this.plugin.app.vault.getAbstractFileByPath(pdfPath);
    if (!pdfFile || pdfFile.extension !== 'pdf') fail('原始 PDF 附件不存在或已移动。', 'CITATION_PDF_MISSING');
    const computedPageIndex = text.slice(0, position.start).split('\f').length - 1;
    const storedPageIndex = use.locator?.page_index;
    if (storedPageIndex != null && (!Number.isInteger(storedPageIndex) || storedPageIndex !== computedPageIndex)) {
      fail('证据页码与固定快照位置不一致，拒绝定位。', 'CITATION_PAGE_CHANGED');
    }
    return {
      useId,
      use,
      record,
      selector,
      pageIndex: computedPageIndex,
      artifact,
      pdfFile,
      libraryRoot,
      zoteroTarget: EVIDENCE_ID.test(useId) ? use.locator?.zotero || artifact?.zotero || null : null
    };
  }

  contextsFor(filePath) {
    return (this.plugin.pdf?.contexts?.() || []).filter(context => context?.file?.path === filePath);
  }

  async waitForContext(filePath, timeout = 15000) {
    const deadline = Date.now() + timeout;
    do {
      const contexts = this.contextsFor(filePath);
      if (contexts.length === 1) return contexts[0];
      if (contexts.length > 1) fail('此 PDF 同时存在多个批注视图，无法安全选择。', 'CITATION_VIEW_AMBIGUOUS');
      await this.delay(100);
    } while (Date.now() < deadline);
    fail('PDF Annotator 尚未完成打开，请稍后再次点击。', 'CITATION_VIEW_TIMEOUT');
  }

  annotations(context) {
    if (typeof this.plugin.pdf?.annotations === 'function') return this.plugin.pdf.annotations(context);
    return (context.store?.listSets?.() || []).flatMap(set => context.store.highlightsForSet?.(set.id) || []);
  }

  async cleanupLegacyAnnotations(context) {
    const generated = this.annotations(context).filter(annotation => legacyAgentUseId(annotation));
    if (!generated.length || typeof context.store?.remove !== 'function') return 0;
    for (const annotation of generated) context.store.remove(annotation.id);
    await context.store.flush?.();
    context.view?.renderAnnotationSidebar?.();
    return generated.length;
  }

  async waitForPage(view, pageIndex, timeout = 10000) {
    const deadline = Date.now() + timeout;
    let page = view?.pageViews?.[pageIndex];
    if (page) {
      page.el?.scrollIntoView?.({ block: 'center' });
      if (!page.rendered && !page.rendering) await view.renderPageContent?.(page);
    }
    while (Date.now() < deadline) {
      page = view?.pageViews?.[pageIndex];
      if (page?.rendered && page.textLayerEl) return page;
      if (page && !page.rendering && !page.rendered) await view.renderPageContent?.(page);
      await this.delay(50);
    }
    return page || null;
  }

  async flashCitation(context, citation) {
    const page = await this.waitForPage(context.view, citation.pageIndex);
    page?.el?.scrollIntoView?.({ block: 'center' });
    if (page?.textLayerEl) {
      const range = rangeForLocators(page.textLayerEl, citationLocators(citation.selector));
      if (paintRangeFlash(page, range, citation.useId, this.flashDuration)) return 'text-flashed';
    }
    return paintPageFlash(page, citation.useId, this.flashDuration) ? 'page-flashed' : 'page-only';
  }

  async openFallback(citation) {
    const workspace = this.plugin.app.workspace;
    const leaf = workspace.getLeaf?.('tab');
    if (!leaf?.openFile) fail('无法打开 PDF 阅读器。', 'CITATION_OPEN_FAILED');
    await leaf.openFile(citation.pdfFile, { active: true, eState: { subpath: `#page=${citation.pageIndex + 1}` } });
    await workspace.revealLeaf?.(leaf);
    workspace.setActiveLeaf?.(leaf, { focus: true });
    return { status: 'page-only', citation };
  }

  async openInZotero(citation) {
    const attachment = await this.resolveZoteroAttachment(citation.zoteroTarget);
    const currentSha = await this.hashFile(attachment.path);
    if (currentSha !== citation.artifact.sha256) {
      fail('Zotero 当前 PDF 与证据快照绑定的版本不同，拒绝静默定位。', 'CITATION_ZOTERO_PDF_CHANGED');
    }
    const result = await this.openZoteroEvidence({
      evidence_id: citation.useId,
      zotero: citation.zoteroTarget,
      page_index: citation.pageIndex,
      quote: citation.selector.exact,
      prefix: citation.selector.prefix || '',
      suffix: citation.selector.suffix || '',
      pdf_sha256: citation.artifact.sha256
    });
    return { ...result, citation, removedLegacy: 0 };
  }

  async openResolved(citation) {
    if (citation.zoteroTarget) return this.openInZotero(citation);
    const annotator = this.plugin.app.plugins?.plugins?.['local-pdf-annotator'];
    if (!annotator || typeof annotator.openInAnnotator !== 'function') return this.openFallback(citation);
    await annotator.openInAnnotator(citation.pdfFile, 'tab');
    const context = await this.waitForContext(citation.pdfFile.path);
    if (context.bundleId !== citation.artifact.sha256) {
      fail('PDF Annotator 打开的文件 SHA 与引用记录不一致，拒绝高亮。', 'CITATION_PDF_CHANGED');
    }
    const removedLegacy = await this.cleanupLegacyAnnotations(context);
    const status = await this.flasher(context, citation);
    this.plugin.scheduleDecorate?.();
    return { status, citation, removedLegacy };
  }

  openUse(useId) {
    if (this.opening.has(useId)) return this.opening.get(useId);
    const pending = this.resolve(useId)
      .then(citation => this.openResolved(citation))
      .finally(() => this.opening.delete(useId));
    this.opening.set(useId, pending);
    return pending;
  }
}

module.exports = {
  CitationBridge,
  CITATION_ID,
  EVIDENCE_ID,
  USE_ID,
  citationLocators,
  choosePdfArtifact,
  compactSegments,
  legacyAgentUseId,
  normalizeQuote,
  rangeForLocators,
  uniqueCompactMatch,
  vaultPath,
  sha256File
};
