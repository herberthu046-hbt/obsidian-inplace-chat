'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_FIELDS = [
  'totalTokens',
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens'
];
const STRING_FIELDS = new Map([
  ['id', 256], ['actionId', 256], ['jobId', 256], ['attemptId', 256],
  ['documentId', 256], ['threadId', 256], ['turnId', 256],
  ['source', 128], ['stage', 128], ['status', 128], ['reason', 2000],
  ['provider', 128], ['accountScopeKey', 256], ['model', 128], ['effort', 64],
  ['version', 64], ['promptTemplateVersion', 64], ['fingerprint', 256], ['errorCode', 128],
  ['key', 64], ['code', 64], ['modifiers', 64], ['scope', 128]
]);
const BOOLEAN_FIELDS = ['called', 'accepted', 'ambiguous', 'defaultPrevented', 'repeat', 'isComposing'];
const NUMBER_FIELDS = ['elapsedMs'];

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function redact(value, maxLength) {
  let text = String(value);
  text = text.replace(/\b[A-Z]:[\\/][^\s"'`]+/gi, '[path]');
  text = text.replace(/(^|[\s(])\/(?:[^\s"'`)]+\/?)+/g, '$1[path]');
  text = text.replace(/(^|[\s("'`])(?:\.{0,2}[\\/])?[^\s"'`<>]*[\\/][^\s"'`<>]+/g, '$1[path]');
  text = text.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]');
  text = text.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]');
  text = text.replace(/\b(?:sk|sess|token)[-_][A-Za-z0-9_-]{12,}\b/gi, '[redacted]');
  return text.slice(0, maxLength);
}

function sanitizeCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) continue;
    const number = finiteNumber(raw);
    if (number !== undefined) result[key] = number;
  }
  return Object.keys(result).length ? result : undefined;
}

function tokenValues(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  for (const field of TOKEN_FIELDS) {
    const number = finiteNumber(value[field]);
    if (number !== undefined) result[field] = number;
  }
  return Object.keys(result).length ? result : null;
}

function sanitizeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  const flat = tokenValues(value);
  if (flat) Object.assign(result, flat);
  const total = tokenValues(value.total);
  const last = tokenValues(value.last);
  if (total) result.total = total;
  if (last) result.last = last;
  const context = finiteNumber(value.modelContextWindow);
  if (context !== undefined) result.modelContextWindow = context;
  return Object.keys(result).length ? result : undefined;
}

function sanitizeEvent(event, now) {
  const input = event && typeof event === 'object' && !Array.isArray(event) ? event : {};
  const result = { schemaVersion: 1, at: new Date(now).toISOString() };
  for (const [field, maxLength] of STRING_FIELDS) {
    if (typeof input[field] === 'string' || typeof input[field] === 'number') result[field] = redact(input[field], maxLength);
  }
  for (const field of BOOLEAN_FIELDS) if (typeof input[field] === 'boolean') result[field] = input[field];
  for (const field of NUMBER_FIELDS) {
    const number = finiteNumber(input[field]);
    if (number !== undefined) result[field] = number;
  }
  const counts = sanitizeCounts(input.counts);
  if (counts) result.counts = counts;
  const usage = sanitizeUsage(input.usage);
  if (usage) result.usage = usage;
  return result;
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : Date.now();
  const number = value instanceof Date ? value.getTime() : Number(value);
  return Number.isFinite(number) ? number : Date.now();
}

class DiagnosticStore {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.maxBytes = Math.max(1024, Number(options.maxBytes) || 10 * 1024 * 1024);
    this.maxFiles = Math.max(1, Math.floor(Number(options.maxFiles) || 32));
    this.now = typeof options.now === 'function' ? options.now : Date.now;
    this.retentionMs = 7 * DAY_MS;
    this.flushBytes = Math.min(64 * 1024, Math.max(1024, Math.floor(this.maxBytes / 8)));
    this.segmentBytes = Math.max(1024, Math.floor(this.maxBytes / Math.min(this.maxFiles, 16)));
    this.buffer = [];
    this.bufferBytes = 0;
    this.error = null;
    this.droppedEvents = 0;
    this.closed = false;
  }

  record(event) {
    if (this.closed) {
      this.error = new Error('DiagnosticStore is closed.');
      return null;
    }
    try {
      const value = sanitizeEvent(event, timestamp(this.now));
      const line = JSON.stringify(value) + '\n';
      this.buffer.push({ value, line, bytes: Buffer.byteLength(line) });
      this.bufferBytes += this.buffer.at(-1).bytes;
      if (this.buffer.length >= 64 || this.bufferBytes >= this.flushBytes) this.flush();
      if (this.bufferBytes > this.flushBytes * 4) this.dropOldestBuffered();
      return value;
    } catch (error) {
      this.error = error;
      return null;
    }
  }

  dropOldestBuffered() {
    while (this.buffer.length > 1 && this.bufferBytes > this.flushBytes * 4) {
      this.bufferBytes -= this.buffer.shift().bytes;
      this.droppedEvents++;
    }
  }

  files() {
    if (!fs.existsSync(this.directory)) return [];
    return fs.readdirSync(this.directory)
      .filter(name => /^diagnostics-\d{4}-\d{2}-\d{2}-\d{4}\.jsonl$/.test(name))
      .map(name => {
        const filename = path.join(this.directory, name);
        const stat = fs.statSync(filename);
        return { name, filename, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  nextFile(bytes) {
    const day = new Date(timestamp(this.now)).toISOString().slice(0, 10);
    const matches = this.files().filter(file => file.name.startsWith(`diagnostics-${day}-`));
    const last = matches.at(-1);
    if (last && last.size + bytes <= this.segmentBytes) return last.filename;
    const sequence = last ? Number(/-(\d{4})\.jsonl$/.exec(last.name)?.[1]) + 1 : 1;
    return path.join(this.directory, `diagnostics-${day}-${String(sequence).padStart(4, '0')}.jsonl`);
  }

  flush() {
    if (!this.buffer.length) {
      this.pruneSafely();
      return;
    }
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      // Keep device-local operation traces out of ordinary vault Git history.
      const ignoreFile = path.join(this.directory, '.gitignore');
      if (!fs.existsSync(ignoreFile)) fs.writeFileSync(ignoreFile, '*\n', { encoding: 'utf8', flag: 'wx' });
      while (this.buffer.length) {
        const group = [];
        let bytes = 0;
        while (this.buffer.length && (!group.length || bytes + this.buffer[0].bytes <= this.segmentBytes)) {
          const item = this.buffer.shift();
          group.push(item);
          bytes += item.bytes;
          this.bufferBytes -= item.bytes;
        }
        const filename = this.nextFile(bytes);
        try {
          fs.appendFileSync(filename, group.map(item => item.line).join(''), 'utf8');
        } catch (error) {
          this.buffer.unshift(...group);
          this.bufferBytes += bytes;
          throw error;
        }
      }
      this.error = null;
    } catch (error) {
      this.error = error;
      this.dropOldestBuffered();
      return;
    }
    this.pruneSafely();
  }

  pruneSafely() {
    try {
      const cutoff = timestamp(this.now) - this.retentionMs;
      let files = this.files();
      for (const file of files.filter(item => item.mtimeMs < cutoff)) fs.unlinkSync(file.filename);
      files = this.files();
      let total = files.reduce((sum, file) => sum + file.size, 0);
      while (files.length > 1 && (files.length > this.maxFiles || total > this.maxBytes)) {
        const oldest = files.shift();
        fs.unlinkSync(oldest.filename);
        total -= oldest.size;
      }
    } catch (error) {
      this.error = error;
    }
  }

  readRecent(limit = 100) {
    const count = Math.max(0, Math.floor(Number(limit) || 0));
    if (!count) return [];
    this.flush();
    const values = [];
    try {
      for (const file of this.files()) {
        for (const line of fs.readFileSync(file.filename, 'utf8').split(/\r?\n/)) {
          if (!line) continue;
          try { values.push(JSON.parse(line)); } catch { /* a partial final line does not hide older events */ }
        }
      }
    } catch (error) {
      this.error = error;
    }
    for (const item of this.buffer) values.push(item.value);
    return values.slice(-count);
  }

  close() {
    this.flush();
    this.closed = true;
  }
}

function receiptTime(job, index) {
  for (const value of [job?.updatedAt, job?.replyAt, job?.createdAt]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return index;
}

function scopeFor(job) {
  return {
    provider: redact(job?.threadScope?.modelProvider || job?.provider?.modelProvider || 'codex', 128),
    accountScopeKey: redact(job?.accountScope?.key || job?.threadScope?.accountScopeKey || 'unknown', 256),
    accountScopeStable: Boolean(job?.accountScope?.stable ?? job?.threadScope?.accountScopeStable)
  };
}

function usageFor(job) {
  const result = job?.result && typeof job.result === 'object' ? job.result : {};
  const aggregate = result.aggregateUsage || job?.aggregateUsage;
  const raw = result.usage || job?.usage;
  const aggregateTokens = tokenValues(aggregate?.total || aggregate);
  const last = tokenValues(raw?.last);
  const total = tokenValues(raw?.total);
  const flat = tokenValues(raw);
  const sample = aggregateTokens || last || flat;
  const source = aggregateTokens
    ? (result.aggregateUsage ? 'result.aggregateUsage' : 'job.aggregateUsage')
    : last ? (result.usage ? 'result.usage.last' : 'job.usage.last')
      : flat ? (result.usage ? 'result.usage' : 'job.usage') : null;
  const kind = aggregateTokens ? 'cumulative-delta-sample' : sample ? 'last-sample-only' : 'unknown';
  const reportedCompleteness = result.usageCompleteness || job?.usageCompleteness;
  const unknownFields = TOKEN_FIELDS.filter(field => sample?.[field] === undefined);
  return {
    sample,
    total,
    source,
    kind,
    completeness: typeof reportedCompleteness === 'string'
      ? redact(reportedCompleteness, 64)
      : !sample ? 'unknown' : aggregateTokens ? 'cumulative-delta-sample'
        : unknownFields.length ? 'last-sample-only-partial' : 'last-sample-only',
    unknownFields,
    note: kind === 'last-sample-only'
      ? 'Latest reported last sample; not guaranteed to represent every engine request in the turn.'
      : kind === 'cumulative-delta-sample'
        ? 'Delta between known cumulative baselines; still a sample and not guaranteed final.'
        : 'No usage was reported; unknown is not zero.'
  };
}

function mergeTokenSums(target, sample) {
  for (const field of TOKEN_FIELDS) if (sample?.[field] !== undefined) target[field] = (target[field] || 0) + sample[field];
}

function summarizeReceipts(jobs) {
  const input = Array.isArray(jobs) ? jobs : [];
  const groups = new Map();
  input.forEach((job, index) => {
    if (!job || typeof job !== 'object') return;
    const scope = scopeFor(job);
    const threadId = typeof job.threadId === 'string' ? job.threadId : 'unknown';
    const turnId = typeof (job.turnId || job.result?.turnId) === 'string' ? (job.turnId || job.result.turnId) : `job:${job.id || index}`;
    const key = [scope.provider, scope.accountScopeKey, threadId, turnId].join('\u0000');
    const candidate = { job, index, at: receiptTime(job, index), usage: usageFor(job), scope, threadId, turnId };
    const group = groups.get(key) || { key, candidates: [], jobIds: new Set(), statuses: new Set() };
    group.candidates.push(candidate);
    if (job.id) group.jobIds.add(String(job.id));
    if (job.status) group.statuses.add(String(job.status));
    groups.set(key, group);
  });

  const rows = [];
  for (const group of groups.values()) {
    group.candidates.sort((a, b) => a.at - b.at || a.index - b.index);
    const withUsage = group.candidates.filter(item => item.usage.kind !== 'unknown');
    const chosen = withUsage.at(-1) || group.candidates.at(-1);
    const job = chosen.job;
    rows.push({
      key: group.key,
      jobId: job.id || null,
      jobIds: [...group.jobIds],
      statuses: [...group.statuses],
      provider: chosen.scope.provider,
      accountScopeKey: chosen.scope.accountScopeKey,
      accountScopeStable: chosen.scope.accountScopeStable,
      threadId: chosen.threadId === 'unknown' ? null : chosen.threadId,
      turnId: chosen.turnId.startsWith('job:') ? null : chosen.turnId,
      model: job.result?.model || job.provider?.model || job.threadScope?.model || null,
      effort: job.provider?.effort || null,
      usage: chosen.usage,
      status: job.status || null,
      at: Number.isFinite(chosen.at) ? new Date(chosen.at).toISOString() : null
    });
  }
  rows.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.key.localeCompare(b.key));

  const sampleSums = {};
  const unknownByField = Object.fromEntries(TOKEN_FIELDS.map(field => [field, 0]));
  let withSample = 0, missingUsage = 0, partialUsage = 0;
  for (const row of rows) {
    if (row.usage.sample) {
      withSample++;
      mergeTokenSums(sampleSums, row.usage.sample);
      if (row.usage.unknownFields.length) partialUsage++;
    } else missingUsage++;
    for (const field of row.usage.unknownFields) unknownByField[field]++;
  }

  const latestTotals = new Map();
  for (const row of rows) {
    if (!row.usage.total || !row.threadId) continue;
    const key = [row.provider, row.accountScopeKey, row.threadId].join('\u0000');
    latestTotals.set(key, {
      provider: row.provider,
      accountScopeKey: row.accountScopeKey,
      threadId: row.threadId,
      at: row.at,
      tokens: row.usage.total,
      note: 'Latest cumulative thread snapshot; snapshots are not added together.'
    });
  }

  return {
    version: 1,
    scope: 'inplace-chat receipts only',
    rows,
    latestThreadTotals: [...latestTotals.values()],
    summary: {
      receiptCount: input.filter(item => item && typeof item === 'object').length,
      deduplicatedRows: rows.length,
      withSample,
      partialUsage,
      missingUsage,
      unknownByField,
      sampleSums,
      sampleSumsKind: 'sum-of-reported-samples-not-guaranteed-turn-aggregate',
      note: 'Cumulative total snapshots are never summed. Missing usage is unknown, not zero.'
    }
  };
}

module.exports = {
  DiagnosticStore,
  TOKEN_FIELDS,
  sanitizeEvent,
  summarizeReceipts
};
