'use strict';

// Run explicitly with: node --test test/pdf-browser.cjs
// Uses Playwright installed locally; no browser or test dependency is shipped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { chromium } = require('playwright');
const { PdfBridge } = require('../src/pdf-bridge.cjs');

const obsidian = `
export class Component { load() {} unload() {} }
export const MarkdownRenderer = { async render(_app, text, target) { target.textContent = text; } };
export class SuggestModal {
  constructor(app) { this.app = app; }
  setPlaceholder(text) { this.placeholder = text; }
  open() {
    this.el = document.createElement('div');
    this.el.className = 'ipc-thread-picker';
    this.el.style.cssText = 'position:fixed;left:20px;top:20px;z-index:100;background:white';
    for (const thread of this.getSuggestions('')) {
      const button = document.createElement('button');
      this.renderSuggestion(thread, button);
      button.onclick = () => { this.close(); this.onChooseSuggestion(thread); };
      this.el.appendChild(button);
    }
    document.body.appendChild(this.el);
  }
  close() { this.el.remove(); this.onClose?.(); }
}`;

test('real pointer sequences clear one discussion, survive paint replacement, and choose overlapping questions', async t => {
  const bundled = await esbuild.build({ entryPoints: [path.resolve(__dirname, '../src/pdf-ui.cjs')],
    bundle: true, platform: 'browser', format: 'iife', globalName: 'PdfUiModule', write: false,
    plugins: [{ name: 'obsidian-test-runtime', setup(build) {
      build.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'test' }));
      build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: obsidian, loader: 'js' }));
    } }] });
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const executablePath = process.env.IPC_BROWSER_EXECUTABLE || (fs.existsSync(edge) ? edge : undefined);
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<style>
    #pdf { position:absolute;left:100px;top:100px;width:600px;height:400px }
    .page, .canvasWrapper { position:absolute;inset:0 }
    .lpa-highlight { position:absolute;top:20px;height:20px;background:yellow;pointer-events:none }
    .textLayer { position:absolute;inset:0;z-index:2 }
    .textLayer span { position:absolute;top:20px;height:20px }
    .ipc-pdf-unread { outline:2px solid blue }
  </style><div id="pdf"><div class="page" data-page-number="1"><div class="canvasWrapper"><canvas width="600" height="400"></canvas></div><div class="textLayer"><span style="left:20px">unique</span><span style="left:100px">merged-one</span><span style="left:150px">merged-two</span><span style="left:220px">overlap</span></div></div></div>`);
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  await page.addScriptTag({ content: `window.HitBridge = class { ${PdfBridge.prototype.threadsAtPoint.toString()} };` });
  await page.evaluate(async () => {
    const root = document.getElementById('pdf');
    const annotations = [
      { id: 'unique', left: 20, right: 80 }, { id: 'merged-one', left: 100, right: 140 },
      { id: 'merged-two', left: 150, right: 195 }, { id: 'overlap-a', left: 220, right: 275 },
      { id: 'overlap-b', left: 220, right: 275 }
    ].map(mark => ({ id: mark.id, setId: 'notes', type: 'highlight', rects: [{ x1: mark.left, y1: 20, x2: mark.right, y2: 40 }] }));
    const threads = annotations.map(mark => ({ id: mark.id, annotationId: mark.id, setId: mark.setId, quote: mark.id, ownEntries: [], unread: true }));
    const context = { root, file: { path: 'synthetic.pdf' }, bundleId: 'synthetic', store: { byPage: () => annotations }, view: {
      pageBoxAtPoint(x, y) {
        const element = root.querySelector('.page');
        const box = (element.querySelector(':scope > .textLayer') ?? element.querySelector(':scope > .canvasWrapper') ?? element).getBoundingClientRect();
        return box.width >= 2 && box.height >= 2 && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom ? { idx: 0, box } : null;
      },
      geoms: new Map([[0, { w: 600, h: 400, vp1: { convertToPdfPoint: (x, y) => [x, y] } }]])
    } };
    const bridge = new window.HitBridge();
    bridge.contexts = () => [context];
    bridge.threads = () => threads;
    window.testContext = context;
    window.testThreads = threads;
    window.calls = { read: [], open: [], sequence: [] };
    const plugin = { app: {}, pdf: bridge,
      async markRead(_file, id) { window.calls.read.push(id); },
      async openCommentReader(_file, id) { window.calls.open.push(id); },
      notice(error) { throw error; }
    };
    window.ui = new PdfUiModule.PdfUi(plugin);
    const paint = () => {
      root.querySelectorAll('.lpa-highlight').forEach(mark => mark.remove());
      for (const [ids, left, width] of [['unique', 20, 60], ['merged-one merged-two', 100, 95], ['overlap-a overlap-b', 220, 55]]) {
        const element = document.createElement('div');
        element.className = 'lpa-highlight'; element.dataset.hlIds = ids;
        if (!ids.includes(' ')) element.dataset.hlId = ids;
        element.style.left = left + 'px'; element.style.width = width + 'px';
        root.prepend(element);
      }
    };
    paint();
    root.addEventListener('mouseup', () => { paint(); queueMicrotask(() => window.ui.decorate()); });
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick']) window.addEventListener(type, event => { window.calls.sequence.push(type); window.calls.target = event.target.tagName; }, true);
    await window.ui.decorate();
  });

  await page.mouse.click(130, 130);
  await page.waitForFunction(() => window.calls.read.length === 1);
  assert.deepEqual(await page.evaluate(() => window.calls.read), ['unique']);
  assert.equal(await page.locator('[data-hl-id="unique"]').evaluate(el => el.classList.contains('ipc-pdf-unread')), false);
  await page.mouse.dblclick(130, 130);
  await page.waitForFunction(() => window.calls.open.length === 1);
  assert.deepEqual(await page.evaluate(() => window.calls.open), ['unique']);
  assert.ok((await page.evaluate(() => window.calls.sequence)).includes('dblclick'));

  await page.mouse.click(210, 130);
  await page.waitForFunction(() => window.calls.read.includes('merged-one'));
  assert.equal(await page.locator('[data-hl-ids="merged-one merged-two"]').evaluate(el => el.classList.contains('ipc-pdf-unread')), true);
  assert.equal(await page.locator('.ipc-thread-picker').count(), 0);
  await page.mouse.click(270, 130);
  await page.waitForFunction(() => window.calls.read.includes('merged-two'));
  assert.equal(await page.locator('[data-hl-ids="merged-one merged-two"]').evaluate(el => el.classList.contains('ipc-pdf-unread')), false);

  await page.mouse.click(335, 130);
  await page.waitForSelector('.ipc-thread-picker');
  assert.deepEqual(await page.evaluate(() => window.calls.read), ['unique', 'merged-one', 'merged-two']);
  await page.getByRole('button', { name: 'overlap-b', exact: true }).click();
  await page.waitForFunction(() => window.calls.open.includes('overlap-b'));
  assert.deepEqual(await page.evaluate(() => window.calls.read), ['unique', 'merged-one', 'merged-two', 'overlap-b']);
  assert.equal(await page.locator('[data-hl-ids="overlap-a overlap-b"]').evaluate(el => el.classList.contains('ipc-pdf-unread')), true);
  await page.evaluate(async () => {
    const textLayer = document.querySelector('.textLayer');
    textLayer.replaceChildren();
    Object.assign(textLayer.style, { width: '0px', height: '0px', right: 'auto', bottom: 'auto' });
    window.testThreads[0].unread = true;
    window.calls.read = [];
    window.calls.open = [];
    await window.ui.decorate();
  });
  assert.equal(await page.evaluate(() => window.testContext.view.pageBoxAtPoint(130, 130)), null);
  await page.mouse.click(130, 130);
  await page.waitForFunction(() => window.calls.read.includes('unique'));
  assert.equal(await page.evaluate(() => window.calls.target), 'CANVAS');
  await page.mouse.dblclick(130, 130);
  await page.waitForFunction(() => window.calls.open.includes('unique'));
  await page.evaluate(() => window.ui.destroy());
});
