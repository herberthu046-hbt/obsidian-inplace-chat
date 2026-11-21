'use strict';
const { execFile } = require('node:child_process');
const path = require('node:path');

function run(executable, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { cwd, windowsHide: true, shell: false, encoding: 'buffer', timeout: 15000,
      maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout || Buffer.alloc(0);
          error.stderr = stderr || Buffer.alloc(0);
          reject(error);
        } else resolve(stdout || Buffer.alloc(0));
      });
  });
}

function fallback(reason, details = {}) { return { ok: false, reason, candidates: [], ...details }; }
function output(buffer) { return buffer.toString('utf8').replace(/[\r\n]+$/, ''); }
function isMissingExecutable(error) { return error?.code === 'ENOENT' || error?.code === 'UNKNOWN'; }
function isTimeout(error) { return Boolean(error?.killed) || error?.code === 'ETIMEDOUT'; }
function isNotRepository(error) { return /not a git repository/i.test(output(error?.stderr || Buffer.alloc(0))); }

function parseNameStatus(buffer, source) {
  const fields = buffer.toString('utf8').split('\0');
  if (fields.at(-1) === '') fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length;) {
    const code = fields[index++];
    if (!code) continue;
    const kind = code[0];
    if (kind === 'R' || kind === 'C') {
      const oldPath = fields[index++], currentPath = fields[index++];
      if (oldPath === undefined || currentPath === undefined) throw new Error('Malformed git --name-status -z output');
      changes.push({ path: currentPath, oldPath, status: kind === 'R' ? 'renamed' : 'added', sources: [source] });
      continue;
    }
    const currentPath = fields[index++];
    if (currentPath === undefined) throw new Error('Malformed git --name-status -z output');
    const status = kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified';
    changes.push({ path: currentPath, status, sources: [source] });
  }
  return changes;
}

function mergeChanges(groups) {
  const merged = new Map();
  const rank = { modified: 1, added: 2, renamed: 3, deleted: 4 };
  for (const change of groups.flat()) {
    const key = `${change.path}\0${change.oldPath || ''}`;
    const found = merged.get(key);
    if (!found) { merged.set(key, { ...change }); continue; }
    found.sources = [...new Set([...found.sources, ...change.sources])].sort();
    if ((rank[change.status] || 0) > (rank[found.status] || 0)) found.status = change.status;
  }
  return [...merged.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 :
    (a.oldPath || '') < (b.oldPath || '') ? -1 : (a.oldPath || '') > (b.oldPath || '') ? 1 : 0);
}

/**
 * Return Git candidates since a previously processed commit. This function is
 * deliberately read-only: it never checks out, stages, commits, or writes Git state.
 * Paths are relative to cwd and are only hints; callers must fully reconcile each file.
 */
async function scanChangedFiles({ cwd, baseline, executable = 'git' } = {}) {
  if (!cwd) throw new TypeError('cwd is required');
  let root;
  try { root = output(await run(executable, ['rev-parse', '--show-toplevel'], cwd)); }
  catch (error) {
    if (isMissingExecutable(error)) return fallback('git-unavailable');
    if (isTimeout(error)) return fallback('git-timeout');
    if (isNotRepository(error)) return fallback('not-repository');
    return fallback('git-error', { message: output(error.stderr) || error.message });
  }
  let head;
  try { head = output(await run(executable, ['rev-parse', '--verify', 'HEAD'], cwd)); }
  catch (error) {
    if (isTimeout(error)) return fallback('git-timeout', { root });
    if (error.code === 128 || /needed a single revision|unknown revision|ambiguous argument|bad revision/i.test(output(error.stderr))) {
      return fallback('no-history', { root });
    }
    return fallback('git-error', { root, message: output(error.stderr) || error.message });
  }
  if (typeof baseline !== 'string' || !baseline.trim()) return fallback('baseline-missing', { root, head });
  const normalizedBaseline = baseline.trim();
  // Baselines are values previously returned by this helper, never arbitrary refs
  // or option-like user input.
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(normalizedBaseline)) return fallback('baseline-missing', { root, head });
  try { await run(executable, ['cat-file', '-e', `${normalizedBaseline}^{commit}`], cwd); }
  catch (error) {
    if (isTimeout(error)) return fallback('git-timeout', { root, head });
    return fallback('baseline-missing', { root, head });
  }
  try { await run(executable, ['merge-base', '--is-ancestor', normalizedBaseline, head], cwd); }
  catch (error) {
    if (isTimeout(error)) return fallback('git-timeout', { root, head });
    if (error.code === 1) return fallback('history-rewritten', { root, head });
    return fallback('git-error', { root, head, message: output(error.stderr) || error.message });
  }

  try {
    const common = ['--name-status', '-z', '--find-renames', '--relative'];
    const [sinceBaseline, staged, unstaged, untracked] = await Promise.all([
      run(executable, ['diff', ...common, normalizedBaseline, '--', '.'], cwd),
      run(executable, ['diff', '--cached', ...common, '--', '.'], cwd),
      run(executable, ['diff', ...common, '--', '.'], cwd),
      run(executable, ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], cwd)
    ]);
    const newFiles = untracked.toString('utf8').split('\0').filter(Boolean)
      .map(file => ({ path: file, status: 'added', sources: ['untracked'] }));
    return {
      ok: true,
      root: path.resolve(root),
      baseline: normalizedBaseline,
      head,
      candidates: mergeChanges([
        parseNameStatus(sinceBaseline, 'baseline'),
        parseNameStatus(staged, 'staged'),
        parseNameStatus(unstaged, 'unstaged'),
        newFiles
      ])
    };
  } catch (error) {
    if (isTimeout(error)) return fallback('git-timeout', { root, head });
    return fallback('git-error', { root, head, message: output(error.stderr || Buffer.alloc(0)) || error.message });
  }
}

module.exports = { scanChangedFiles, parseNameStatus, mergeChanges };
