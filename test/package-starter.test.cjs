'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { buildStarter, verifyStarter, verifiedAsset } = require('../scripts/package-starter.cjs');
const { fetchDependencies } = require('../scripts/fetch-dependencies.cjs');
const sha = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-empty-vault-test-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const project = path.join(temp, 'project'), dependencyVault = path.join(temp, 'personal'), output = path.join(temp, 'starter');
  function put(relative, value) {
    const file = path.join(temp, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  }
  const own = { id: 'inplace-chat', version: '0.5.7' };
  put('project/manifest.json', own); put('project/dist/manifest.json', own);
  put('project/dist/main.js', 'own-code'); put('project/dist/styles.css', '.style {}');
  put('project/README.md', '# Development instructions, not for the starter');
  put('project/distribution/STARTER-README.md', '# 中文空白库使用说明');
  put('project/distribution/STARTER.gitignore', 'data.json\nworkspace*.json\n.inplace-chat/\n.pdf-annotator/\nauth.json\n.env\n*.log\n');
  put('project/distribution/STARTER.gitattributes', '* -text\n');
  put('project/LICENSE', 'fixture-own-license');
  put('project/scripts/setup-codex-home.ps1', '# Public first-run setup');
  put('project/distribution/THIRD-PARTY-NOTICES.md', '# Notices');
  const plugins = ['document-comments','local-pdf-annotator'].map(id => {
    const content = { 'main.js': id + '-code', 'manifest.json': JSON.stringify({ id, version: '1.0.0' }), 'styles.css': '.style {}' };
    for (const [name, value] of Object.entries(content)) put(`personal/.obsidian/plugins/${id}/${name}`, value + (name === 'main.js' ? '\n/* nosourcemap */' : ''));
    put(`project/distribution/licenses/${id}.txt`, 'fixture-license');
    return { id, version: '1.0.0', repo: `upstream/${id}`, release: `https://github.com/upstream/${id}/releases/tag/1.0.0`, files: Object.entries(content).map(([name, value]) => ({ name, sha256: sha(value) })) };
  });
  put('project/distribution/dependencies.json', { version: 1, plugins });
  put('personal/.obsidian/plugins/document-comments/data.json', 'PRIVATE SETTINGS');
  put('personal/.obsidian/plugins/inplace-chat/data.json', 'PRIVATE SESSION');
  put('personal/.inplace-chat/receipts/private.json', 'PRIVATE ANSWER');
  put('personal/.git/config', 'PRIVATE REMOTE');
  put('personal/paper.pdf', 'PRIVATE PDF');
  return { project, dependencyVault, output, put, temp };
}

test('starter packages only release allowlist, official dependency bytes and public docs', t => {
  const f = fixture(t);
  const result = buildStarter(f);
  assert.equal(result.files, 20);
  assert.deepEqual(verifyStarter(f.output), { version: '0.5.7', files: 20 });
  const manifest = JSON.parse(fs.readFileSync(path.join(f.output, 'release-manifest.json'), 'utf8'));
  assert.equal(manifest.permissions.sandbox, 'danger-full-access');
  assert.equal(manifest.permissions.approvalPolicy, 'never');
  const names = manifest.files.map(file => file.path);
  assert.ok(names.includes('.obsidian/community-plugins.json'));
  assert.ok(names.includes('.obsidian/hotkeys.json'));
  assert.ok(names.includes('README.md'));
  assert.ok(names.includes('.gitignore'));
  assert.ok(names.includes('.gitattributes'));
  assert.ok(names.includes('LICENSE'));
  assert.ok(names.includes('scripts/setup-codex-home.ps1'));
  assert.ok(!names.includes('scripts/setup-pdf-reader.cjs'));
  assert.equal(fs.readFileSync(path.join(f.output, '.gitignore'), 'utf8'), fs.readFileSync(path.join(f.project, 'distribution/STARTER.gitignore'), 'utf8'));
  assert.equal(fs.readFileSync(path.join(f.output, '.gitattributes'), 'utf8'), '* -text\n');
  assert.equal(fs.readFileSync(path.join(f.output, 'README.md'), 'utf8'), '# 中文空白库使用说明');
  assert.ok(names.every(name => !/data\.json|workspace|receipts|diagnostics|\.git\/|\.pdf$/.test(name)));
  for (const item of manifest.files) {
    const bytes = fs.readFileSync(path.join(f.output, item.path));
    assert.equal(sha(bytes), item.sha256);
    assert.ok(!bytes.includes(Buffer.from('PRIVATE')));
  }
  assert.equal(fs.readFileSync(path.join(f.output, '.obsidian/plugins/document-comments/main.js'), 'utf8'), 'document-comments-code');
  assert.ok(fs.readFileSync(path.join(f.dependencyVault, '.obsidian/plugins/document-comments/main.js'), 'utf8').endsWith('/* nosourcemap */'));
});

test('starter refuses changed dependencies before creating any output', t => {
  const f = fixture(t);
  f.put('personal/.obsidian/plugins/document-comments/main.js', 'modified');
  assert.throws(() => buildStarter(f), /checksum mismatch/);
  assert.equal(fs.existsSync(f.output), false);
});

test('starter never overwrites existing output and detects unexpected or altered files', t => {
  const f = fixture(t); buildStarter(f);
  assert.throws(() => buildStarter(f), /already exists/);
  f.put('starter/private.txt', 'PRIVATE');
  assert.throws(() => verifyStarter(f.output), /Unexpected release file/);
  fs.unlinkSync(path.join(f.output, 'private.txt'));
  f.put('starter/README.md', 'modified instructions');
  assert.throws(() => verifyStarter(f.output), /Release file changed/);
});

test('source and built versions must match; marker removal cannot conceal modified code', t => {
  const f = fixture(t);
  f.put('project/dist/manifest.json', { id: 'inplace-chat', version: '0.0.1' });
  assert.throws(() => buildStarter(f), /stale/);
  assert.equal(fs.existsSync(f.output), false);
  assert.throws(() => verifiedAsset(Buffer.from('bad\n/* nosourcemap */'), sha('good')), /checksum mismatch/);
});

test('fixed public release downloads build the same starter without a personal vault', async t => {
  const f = fixture(t), cache = path.join(f.temp, 'downloads'), urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    const match = /^https:\/\/github\.com\/upstream\/([^/]+)\/releases\/download\/1\.0\.0\/([^/]+)$/.exec(url);
    assert.ok(match, 'uses a fixed official release asset URL');
    const installed = fs.readFileSync(path.join(f.dependencyVault, '.obsidian/plugins', match[1], match[2]));
    const bytes = verifiedAsset(installed, JSON.parse(fs.readFileSync(path.join(f.project, 'distribution/dependencies.json'))).plugins.find(p => p.id === match[1]).files.find(a => a.name === match[2]).sha256);
    return { ok: true, arrayBuffer: async () => bytes };
  };
  assert.equal((await fetchDependencies({ project: f.project, output: cache, fetchImpl })).files, 6);
  assert.equal(urls.length, 6);
  await fetchDependencies({ project: f.project, output: cache, fetchImpl: () => { throw Error('offline cache must not download'); } });
  const downloadedOutput = path.join(f.temp, 'downloaded-starter');
  buildStarter({ project: f.project, dependencyDirectory: cache, output: downloadedOutput });
  buildStarter(f);
  assert.deepEqual(fs.readFileSync(path.join(downloadedOutput, 'release-manifest.json')), fs.readFileSync(path.join(f.output, 'release-manifest.json')));
  const result = verifyStarter(downloadedOutput);
  assert.equal(result.files, 20);
});

test('downloads reject modified assets, failed responses and changed cached code', async t => {
  const f = fixture(t), output = path.join(f.temp, 'cache');
  await assert.rejects(fetchDependencies({ project: f.project, output, fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('modified') }) }), /checksum mismatch/);
  assert.equal(fs.existsSync(output), false);
  await assert.rejects(fetchDependencies({ project: f.project, output, fetchImpl: async () => ({ ok: false, status: 404 }) }), /download failed \(404\)/);
  f.put('cache/document-comments/main.js', 'modified-cache');
  await assert.rejects(fetchDependencies({ project: f.project, output, fetchImpl: () => { throw Error('must validate existing cache first'); } }), /checksum mismatch/);
});

test('dependency lock must pin exactly the official file names and a matching fixed release', t => {
  const f = fixture(t);
  const lock = JSON.parse(fs.readFileSync(path.join(f.project, 'distribution/dependencies.json')));
  lock.plugins[0].release = 'https://github.com/upstream/document-comments/releases/latest';
  f.put('project/distribution/dependencies.json', lock);
  assert.throws(() => buildStarter(f), /fixed upstream release/);
  lock.plugins[0].release = 'https://github.com/upstream/document-comments/releases/tag/1.0.0';
  lock.plugins[0].files[0].name = '../private';
  f.put('project/distribution/dependencies.json', lock);
  assert.throws(() => buildStarter(f), /pinned checksum/);
  assert.equal(fs.existsSync(f.output), false);
});
