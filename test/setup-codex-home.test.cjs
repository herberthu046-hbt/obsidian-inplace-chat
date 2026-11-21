'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const windows = process.platform === 'win32';
const script = path.resolve(__dirname, '../scripts/setup-codex-home.ps1');
const literal = value => `'${value.replaceAll("'", "''")}'`;
function powershell(command, options = {}) {
  const utf8Command = '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false); ' + command;
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(utf8Command, 'utf16le').toString('base64')], {
    encoding: 'utf8', windowsHide: true, ...options,
  });
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ipc-setup-test-'));
  const vault = path.join(root, "同学's notes"), source = path.join(root, 'codex source');
  fs.mkdirSync(vault); fs.mkdirSync(source);
  // Synthetic marker only: the installer never reads or prints credentials.
  fs.writeFileSync(path.join(source, 'auth.json'), 'synthetic-login-marker');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, vault, source };
}

test('Windows setup CheckOnly matches the plugin SHA-256 home for Unicode, apostrophes, separators and case', { skip: !windows }, t => {
  const f = fixture(t);
  for (const vault of [f.vault, f.vault + '\\', f.vault.replaceAll('\\', '/'), f.vault[0].toLowerCase() + f.vault.slice(1)]) {
    const run = powershell(`& ${literal(script)} -Vault ${literal(vault)} -Source ${literal(f.source)} -CheckOnly`);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const plan = JSON.parse(run.stdout.replace(/^\uFEFF/, ''));
    const expected = createHash('sha256').update(path.resolve(vault)).digest('hex').slice(0, 16);
    assert.equal(path.basename(plan.homes[0].home), expected);
    assert.equal(plan.homes[0].source, f.source);
    assert.ok(!run.stdout.includes('synthetic-login-marker'));
    assert.equal(plan.result, null);
  }
});

test('Windows setup honors CODEX_HOME and preserves legacy Plan during a read-only check', { skip: !windows }, t => {
  const f = fixture(t), home = path.join(f.root, 'independent home'), result = path.join(f.root, 'result.json');
  let run = powershell(`& ${literal(script)} -Vault ${literal(f.vault)} -CheckOnly`, { env: { ...process.env, CODEX_HOME: f.source } });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).homes[0].source, f.source);
  const planFile = path.join(f.root, 'legacy plan.json');
  fs.writeFileSync(planFile, JSON.stringify({ homes: [{ home, source: f.source }], result }));
  run = powershell(`& ${literal(script)} -Plan ${literal(planFile)} -CheckOnly`);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).homes[0].home, home);
  assert.equal(fs.existsSync(home), false);
  assert.equal(fs.existsSync(result), false);
  run = powershell(`Set-Location -LiteralPath ${literal(f.root)}; & ${literal(script)} -Vault ${literal(path.relative(f.root, f.vault))} -Source ${literal(path.relative(f.root, f.source))} -CheckOnly`);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).homes[0].vault, f.vault);
});

test('Windows setup rejects a missing login before UAC and returns a useful legacy Plan error', { skip: !windows }, t => {
  const f = fixture(t), home = path.join(f.root, 'plugin'), result = path.join(f.root, 'result.json');
  fs.unlinkSync(path.join(f.source, 'auth.json'));
  const planFile = path.join(f.root, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify({ homes: [{ home, source: f.source }], result }));
  const run = powershell(`& ${literal(script)} -Plan ${literal(planFile)}`);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /codex login first/);
  assert.equal(JSON.parse(fs.readFileSync(result, 'utf8').replace(/^\uFEFF/, '')).ok, false);
  assert.equal(fs.existsSync(home), false);
});

test('Windows setup refuses to overwrite an existing credential file', { skip: !windows }, t => {
  const f = fixture(t), home = path.join(f.root, 'plugin'), result = path.join(f.root, 'result.json');
  fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'auth.json'), 'keep-existing');
  const planFile = path.join(f.root, 'plan.json');
  fs.writeFileSync(planFile, JSON.stringify({ homes: [{ home, source: f.source }], result }));
  const run = powershell(`& ${literal(script)} -Plan ${literal(planFile)}`);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Refusing to replace/);
  assert.equal(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'), 'keep-existing');
});

test('Windows setup encodes one hidden UAC request without losing original Unicode or quoted paths', { skip: !windows }, t => {
  const admin = powershell(`([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`);
  assert.equal(admin.status, 0, admin.stderr);
  if (admin.stdout.trim() === 'True') { t.skip('UAC routing applies only to a non-elevated parent'); return; }
  const f = fixture(t), audit = path.join(f.root, 'captured elevation.json');
  const run = powershell(`
    function New-Item { throw 'Real link creation is forbidden in this offline test.' }
    function Start-Process {
      param($FilePath, $ArgumentList, $Verb, $WindowStyle, [switch]$Wait, [switch]$PassThru)
      $encoded = $ArgumentList[-1]
      $command = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($encoded))
      if ($command -notmatch "-Plan '((?:[^']|'')+)'$") { throw 'Missing encoded Plan argument' }
      $planFile = $Matches[1].Replace("''", "'")
      $plan = Get-Content -LiteralPath $planFile -Raw -Encoding UTF8 | ConvertFrom-Json
      @{ command = $command; plan = $plan; verb = $Verb; windowStyle = $WindowStyle; arguments = $ArgumentList; executable = $FilePath } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath ${literal(audit)} -Encoding UTF8
      @{ ok = $true } | ConvertTo-Json | Set-Content -LiteralPath $plan.result -Encoding UTF8
      [pscustomobject]@{ ExitCode = 0 }
    }
    & ${literal(script)} -Vault ${literal(f.vault)} -Source ${literal(f.source)}
  `);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const capture = JSON.parse(fs.readFileSync(audit, 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(capture.verb, 'RunAs');
  assert.equal(capture.windowStyle, 'Hidden');
  assert.equal(capture.plan.homes[0].vault, f.vault);
  assert.equal(capture.plan.homes[0].source, f.source);
  assert.match(capture.command, /-Plan '/);
  assert.ok(capture.arguments.includes('-EncodedCommand'));
  assert.equal(fs.existsSync(capture.plan.result), false, 'temporary UAC result is removed');
  assert.equal(fs.existsSync(capture.plan.result.replace(/\.result\.json$/, '')), false, 'temporary UAC plan is removed');
});
