// BRO-5649: Codex-written tests, collector, land preflight and the Claude check run as a keyless
// sandbox user (scripts/lib/codex-sandbox.js). The pure tests pin the env and argv; the live tests
// prove from INSIDE a sandboxed run that no runner key is readable: not in its env, not on any
// ancestor's /proc environ or cmdline. They run where the slot-0 sandbox user exists (the Codex
// runner creates it; tests never create OS users) and this process can become it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const S = require('../../scripts/lib/codex-sandbox.js');

const SECRETS = {
  ANTHROPIC_API_KEY: 'sk-ant-sentinel-0123456789abcdef',
  REVIEW_TEXTS_TOKEN: 'ghp_sentinel0123456789abcdefghij',
  CODEX_RUNNER_PUSH_TOKEN: 'ghp_sentinelpush0123456789abcdef',
  GH_TOKEN: 'ghs_sentinel0123456789abcdefghij',
  LINEAR_API_KEY: 'lin_api_sentinel0123456789abcdef',
  OPENAI_API_KEY: 'sk-proj-sentinel0123456789abcdef',
};

test('sandboxEnv: only PASS_ENV, its own HOME/TMPDIR, isolated git config; no runner secret', () => {
  const env = sandboxEnvFrom({ ...SECRETS, PATH: '/usr/bin', HOME: '/home/runner', CI: 'true', NODE_OPTIONS: '--require /x.js' });
  for (const [k, v] of Object.entries(SECRETS)) {
    assert.ok(!(k in env), `${k} passed`);
    assert.ok(!Object.values(env).includes(v), `${k}'s value passed`);
  }
  assert.equal(env.HOME, '/tmp/sbx');
  assert.equal(env.TMPDIR, '/tmp/sbx');
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.CI, 'true');
  assert.ok(!('NODE_OPTIONS' in env), 'NODE_OPTIONS would preload code into the runner-side launcher');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  const cfg = Object.fromEntries(Array.from({ length: Number(env.GIT_CONFIG_COUNT) }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`] + '#' + i, env[`GIT_CONFIG_VALUE_${i}`]]));
  assert.ok(Object.entries(cfg).some(([k, v]) => k.startsWith('safe.directory#') && v === '*'));
  assert.ok(Object.entries(cfg).some(([k, v]) => k.startsWith('core.hooksPath#') && v === '/dev/null'));
  assert.ok(Object.entries(cfg).some(([k, v]) => k.includes('pushInsteadOf') && v === 'https://github.com/'));
});

function sandboxEnvFrom(env) { return S.sandboxEnv(env, { home: '/tmp/sbx' }); }

test('sandboxArgv: runuser as root, sudo -n otherwise, env -i before the command', () => {
  const env = { PATH: '/usr/bin', HOME: '/tmp/sbx' };
  assert.deepEqual(S.sandboxArgv('codexsb0', 'node', ['-e', '1'], env, { root: true }),
    ['runuser', '-u', 'codexsb0', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin', 'HOME=/tmp/sbx', 'node', '-e', '1']);
  assert.deepEqual(S.sandboxArgv('codexsb2', 'node', [], env, { root: false }).slice(0, 7),
    ['sudo', '-n', '-u', 'codexsb2', '--', '/usr/bin/env', '-i']);
});

test('sandboxUser: one user per runner slot', () => {
  assert.equal(S.sandboxUser(), 'codexsb0');
  assert.equal(S.sandboxUser(0), 'codexsb0');
  assert.equal(S.sandboxUser(3), 'codexsb3');
});

test('parseMarked: the last marked line wins; anything else is null', () => {
  assert.deepEqual(S.parseMarked(`noise\n${S.JSON_MARK}{"a":1}\n${S.JSON_MARK}{"a":2}\ntrailing`), { a: 2 });
  assert.equal(S.parseMarked('no marker'), null);
  assert.equal(S.parseMarked(`${S.JSON_MARK}{bad`), null);
});

// ---- live: from inside the sandbox ----

const USER = S.sandboxUser(0);
const liveSkip = (() => {
  if (process.platform !== 'linux') return 'needs Linux';
  if (spawnSync('id', ['-u', USER]).status !== 0) return `no ${USER} user here (the Codex runner creates it)`;
  const root = process.getuid() === 0;
  if (!root && spawnSync('sudo', ['-n', 'true']).status !== 0) return 'cannot become the sandbox user (no root, no passwordless sudo)';
  return false;
})();

// Prints its env keys (the guard's evidence), its uid, and for every ancestor whether its
// environ/cmdline could be read and whether either holds a sentinel. Sentinels come on stdin: on
// argv they would sit in the probe's own cmdline.
const PROBE = `
const fs=require('fs');const sent=JSON.parse(fs.readFileSync(0,'utf8'));
const has=(s)=>sent.some((v)=>s.includes(v));
const rows=[];let pid=process.pid;
for(let i=0;i<12&&pid>1;i++){
  const row={pid};
  for(const f of ['environ','cmdline']){try{row[f]=has(fs.readFileSync('/proc/'+pid+'/'+f,'utf8'))?'LEAK':'clean'}catch(e){row[f]=e.code}}
  rows.push(row);
  try{pid=Number(fs.readFileSync('/proc/'+pid+'/stat','utf8').split(') ')[1].split(' ')[1])}catch{break}
}
console.log('sandboxed process.env keys: '+Object.keys(process.env).sort().join(','));
console.log(${JSON.stringify(S.JSON_MARK)}+JSON.stringify({uid:process.getuid(),keys:Object.keys(process.env),selfHas:has(JSON.stringify(process.env)),rows}));
`;

test('live: a sandboxed run cannot read any runner key (env, ancestor environ, ancestor cmdline)', { skip: liveSkip }, () => {
  const saved = { ...process.env };
  Object.assign(process.env, SECRETS);
  try {
    const SB = S.createSandbox({ user: USER, root: process.cwd() });
    const ready = SB.ensure();
    assert.ok(ready.ok, ready.why);
    const r = SB.runMarked(process.cwd(), PROBE, [], { timeoutMs: 60_000, input: JSON.stringify(Object.values(SECRETS)) });
    console.log(r.out.split('\n').find((l) => l.startsWith('sandboxed process.env keys')));
    assert.ok(r.value, `no probe result: ${r.out}`);
    assert.notEqual(r.value.uid, process.getuid(), 'ran as the runner uid');
    assert.equal(r.value.selfHas, false, 'a sentinel reached the sandbox env');
    for (const k of Object.keys(SECRETS)) assert.ok(!r.value.keys.includes(k), `${k} in the sandbox env`);
    assert.ok(r.value.rows.length >= 2, 'probe saw no ancestors');
    for (const row of r.value.rows) {
      assert.notEqual(row.environ, 'LEAK', `pid ${row.pid} environ readable with a key`);
      assert.notEqual(row.cmdline, 'LEAK', `pid ${row.pid} cmdline holds a key`);
    }
    // The runner itself (this process) holds the sentinels: its environ must be EACCES.
    const self = r.value.rows.find((row) => row.pid === process.pid);
    if (self) assert.equal(self.environ, 'EACCES');
  } finally {
    for (const k of Object.keys(SECRETS)) if (!(k in saved)) delete process.env[k]; else process.env[k] = saved[k];
  }
});

test('live: secretEnv reaches the command through a file, never argv, and the file is gone', { skip: liveSkip }, () => {
  const SB = S.createSandbox({ user: USER, root: process.cwd() });
  const key = 'sk-ant-sentinel-reviewer-auth-0123456789';
  const code = `const fs=require('fs');const key=fs.readFileSync(0,'utf8');let p=process.pid,argvHit=false;for(let i=0;i<12&&p>1;i++){try{if(fs.readFileSync('/proc/'+p+'/cmdline','utf8').includes(key))argvHit=true}catch{};try{p=Number(fs.readFileSync('/proc/'+p+'/stat','utf8').split(') ')[1].split(' ')[1])}catch{break}}
console.log(${JSON.stringify(S.JSON_MARK)}+JSON.stringify({got:process.env.ANTHROPIC_API_KEY===key,argvHit,file:'SANDBOX_SECRET_FILE' in process.env,left:fs.readdirSync(process.env.HOME).filter((f)=>f.includes('secret'))}))`;
  const r = SB.run(process.cwd(), 'node', ['-e', code], { timeoutMs: 60_000, input: key, secretEnv: { ANTHROPIC_API_KEY: key } });
  const v = S.parseMarked(r.stdout);
  assert.ok(v, r.out);
  assert.deepEqual(v, { got: true, argvHit: false, file: false, left: [] });
});

test('live: withTrees hands a tree over and back, restoring a .git pointer the sandbox rewrote', { skip: liveSkip }, () => {
  const SB = S.createSandbox({ user: USER, root: process.cwd() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sandbox-tree-'));
  try {
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /real/gitdir\n');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.symlinkSync('/etc/hostname', path.join(dir, 'link'));
    const r = SB.withTrees([dir], () => SB.run(dir, 'node', ['-e',
      "const fs=require('fs');fs.writeFileSync('.git','gitdir: /attacker\\n');fs.writeFileSync('sub/made.txt','x');console.log('wrote')"], { timeoutMs: 60_000 }));
    assert.match(r.out, /wrote/);
    assert.equal(fs.readFileSync(path.join(dir, '.git'), 'utf8'), 'gitdir: /real/gitdir\n');
    for (const f of ['.', 'sub', 'sub/made.txt', '.git']) assert.equal(fs.lstatSync(path.join(dir, f)).uid, process.getuid(), `${f} not taken back`);
    assert.notEqual(fs.statSync('/etc/hostname').uid, spawnSync('id', ['-u', USER], { encoding: 'utf8' }).stdout.trim() * 1, 'followed a symlink');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('live: judgeLandSandboxed runs main\'s land preflight in the sandbox and returns its verdict', { skip: liveSkip }, () => {
  const SB = S.createSandbox({ user: USER, root: process.cwd() });
  assert.ok(SB.ensure().ok);
  const git = (...a) => spawnSync('git', a, { encoding: 'utf8' }).stdout.trim();
  const repo = git('rev-parse', '--show-toplevel');
  const objects = `${git('rev-parse', '--path-format=absolute', '--git-common-dir')}/objects`;
  const r = S.judgeLandSandboxed(SB, { preflight: path.join(repo, 'scripts/lib/land-preflight.mjs'), cwd: repo, target: 'refs/heads/land/sandbox-guard-probe', objects, timeoutMs: 120_000 });
  // A null value is the regression: the module ran its own CLI (argv[1] named it) or crashed.
  assert.ok(r.value, `no verdict: ${r.out.slice(-600)}`);
  assert.ok(['allow', 'block', 'skip'].includes(r.value.decision), JSON.stringify(r.value).slice(0, 300));
  assert.ok(r.value.detail && r.value.detail.rebase, 'no rebase detail');
});

test('live: dropStale removes a tree a dead sandbox run left behind, and keeps the runner\'s own', { skip: liveSkip }, () => {
  const SB = S.createSandbox({ user: USER, root: process.cwd() });
  const mine = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sandbox-mine-'));
  const left = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sandbox-left-'));
  try {
    fs.writeFileSync(path.join(mine, '.git'), 'gitdir: /real\n');
    fs.writeFileSync(path.join(left, '.git'), 'gitdir: /attacker\n');
    // A run killed inside withTrees: the tree is still the sandbox's.
    assert.equal(spawnSync(process.getuid() === 0 ? 'chown' : 'sudo', [...(process.getuid() === 0 ? [] : ['-n', 'chown']), '-R', `${USER}:`, left]).status, 0);
    assert.equal(SB.dropStale(mine), false);
    assert.ok(fs.existsSync(path.join(mine, '.git')));
    assert.equal(SB.dropStale(left), true);
    assert.equal(fs.existsSync(left), false);
    assert.equal(SB.dropStale(left), false, 'a missing tree is not stale');
  } finally { fs.rmSync(mine, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); spawnSync('rm', ['-rf', left]); }
});

test('readSandboxFile: reads a plain file, refuses a symlink, a fifo, a dir or a missing path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sandbox-read-'));
  try {
    fs.writeFileSync(path.join(dir, 'ok.log'), 'hello');
    fs.symlinkSync('/etc/hostname', path.join(dir, 'link.log'));
    spawnSync('mkfifo', [path.join(dir, 'pipe.log')]);
    assert.equal(S.readSandboxFile(path.join(dir, 'ok.log')), 'hello');
    assert.equal(S.readSandboxFile(path.join(dir, 'ok.log'), 3), 'hel', 'capped');
    for (const f of ['link.log', 'pipe.log', '.', 'missing.log']) assert.equal(S.readSandboxFile(path.join(dir, f)), null, f);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('live: dropStale with gitCommon drops a tree whose .git points anywhere but its worktrees dir', { skip: liveSkip }, () => {
  const SB = S.createSandbox({ user: USER, root: process.cwd() });
  const common = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sandbox-common-'));
  const trees = ['good', 'elsewhere', 'symlinked', 'garbage', 'relative'].map((n) => fs.mkdtempSync(path.join(os.tmpdir(), `codex-sandbox-${n}-`)));
  const [good, elsewhere, symlinked, garbage, relative] = trees;
  try {
    fs.writeFileSync(path.join(good, '.git'), `gitdir: ${common}/worktrees/good\n`);
    fs.writeFileSync(path.join(elsewhere, '.git'), `gitdir: ${common}/../attacker\n`);
    fs.symlinkSync(path.join(good, '.git'), path.join(symlinked, '.git'));
    fs.writeFileSync(path.join(garbage, '.git'), '[core]\n\tfsmonitor = /tmp/x\n');
    fs.writeFileSync(path.join(relative, '.git'), `gitdir: ${path.relative(relative, common)}/worktrees/relative\n`);
    assert.equal(SB.dropStale(good, { gitCommon: common }), false);
    assert.equal(SB.dropStale(relative, { gitCommon: common }), false, 'git resolves a relative pointer from the tree');
    for (const d of [elsewhere, symlinked, garbage]) {
      assert.equal(SB.dropStale(d, { gitCommon: common }), true, d);
      assert.equal(fs.existsSync(d), false, d);
    }
  } finally { for (const d of [common, ...trees]) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('live: CA files the runner points at are copied into the sandbox home', { skip: liveSkip }, () => {
  const SB = S.createSandbox({ user: USER, root: process.cwd() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sandbox-ca-'));
  const ca = path.join(dir, 'ca.pem');
  fs.writeFileSync(ca, '-----CA-----', { mode: 0o600 });
  const prev = process.env.NODE_EXTRA_CA_CERTS; process.env.NODE_EXTRA_CA_CERTS = ca;
  try {
    const code = `const fs=require('fs');const c=process.env.NODE_EXTRA_CA_CERTS;console.log(${JSON.stringify(S.JSON_MARK)}+JSON.stringify({inHome:c.startsWith(process.env.HOME),ca:fs.readFileSync(c,'utf8')}))`;
    const r = SB.runMarked(process.cwd(), code, [], { timeoutMs: 60_000 });
    assert.deepEqual(r.value, { inHome: true, ca: '-----CA-----' }, r.out);
  } finally {
    if (prev === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = prev;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test('live: a detached child named to look like a zombie is still killed', { skip: liveSkip }, () => {
  const SB = S.createSandbox({ user: USER, root: process.cwd() });
  // /proc/<pid>/stat is "pid (comm) state": a comm of "x) Z" fooled a parse at the first ') '.
  const code = "const {spawn}=require('child_process');spawn(process.execPath,['-e',\"process.title='x) Z y';setInterval(()=>{},1000)\"],{detached:true,stdio:'ignore'}).unref();setTimeout(()=>console.log('forked'),300)";
  const r = SB.run(process.cwd(), 'node', ['-e', code], { timeoutMs: 60_000 });
  assert.match(r.out, /forked/);
  const ps = spawnSync('pgrep', ['-u', USER], { encoding: 'utf8' }).stdout.trim();
  const live = ps ? ps.split('\n').filter((pid) => {
    try { const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return st[st.lastIndexOf(')') + 2] !== 'Z'; } catch { return false; }
  }) : [];
  assert.deepEqual(live, []);
});

test('loopbackProxyPort: only a loopback proxy counts', () => {
  assert.equal(S.loopbackProxyPort({ HTTPS_PROXY: 'http://127.0.0.1:39857' }), 39857);
  assert.equal(S.loopbackProxyPort({ https_proxy: 'http://localhost:3128' }), 3128);
  assert.equal(S.loopbackProxyPort({ HTTPS_PROXY: 'http://proxy.corp:8080' }), null);
  assert.equal(S.loopbackProxyPort({}), null);
  assert.ok(!S.PASS_ENV.some((k) => /proxy/i.test(k)), 'proxy vars stay out of the sandbox');
});

test('live: the sandbox cannot connect to the runner\'s egress proxy', { skip: liveSkip || (!S.loopbackProxyPort(process.env) && 'no loopback proxy here') }, () => {
  const SB = S.createSandbox({ user: USER, root: process.cwd() });
  assert.ok(SB.ensure().ok);
  const port = S.loopbackProxyPort(process.env);
  const code = `const c=require('net').connect(${port},'127.0.0.1');c.setTimeout(5000);const out=(v)=>{console.log(${JSON.stringify(S.JSON_MARK)}+JSON.stringify(v));process.exit(0)};c.on('connect',()=>out('connected'));c.on('error',(e)=>out(e.code));c.on('timeout',()=>out('timeout'))`;
  const r = SB.runMarked(process.cwd(), code, [], { timeoutMs: 60_000 });
  assert.notEqual(r.value, 'connected', r.out);
  assert.ok(r.value, r.out);
});
