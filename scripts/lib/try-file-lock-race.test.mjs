// BRO-7171 leftover: non-blocking ("skip if busy") locks that break a dead
// holder's lock by unlink-then-wx let two waiters that both saw the dead
// holder both win: the second unlinks the first one's fresh lock.
// cookie-renew.acquireLock and recovery-run-lock.acquireRunLock had that
// shape; both now use file-lock.tryAcquireFileLock (in-place claim under the
// steal gate, task #1024). Real processes racing on one dead-holder lock.
// Run: node --test scripts/lib/try-file-lock-race.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { tryAcquireFileLock } = require('./file-lock.js');

// Each racer spins to a shared start instant, tries once, and if it won holds
// the lock for 400ms, logging enter/exit. More than one inside = a steal.
const ACQUIRERS = {
  'cookie-renew.acquireLock': (lib) => `const rel = require(${JSON.stringify(path.join(lib, 'cookie-renew.js'))}).acquireLock(lock); const got = !!rel; const release = rel || (() => {});`,
  'recovery-run-lock.acquireRunLock': (lib) => `process.env.RECOVERY_RUN_LOCK_PATH = lock; let got = false, release = () => {};
    try { release = require(${JSON.stringify(path.join(lib, 'recovery-run-lock.js'))}).acquireRunLock('race'); got = true; } catch (e) { if (e.code !== 'ERUNLOCKBUSY') throw e; }`,
  'file-lock.tryAcquireFileLock': (lib) => `const rel = require(${JSON.stringify(path.join(lib, 'file-lock.js'))}).tryAcquireFileLock(lock); const got = !!rel; const release = rel || (() => {});`,
};

for (const [name, snippet] of Object.entries(ACQUIRERS)) {
  test(`${name}: racers on one dead-holder lock never hold it at once`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'try-lock-race-'));
    const lock = path.join(dir, 'x.lock');
    const marker = path.join(dir, 'marker.txt');
    fs.writeFileSync(marker, '');
    const worker = path.join(dir, 'w.cjs');
    fs.writeFileSync(worker, `
      const fs = require('fs');
      const [lock, marker, startAt] = process.argv.slice(2);
      while (Date.now() < Number(startAt)) {}
      ${snippet(here)}
      if (got) {
        fs.appendFileSync(marker, 'enter\\n');
        const until = Date.now() + 400; while (Date.now() < until) {}
        fs.appendFileSync(marker, 'exit\\n');
        release();
      }
    `);
    let maxInside = 0;
    for (let round = 0; round < 4 && maxInside <= 1; round++) {
      fs.writeFileSync(lock, '999999 2020-01-01T00:00:00Z\n'); // dead holder
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(lock, old, old);
      fs.writeFileSync(marker, '');
      const startAt = Date.now() + 700;
      await Promise.all(Array.from({ length: 10 }, () => new Promise((resolve, reject) => {
        execFile(process.execPath, [worker, lock, marker, String(startAt)], (err, so, se) => (err ? reject(new Error(err.message + se)) : resolve()));
      })));
      let inside = 0;
      const lines = fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean);
      for (const l of lines) { inside += l === 'enter' ? 1 : -1; maxInside = Math.max(maxInside, inside); }
      assert.ok(lines.length >= 2, 'at least one racer took the dead holder\'s lock');
    }
    assert.equal(maxInside, 1, `${maxInside} racers held the lock at once`);
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// Class guard: no new lock acquirer breaks a stale lock by unlink/rm and then
// re-creates it with wx. Use file-lock's withFileLock / tryAcquireFileLock.
// Matched all five pre-fix acquirers (cookie-renew, recovery-run-lock,
// codex-runner, claude-tab-relaunch, owner-decision-recall).
const STEAL_RE = /['"]wx['"][\s\S]{0,1500}?(?:EEXIST|catch \{ \/\* held)[\s\S]{0,900}?(?:unlinkSync|rmSync)\(/;
const STEAL_ALLOW = new Map([
  ['scripts/migrate-reroute-backlog.js', 'wx guards a one-shot target write, not a lock'],
  ['scripts/dispatch-ingest-batch.js', 'never steals: EEXIST throws; the unlink is its own release'],
  ['scripts/lib/autonomous-ledger.js', 'autonomous loop retired 2026-07-27; kills a wedged holder first'],
]);
test('class guard: no unlink-then-wx stale-lock steal outside file-lock.js', () => {
  const repo = path.resolve(here, '..', '..');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return ['node_modules', '.git'].includes(e.name) ? [] : walk(p);
    return /\.(c?js|mjs)$/.test(e.name) && !/\.test\./.test(e.name) ? [p] : [];
  });
  const hits = walk(path.join(repo, 'scripts')).map((f) => path.relative(repo, f))
    .filter((rel) => rel !== 'scripts/lib/file-lock.js' && !STEAL_ALLOW.has(rel) && STEAL_RE.test(fs.readFileSync(path.join(repo, rel), 'utf8')));
  assert.deepEqual(hits, [], 'use file-lock tryAcquireFileLock/withFileLock instead of unlink-then-wx');
});

test('tryAcquireFileLock: live holder -> null; release removes only its own body', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'try-lock-'));
  const lock = path.join(dir, 'y.lock');
  fs.writeFileSync(lock, `${process.ppid} live\n`);
  assert.equal(tryAcquireFileLock(lock), null, 'a live holder is never stolen');
  fs.unlinkSync(lock);
  const release = tryAcquireFileLock(lock);
  assert.equal(typeof release, 'function');
  fs.writeFileSync(lock, 'someone-else\n'); // our lock was taken over (abandoned-age steal)
  release();
  assert.equal(fs.readFileSync(lock, 'utf8'), 'someone-else\n', 'release never deletes a successor');
  // abandonedMs: an old lock is stale even with a live pid.
  const old = new Date(Date.now() - 10_000);
  fs.writeFileSync(lock, `${process.ppid} live\n`);
  fs.utimesSync(lock, old, old);
  assert.equal(typeof tryAcquireFileLock(lock, { abandonedMs: 5000 }), 'function');
  fs.rmSync(dir, { recursive: true, force: true });
});
