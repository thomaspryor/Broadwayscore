// BRO-7171 leftover: off CI, owner-alert-router wrote digest rows into the
// shared checkout's tracked data/audit/alert-digest-queue.json, which
// sync-audit-checkout.sh resets and only CI drains: the row was lost. Off CI
// the router now writes a machine-local spool, and alert-digest-spool.js
// publishes it into origin's queue exactly once. Real git, a local bare remote.
// Run: node --test scripts/lib/alert-digest-spool.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-spool-'));
process.env.ALERT_DIGEST_SPOOL_PATH = path.join(TMP, 'spool.json');
const S = require('./alert-digest-spool.js');
const REL = 'data/audit/alert-digest-queue.json';

const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function remoteWith(rows) {
  const bare = path.join(TMP, `remote-${Math.random().toString(36).slice(2)}.git`);
  git(TMP, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = fs.mkdtempSync(path.join(TMP, 'seed-'));
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 't@t'); git(seed, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(seed, 'data/audit'), { recursive: true });
  fs.writeFileSync(path.join(seed, REL), JSON.stringify(rows, null, 2) + '\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-qm', 'seed');
  git(seed, 'remote', 'add', 'origin', bare); git(seed, 'push', '-q', 'origin', 'main');
  const clone = fs.mkdtempSync(path.join(TMP, 'clone-'));
  git(TMP, 'clone', '-q', bare, clone);
  git(clone, 'config', 'user.email', 't@t'); git(clone, 'config', 'user.name', 't');
  return { bare, clone, seed };
}
const originQueue = (bare) => JSON.parse(git(TMP, '--git-dir', bare, 'show', `main:${REL}`));
const reset = () => { for (const p of [S.spoolPath(), S.metaPath()]) fs.rmSync(p, { force: true }); };

test('off CI the router queues into the spool, never the tracked checkout file', () => {
  reset();
  // Spool mode is Mac-only by platform; force it so this also runs on Linux CI.
  const env = { ...process.env, ALERT_DIGEST_SPOOL_PATH: S.spoolPath(), ALERT_LEDGER_PATH: path.join(TMP, 'ledger.json'), ALERT_DIGEST_FORCE_SPOOL: '1' };
  delete env.CI; delete env.GITHUB_ACTIONS; delete env.ALERT_DIGEST_QUEUE_PATH; delete env.CLAUDE_CODE_REMOTE;
  const tracked = path.join(here, '..', '..', REL);
  const before = fs.existsSync(tracked) ? fs.readFileSync(tracked, 'utf8') : null;
  const r = spawnSync(process.execPath, ['-e', `
    const R = require(${JSON.stringify(path.join(here, 'owner-alert-router.js'))});
    R.queueDigestLine({ conditionKey: 'mac:test', title: 'Mac row', description: 'Mac row lost before', severity: 'warning' });`], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(S.readSpool().map((x) => x.conditionKey), ['mac:test']);
  const after = fs.existsSync(tracked) ? fs.readFileSync(tracked, 'utf8') : null;
  assert.equal(after, before, 'the shared checkout queue file is untouched');
});

// Ship-check: only the Mac runs sync-audit-checkout.sh (the flusher). A cloud
// Claude session must keep the tracked queue it commits, not an ephemeral spool.
test('queue location: Mac spools; a cloud session (CLAUDE_CODE_REMOTE) and CI use the tracked file', () => {
  const where = (extra) => {
    const env = { ...process.env, ...extra };
    for (const k of ['CI', 'GITHUB_ACTIONS', 'ALERT_DIGEST_QUEUE_PATH', 'ALERT_DIGEST_FORCE_SPOOL', 'CLAUDE_CODE_REMOTE']) if (!(k in extra)) delete env[k];
    const r = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(path.join(here, 'owner-alert-router.js'))})._DIGEST_QUEUE_PATH)`], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  assert.ok(where({ CLAUDE_CODE_REMOTE: 'true' }).endsWith(REL), 'cloud session');
  assert.ok(where({ GITHUB_ACTIONS: 'true' }).endsWith(REL), 'CI');
  assert.equal(where({}).endsWith(REL), process.platform !== 'darwin', 'local: spool on the Mac only');
});

test('flush merges into origin, trims the spool, and a landed in-flight flush is never re-pushed', () => {
  reset();
  const ci = { conditionKey: 'ci:row', title: 'CI', queuedAt: '2026-11-09T01:00:00.000Z' };
  const { bare, clone } = remoteWith([ci]);
  const mac = { conditionKey: 'mac:row', title: 'Mac', queuedAt: '2026-11-09T02:00:00.000Z' };
  fs.writeFileSync(S.spoolPath(), JSON.stringify([mac]));
  const r = S.flush({ repoDir: clone });
  assert.equal(r.pushed, true);
  assert.deepEqual(originQueue(bare).map((x) => x.conditionKey), ['ci:row', 'mac:row']);
  assert.deepEqual(S.readSpool(), [], 'published rows leave the spool');
  assert.equal(S.readMeta().published['mac:row'], mac.queuedAt);

  // health-check drains origin; a crash had left the same row + its landed commit in flight.
  const drain = fs.mkdtempSync(path.join(TMP, 'drain-'));
  git(TMP, 'clone', '-q', bare, drain);
  git(drain, 'config', 'user.email', 't@t'); git(drain, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(drain, REL), '[]\n');
  git(drain, 'commit', '-qam', 'drain'); git(drain, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(S.spoolPath(), JSON.stringify([mac]));
  fs.writeFileSync(S.metaPath(), JSON.stringify({ published: {}, removals: {}, inflight: { commit: r.commit, rows: [{ k: 'mac:row', q: mac.queuedAt }], removals: {} } }));
  const r2 = S.flush({ repoDir: clone });
  assert.equal(r2.resolvedInflight, true);
  assert.equal(r2.pushed, false);
  assert.deepEqual(originQueue(bare), [], 'a drained row is not brought back');
});

test('removal tombstones remove only rows this machine published, queued at or before the removal', () => {
  reset();
  const old = { conditionKey: 'mac:gone', title: 'x', queuedAt: '2026-11-09T01:00:00.000Z' };
  const other = { conditionKey: 'ci:same-name', title: 'y', queuedAt: '2026-11-09T01:00:00.000Z' };
  const { bare, clone } = remoteWith([old, other]);
  fs.writeFileSync(S.metaPath(), JSON.stringify({ published: { 'mac:gone': old.queuedAt }, removals: {}, inflight: null }));
  assert.equal(S.recordRemovals(['mac:gone', 'ci:same-name'], '2026-11-09T03:00:00.000Z'), 1, 'only a key we published is tombstoned');
  S.flush({ repoDir: clone });
  assert.deepEqual(originQueue(bare).map((x) => x.conditionKey), ['ci:same-name']);
  assert.deepEqual(S.readMeta().removals, {});
  // pure rule: a row re-queued after the removal survives it
  const merged = S.mergeIntoOrigin([{ ...old, queuedAt: '2026-11-09T04:00:00.000Z' }], [], { 'mac:gone': '2026-11-09T03:00:00.000Z' });
  assert.equal(merged.length, 1);
});
