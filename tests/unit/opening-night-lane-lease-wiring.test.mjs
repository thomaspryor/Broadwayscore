// BRO-4786 (BRO-4210 phase 2d): cross-machine lease claim + every competing writer honours the lease.
// Real functions and real git (temp bare repo); nothing under the repo is written.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const store = require('../../scripts/lib/opening-night-lane/lease-store.js');
const lease = require('../../scripts/lib/opening-night-lane/lease.js');
const guard = require('../../scripts/lib/opening-night-lane/lease-guard.js');

const SHOW = 'other-desert-cities-2026';
const NIGHT = '2026-10-18';
const tmp = (p = 'bro4786-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const noSleep = { sleep: () => {} };

function remoteWithTwoClones() {
  const base = tmp();
  const bare = path.join(base, 'remote.git');
  git(base, 'init', '--bare', '-q', bare);
  const clone = (n) => { const d = path.join(base, n); git(base, 'clone', '-q', bare, d); return d; };
  return { base, bare, a: clone('a'), b: clone('b') };
}

// ------------------------------------------------------------ CAS claim

test('CAS: two starters race for the same night, exactly one wins', () => {
  const { base, a, b } = remoteWithTwoClones();
  try {
    const args = (holder) => ({ show: SHOW, night: NIGHT, holder });
    // A reads the empty store, but B claims before A's push lands: A's push is rejected
    // (not a fast-forward), A re-reads, re-runs the pure transition and is told held-by-other.
    let raced = false;
    const resA = store.casTransition({ repoDir: a, ...noSleep }, (state) => {
      const out = lease.acquire(state, args('gha-1'));
      if (!raced) { raced = true; assert.equal(store.claim({ repoDir: b, ...noSleep }, args('mac-1')).ok, true); }
      return out;
    });
    assert.equal(resA.ok, false);
    assert.equal(resA.reason, 'held-by-other');
    assert.equal(resA.holder, 'mac-1');
    assert.equal(resA.attempts, 2);
    assert.equal(store.readRemote({ repoDir: a }).state.leases[`${SHOW}|${NIGHT}`].holder, 'mac-1');
  } finally { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('CAS: simultaneous starters in separate processes, exactly one acquires', () => {
  const { base, a, b } = remoteWithTwoClones();
  try {
    const script = (dir, holder) => `
      const s = require(${JSON.stringify(path.join(ROOT, 'scripts/lib/opening-night-lane/lease-store.js'))});
      const r = s.claim({ repoDir: ${JSON.stringify(dir)} }, { show: ${JSON.stringify(SHOW)}, night: ${JSON.stringify(NIGHT)}, holder: ${JSON.stringify(holder)} });
      console.log(JSON.stringify({ ok: r.ok, reason: r.reason }));`;
    const { spawn } = require('node:child_process');
    return Promise.all([['gha-9', a], ['mac-9', b]].map(([h, d]) => new Promise((res) => {
      let out = '';
      const p = spawn(process.execPath, ['-e', script(d, h)]);
      p.stdout.on('data', (c) => { out += c; });
      p.on('close', () => res(JSON.parse(out.trim().split('\n').pop())));
    }))).then((results) => {
      assert.equal(results.filter((r) => r.ok).length, 1, JSON.stringify(results));
      assert.equal(results.filter((r) => r.reason === 'held-by-other').length, 1, JSON.stringify(results));
    }).finally(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  } catch (e) { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); throw e; }
});

test('CAS: same holder renews, release frees the night, branch is separate from main history', () => {
  const { base, a, b } = remoteWithTwoClones();
  try {
    const args = { show: SHOW, night: NIGHT, holder: 'gha-2' };
    assert.equal(store.claim({ repoDir: a }, args).reason, 'acquired');
    assert.equal(store.claim({ repoDir: a }, args).reason, 'renewed');
    assert.equal(store.heartbeat({ repoDir: b }, { ...args, holder: 'mac-2' }).reason, 'held-by-other');
    assert.equal(store.release({ repoDir: b }, { ...args, holder: 'mac-2' }).ok, false);
    assert.equal(store.release({ repoDir: a }, args).reason, 'released');
    assert.equal(store.claim({ repoDir: b }, { ...args, holder: 'mac-2' }).reason, 'acquired');
  } finally { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('CAS: unreachable remote fails closed (never a grant)', () => {
  const dir = tmp();
  try {
    git(dir, 'init', '-q');
    git(dir, 'remote', 'add', 'origin', path.join(dir, 'nope.git'));
    const r = store.claim({ repoDir: dir, ...noSleep }, { show: SHOW, night: NIGHT, holder: 'gha-3' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'state-unreadable');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

// ------------------------------------------------------------ skip predicate

function leaseFile(dir, leases) {
  const f = path.join(dir, 'leases.json');
  fs.writeFileSync(f, JSON.stringify({ leases }));
  return f;
}
const live = (holder, mins = 30) => ({ holder, acquiredAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), expiresAt: new Date(Date.now() + mins * 60000).toISOString() });

test('skip predicate: leased skips, others / expired / missing file do not, lane holder passes, unreadable and unknown fail closed', () => {
  const dir = tmp();
  try {
    const f = leaseFile(dir, { [`${SHOW}|${NIGHT}`]: live('gha-1'), 'old-show-2026|2026-01-01': live('x', -5) });
    assert.equal(guard.leaseSkipReason(SHOW, { file: f, env: {} }).holder, 'gha-1');
    assert.equal(guard.leaseSkipReason('some-other-show', { file: f, env: {} }), null);
    assert.equal(guard.leaseSkipReason('old-show-2026', { file: f, env: {} }), null);
    assert.equal(guard.leaseSkipReason(SHOW, { file: f, env: { OPENING_NIGHT_LANE_HOLDER: 'gha-1' } }), null);
    assert.equal(guard.leaseSkipReason(SHOW, { file: path.join(dir, 'missing.json'), env: {} }), null);
    const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, '{not json');
    assert.equal(guard.leaseSkipReason(SHOW, { file: bad, env: {} }).unreadable, true);
    const unk = path.join(dir, 'unk.json'); fs.writeFileSync(unk, JSON.stringify({ leases: {}, unknown: true }));
    assert.equal(guard.leaseSkipReason(SHOW, { file: unk, env: {} }).unreadable, true);
    assert.deepEqual(guard.leasedShowIds({ file: f, env: {} }), [SHOW]);
    assert.deepEqual(guard.partitionLeased([SHOW, 'a-2026'], { file: f, env: {} }).kept, ['a-2026']);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

function runScript(args, leasesFile) {
  return spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', timeout: 60000, env: { ...process.env, OPENING_NIGHT_LEASES_FILE: leasesFile, OPENING_NIGHT_LANE_HOLDER: '' } });
}

test('opening-night-poller skips a leased show and exits 0 before any fetch', () => {
  const dir = tmp();
  try {
    const f = leaseFile(dir, { [`${SHOW}|${NIGHT}`]: live('gha-1') });
    const r = runScript(['scripts/opening-night-poller.js', `--show=${SHOW}`, '--dry-run'], f);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Opening-night lease: .*Poller skipping/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('gather-reviews drops a leased show and does nothing when all are leased', () => {
  const dir = tmp();
  try {
    const f = leaseFile(dir, { [`${SHOW}|${NIGHT}`]: live('gha-1') });
    const r = runScript(['scripts/gather-reviews.js', `--shows=${SHOW}`], f);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Skipping in gather-reviews/);
    assert.match(r.stdout, /All requested shows are leased/);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('rebuild-all-reviews skips leased dirs and carries their rows over (wired before the aggregate write)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
  assert.match(src, /lease-guard/);
  const skipAt = src.indexOf('.filter(f => !leasedShowIds.has(f))');
  const carryAt = src.indexOf('[LEASE CARRY-OVER]');
  const writeAt = src.indexOf('fs.writeFileSync(reviewsTmpPath');
  assert.ok(skipAt > 0 && carryAt > skipAt && writeAt > carryAt, 'skip, then carry-over, then write');
});

// ------------------------------------------------------------ push-review-texts refusal

test('revertLeasedChanges undoes tracked, staged, untracked and _pending writes under leased shows only', () => {
  const dir = tmp();
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
    for (const d of [SHOW, 'free-show-2026']) { fs.mkdirSync(path.join(dir, d)); fs.writeFileSync(path.join(dir, d, 'r.json'), '{"v":1}'); }
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
    fs.writeFileSync(path.join(dir, SHOW, 'r.json'), '{"v":2}');            // tracked edit
    fs.writeFileSync(path.join(dir, SHOW, 'new.json'), '{}');               // untracked
    fs.mkdirSync(path.join(dir, '_pending', SHOW), { recursive: true });
    fs.writeFileSync(path.join(dir, '_pending', SHOW, 'q.json'), '{}');     // quarantine mirror
    fs.writeFileSync(path.join(dir, 'free-show-2026', 'r.json'), '{"v":2}'); // not leased: kept
    git(dir, 'add', `${SHOW}/r.json`);                                       // staged edit
    const reverted = guard.revertLeasedChanges(dir, [SHOW]);
    assert.equal(reverted.length, 3);
    assert.equal(fs.readFileSync(path.join(dir, SHOW, 'r.json'), 'utf8'), '{"v":1}');
    assert.equal(fs.existsSync(path.join(dir, SHOW, 'new.json')), false);
    assert.equal(fs.existsSync(path.join(dir, '_pending', SHOW, 'q.json')), false);
    assert.equal(fs.readFileSync(path.join(dir, 'free-show-2026', 'r.json'), 'utf8'), '{"v":2}');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('revertLeasedChanges handles staged new files and renames (autostash-conflict staging path)', () => {
  const dir = tmp();
  try {
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't');
    fs.mkdirSync(path.join(dir, SHOW));
    fs.writeFileSync(path.join(dir, SHOW, 'a.json'), '{"keep":"this one is long enough to be detected as a rename"}');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'base');
    git(dir, 'mv', `${SHOW}/a.json`, `${SHOW}/b.json`);                       // staged rename
    fs.writeFileSync(path.join(dir, SHOW, 'new.json'), '{}'); git(dir, 'add', `${SHOW}/new.json`); // staged add
    guard.revertLeasedChanges(dir, [SHOW]);
    assert.equal(git(dir, 'status', '--porcelain'), '');
    assert.equal(fs.existsSync(path.join(dir, SHOW, 'a.json')), true);
    assert.equal(fs.existsSync(path.join(dir, SHOW, 'b.json')), false);
    assert.equal(fs.existsSync(path.join(dir, SHOW, 'new.json')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

// ------------------------------------------------------------ structural: every workflow calls it

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('structural: every competing workflow syncs leases after each review-texts checkout', () => {
  for (const w of ['opening-night-poller', 'opening-night-express', 'gather-reviews', 'enrich-reviews', 'rebuild-reviews', 'rebuild-fast']) {
    const y = read(`.github/workflows/${w}.yml`);
    const checkouts = [...y.matchAll(/uses: \.\/\.github\/actions\/checkout-review-texts/g)].length;
    const syncs = [...y.matchAll(/uses: \.\/\.github\/actions\/opening-night-lease-sync/g)].length;
    assert.ok(checkouts > 0, `${w} has no review-texts checkout (list is stale)`);
    assert.equal(syncs, checkouts, `${w}: ${checkouts} checkout(s) but ${syncs} lease sync step(s)`);
  }
});

test('structural: push-review-texts enforces the lease before staging, and the sync action runs the CLI', () => {
  const a = read('.github/actions/push-review-texts/action.yml');
  const enforceAt = a.indexOf('opening-night-lease.js" enforce');
  assert.ok(enforceAt > 0, 'enforce call missing');
  assert.ok(enforceAt < a.indexOf('# Stage all changes'), 'enforce must run before the staging step');
  assert.ok(a.indexOf('opening-night-lease.js" sync') > 0 && a.indexOf('opening-night-lease.js" sync') < enforceAt, 'push action must re-sync before enforce');
  assert.match(a, /enforce --dir="\$GITHUB_WORKSPACE\/data\/review-texts"/);
  assert.match(read('.github/actions/opening-night-lease-sync/action.yml'), /opening-night-lease\.js" sync/);
  assert.match(read('.gitignore'), /^data\/opening-night\/leases\.json$/m);
});

test('structural: the scripts named in the issue call the shared guard', () => {
  for (const s of ['scripts/opening-night-poller.js', 'scripts/gather-reviews.js', 'scripts/rebuild-all-reviews.js']) {
    assert.match(read(s), /opening-night-lane\/lease-guard/, `${s} must use the lease guard`);
  }
});
