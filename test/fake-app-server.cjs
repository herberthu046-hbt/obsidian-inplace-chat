'use strict';
const fs = require('node:fs');
const readline = require('node:readline');

const scenario = process.argv[2] || 'normal';
const logPath = process.argv[3];
const statePath = process.argv[4];
let state = { threadSeq: 0, turnSeq: 0, turns: {} };
try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
// Like managed Codex auth, this fake captures the login when its process starts.
const startupEmail = state.accountEmail || 'reader@example.com';
function save() { if (statePath) fs.writeFileSync(statePath, JSON.stringify(state)); }
function log(value) { if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + '\n'); }
function send(value) { process.stdout.write(JSON.stringify(value) + '\n'); }
function response(message, result) { send({ id: message.id, result }); }
function account() { return { account: { type: 'chatgpt', email: startupEmail, planType: 'plus' }, requiresOpenaiAuth: true }; }
function thread(id, model = 'gpt-test') {
  return { id, sessionId: id, model, modelProvider: 'openai', projectId: 'project-qa', turns: [], status: { type: 'idle' },
    cliVersion: 'fake', cwd: process.cwd(), createdAt: 1, updatedAt: 1, preview: '', source: 'appServer', ephemeral: false };
}
function threadResult(id, requestedModel) {
  const model = scenario === 'model-mismatch' ? 'different-model' : (requestedModel || 'gpt-test');
  return { thread: thread(id, model), model, modelProvider: 'openai', instructionSources: [], approvalPolicy: 'never',
    approvalsReviewer: 'user', cwd: process.cwd(), sandbox: { type: 'readOnly' } };
}
function completedItem(turnId, text = '{"replies":[{"commentId":"a","text":"ok"}]}') {
  return { id: `item-${turnId}`, type: 'agentMessage', phase: 'final_answer', text };
}

log({ startup: process.argv.slice(2), codexHome: process.env.CODEX_HOME, sqliteHome: process.env.CODEX_SQLITE_HOME });
if (scenario === 'stderr-secret') process.stderr.write('Authorization: Bearer secret-token-value-1234567890\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); log(message);
  if (message.method === 'initialized') return;
  switch (message.method) {
    case 'initialize': return response(message, { userAgent: 'fake' });
    case 'config/read': return response(message, { config: { mcp_servers: { personal: { enabled: true } } } });
    case 'skills/list': return response(message, { data: [{ cwd: process.cwd(), skills: [{ path: 'C:/private/SKILL.md' }] }] });
    case 'account/read': return response(message, account());
    case 'project/list':
      if (scenario === 'no-projects') return send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
      return response(message, { data: [], nextCursor: null });
    case 'project/create': return response(message, { project: { id: 'project-qa', name: message.params.name, roots: message.params.roots } });
    case 'thread/name/set': return response(message, {});
    case 'thread/start': {
      const id = `thread-${++state.threadSeq}`; save(); return response(message, threadResult(id, message.params.model));
    }
    case 'thread/resume': return response(message, threadResult(message.params.threadId, message.params.model));
    case 'turn/start': {
      const id = `turn-${++state.turnSeq}`;
      const item = completedItem(id);
      state.turns[id] = { id, status: 'completed', items: [item] }; save();
      response(message, { turn: { id, status: 'inProgress', items: [] } });
      if (scenario === 'timeout') return;
      setTimeout(() => {
        if (scenario === 'reroute') send({ method: 'model/rerouted', params: { threadId: message.params.threadId, turnId: id,
          fromModel: message.params.model || 'gpt-test', toModel: 'fallback-model', reason: 'unavailable' } });
        send({ method: 'item/completed', params: { threadId: message.params.threadId, turnId: id, item, completedAtMs: Date.now() } });
        send({ method: 'turn/completed', params: { threadId: message.params.threadId, turn: state.turns[id] } });
      }, scenario === 'login-switch' ? 1000 : scenario === 'slow' ? 80 : 5);
      return;
    }
    case 'thread/read': {
      let turns = Object.values(state.turns);
      if (scenario.startsWith('recover-')) turns = [{ id: 'old-turn', status: scenario.slice(8), items: [] }];
      if (scenario === 'malformed-recover') turns = [{ id: message.params.threadId === 'missing' ? 'other' : 'turn-bad', status: 'completed',
        items: [completedItem('one'), completedItem('two')] }];
      const value = thread(message.params.threadId);
      value.turns = turns;
      return response(message, { thread: value });
    }
    default: return send({ id: message.id, error: { code: -32601, message: `unsupported ${message.method}` } });
  }
});
