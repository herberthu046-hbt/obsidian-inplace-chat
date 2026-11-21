'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { PortableStore } = require('../src/portable-store.cjs');
const S = require('../src/state.cjs');
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-revisions-'));
  return { root, file: path.join(root, 'state.json'), store: new PortableStore() };
}

test('migration preserves exact original, blocks old plugins, retains every committed change and skips no-ops', () => {
  const { file, store } = setup();
  const old = '{"version":2,"documents":{}}\r\n';
  fs.writeFileSync(file, old);
  assert.deepEqual(store.readJSON(file), { version: 2, documents: {} });
  store.writeJSON(file, { version: 2, documents: {} });
  assert.equal(fs.readFileSync(file + '.revisions/legacy', 'utf8'), old);
  assert.throws(() => S.migrateState(JSON.parse(fs.readFileSync(file, 'utf8'))));
  const marker = fs.readFileSync(file), first = fs.readFileSync(file + '.revisions/commits/0000000000000001.json');
  for (let n = 1; n <= 3; n++) store.writeJSON(file, { n, pending: ['keep'], job: 'unresolved', unread: ['keep'] });
  assert.equal(store.writeJSON(file, store.readJSON(file)), false);
  assert.equal(store.head(file).sequence, 4);
  assert.deepEqual(fs.readFileSync(file), marker);
  assert.deepEqual(fs.readFileSync(file + '.revisions/commits/0000000000000001.json'), first);
  assert.equal(new PortableStore().readJSON(file).job, 'unresolved');
});

test('an object written before a crash is not a commit; restart reads only the previous committed state', () => {
  const { file, store } = setup();
  store.writeJSON(file, { revision: 1 });
  const original = fs.linkSync;
  try {
    fs.linkSync = () => { throw Object.assign(Error('injected interruption before publication'), { code: 'EIO' }); };
    assert.throws(() => store.writeJSON(file, { revision: 2 }), { code: 'CHAT_STORE_PUBLISH_FAILED' });
  } finally { fs.linkSync = original; }
  assert.deepEqual(new PortableStore().readJSON(file), { revision: 1 });
  assert.equal(store.head(file).sequence, 1);
  assert.equal(fs.readdirSync(file + '.revisions/objects').length, 2);
  store.writeJSON(file, { revision: 2 });
  assert.equal(new PortableStore().readJSON(file).revision, 2);
});

test('crash after publication keeps the complete new revision and a stale writer cannot overwrite it', () => {
  const { file, store } = setup();
  store.writeJSON(file, { revision: 1 });
  const original = fs.fsyncSync; let calls = 0;
  try {
    fs.fsyncSync = fd => { if (++calls === 2) throw Error('injected interruption after publication'); return original(fd); };
    assert.throws(() => store.writeJSON(file, { revision: 2 }), /interruption/);
  } finally { fs.fsyncSync = original; }
  assert.equal(new PortableStore().readJSON(file).revision, 2);
  assert.throws(() => store.writeJSON(file, { revision: 3 }), { code: 'CHAT_STORE_CONFLICT' });
});

test('two writers fail closed on stale state and on a publication race', () => {
  const { file, store } = setup();
  store.writeJSON(file, { revision: 1 });
  const other = new PortableStore(); other.readJSON(file);
  store.writeJSON(file, { revision: 2 });
  assert.throws(() => other.writeJSON(file, { revision: 'stale' }), { code: 'CHAT_STORE_CONFLICT' });
  other.readJSON(file);
  const original = fs.linkSync; let raced = false;
  try {
    fs.linkSync = (...args) => {
      if (!raced) { raced = true; other.writeJSON(file, { revision: 'winner' }); }
      return original(...args);
    };
    assert.throws(() => store.writeJSON(file, { revision: 'loser' }), { code: 'CHAT_STORE_CONFLICT' });
  } finally { fs.linkSync = original; }
  assert.equal(new PortableStore().readJSON(file).revision, 'winner');
});

test('corrupted or missing committed data and missing manifests never fall back to an empty or older state', () => {
  for (const damage of ['truncate','checksum','gap','manifest']) {
    const { file, store } = setup(); store.writeJSON(file, { job: 'locked' }); store.writeJSON(file, { job: 'still-locked' });
    const latest = file + '.revisions/commits/0000000000000002.json';
    if (damage === 'truncate') fs.writeFileSync(latest, '{');
    if (damage === 'checksum') { const record = JSON.parse(fs.readFileSync(latest)); record.payload = '{}'; fs.writeFileSync(latest, JSON.stringify(record)); }
    if (damage === 'gap') fs.unlinkSync(file + '.revisions/commits/0000000000000001.json');
    if (damage === 'manifest') fs.unlinkSync(file);
    assert.throws(() => new PortableStore().readJSON(file, {}), /状态|版本|迁移/);
  }
});

test('migration replacement failure preserves original and refuses to load stale state', () => {
  const { file, store } = setup(); const old = '{"job":"keep"}\n'; fs.writeFileSync(file, old);
  const original = fs.renameSync;
  try {
    fs.renameSync = () => { throw Object.assign(Error('reader held'), { code: 'EPERM' }); };
    assert.throws(() => store.writeJSON(file, { job: 'keep' }), { code: 'CHAT_MIGRATION_BLOCKED' });
  } finally { fs.renameSync = original; }
  assert.equal(fs.readFileSync(file, 'utf8'), old);
  assert.throws(() => new PortableStore().readJSON(file), { code: 'CHAT_MIGRATION_PENDING' });
  store.writeJSON(file, { job: 'keep' }); // explicit same-value completion, never automatic old-state fallback
  assert.equal(store.readJSON(file).job, 'keep');
});

test('Windows readers can hold the manifest, committed revision and publication source throughout saving', { skip: process.platform !== 'win32' }, () => {
  const { root, file, store } = setup(); store.writeJSON(file, { revision: 0 });
  const module = path.resolve(__dirname, '../src/portable-store.cjs');
  const script = `import pathlib,subprocess,sys,json
root=pathlib.Path(sys.argv[1]); module=sys.argv[2]; target=root/'state.json'
held=[p.open('rb') for p in root.rglob('*') if p.is_file()]
try:
 subprocess.run(['node','-e',"const {PortableStore}=require(process.argv[1]);const s=new PortableStore(),f=process.argv[2];s.readJSON(f);for(let i=1;i<=25;i++)s.writeJSON(f,{revision:i});",module,str(target)],check=True)
 # Even a source object held without FILE_SHARE_DELETE can be published by hard link.
 src=root/'object';src.write_text('complete',encoding='utf8')
 with src.open('rb'):
  subprocess.run(['node','-e',"require('fs').linkSync(process.argv[1],process.argv[2]);",str(src),str(root/'commit')],check=True)
finally:
 for f in held:f.close()
print('held-readers-ok')`;
  assert.match(execFileSync('python', ['-c', script, root, module], { encoding: 'utf8' }), /held-readers-ok/);
  assert.equal(new PortableStore().readJSON(file).revision, 25);
});
