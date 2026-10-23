// BRO-6083: scripts/coordinator-check.js --land against a temp git repo, Linear injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { run } = require('../../scripts/coordinator-check.js');

const NOTE = { id: '44e3f2b8-aaaa-bbbb-cccc-000000000001', body: 'COORDINATOR-NOTE: do not start a parallel fix of the lease', createdAt: '2026-10-23T14:21:00.000Z' };

function repo(files, message) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'README'), 'x'); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'work');
  for (const f of files) { fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), 'y'); }
  g('add', '.'); g('commit', '-qm', message);
  return dir;
}

async function land(dir, extra = [], card = { ok: true, url: 'u', comments: [NOTE] }) {
  const out = []; const err = []; const calls = [];
  const fetchCard = async (c) => { calls.push(c); return card; };
  const code = await run(['--land', '--base', 'main', '--head', 'work', '--cwd', dir, ...extra], { fetchCard, out: (s) => out.push(s), err: (s) => err.push(s), env: {} });
  return { code, out: out.join('\n'), err: err.join('\n'), calls };
}

test('lane land without ack is reported with card and latest note, exit 0 (advisory)', async () => {
  const r = await land(repo(['scripts/lib/opening-night-lane/lease.js'], 'fix lease'), ['--github']);
  assert.equal(r.code, 0);
  assert.match(r.err, /BRO-5955/);
  assert.match(r.err, /do not start a parallel fix of the lease/);
  assert.match(r.out, /^::warning title=Coordinator card not acknowledged/m);
});

test('--strict exits 1 on warn; acked land exits 0 and is quiet', async () => {
  assert.equal((await land(repo(['scripts/lib/opening-night-lane/lease.js'], 'fix'), ['--strict'])).code, 1);
  const ok = await land(repo(['scripts/lib/opening-night-lane/lease.js'], 'fix\n\nCOORDINATOR-ACK: BRO-5955@44e3f2b8'), ['--strict']);
  assert.equal(ok.code, 0);
  assert.equal(ok.err, '');
});

test('land outside any area never calls Linear', async () => {
  const r = await land(repo(['src/app/page.tsx'], 'ui'));
  assert.equal(r.code, 0);
  assert.deepEqual(r.calls, []);
  assert.match(r.out, /no coordinated area/);
});

test('Linear down is reported as unknown, exit 0 even with --strict', async () => {
  const r = await land(repo(['scripts/opening-night-poller.js'], 'x'), ['--strict', '--json'], { ok: false, error: 'timeout' });
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).status, 'unknown');
});

test('a bad ref fails open', async () => {
  const dir = repo(['x.js'], 'x');
  const err = [];
  const code = await run(['--land', '--base', 'nope', '--head', 'work', '--cwd', dir], { fetchCard: async () => ({ ok: true, comments: [] }), out: () => {}, err: (s) => err.push(s), env: {} });
  assert.equal(code, 0);
  assert.match(err.join(''), /skipping/);
});

test('--card reminder names the coordinator for an opening-night card', async () => {
  const out = [];
  const fetchCard = async (c) => (c === 'BRO-1' ? { ok: true, title: 'Poller: opening night retry', description: '', comments: [] } : { ok: true, url: 'u', comments: [NOTE] });
  assert.equal(await run(['--card', 'BRO-1'], { fetchCard, out: (s) => out.push(s), err: () => {} }), 0);
  assert.match(out.join('\n'), /coordinated on BRO-5955[\s\S]*COORDINATOR-ACK: BRO-5955@44e3f2b8/);
});

test('startReminder: opening-night card text gets BRO-5955, others and the coordinator itself get nothing', async () => {
  const { startReminder } = require('../../scripts/coordinator-check.js');
  const fetchCard = async () => ({ ok: true, url: 'u', comments: [NOTE] });
  assert.match(await startReminder('Opening night poller misses BWW', { fetchCard }), /coordinated on BRO-5955/);
  assert.equal(await startReminder('Homepage spacing', { fetchCard }), '');
  assert.equal(await startReminder('opening night lane cutover', { fetchCard, exclude: 'BRO-5955' }), '');
  assert.equal(await startReminder('opening night', { fetchCard: async () => { throw new Error('x'); } }), '');
});

test('linear-brain get prints the coordinator reminder to stderr, stdout stays JSON, a throwing reminder is harmless', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const run = (reminder) => spawnSync(process.execPath, ['-e', `
    const { main } = require('./scripts/linear-brain.js');
    main(['get', 'BRO-9001'], {
      getIssue: async () => ({ identifier: 'BRO-9001', title: 'Opening night poller', description: 'd', url: 'u', state: { name: 'Todo', type: 'unstarted' } }),
      coordinatorReminder: ${reminder},
    });
  `], { cwd: root, encoding: 'utf8', timeout: 15000 });
  const ok = run(`async (text, exclude) => 'REMINDER for ' + exclude + ': ' + text.split('\\n')[0]`);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).identifier, 'BRO-9001');
  assert.match(ok.stderr, /REMINDER for BRO-9001: Opening night poller/);
  const bad = run(`async () => { throw new Error('linear down'); }`);
  assert.equal(bad.status, 0, bad.stderr);
  assert.equal(JSON.parse(bad.stdout).identifier, 'BRO-9001');
});
