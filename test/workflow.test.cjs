'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const C = require('../src/comments.cjs');
const S = require('../src/state.cjs');
const gitAdapter = require('../src/git.cjs');
const { DiagnosticStore, summarizeReceipts } = require('../src/diagnostics.cjs');
const { ChatFiles } = require('../src/chat-files.cjs');
const ChatDocument = require('../src/chat-document.cjs');

class TFile { constructor(name) { this.path = name; this.extension = 'md'; } }
class MarkdownView {}
class Notice { constructor(message) { this.message = message; } }
const filename = path.resolve(__dirname, '../src/main.cjs');
const moduleUnderTest = new Module(filename, module);
moduleUnderTest.paths = Module._nodeModulePaths(path.dirname(filename));
moduleUnderTest.filename = filename;
const originalRequire = moduleUnderTest.require.bind(moduleUnderTest);
moduleUnderTest.require = name => name === 'obsidian' ? {
  Plugin: class {}, PluginSettingTab: class {}, Setting: class {}, Notice, Modal: class {}, TFile, MarkdownView,
  setIcon: (element, icon) => { element.icon = icon; }
} : name === './reader.cjs' ? { registerCommentReader() {} } : name === './pdf-ui.cjs' ? { PdfUi: class {} } : originalRequire(name);
moduleUnderTest._compile(fs.readFileSync(filename, 'utf8'), filename);
const Plugin = moduleUnderTest.exports;

const block = (id, quote, entry) => `<!--c:${id}-->${quote}<!--/c:${id}-->\n<!--co:${id} by:me status:open\n${entry}\n-->\n`;
const baseOne = block('aa', '局部正文', 'me (one): 问题');

test('mark read synchronizes a source and its unopened chat, preserving other discussions', async () => {
  const p = new Plugin();
  const makeDoc = (id, threads) => ({ ...S.createDocument(id), unread: Object.fromEntries(threads.map(t => [t, { threadId: t, messageId: t }])) });
  p.state = { documents: { 'source.pdf': makeDoc('source', ['aa','bb']), 'chat-a.md': makeDoc('chat-a', ['aa']), 'chat-b.md': makeDoc('chat-b', ['bb']), 'other.md': makeDoc('other', ['aa']) } };
  p.cache = new Map(Object.entries(p.state.documents).map(([name, doc]) => [name, { unread: S.unread(doc) }]));
  const bindings = { 'chat-a.md': { documentId: 'source', commentId: 'aa' }, 'chat-b.md': { documentId: 'source', commentId: 'bb' } };
  p.chatFiles = { meta: file => bindings[file.path] };
  p.app = { vault: { getMarkdownFiles: () => Object.keys(bindings).map(path => ({ path })) }, workspace: {} };
  let saves = 0;
  p.saveState = () => { saves++; }; p.decorate = () => {};
  await p.markRead('source.pdf', 'aa');
  assert.equal(S.unread(p.state.documents['chat-a.md']).length, 0);
  assert.deepEqual(S.unread(p.state.documents['source.pdf']).map(x => x.threadId), ['bb']);
  assert.equal(S.unread(p.state.documents['chat-b.md']).length, 1);
  assert.equal(S.unread(p.state.documents['other.md']).length, 1);
  await p.markRead('chat-b.md');
  assert.equal(S.unread(p.state.documents['source.pdf']).length, 0);
  assert.equal(S.unread(p.state.documents['chat-b.md']).length, 0);
  assert.equal(saves, 2);
  await p.markRead('chat-b.md');
  assert.equal(saves, 2);
});

test('mark all read preserves pending questions and jobs, and later replies become unread', async () => {
  const p = new Plugin();
  const first = S.reconcile(S.createDocument('one'), baseOne, { mode: 'import' });
  const replied = baseOne.replace('\n-->','\nchat (reply-one): 回答\n-->');
  const doc = S.reconcile(first.document, replied, { mode: 'observe' }).document;
  doc.job = { id: 'still-running' };
  p.state = { documents: { 'a.md': doc } };
  p.cache = new Map([['a.md', { unread: S.unread(doc) }]]);
  p.ready = Promise.resolve(); p.app = { workspace: {} }; p.decorate = () => {};
  let saves = 0; p.saveState = () => { saves++; };
  const before = JSON.parse(JSON.stringify(doc));
  await p.markAllRead();
  assert.equal(S.unread(p.state.documents['a.md']).length, 0);
  assert.deepEqual(p.state.documents['a.md'], { ...before, unread: {} });
  assert.equal(p.cache.get('a.md').unread.length, 0);
  await p.markAllRead(); assert.equal(saves, 1);
  const later = S.reconcile(p.state.documents['a.md'], replied.replace('\n-->','\nchat (reply-two): 新回答\n-->'), { mode: 'observe' });
  assert.equal(later.unread.length, 1);
});

function setup(initial = baseOne) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inplace-chat-workflow-'));
  const file = new TFile('article.md');
  let content = initial;
  let calls = 0;
  const prompts = [];
  const provider = {
    __ipcKey: 'mock',
    close() {},
    getAccountScope: async () => ({ key: 'account-one', type: 'chatgpt', label: 'masked', stable: true }),
    getThreadScope: () => ({ accountScopeKey: 'account-one', accountScopeStable: true, model: 'gpt-test', modelProvider: 'openai' }),
    thread: async (id, _name, expected) => {
      if (id && expected?.accountScopeKey && expected.accountScopeKey !== 'account-one') throw new Error('scope mismatch');
      return id || 'thread-one';
    },
    answer: async (_id, prompt, onStarted) => {
      calls++;
      prompts.push(prompt);
      await onStarted(`turn-${calls}`);
      const data = JSON.parse(prompt.slice(prompt.indexOf('{')));
      return { text: JSON.stringify({ replies: data.requests.map(r => ({ commentId: r.commentId, text: `回答-${r.commentId}` })) }), turnId: `turn-${calls}`, model: 'gpt-test' };
    }
  };
  const p = new Plugin();
  const imported = S.reconcile(S.createDocument('doc-one'), content, { mode: 'import' });
  Object.assign(p, {
    root,
    storage: path.join(root, '.inplace-chat'),
    stateFile: path.join(root, '.inplace-chat', 'state.json'),
    state: { version: S.VERSION, documents: { [file.path]: imported.document } },
    cache: new Map([[file.path, { comments: imported.comments, pending: imported.pending, unread: imported.unread, ambiguities: [], diagnostics: [] }]]),
    sessions: {}, git: {}, settings: { executable: 'codex', model: 'gpt-test', effort: 'high', maxContextChars: 16000, contextRadius: 30 },
    localSave: Promise.resolve(), busyFiles: new Set(), timers: new Map(), providers: new Map(), providerUsers: new Map(), ready: Promise.resolve(),
    getProvider: () => provider,
    saveData: async value => { p.lastSaved = value; },
    decorate: () => {}, scheduleDecorate: () => {},
    app: {
      vault: {
        getName: () => 'test',
        getAbstractFileByPath: name => name === file.path ? file : null,
        getMarkdownFiles: () => [file],
        read: async () => content,
        process: async (_file, callback) => { content = callback(content); }
      },
      workspace: { getLeavesOfType: () => [] },
      plugins: { plugins: {} }
    }
  });
  p.saveState();
  return {
    p, file, provider, prompts,
    get content() { return content; }, set content(value) { content = value; },
    get calls() { return calls; }
  };
}

function withChatFiles(s) {
  const vault=s.p.app.vault;
  const files=new Map([[s.file.path,s.file]]);
  const read=vault.read, process=vault.process;
  vault.getMarkdownFiles=()=>[...files.values()].filter(file=>file.extension==='md');
  vault.getAbstractFileByPath=name=>files.get(name)||null;
  vault.createFolder=async name=>{fs.mkdirSync(path.join(s.p.root,name),{recursive:true});const folder={path:name,children:[]};files.set(name,folder);return folder;};
  vault.create=async (name,text)=>{const file=new TFile(name);files.set(name,file);fs.writeFileSync(path.join(s.p.root,name),text);return file;};
  vault.read=async file=>file===s.file ? read(file) : fs.readFileSync(path.join(s.p.root,file.path),'utf8');
  vault.process=async (file,callback)=>file===s.file ? process(file,callback) : fs.writeFileSync(path.join(s.p.root,file.path),callback(await vault.read(file)));
  s.p.chatFiles=new ChatFiles(s.p);
  return s.p.chatFiles;
}

test('standalone Markdown chat reuses the original session, carries reference delta, and leaves source history unchanged',async()=>{
 const s=setup(block('aa','选文','me (one): @chat 原问题\nchat (two): 原回答'));
 const chats=withChatFiles(s), original=s.content;
 s.p.sessions['doc-one']={threadId:'existing-thread'};
 const file=await chats.ensure(s.file,'aa');
 assert.equal(file.path,'chat/article - chat - aa.md');
 assert.equal(await chats.ensure(s.file,'aa'),file);
 assert.equal(s.calls,0);
 assert.equal(S.pending(s.p.state.documents[file.path]).length,0);
 await s.p.app.vault.process(file,raw=>raw+'\n<!--c:ref1-->原回答<!--/c:ref1-->\n<!--co:ref1\nme (ref): 请解释这里\n-->\n');
 assert.equal(await chats.submit(file,'这里是什么意思'),true);
 assert.equal(s.calls,1);assert.equal(s.content,original);
 const job=s.p.readUsageReceipts().jobs[0];
 assert.equal(job.threadId,'existing-thread');assert.equal(job.sessionDocumentId,'doc-one');
 assert.equal(job.sourceDocument.path,path.join(s.p.root,s.file.path));
 assert.match(job.prompt,/请解释这里/);
 const doc=ChatDocument.parse(await s.p.app.vault.read(file));
 assert.deepEqual(doc.messages.map(m=>m.author),['me','chat','me','chat']);
 assert.equal(doc.messages.at(-1).text,'回答-aa');
 assert.equal(S.pending(s.p.state.documents[file.path]).length,0);
 await chats.submit(file,'继续');
 const second=JSON.parse(s.prompts[1].slice(s.prompts[1].indexOf('{')));
 assert.equal(second.requests[0].discussionDelta.filter(m=>m.author==='me').length,1);
 assert.doesNotMatch(second.requests[0].discussionDelta.at(-1).text,/请解释这里/);
});

test('composer clears after saving, before the answer, and retains a subsequently typed identical draft',async t=>{
 const s=setup(block('aa','选文','me (one): @chat 原问题\nchat (two): 原回答'));
 const chats=withChatFiles(s),file=await chats.ensure(s.file,'aa');
 t.after(()=>chats.destroy());
 chats.decoratePanels=()=>{};
 const panel={file,input:{value:'追问'},resize:()=>{}};
 chats.panels.set({},panel);
 // destroy only owns real DOM panels; this fake panel is removed after assertions.
 t.after(()=>chats.panels.clear());
 chats.setDraft(file,'追问');
 let finish, started;
 const entered=new Promise(resolve=>{started=resolve;});
 s.p.send=async()=>{started();await new Promise(resolve=>{finish=resolve;});};
 const pending=chats.submit(file,'追问');
 await entered;
 assert.equal(panel.input.value,'');assert.equal(chats.draft(file),'');
 assert.equal(ChatDocument.parse(await s.p.app.vault.read(file)).messages.at(-1).text,'追问');
 panel.input.value='追问';chats.setDraft(file,'追问');
 finish();await pending;
 assert.equal(panel.input.value,'追问');assert.equal(chats.draft(file),'追问');
 chats.panels.clear();
});

test('save failure preserves composer and draft without calling the model',async t=>{
 const s=setup(block('aa','选文','me (one): @chat 原问题\nchat (two): 原回答'));
 const chats=withChatFiles(s),file=await chats.ensure(s.file,'aa');
 t.after(()=>chats.destroy());chats.decoratePanels=()=>{};
 chats.setDraft(file,'未保存的问题');
 const panel={file,input:{value:'未保存的问题'}};chats.panels.set({},panel);
 s.p.app.vault.process=async()=>{throw Error('disk full');};
 await assert.rejects(chats.submit(file,'未保存的问题'),/disk full/);
 assert.equal(panel.input.value,'未保存的问题');assert.equal(chats.draft(file),'未保存的问题');
 assert.equal(s.calls,0);chats.panels.clear();
});

test('edits during saving survive acknowledgement; remote failure retains the saved question',async t=>{
 const s=setup(block('aa','选文','me (one): @chat 原问题\nchat (two): 原回答'));
 const chats=withChatFiles(s),file=await chats.ensure(s.file,'aa');
 t.after(()=>chats.destroy());chats.decoratePanels=()=>{};
 const panel={file,input:{value:'已发问题'}};chats.panels.set({},panel);
 chats.setDraft(file,'已发问题');
 const process=s.p.app.vault.process;
 s.p.app.vault.process=async(...args)=>{
   await process(...args);panel.input.value='新草稿';chats.setDraft(file,'新草稿');
 };
 s.p.send=async()=>{throw Error('offline');};
 await assert.rejects(chats.submit(file,'已发问题'),/offline/);
 assert.equal(panel.input.value,'新草稿');assert.equal(chats.draft(file),'新草稿');
 assert.equal(ChatDocument.parse(await s.p.app.vault.read(file)).messages.at(-1).text,'已发问题');
 chats.panels.clear();
});

test('preflight failure retains one saved question for retry; related document busy blocks without writing',async()=>{
 const s=setup(block('aa','选文','me (one): @chat 原问题\nchat (two): 原回答'));
 const chats=withChatFiles(s),file=await chats.ensure(s.file,'aa');
 s.p.busyFiles.add(s.file.path);
 await assert.rejects(chats.submit(file,'追问'),/正在回答/);
 s.p.busyFiles.clear();
 const scope=s.provider.getAccountScope;
 s.provider.getAccountScope=async()=>{throw Error('offline');};
 await assert.rejects(chats.submit(file,'追问'),/offline/);
 assert.equal(ChatDocument.parse(await s.p.app.vault.read(file)).messages.length,3);
 s.provider.getAccountScope=scope;
 await chats.submit(file,'追问');
 assert.equal(ChatDocument.parse(await s.p.app.vault.read(file)).messages.length,4);
 assert.equal(s.calls,1);
});

test('historical import is quiet; explicit historical requeue survives preflight and sends once', async () => {
  const s = setup(block('aa', '旧正文', 'me (old): @chat 旧问题') + block('bb', '旧回答', 'chat (past): 历史回答'));
  assert.equal(S.pending(s.p.state.documents[s.file.path]).length, 0);
  assert.equal(S.unread(s.p.state.documents[s.file.path]).length, 0);
  await s.p.requeueHistorical(s.file.path, ['aa']);
  assert.equal(S.pending(s.p.state.documents[s.file.path]).length, 1);
  await s.p.send(s.file.path, ['aa']);
  assert.equal(s.calls, 1);
  assert.equal(C.parse(s.content).find(c => c.id === 'aa').entries.at(-1).author, 'chat');
});

test('full refresh imports an unknown historical file quietly even on fallback paths', async () => {
  const s = setup(block('aa', '旧正文', 'me (old): @chat 旧问题\nchat (past): 历史回答'));
  s.p.state.documents = {};
  s.p.cache.clear();
  s.p.saveState();
  await s.p.refreshAll();
  const doc = s.p.state.documents[s.file.path];
  assert.equal(S.pending(doc).length, 0);
  assert.equal(S.unread(doc).length, 0);
});

test('inbox-style subset dispatch sends only selected thread and leaves the other pending', async () => {
  const initial = block('aa', '甲', 'me (one): 问题甲') + block('bb', '乙', 'me (two): 问题乙');
  const s = setup(initial);
  s.content = s.content.replace('问题甲', '@chat 问题甲').replace('问题乙', '@chat 问题乙');
  await s.p.refreshFile(s.file, 'observe');
  await s.p.send(s.file.path, ['bb']);
  const sent = JSON.parse(s.prompts[0].slice(s.prompts[0].indexOf('{')));
  assert.deepEqual(sent.requests.map(r => r.commentId), ['bb']);
  assert.deepEqual(S.pending(s.p.state.documents[s.file.path]).map(c => c.id), ['aa']);
  assert.equal(C.parse(s.content).find(c => c.id === 'aa').entries.some(e => e.author === 'chat'), false);
});

test('removing @chat removes pending and explicit send does not call provider', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  await s.p.refreshFile(s.file, 'observe');
  assert.equal(S.pending(s.p.state.documents[s.file.path]).length, 1);
  s.content = s.content.replace('@chat ', '');
  await s.p.refreshFile(s.file, 'observe');
  assert.equal(S.pending(s.p.state.documents[s.file.path]).length, 0);
  await s.p.send(s.file.path);
  assert.equal(s.calls, 0);
});

test('delete clears observed queue even without Git and recreation gets fresh identities', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  await s.p.refreshFile(s.file, 'observe');
  const before = S.pending(s.p.state.documents[s.file.path])[0].targetSnapshot.messages[0].messageId;
  s.p.observeDeletion(s.file.path);
  assert.equal(S.pending(s.p.state.documents[s.file.path]).length, 0);
  s.content = block('aa', '重建正文', 'me (new): @chat 重建问题');
  await s.p.refreshFile(s.file, 'observe');
  const after = S.pending(s.p.state.documents[s.file.path])[0].targetSnapshot.messages[0].messageId;
  assert.notEqual(after, before);
});

test('follow-up added during generation is not marked as model context and is sent next time', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  const original = s.provider.answer;
  s.provider.answer = async (...args) => {
    const result = await original(...args);
    s.content = s.content.replace('\n-->\n', '\nme (later): @chat 生成期间的新问题\n-->\n');
    return result;
  };
  await s.p.send(s.file.path);
  assert.equal(S.pending(s.p.state.documents[s.file.path]).length, 1);
  s.provider.answer = original;
  await s.p.send(s.file.path);
  const second = JSON.parse(s.prompts[1].slice(s.prompts[1].indexOf('{')));
  assert.deepEqual(second.requests[0].discussionDelta.map(e => e.text), ['@chat 生成期间的新问题']);
});

test('same-document overlap is blocked while settings changes do not interrupt the captured provider snapshot', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  const original = s.provider.answer;
  s.provider.answer = async (...args) => { started(); await gate; return original(...args); };
  const first = s.p.send(s.file.path);
  await began;
  s.p.settings.model = 'gpt-changed';
  await s.p.send(s.file.path);
  release();
  await first;
  assert.equal(s.calls, 1);
  const receipt = s.p.readUsageReceipts().jobs[0];
  assert.equal(receipt.provider.model, 'gpt-test');
});

test('switching accounts keeps the document thread and discussion context on the next send', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 第一个问题');
  await s.p.send(s.file.path);
  const originalThread = s.p.sessions['doc-one'].threadId;
  const previousContext = JSON.parse(JSON.stringify(s.p.sessions['doc-one'].contexts));
  s.content = s.content.replace('\n-->', '\nme (two): @chat 后续问题\n-->');
  s.provider.getAccountScope = async () => ({ key: 'account-two', type: 'chatgpt', label: 'other', stable: true });
  s.provider.getThreadScope = () => ({ accountScopeKey: 'account-two', accountScopeStable: true, model: 'gpt-test', modelProvider: 'openai' });
  s.provider.thread = async id => { assert.equal(id, originalThread); return id; };
  await s.p.send(s.file.path);
  assert.equal(s.p.sessions['doc-one'].threadId, originalThread);
  assert.equal(s.p.sessions['doc-one'].scopeKey, 'account-two');
  assert.ok(Object.keys(previousContext).length);
  const second = JSON.parse(s.prompts[1].slice(s.prompts[1].indexOf('{')));
  assert.deepEqual(second.requests[0].discussionDelta.map(entry => entry.text), ['@chat 后续问题']);
  assert.equal(C.parse(s.content)[0].entries.filter(entry => entry.author === 'chat').length, 2);
});

test('new request leases capture the latest login without interrupting an active request', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-account-switch-'));
  const log = path.join(root, 'protocol.jsonl'), state = path.join(root, 'state.json');
  fs.writeFileSync(state, JSON.stringify({ threadSeq: 0, turnSeq: 0, turns: {}, accountEmail: 'first@example.com' }));
  const p = new Plugin();
  Object.assign(p, { root, providers: new Map(), providerUsers: new Map() });
  const config = { executable: process.execPath, executableArgs: [path.join(__dirname, 'fake-app-server.cjs'), 'login-switch', log, state], model: 'gpt-test' };
  const first = p.leaseProvider(config);
  const generatedHome = first.codexHome;
  first.codexHome = path.join(root, 'plugin-home'); first.sourceCodexHome = path.join(root, 'desktop-home');
  fs.mkdirSync(first.sourceCodexHome);
  let next;
  t.after(async () => {
    await Promise.all([first.close(), next?.close()]);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const firstScope = await first.getAccountScope();
  const firstId = '11111111-1111-1111-1111-111111111111', nextId = '22222222-2222-2222-2222-222222222222';
  await first.thread(firstId);
  let started;
  const began = new Promise(resolve => { started = resolve; });
  const running = first.answer(firstId, 'first', started);
  await began;
  const persisted = JSON.parse(fs.readFileSync(state, 'utf8'));
  fs.writeFileSync(state, JSON.stringify({ ...persisted, accountEmail: 'second@example.com' }));
  next = p.leaseProvider(config);
  assert.equal(next.codexHome, generatedHome);
  next.codexHome = first.codexHome; next.sourceCodexHome = first.sourceCodexHome;
  const nextScope = await next.getAccountScope();
  assert.notEqual(nextScope.key, firstScope.key);
  assert.notEqual(next.child.pid, first.child.pid);
  assert.equal(await next.thread(nextId, null, { accountScopeKey: firstScope.key }), nextId);
  const following = next.answer(nextId, 'second');
  assert.equal(first.activeThreads.has(firstId), true);
  assert.equal((await Promise.all([running, following])).length, 2);
  const secondExit = new Promise(resolve => next.child.once('exit', resolve));
  p.releaseProvider(next);
  await secondExit;
  assert.ok(first.activeGeneration);
  assert.equal(p.providers.size, 1);
  const firstExit = new Promise(resolve => first.child.once('exit', resolve));
  p.releaseProvider(first);
  await firstExit;
  assert.equal(p.providers.size, 0);
  const messages = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(messages.filter(message => message.method === 'thread/start').length, 0);
  assert.equal(messages.filter(message => message.startup).length, 2);
});

test('ambiguous failure locks document and recovery reads the original turn without answering again', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  s.provider.answer = async (_id, _prompt, cb) => { await cb('remote-turn'); throw new Error('Disconnected'); };
  await assert.rejects(s.p.send(s.file.path), /Disconnected/);
  await assert.rejects(s.p.send(s.file.path), /恢复/);
  s.provider.recover = async (id, turn, expected) => {
    assert.equal(id, 'thread-one');
    assert.equal(turn, 'remote-turn');
    assert.equal(expected.accountScopeKey, 'account-one');
    return { text: '{"replies":[{"commentId":"aa","text":"恢复回答"}]}' };
  };
  await s.p.recover(s.file.path);
  assert.equal(C.parse(s.content)[0].entries.at(-1).text, '恢复回答');
});

test('model reroute is persisted and recovery fails locally without another provider call', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  s.provider.answer = async (_id, _prompt, cb) => {
    await cb('rerouted-turn');
    const error = new Error('model rerouted');
    error.code = 'MODEL_REROUTED';
    error.ambiguous = false;
    throw error;
  };
  await assert.rejects(s.p.send(s.file.path), /rerouted/);
  let recoverCalls = 0;
  s.provider.recover = async () => { recoverCalls++; throw new Error('must not run'); };
  await assert.rejects(s.p.recover(s.file.path), /实际模型/);
  assert.equal(recoverCalls, 0);
  const job = s.p.readJob(s.p.state.documents[s.file.path].job);
  assert.equal(job.errorCode, 'MODEL_REROUTED');
});

async function interruptedSetup() {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  s.provider.answer = async (_id, _prompt, cb) => { await cb('old-turn'); throw new Error('app closed'); };
  await assert.rejects(s.p.send(s.file.path), /app closed/);
  s.jobId = s.p.state.documents[s.file.path].job;
  // Simulate a freshly loaded runtime using the existing durable receipt/state.
  s.p.busyFiles = new Set(); s.p.recoveringFiles = new Set();
  s.p.loadPortableState();
  s.provider.answer = async () => { throw new Error('recovery must never generate'); };
  return s;
}

for (const [code, status] of [['TURN_INTERRUPTED', 'interrupted'], ['TURN_FAILED', 'failed']]) {
  test(`restart releases confirmed ${status} while retaining question, receipt, usage and session`, async () => {
    const s = await interruptedSetup(), original = s.content;
    const job = s.p.readJob(s.jobId);
    job.aggregateUsage = { totalTokens: 123 };
    job.error = '回答超时'; job.errorCode = 'TURN_TIMEOUT'; s.p.writeJob(job);
    const session = structuredClone(s.p.sessions);
    s.provider.recover = async (thread, turn) => {
      assert.equal(thread, job.threadId); assert.equal(turn, 'old-turn');
      const error = new Error('terminal'); error.code = code; throw error;
    };
    const results = await s.p.recoverOutstanding();
    assert.equal(results[0].status, status);
    assert.equal(s.p.state.documents[s.file.path].job, undefined);
    assert.equal(s.p.state.documents[s.file.path].lastStoppedJob, s.jobId);
    assert.equal(S.pending(s.p.state.documents[s.file.path], s.content).length, 1);
    assert.deepEqual(s.p.sessions, session); assert.equal(s.content, original);
    const saved = s.p.readJob(s.jobId);
    assert.equal(saved.status, status); assert.equal(saved.aggregateUsage.totalTokens, 123);
    assert.deepEqual(saved.originalFailure, { message: '回答超时', code: 'TURN_TIMEOUT' });
    assert.equal(saved.errorCode, code);
    s.p.loadPortableState(); assert.equal(s.p.state.documents[s.file.path].job, undefined);
    assert.equal(s.p.busyFiles.size, 0); assert.equal(s.p.recoveringFiles.size, 0);
  });
}

test('restart recovers a completed answer once without any new generation', async () => {
  const s = await interruptedSetup(); let reads = 0;
  s.provider.recover = async () => { reads++; return { text: '{"replies":[{"commentId":"aa","text":"原回答"}]}' }; };
  assert.equal((await s.p.recoverOutstanding())[0].status, 'applied');
  await s.p.recoverOutstanding();
  assert.equal(reads, 1);
  assert.equal(C.parse(s.content)[0].entries.filter(e => e.author === 'chat').length, 1);
  assert.equal(S.pending(s.p.state.documents[s.file.path], s.content).length, 0);
});

test('unknown remote state stays locked and a missing turn receipt never contacts provider', async () => {
  const s = await interruptedSetup(); let reads = 0;
  s.provider.recover = async () => { reads++; const e = new Error('unknown'); e.code = 'TURN_NOT_RECOVERABLE'; e.ambiguous = true; throw e; };
  await s.p.recoverOutstanding();
  assert.equal(s.p.state.documents[s.file.path].job, s.jobId);
  const job = s.p.readJob(s.jobId);
  assert.equal(job.status, 'needs-recovery'); assert.equal(job.ambiguous, true);
  delete job.turnId; s.p.writeJob(job);
  await s.p.recoverOutstanding(); assert.equal(reads, 1);
  assert.equal(s.p.state.documents[s.file.path].job, s.jobId);
  assert.equal(s.p.busyFiles.size, 0);
});

test('startup recovery skips a request already being processed locally', async () => {
  const s = await interruptedSetup();
  s.p.busyFiles.add(s.file.path);
  s.provider.recover = async () => { throw new Error('must not read live turn'); };
  assert.deepEqual(await s.p.recoverOutstanding(), []);
  assert.equal(s.p.state.documents[s.file.path].job, s.jobId);
});

test('late target edit preserves user work and keeps generated answer only in durable receipt', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  const original = s.provider.answer;
  s.provider.answer = async (...args) => {
    const result = await original(...args);
    s.content = s.content.replace('@chat 问题', '@chat 修改后的问题');
    return result;
  };
  await assert.rejects(s.p.send(s.file.path), /已更改/);
  assert.ok(s.content.includes('修改后的问题'));
  assert.equal(C.parse(s.content)[0].entries.filter(e => e.author === 'chat').length, 0);
  const job = s.p.readJob(s.p.state.documents[s.file.path].job);
  assert.ok(job.result.text.includes('回答-aa'));
});

test('write-before-ack crash recovers idempotently and appends exactly one reply', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  const original = s.p.app.vault.process;
  let crash = true;
  s.p.app.vault.process = async (...args) => { await original(...args); if (crash) { crash = false; throw new Error('simulated crash'); } };
  await assert.rejects(s.p.send(s.file.path), /simulated crash/);
  await s.p.recover(s.file.path);
  assert.equal(C.parse(s.content)[0].entries.filter(e => e.author === 'chat').length, 1);
});

test('one unreadable chat cannot abort startup reconciliation of the remaining vault', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  const bad = new TFile('broken-chat.md'), errors = [];
  s.p.app.vault.getAbstractFileByPath = name => name === bad.path ? bad : s.file;
  s.p.app.vault.getMarkdownFiles = () => [bad, s.file];
  const refresh = s.p.refreshFile.bind(s.p);
  s.p.refreshFile = async file => {
    if (file === bad) throw new Error('broken chat');
    return refresh(file, 'observe');
  };
  s.p.notice = error => errors.push(error.message);
  const original = gitAdapter.scanChangedFiles;
  gitAdapter.scanChangedFiles = async () => ({ ok: true, head: 'b'.repeat(40), candidates: [{ path: bad.path }, { path: s.file.path }] });
  try {
    await s.p.initializeCache();
    assert.equal(s.p.cache.get(s.file.path).pending.length, 1);
    assert.deepEqual(errors, ['broken chat']);
    assert.equal(s.calls, 0);
  } finally { gitAdapter.scanChangedFiles = original; }
});

test('first Git baseline fallback imports historical requests and replies quietly', async () => {
  const s = setup(block('aa', '正文', 'me (old): @chat 旧问题\nchat (reply): 旧回答'));
  s.p.state.documents = {};
  s.p.cache.clear();
  const original = gitAdapter.scanChangedFiles;
  gitAdapter.scanChangedFiles = async () => ({ ok: false, reason: 'baseline-missing', head: 'a'.repeat(40), candidates: [] });
  try {
    await s.p.initializeCache();
    assert.equal(S.pending(s.p.state.documents[s.file.path]).length, 0);
    assert.equal(S.unread(s.p.state.documents[s.file.path]).length, 0);
    assert.equal(s.calls, 0);
    assert.equal(s.p.git.head, 'a'.repeat(40));
  } finally { gitAdapter.scanChangedFiles = original; }
});

test('v1 state is backed up before migration and unsupported state fails closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inplace-chat-migrate-'));
  const p = new Plugin();
  p.storage = path.join(root, '.inplace-chat');
  p.stateFile = path.join(p.storage, 'state.json');
  fs.mkdirSync(p.storage, { recursive: true });
  fs.writeFileSync(p.stateFile, JSON.stringify({ version: 1, documents: { 'a.md': { id: 'old', handled: ['x'], job: 'job' } } }));
  p.loadPortableState();
  assert.equal(p.state.version, 2);
  assert.equal(p.state.documents['a.md'].job, 'job');
  assert.equal(fs.readdirSync(p.storage).filter(name => name.includes('.backup.json')).length, 1);
  fs.writeFileSync(p.stateFile, JSON.stringify({ version: 99, documents: {} }));
  assert.throws(() => p.loadPortableState(), /不一致/);
});

function commentKeySetup({ draft = '', sidebar = false, custom } = {}) {
  const s = setup();
  const card = {
    querySelector: () => ({ value: draft }),
    querySelectorAll: () => [{ value: draft }]
  };
  const target = {
    value: '', matches: () => false,
    closest: selector => selector.includes('modal') ? null : selector.includes('doc-comment') ? card : null
  };
  const leaf = { view: { file: s.file, containerEl: { contains: surface => surface === card } } };
  s.p.app.workspace.getLeavesOfType = type => type === (sidebar ? 'document-comments-sidebar' : 'markdown') ? [leaf] : [];
  s.p.app.workspace.getActiveFile = () => new TFile('wrong-active-note.md');
  s.p.app.hotkeyManager = { customKeys: custom || {}, getHotkeys: id => id.endsWith(':send-pending') ? [{ modifiers: ['Alt'], key: 'Enter' }] : [{ modifiers: ['Alt', 'Shift'], key: 'C' }] };
  const sent = [];
  s.p.sendPendingForFile = file => { sent.push(file.path); };
  const event = {
    target, key: 'Enter', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false,
    repeat: false, isComposing: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }
  };
  return { ...s, card, event, sent };
}

test('comment hotkey uses the owning document even when focus remains on a saved card button', () => {
  for (const sidebar of [false, true]) {
    const s = commentKeySetup({ sidebar });
    assert.equal(s.p.handleCommentHotkey(s.event), true);
    assert.deepEqual(s.sent, ['article.md']);
    assert.equal(s.event.stopped, true);
  }
});

test('customized and disabled send hotkeys override default Alt+Enter in comments', () => {
  const id = 'inplace-chat:send-pending';
  const s = commentKeySetup({ custom: { [id]: [] } });
  assert.equal(s.p.handleCommentHotkey(s.event), false);
  assert.deepEqual(s.sent, []);
  assert.equal(s.event.defaultPrevented, false);
  s.p.app.hotkeyManager.customKeys[id] = [{ modifiers: ['Ctrl', 'Shift'], key: 'k' }];
  assert.equal(s.p.handleCommentHotkey(s.event), false);
  Object.assign(s.event, { key: 'K', altKey: false, ctrlKey: true, shiftKey: true });
  assert.equal(s.p.handleCommentHotkey(s.event), true);
  assert.deepEqual(s.sent, ['article.md']);
});

test('empty hotkey-manager result falls back to the registered command default', () => {
  const s = commentKeySetup();
  let argumentCount = -1;
  s.p.app.hotkeyManager.getHotkeys = function () { argumentCount = arguments.length; return []; };
  assert.equal(s.p.handleCommentHotkey(s.event), false);
  s.event.key = 's';
  assert.equal(s.p.handleCommentHotkey(s.event), true);
  assert.equal(argumentCount, 1);
  assert.deepEqual(s.sent, ['article.md']);
});

test('window capture observes but does not resend an Alt+Enter consumed by an Obsidian local scope', () => {
  const s = commentKeySetup();
  s.event.defaultPrevented = true;
  s.event.code = 'Enter';
  s.p.traceEvents = [];
  s.p.trace = event => s.p.traceEvents.push(event);
  assert.equal(s.p.handleHotkeyCapture(s.event), false);
  assert.deepEqual(s.sent, []);
  const observed = s.p.traceEvents.find(event => event.stage === 'hotkey_event');
  assert.deepEqual({ key: observed.key, code: observed.code, modifiers: observed.modifiers, defaultPrevented: observed.defaultPrevented, scope: observed.scope }, {
    key: 'Enter', code: 'Enter', modifiers: 'Alt', defaultPrevented: true, scope: 'comment'
  });
});

test('a consumed send key cannot dispatch again after a command taking more than 100ms', () => {
  for (const pdf of [false, true]) {
    const s = commentKeySetup();
    s.p.trace = () => {};
    if (pdf) {
      s.file.extension = 'pdf';
      s.p.pdf = { fileForTarget: () => s.file };
    }
    s.p.sendPendingForFile(s.file, 'command_hotkey');
    s.event.preventDefault();
    s.p.lastCommandDispatchAt = Date.now() - 107;
    assert.equal(s.p.handleHotkeyCapture(s.event), false);
    assert.deepEqual(s.sent, ['article.md']);
  }
});

test('independent unconsumed keys still use fallback even immediately after a command', () => {
  for (const pdf of [false, true]) {
    const s = commentKeySetup();
    s.p.trace = () => {};
    if (pdf) {
      s.file.extension = 'pdf';
      s.p.pdf = { fileForTarget: () => s.file };
    }
    s.p.lastCommandDispatchAt = Date.now();
    assert.equal(s.p.handleHotkeyCapture(s.event), true);
    const second = { ...s.event, defaultPrevented: false };
    assert.equal(s.p.handleHotkeyCapture(second), true);
    assert.deepEqual(s.sent, ['article.md', 'article.md']);
  }
});

test('one cancelable keyboard event shared by command and capture listeners sends only once', () => {
  const s = commentKeySetup();
  s.p.trace = () => {};
  const windowEvents = new EventTarget();
  windowEvents.addEventListener('keydown', event => {
    s.p.sendPendingForFile(s.file, 'command_hotkey');
    event.preventDefault();
    // Reproduce the recorded root-command -> fallback gap of 107ms.
    s.p.lastCommandDispatchAt = Date.now() - 107;
  });
  windowEvents.addEventListener('keydown', event => s.p.handleHotkeyCapture(event));
  const event = new Event('keydown', { cancelable: true });
  for (const key of ['target', 'key', 'altKey', 'ctrlKey', 'metaKey', 'shiftKey', 'repeat', 'isComposing']) {
    Object.defineProperty(event, key, { value: s.event[key] });
  }
  windowEvents.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(s.sent, ['article.md']);
});

test('Return and NumpadEnter variants match an Enter hotkey', () => {
  const hotkeys = [{ modifiers: ['Alt'], key: 'Enter' }];
  const base = { altKey: true, ctrlKey: false, metaKey: false, shiftKey: false };
  assert.equal(moduleUnderTest.exports.eventMatchesCommandHotkey({ ...base, key: 'Return', code: 'Enter' }, hotkeys, false), true);
  assert.equal(moduleUnderTest.exports.eventMatchesCommandHotkey({ ...base, key: '', code: 'NumpadEnter' }, hotkeys, false), true);
});

test('macOS maps Mod to Command while preserving Option as Alt', () => {
  const commandHotkey = [{ modifiers: ['Mod', 'Shift'], key: 's' }];
  const optionHotkey = [{ modifiers: ['Alt', 'Shift'], key: 's' }];
  assert.equal(moduleUnderTest.exports.eventMatchesCommandHotkey({
    key: 's', code: 'KeyS', altKey: false, ctrlKey: false, metaKey: true, shiftKey: true
  }, commandHotkey, true), true);
  assert.equal(moduleUnderTest.exports.eventMatchesCommandHotkey({
    key: 's', code: 'KeyS', altKey: true, ctrlKey: false, metaKey: false, shiftKey: true
  }, optionHotkey, true), true);
});

test('Alt+S in a nonempty PDF reader input sends only that discussion', async () => {
  const s = setup();
  const pdfFile = new TFile('paper.pdf');
  pdfFile.extension = 'pdf';
  const thread = { dataset: { threadId: 'pdf-thread-a' } };
  const target = {
    value: '这是当前追问',
    matches: selector => selector === 'textarea.ipc-pdf-input',
    closest: selector => selector.includes('modal') ? null : selector === '.ipc-reader-thread' ? thread : null
  };
  const context = { file: pdfFile, bundleId: 'bundle' };
  const added = [], batches = [];
  s.p.pdf = {
    fileForTarget: () => null,
    contextFor: file => { assert.equal(file, pdfFile); return context; },
    addMessage: async (...args) => { added.push(args); }
  };
  s.p.sendPendingForFile = (...args) => batches.push(args);
  const leaf = { view: { path: pdfFile.path, containerEl: { contains: node => node === target } } };
  s.p.app.vault.getAbstractFileByPath = name => name === pdfFile.path ? pdfFile : null;
  s.p.app.workspace.getLeavesOfType = type => type === 'inplace-chat-comment-reader' ? [leaf] : [];
  s.p.app.hotkeyManager = { customKeys: {}, getHotkeys: () => [] };
  const event = {
    target, key: 's', altKey: true, ctrlKey: false, metaKey: false, shiftKey: false,
    repeat: false, isComposing: false, defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }
  };
  assert.equal(s.p.handleCommentHotkey(event), true);
  await Promise.resolve();
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(batches, []);
  assert.equal(added.length, 1);
  assert.equal(added[0][0], context);
  assert.equal(added[0][1], 'pdf-thread-a');
  assert.equal(added[0][2], '这是当前追问');
  assert.deepEqual(added[0][3], { send: true });

  target.value = '';
  const emptyEvent = { ...event, defaultPrevented: false, preventDefault: event.preventDefault, stopImmediatePropagation: event.stopImmediatePropagation };
  assert.equal(s.p.handleCommentHotkey(emptyEvent), true);
  assert.equal(added.length, 1);
  assert.equal(batches.length, 1);
  assert.equal(batches[0][0], pdfFile);
  assert.equal(batches[0][1], 'pdf_hotkey');
});

test('unsaved comments, plain Enter, IME, repeat, and unrelated controls cannot dispatch', () => {
  const draft = commentKeySetup({ draft: '@chat 尚未保存' });
  draft.p.handleCommentHotkey(draft.event);
  assert.deepEqual(draft.sent, []);
  for (const patch of [{ altKey: false }, { isComposing: true }, { repeat: true }, { target: { closest: () => null } }]) {
    const s = commentKeySetup();
    Object.assign(s.event, patch);
    assert.equal(s.p.handleCommentHotkey(s.event), false);
    assert.deepEqual(s.sent, []);
  }
});

test('status separates the current document from an unrelated failed request', () => {
  const s = setup(), attrs = {};
  s.p.app.workspace.getActiveFile = () => s.file;
  s.p.state.documents['other.md'] = { id: 'other', lastStoppedJob: 'stopped-job' };
  s.p.cache.set('other.md', { pending: [{ id: 'other-question' }], unread: [] });
  s.p.status = { classList: { toggle() {} }, setAttribute(k, v) { attrs[k] = v; }, setText(v) { this.textContent = v; } };
  Plugin.prototype.decorate.call(s.p);
  const [current, other] = s.p.status.textContent.split(' ｜ ');
  assert.match(current, /当前文档/);
  assert.doesNotMatch(current, /中断|失败/);
  assert.match(other, /其他文档：1 已中断\/失败 · 1 待答/);
  assert.match(attrs.title, /other.md：1 已中断\/失败/);
  assert.equal(s.p.state.documents['other.md'].lastStoppedJob, 'stopped-job');
});

test('status groups a source and its chat detail even when the active tab changes', () => {
  const s = setup(), chat = new TFile('chat.md');
  let active = chat;
  s.p.app.workspace.getActiveFile = () => active;
  s.p.app.vault.getAbstractFileByPath = name => name === chat.path ? chat : name === s.file.path ? s.file : null;
  s.p.chatFiles = { schedule() {}, owner: file => file === chat || file === s.file ? 'doc-one' : file?.path };
  s.p.state.documents[chat.path] = { id: 'chat', job: 'active-job' };
  s.p.busyFiles.add(chat.path);
  s.p.status = { classList: { toggle() {} }, setAttribute() {}, setText(v) { this.textContent = v; } };
  Plugin.prototype.decorate.call(s.p);
  assert.match(s.p.status.textContent, /当前文档 · 1 正在工作/);
  assert.doesNotMatch(s.p.status.textContent, /其他文档/);
  active = s.file;
  Plugin.prototype.decorate.call(s.p);
  assert.match(s.p.status.textContent, /当前文档 · 1 正在工作/);
  s.p.busyFiles.clear();
  s.p.state.documents[chat.path].job = null;
  Plugin.prototype.decorate.call(s.p);
  assert.doesNotMatch(s.p.status.textContent, /正在工作/);
});

test('working status appears during generation and clears after failure', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  const classes = new Set();
  s.p.status = {
    textContent: '', classList: { toggle: (name, yes) => yes ? classes.add(name) : classes.delete(name) },
    setAttribute() {}, setText(value) { this.textContent = value; }
  };
  s.p.decorate = Plugin.prototype.decorate;
  let finish, started;
  const gate = new Promise(resolve => { finish = resolve; });
  const began = new Promise(resolve => { started = resolve; });
  s.provider.answer = async () => { started(); await gate; throw new Error('offline test failure'); };
  const sending = s.p.send(s.file.path);
  const rejected = assert.rejects(sending, /offline test failure/);
  await began;
  assert.equal(classes.has('is-working'), true);
  assert.match(s.p.status.textContent, /正在工作/);
  finish();
  await rejected;
  assert.equal(classes.has('is-working'), false);
  assert.doesNotMatch(s.p.status.textContent, /正在工作/);
});

test('first-comment draft outside a saved card and unrelated modal are never sent', () => {
  const draft = commentKeySetup();
  draft.event.target = {
    value: '@chat 还没保存', matches: selector => selector === 'textarea',
    closest: selector => selector.includes(',') ? draft.card : null
  };
  assert.equal(draft.p.handleCommentHotkey(draft.event), true);
  assert.deepEqual(draft.sent, []);
  const modal = commentKeySetup();
  modal.event.target.closest = () => modal.card;
  assert.equal(modal.p.handleCommentHotkey(modal.event), false);
  assert.deepEqual(modal.sent, []);
  assert.equal(modal.event.defaultPrevented, false);
});

test('reader shortcut in native comments opens the owning document without submitting a draft', () => {
  const s = commentKeySetup({ draft: '@chat 未完成' });
  const opened = [];
  s.p.openCommentReader = async filePath => { opened.push(filePath); };
  Object.assign(s.event, { key: 'C', shiftKey: true });
  assert.equal(s.p.handleCommentHotkey(s.event), true);
  assert.deepEqual(opened, ['article.md']);
  assert.deepEqual(s.sent, []);
  const disabled = commentKeySetup({ custom: { 'inplace-chat:open-comment-reader': [] } });
  Object.assign(disabled.event, { key: 'C', shiftKey: true });
  assert.equal(disabled.p.handleCommentHotkey(disabled.event), false);
});

test('conflicting reader and send shortcuts do not silently choose an action', () => {
  const s = commentKeySetup({ custom: { 'inplace-chat:open-comment-reader': [{ modifiers: ['Alt'], key: 'Enter' }] } });
  let opened = false;
  s.p.openCommentReader = async () => { opened = true; };
  assert.equal(s.p.handleCommentHotkey(s.event), true);
  assert.deepEqual(s.sent, []);
  assert.equal(opened, false);
});

test('blocked operations are locally traceable without model calls or document content in logs', async () => {
  const s = setup();
  s.p.diagnostics = new DiagnosticStore(path.join(s.p.root, 'diagnostics'));
  await s.p.send(s.file.path);
  const events = s.p.diagnostics.readRecent();
  assert.equal(events[0].stage, 'send_requested');
  assert.ok(events.some(event => event.reason === 'NO_PENDING' && event.status === 'not_called'));
  assert.equal(s.calls, 0);
  assert.doesNotMatch(JSON.stringify(events), /局部正文|article\.md/);
  const draft = commentKeySetup({ draft: '@chat 未保存的私人问题' });
  draft.p.diagnostics = s.p.diagnostics;
  draft.p.handleCommentHotkey(draft.event);
  assert.ok(s.p.diagnostics.readRecent().some(event => event.reason === 'UNSAVED_DRAFT'));
  assert.doesNotMatch(JSON.stringify(s.p.diagnostics.readRecent()), /私人问题/);
  s.p.diagnostics.close();
});

test('usage received before failure is durable and recovery does not count it twice', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  s.p.diagnostics = new DiagnosticStore(path.join(s.p.root, 'diagnostics'));
  const usage = { last: { inputTokens: 20, outputTokens: 3, totalTokens: 23 }, total: { inputTokens: 200, outputTokens: 30, totalTokens: 230 } };
  let generated = 0;
  s.provider.answer = async (_id, _prompt, onStarted, onEvent) => {
    generated++;
    await onStarted('failed-turn');
    onEvent({ stage: 'usage', turnId: 'failed-turn', usage, aggregateUsage: null, completeness: 'last-sample-only' });
    onEvent({ stage: 'usage', turnId: 'failed-turn', usage, aggregateUsage: null, completeness: 'last-sample-only' });
    throw Object.assign(new Error('connection lost'), { code: 'PROCESS_EXITED', ambiguous: true });
  };
  await assert.rejects(s.p.send(s.file.path), /connection lost/);
  const jobId = s.p.state.documents[s.file.path].job;
  let job = s.p.readJob(jobId);
  assert.deepEqual(job.usage, usage);
  assert.equal(job.usageCompleteness, 'last-sample-only');
  assert.equal(job.errorCode, 'PROCESS_EXITED');
  s.provider.recover = async () => ({ text: JSON.stringify({ replies: [{ commentId: 'aa', text: '恢复的回答' }] }), turnId: 'failed-turn', usage: null });
  await s.p.recover(s.file.path);
  job = s.p.readJob(jobId);
  const summary = summarizeReceipts([job, { ...job, id: 'duplicate-record' }]);
  assert.equal(summary.summary.sampleSums.inputTokens, 20);
  assert.equal(summary.summary.deduplicatedRows, 1);
  assert.equal(generated, 1);
  assert.equal(job.status, 'applied');
  assert.ok(s.p.diagnostics.readRecent().some(event => event.stage === 'recovery_completed'));
  s.p.diagnostics.close();
});

test('diagnostic observer failures do not prevent normal answer writeback', async () => {
  const s = setup();
  s.content = s.content.replace('问题', '@chat 问题');
  s.p.diagnostics = { record() { throw new Error('log unavailable'); }, flush() {} };
  await s.p.send(s.file.path);
  assert.equal(s.calls, 1);
  assert.equal(C.parse(s.content)[0].entries.at(-1).author, 'chat');
});

test('usage history reports invalid receipts instead of treating them as zero or crashing', () => {
  const s = setup();
  const id = '00000000-0000-0000-0000-000000000001';
  fs.mkdirSync(path.dirname(s.p.jobPath(id)), { recursive: true });
  fs.writeFileSync(s.p.jobPath(id), 'null');
  assert.deepEqual(s.p.readUsageReceipts(), { jobs: [], unreadable: 1 });
});
