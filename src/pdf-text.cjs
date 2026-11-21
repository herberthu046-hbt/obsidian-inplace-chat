'use strict';
// Consume the same PDF.js document as the reader: it already owns the font/CMap
// configuration. Do not decode PDF bytes as UTF-8 or guess a Chinese code page.
const cache = new WeakMap();
function pageText(pdf, number) {
  let pages = cache.get(pdf);
  if (!pages) { pages = new Map(); cache.set(pdf, pages); }
  if (!pages.has(number)) {
    const pending = pdf.getPage(number).then(page => page.getTextContent()).then(content =>
      content.items.filter(item => typeof item.str === 'string')
        .map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim());
    pages.set(number, pending);
    pending.catch(() => pages.delete(number));
  }
  return pages.get(number);
}
function clip(text, quote, limit) {
  if (text.length <= limit) return text;
  const chars = [], offsets = [];
  for (let i = 0; i < text.length; i++) if (!/\s/u.test(text[i])) { chars.push(text[i]); offsets.push(i); }
  const needle = String(quote || '').replace(/^p\.\d+\s*·\s*/, '').replace(/\s/gu, '');
  const found = needle ? chars.join('').indexOf(needle) : -1;
  const at = found < 0 ? 0 : offsets[found];
  const start = Math.max(0, Math.min(text.length - limit, at - Math.floor(limit / 3)));
  return (start ? '[前文截断]\n' : '') + text.slice(start, start + limit) + (start + limit < text.length ? '\n[后文截断]' : '');
}
async function excerpt(pdf, anchor, quote) {
  if (!pdf?.getPage || !Number.isInteger(pdf.numPages)) throw new Error('PDF 文本层尚未就绪，请等待文档加载后发送。');
  const page = anchor?.page;
  if (!Number.isInteger(page) || page < 0 || page >= pdf.numPages) throw new Error('PDF 批注页码无效，未发送。');
  const numbers = [page, page + 1, page + 2].filter(n => n >= 1 && n <= pdf.numPages);
  const sections = await Promise.all(numbers.map(async n => {
    const text = await pageText(pdf, n);
    if (!text) return `PDF 第 ${n} 页：没有可提取的文本层。`;
    // Keep the end of the preceding page and start of the following page.
    const part = n === page + 1 ? clip(text, quote, 3000) : n <= page ? text.slice(-1000) : text.slice(0, 1800);
    return `PDF 第 ${n} 页${n === page + 1 ? '（批注所在页）' : '（邻页节选）'}：\n${part}`;
  }));
  return sections.join('\n\n');
}
module.exports = { pageText, excerpt, clip };
