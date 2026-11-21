'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const RELEASE_FILES = ['main.js', 'manifest.json', 'styles.css'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const execFileAsync = promisify(execFile);

async function downloadAsset(url, fetchImpl) {
  // Node 22.13+ fetch does not consistently honor proxy environment variables.
  // The system curl does, and redirects still start at the pinned GitHub URL.
  if (!fetchImpl && Object.keys(process.env).some(name => /^(https?|all)_proxy$/i.test(name) && process.env[name])) {
    const result = await execFileAsync(process.platform === 'win32' ? 'curl.exe' : 'curl', [
      '--fail', '--location', '--silent', '--show-error',
      '--user-agent', 'obsidian-inplace-chat-release-builder', url
    ], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    return result.stdout;
  }
  const response = await (fetchImpl || fetch)(url, { headers: { 'User-Agent': 'obsidian-inplace-chat-release-builder' } });
  if (!response.ok) throw Error(`Dependency download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function readDependencies(project) {
  const lock = JSON.parse(fs.readFileSync(path.join(project, 'distribution/dependencies.json'), 'utf8'));
  if (lock.version !== 1 || lock.plugins?.length !== 2 ||
      new Set(lock.plugins.map(plugin => plugin.id)).size !== 2) throw Error('Expected both comment plugins exactly once.');
  for (const plugin of lock.plugins) {
    if (!['document-comments', 'local-pdf-annotator'].includes(plugin.id)) throw Error('Unexpected dependency.');
    const release = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/releases\/tag\/([^/?#]+)$/.exec(plugin.release);
    if (!release || release[1] !== plugin.repo || decodeURIComponent(release[2]) !== plugin.version) throw Error('Expected a fixed upstream release URL.');
    if (plugin.files?.length !== RELEASE_FILES.length || new Set(plugin.files.map(file => file.name)).size !== RELEASE_FILES.length ||
        plugin.files.some(file => !RELEASE_FILES.includes(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256))) throw Error('Missing pinned checksum.');
  }
  return lock;
}

async function fetchDependencies({ project = path.resolve(__dirname, '..'), output = path.join(project, '.cache/starter-dependencies'), fetchImpl } = {}) {
  project = path.resolve(project); output = path.resolve(output);
  const lock = readDependencies(project), files = new Map();
  for (const plugin of lock.plugins) {
    for (const asset of plugin.files) {
      const relative = `${plugin.id}/${asset.name}`, destination = path.join(output, relative);
      let bytes;
      if (fs.existsSync(destination)) bytes = fs.readFileSync(destination);
      else {
        const url = plugin.release.replace('/releases/tag/', '/releases/download/') + '/' + asset.name;
        bytes = await downloadAsset(url, fetchImpl);
      }
      if (sha256(bytes) !== asset.sha256) throw Error('Dependency checksum mismatch: ' + relative);
      files.set(relative, bytes);
    }
    const manifest = JSON.parse(files.get(`${plugin.id}/manifest.json`).toString('utf8'));
    if (manifest.id !== plugin.id || manifest.version !== plugin.version) throw Error('Dependency manifest mismatch.');
  }
  // Validate every asset before creating or extending the download cache.
  for (const [relative, bytes] of files) {
    const destination = path.join(output, relative);
    if (fs.existsSync(destination)) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
  }
  return { output, plugins: lock.plugins.map(({ id, version }) => ({ id, version })), files: files.size };
}

if (require.main === module) {
  fetchDependencies({ output: process.argv[2] }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
module.exports = { RELEASE_FILES, readDependencies, fetchDependencies };
