// BRO-2954: a lease with pid:null (job in its first seconds of startup) must
// read as ALIVE at every lease-reading call site, never dead/orphaned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { leaseLooksLive, PID_NULL_GRACE_MS } = require('../../scripts/lib/bsc-runner.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const NOW = Date.UTC(2026, 9, 14, 12);
const ago = (ms) => new Date(NOW - ms).toISOString();

test('leaseLooksLive: pid:null is live inside the startup grace, dead pid is dead, no lease is dead', () => {
  const never = () => false;
  assert.equal(leaseLooksLive({ pid: null, acquiredAt: ago(5_000) }, never, NOW), true);
  assert.equal(leaseLooksLive({ acquiredAt: ago(5_000) }, never, NOW), true);
  assert.equal(leaseLooksLive({ pid: 123 }, never, NOW), false);
  assert.equal(leaseLooksLive({ pid: 123 }, () => true, NOW), false, 'pid with no identity timestamp is not a live lease');
  assert.equal(leaseLooksLive({ pid: 123, acquiredAt: ago(5_000) }, () => true, NOW, () => true), true);
  assert.equal(leaseLooksLive(null, () => true, NOW), false);
  assert.equal(leaseLooksLive(undefined, () => true, NOW), false);
});

test('leaseLooksLive: pid:null past the grace (crashed before spawn) or with no acquiredAt reads dead', () => {
  const always = () => true; // never consulted for pid:null
  assert.equal(leaseLooksLive({ pid: null, acquiredAt: ago(PID_NULL_GRACE_MS - 1) }, always, NOW), true);
  assert.equal(leaseLooksLive({ pid: null, acquiredAt: ago(PID_NULL_GRACE_MS) }, always, NOW), false);
  assert.equal(leaseLooksLive({ pid: null, acquiredAt: ago(6 * 3600_000) }, always, NOW), false);
  assert.equal(leaseLooksLive({ pid: null }, always, NOW), false, 'malformed lease (no acquiredAt) is not a starting job');
  assert.equal(leaseLooksLive({}, always, NOW), false);
});

test('leaseLooksLive: grace is the one bsc-reconcile orphan sweeps use', () => {
  const { GRACE_MS } = require('../../scripts/bsc-reconcile.js');
  assert.equal(GRACE_MS, PID_NULL_GRACE_MS);
});

test('leaseLooksLive: default liveness check treats a fresh pid:null as live without consulting ps', () => {
  assert.equal(leaseLooksLive({ pid: null, acquiredAt: new Date().toISOString() }), true);
  assert.equal(leaseLooksLive({ pid: 2 ** 22 + 12345 }), false);
});

// Guard for every call site named on the card (and any future one): scripts
// may not re-derive lease liveness with a bare pidLooksLikeClaude(<x>.pid).
test('no script re-derives lease liveness with a bare pidLooksLikeClaude(lease.pid)', () => {
  const offenders = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(js|mjs)$/.test(e.name) || /\.test\.m?js$/.test(e.name)) continue;
      if (p.endsWith(path.join('lib', 'bsc-runner.js'))) continue;
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      lines.forEach((line, i) => {
        // Sites that pair pid:null with their own GRACE_MS age check carry this marker on the line above.
        if (i > 0 && lines[i - 1].includes('pid-null-grace-ok')) return;
        if (/pidLooksLikeClaude(Fn)?\(\s*[\w.?]+\??\.pid\s*\)/.test(line)) offenders.push(`${path.relative(ROOT, p)}:${i + 1}`);
      });
    }
  };
  walk(path.join(ROOT, 'scripts'));
  assert.deepEqual(offenders, [], 'use leaseLooksLive(lease[, isAliveFn]) from scripts/lib/bsc-runner.js');
});

test('every site named on BRO-2954 uses leaseLooksLive', () => {
  for (const f of ['scripts/notion-tasks-sync.js', 'scripts/reconcile-landed-but-open.js', 'scripts/bsc-status.js',
    'scripts/audit-archived-in-progress.js', 'scripts/bsc-reconcile.js']) {
    assert.match(fs.readFileSync(path.join(ROOT, f), 'utf8'), /leaseLooksLive\(/, f);
  }
});

test('grace-judged sweep sites keep pid:null as not-alive (crashed-at-startup leases must still be reclaimed)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/bsc-reconcile.js'), 'utf8');
  assert.equal((src.match(/pid-null-grace-ok/g) || []).length, 1);
  assert.match(src, /pidLooksLikeClaudeFn\(lease\.pid\)/);
  assert.match(src, /if \(leaseLooksLive\(lease\)\) continue; \/\/ matching process/);
});
