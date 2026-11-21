'use strict';

// Immutable, committed revisions. Publishing a new hard link needs no delete
// access to any file a Windows Git/Python reader may already have open.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const MARKER = { version: 3, $inplaceChatStore: 1 };
const hash = text => createHash('sha256').update(text).digest('hex');
const serial = n => String(n).padStart(16, '0') + '.json';
function failure(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}
function createDurable(file, text) {
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, text, 'utf8'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}
function marker(text) {
  try { const value = JSON.parse(text); return value?.$inplaceChatStore === 1 && value.version === 3; }
  catch { return false; }
}

class PortableStore {
  constructor() { this.observed = new Map(); }
  directory(file) { return file + '.revisions'; }

  head(file) {
    const directory = path.join(this.directory(file), 'commits');
    const names = fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
    if (!names.length) return null;
    if (names.some((name, i) => name !== serial(i + 1)))
      throw failure('CHAT_STORE_INVALID', `状态版本序列不完整：${file}；已停止，未回退旧状态。`);
    const raw = fs.readFileSync(path.join(directory, names.at(-1)), 'utf8');
    let record;
    try { record = JSON.parse(raw); }
    catch (cause) { throw failure('CHAT_STORE_INVALID', `状态版本损坏：${file}；已停止。`, cause); }
    const prior = names.length > 1 ? hash(fs.readFileSync(path.join(directory, names.at(-2)))) : null;
    if (record.format !== 1 || record.sequence !== names.length || typeof record.payload !== 'string' ||
        record.sha256 !== hash(record.payload) || record.previous !== prior)
      throw failure('CHAT_STORE_INVALID', `状态版本校验失败：${file}；已停止，未按空状态继续。`);
    return { sequence: record.sequence, hash: hash(raw), payload: record.payload };
  }

  readText(file, fallback) {
    const directory = this.directory(file);
    if (!fs.existsSync(file)) {
      if (fs.existsSync(directory)) throw failure('CHAT_MIGRATION_PENDING', `状态迁移尚未完成：${file}；不能按空状态继续。`);
      this.observed.set(file, null);
      return fallback;
    }
    const text = fs.readFileSync(file, 'utf8');
    if (!marker(text)) {
      if (fs.existsSync(directory)) throw failure('CHAT_MIGRATION_PENDING', `状态入口与版本目录不一致：${file}；已停止。`);
      this.observed.set(file, null);
      return text;
    }
    const head = this.head(file);
    if (!head) throw failure('CHAT_STORE_INVALID', `状态入口没有已提交版本：${file}；已停止。`);
    this.observed.set(file, head.hash);
    return head.payload;
  }

  readJSON(file, fallback) {
    const text = this.readText(file);
    if (text === undefined) return fallback;
    try { return JSON.parse(text); }
    catch (cause) { throw failure('CHAT_STORE_INVALID', `无法读取状态文件 ${file}；为避免重复发送，已停止。`, cause); }
  }

  publish(file, text, previous) {
    const directory = this.directory(file);
    const objects = path.join(directory, 'objects'), commits = path.join(directory, 'commits');
    fs.mkdirSync(objects, { recursive: true }); fs.mkdirSync(commits, { recursive: true });
    const sequence = (previous?.sequence || 0) + 1;
    const record = JSON.stringify({ format: 1, sequence, previous: previous?.hash || null,
      sha256: hash(text), payload: text }) + '\n';
    const digest = hash(record), object = path.join(objects, digest + '.json');
    if (fs.existsSync(object)) {
      if (hash(fs.readFileSync(object)) !== digest) throw failure('CHAT_STORE_INVALID', `未提交对象损坏，已保留现场：${object}`);
    } else createDurable(object, record);
    // The object is closed and flushed before publication. linkSync is atomic
    // and exclusive: two writers cannot both publish the same sequence number.
    const commit = path.join(commits, serial(sequence));
    try { fs.linkSync(object, commit); }
    catch (cause) {
      throw failure(cause.code === 'EEXIST' ? 'CHAT_STORE_CONFLICT' : 'CHAT_STORE_PUBLISH_FAILED',
        `无法提交状态版本（${cause.code}）：${file}；原版本保留，未覆盖或重试。`, cause);
    }
    // Windows FlushFileBuffers requires a writable handle, even when no bytes
    // are changed. Python/Git read handles allow writes but not replacement.
    const fd = fs.openSync(commit, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return { sequence, hash: digest, payload: text };
  }

  writeText(file, text) {
    if (typeof text !== 'string') throw new TypeError('Portable state must be text');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    const active = old !== undefined && marker(old);
    let head = this.head(file);
    if (active) {
      if (!head) throw failure('CHAT_STORE_INVALID', `状态入口没有已提交版本：${file}`);
      if (this.observed.has(file) && this.observed.get(file) !== head.hash)
        throw failure('CHAT_STORE_CONFLICT', `另一写入者更新了状态：${file}；请重新加载，未覆盖。`);
      if (text === head.payload) { this.observed.set(file, head.hash); return false; }
      head = this.publish(file, text, head);
    } else {
      // Migration is the only replacement of the old filename. It is performed
      // once, with an exact backup, and must finish before any model can run.
      const directory = this.directory(file), backup = path.join(directory, 'legacy');
      fs.mkdirSync(directory, { recursive: true });
      if (fs.existsSync(backup)) {
        if (old === undefined || fs.readFileSync(backup, 'utf8') !== old)
          throw failure('CHAT_MIGRATION_CONFLICT', `迁移期间原状态被修改：${file}；已停止。`);
      } else if (old !== undefined) createDurable(backup, old);
      if (head && head.payload !== text) throw failure('CHAT_MIGRATION_CONFLICT', `迁移版本与原状态不一致：${file}；已停止。`);
      if (!head) head = this.publish(file, text, null);
      const manifest = JSON.stringify(MARKER) + '\n';
      if (old === undefined) createDurable(file, manifest);
      else {
        const temporary = path.join(directory, 'manifest-' + randomUUID() + '.pending');
        createDurable(temporary, manifest);
        try { fs.renameSync(temporary, file); }
        catch (cause) { throw failure('CHAT_MIGRATION_BLOCKED', `旧状态入口正在被占用，迁移未完成：${file}；请待读取结束后重新加载。原件和版本均已保留。`, cause); }
      }
    }
    this.observed.set(file, head.hash);
    return true;
  }

  writeJSON(file, data) { return this.writeText(file, JSON.stringify(data, null, 2) + '\n'); }
}

module.exports = { PortableStore, hash };
