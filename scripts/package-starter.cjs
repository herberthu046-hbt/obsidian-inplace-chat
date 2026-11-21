'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { RELEASE_FILES, readDependencies, fetchDependencies } = require('./fetch-dependencies.cjs');

const sha256 = value => createHash('sha256').update(value).digest('hex');

function verifiedAsset(bytes, expected) {
  if (sha256(bytes) === expected) return bytes;
  // Obsidian may append this non-executable marker on installation. Accept only
  // this exact suffix, and only if removing it restores the pinned upstream hash.
  const suffix = Buffer.from('\n/* nosourcemap */');
  if (bytes.subarray(-suffix.length).equals(suffix)) {
    const original = bytes.subarray(0, -suffix.length);
    if (sha256(original) === expected) return original;
  }
  throw Error('Dependency checksum mismatch; refusing to package locally modified code.');
}

function buildStarter({ project, dependencyVault, dependencyDirectory, output }) {
  project = path.resolve(project); output = path.resolve(output);
  if (fs.existsSync(output)) throw Error('Output already exists; choose a new empty destination.');
  const lock = readDependencies(project);
  if (dependencyVault && dependencyDirectory) throw Error('Choose dependencyVault or dependencyDirectory, not both.');
  const dependencies = dependencyVault ? path.join(dependencyVault, '.obsidian/plugins')
    : dependencyDirectory || path.join(project, '.cache/starter-dependencies');
  const own = JSON.parse(fs.readFileSync(path.join(project, 'dist/manifest.json'), 'utf8'));
  const source = JSON.parse(fs.readFileSync(path.join(project, 'manifest.json'), 'utf8'));
  if (own.id !== 'inplace-chat' || own.version !== source.version) throw Error('Build is missing or stale.');
  const files = new Map();
  for (const name of RELEASE_FILES) files.set(`.obsidian/plugins/inplace-chat/${name}`, fs.readFileSync(path.join(project, 'dist', name)));
  for (const plugin of lock.plugins) {
    if (!['document-comments','local-pdf-annotator'].includes(plugin.id)) throw Error('Unexpected dependency.');
    const root = path.join(dependencies, plugin.id);
    for (const name of RELEASE_FILES) {
      const expected = plugin.files.find(item => item.name === name)?.sha256;
      if (!/^[a-f0-9]{64}$/.test(expected || '')) throw Error('Missing pinned checksum.');
      files.set(`.obsidian/plugins/${plugin.id}/${name}`, verifiedAsset(fs.readFileSync(path.join(root, name)), expected));
    }
    const manifest = JSON.parse(files.get(`.obsidian/plugins/${plugin.id}/manifest.json`).toString('utf8'));
    if (manifest.id !== plugin.id || manifest.version !== plugin.version) throw Error('Dependency manifest mismatch.');
    files.set(`licenses/${plugin.id}.txt`, fs.readFileSync(path.join(project, 'distribution/licenses', plugin.id + '.txt')));
  }
  if (lock.plugins.length !== 2 || new Set(lock.plugins.map(p => p.id)).size !== 2) throw Error('Expected both comment plugins exactly once.');
  const json = object => Buffer.from(JSON.stringify(object, null, 2) + '\n');
  files.set('.obsidian/community-plugins.json', json([...lock.plugins.map(p => p.id), own.id]));
  files.set('.obsidian/hotkeys.json', json({ 'document-comments:add-comment': [{ modifiers: ['Alt'], key: 'C' }] }));
  files.set('README.md', fs.readFileSync(path.join(project, 'distribution/STARTER-README.md')));
  files.set('.gitignore', fs.readFileSync(path.join(project, 'distribution/STARTER.gitignore')));
  files.set('.gitattributes', fs.readFileSync(path.join(project, 'distribution/STARTER.gitattributes')));
  files.set('LICENSE', fs.readFileSync(path.join(project, 'LICENSE')));
  files.set('scripts/setup-codex-home.ps1', fs.readFileSync(path.join(project, 'scripts/setup-codex-home.ps1')));
  files.set('THIRD-PARTY-NOTICES.md', fs.readFileSync(path.join(project, 'distribution/THIRD-PARTY-NOTICES.md')));
  const manifest = {
    format: 1, name: 'In-place Chat empty vault', version: own.version,
    permissions: { sandbox: 'danger-full-access', approvalPolicy: 'never' },
    dependencies: lock.plugins.map(({ id, version, release }) => ({ id, version, release })),
    files: [...files].map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: sha256(bytes) }))
  };
  files.set('release-manifest.json', json(manifest));
  // All inputs are validated before creating output. Never copy a whole vault,
  // plugin directory, settings, logs, receipts, histories, PDFs or user profiles.
  fs.mkdirSync(output, { recursive: true });
  for (const [name, bytes] of files) {
    const target = path.join(output, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
  verifyStarter(output);
  return { output, version: own.version, files: files.size };
}

function verifyStarter(output) {
  const manifest = JSON.parse(fs.readFileSync(path.join(output, 'release-manifest.json'), 'utf8'));
  const allowed = new Set(['release-manifest.json']);
  for (const item of manifest.files) {
    if (item.path.includes('..') || path.isAbsolute(item.path) || item.path.includes('\\') || allowed.has(item.path)) throw Error('Invalid manifest path.');
    allowed.add(item.path);
    const data = fs.readFileSync(path.join(output, item.path));
    if (data.length !== item.bytes || sha256(data) !== item.sha256) throw Error('Release file changed: ' + item.path);
  }
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw Error('Links are not allowed in a release.');
      if (entry.isDirectory()) walk(full);
      else if (!allowed.has(path.relative(output, full).split(path.sep).join('/'))) throw Error('Unexpected release file: ' + entry.name);
    }
  }
  walk(output);
  return { version: manifest.version, files: allowed.size };
}

if (require.main === module) {
  async function main() {
    const args = process.argv.slice(2), project = path.resolve(__dirname, '..');
    if (args.length === 2 && !args[0].startsWith('--')) return buildStarter({ project, dependencyVault: args[0], output: args[1] });
    const options = { project };
    let download = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--download') download = true;
      else if (['--dependencies', '--dependency-vault', '--output'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
        const key = { '--dependencies': 'dependencyDirectory', '--dependency-vault': 'dependencyVault', '--output': 'output' }[args[i]];
        options[key] = args[++i];
      } else throw Error('Unknown or incomplete option: ' + args[i]);
    }
    if (!options.output) throw Error('Usage: node scripts/package-starter.cjs [--download] [--dependencies <cache> | --dependency-vault <vault>] --output <new-directory>');
    if (download) {
      if (options.dependencyVault) throw Error('--download cannot be combined with --dependency-vault.');
      if (fs.existsSync(options.output)) throw Error('Output already exists; choose a new empty destination.');
      const result = await fetchDependencies({ project, output: options.dependencyDirectory });
      options.dependencyDirectory = result.output;
    }
    return buildStarter(options);
  }
  main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { buildStarter, verifyStarter, verifiedAsset };
