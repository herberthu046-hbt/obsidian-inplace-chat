'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const C = require('./comments.cjs');

function describeSource(root, file, text, documentId) {
  const descriptor = { path: path.resolve(root, file.path), format: file.extension,
    version: file.extension === 'pdf' ? documentId : C.hash(C.bodyContext(text)) };
  if (file.extension === 'pdf') {
    const readerRoot = path.join(os.homedir(), '.obsidian-inplace-chat', 'pdf-reader');
    const python = process.env.INPLACE_CHAT_PDF_PYTHON || path.join(readerRoot,
      process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    descriptor.reading = {
      defaultParser: 'PyMuPDF',
      ...(fs.existsSync(python) ? { python } : {}),
      instructions: '首次阅读用 pymupdf.open(path) 打开原 PDF，按页 get_text() 提取全文。Python 使用 -X utf8 输出文本。'
    };
  }
  return descriptor;
}
module.exports = { describeSource };
