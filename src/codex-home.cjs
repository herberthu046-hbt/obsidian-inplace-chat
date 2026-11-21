'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// Only configuration is refreshed. Sessions, SQLite databases and writer
// locks belong to this plugin home and must never be linked to the desktop home.
function prepareHome(home, source) {
  if (path.resolve(home) === path.resolve(source)) throw Error('插件会话目录不能与 Codex 桌面目录相同。');
  fs.mkdirSync(home, { recursive: true });
  // Codex resolves credential symlinks before atomic writes and auth.json.lock
  // acquisition. Share auth.lock too, so only one process refreshes a token.
  // Never copy managed refresh tokens into an independently refreshing store.
  if (fs.existsSync(path.join(source, 'auth.json'))) {
    for (const name of ['auth.json', 'auth.lock']) {
      const link = path.join(home, name), target = path.join(source, name);
      let linked = false;
      try { linked = fs.lstatSync(link).isSymbolicLink() && path.resolve(path.dirname(link), fs.readlinkSync(link)).toLowerCase() === path.resolve(target).toLowerCase(); } catch {}
      if (!linked) throw Error('插件独立会话目录尚未连接 Codex 登录。请运行 setup-codex-home.ps1 完成一次性设置。');
    }
  }
  for (const name of ['config.toml', '.env', 'AGENTS.md', 'models_cache.json']) {
    const from = path.join(source, name), to = path.join(home, name);
    if (fs.existsSync(from)) {
      const temporary = `${to}.${randomUUID()}.tmp`;
      fs.copyFileSync(from, temporary);
      fs.renameSync(temporary, to);
    }
    else if (fs.existsSync(to)) fs.unlinkSync(to);
  }
  for (const name of ['skills', 'plugins', 'rules']) {
    const from = path.join(source, name), to = path.join(home, name);
    if (fs.existsSync(from) && !fs.existsSync(to)) fs.symlinkSync(from, to, process.platform === 'win32' ? 'junction' : 'dir');
  }
}

function findRollout(root, id) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isFile() && entry.name.endsWith(`-${id}.jsonl`)) return file;
    if (entry.isDirectory()) { const found = findRollout(file, id); if (found) return found; }
  }
  return null;
}

function importThread(home, source, id) {
  if (!id) return;
  if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('无效 Codex 会话 ID。');
  if (findRollout(path.join(home, 'sessions'), id) || findRollout(path.join(home, 'archived_sessions'), id)) return;
  const from = findRollout(path.join(source, 'sessions'), id) || findRollout(path.join(source, 'archived_sessions'), id);
  if (!from) return; // Let Codex report its normal missing-thread error.
  const to = path.join(home, 'sessions', path.basename(from));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
}

module.exports = { prepareHome, importThread };
