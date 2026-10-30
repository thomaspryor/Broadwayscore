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

test('skip predicate: leased skips, others / expired / missing file do not, lane holder passes', () => {
  const dir = tmp();
  try {
    const f = leaseFile(dir, { [`${SHOW}|${NIGHT}`]: live('gha-1'), 'old-show-2026|2026-01-01': live('x', -5) });
    assert.equal(guard.leaseSkipReason(SHOW, { file: f, env: {} }).holder, 'gha-1');
    assert.equal(guard.leaseSkipReason('some-other-show', { file: f, env: {} }), null);
    assert.equal(guard.leaseSkipReason('old-show-2026', { file: f, env: {} }), null);
    assert.equal(guard.leaseSkipReason(SHOW, { file: f, env: { OPENING_NIGHT_LANE_HOLDER: 'gha-1' } }), null);
    assert.equal(guard.leaseSkipReason(SHOW, { file: path.join(dir, 'missing.json'), env: {} }), null);
    assert.deepEqual(guard.leasedShowIds({ file: f, env: {} }), [SHOW]);
    assert.deepEqual(guard.partitionLeased([SHOW, 'a-2026'], { file: f, env: {} }).kept, ['a-2026']);
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

// BRO-6648 S1-T0: unknown lease state = only tonight's shows wait; every other show writes.
const { embargoForNight } = require('../../scripts/lib/opening-night-lane/lane-only-markets.js');
const TONIGHT_SHOW = { id: SHOW, title: 'Other Desert Cities', openingDate: NIGHT, category: 'broadway', status: 'previews' };
const LATER_SHOW = { id: 'later-show-2026', title: 'Later Show', openingDate: '2026-12-10', category: 'broadway', status: 'previews' };
const PRESS_NIGHT = Date.parse(embargoForNight(TONIGHT_SHOW, NIGHT));
function showsFixture(dir) { const f = path.join(dir, 'shows.json'); fs.writeFileSync(f, JSON.stringify({ shows: [TONIGHT_SHOW, LATER_SHOW] })); return f; }

test('unknown lease state: tonight waits, every other show writes (marker list, corrupt file, unreadable shows.json)', () => {
  assert.ok(Number.isFinite(PRESS_NIGHT), 'fixture show has an embargo');
  const dir = tmp();
  try {
    const env = { OPENING_NIGHT_SHOWS_FILE: showsFixture(dir) };
    const now = PRESS_NIGHT;
    assert.deepEqual(guard.tonightShowIds({ now, file: env.OPENING_NIGHT_SHOWS_FILE }), [SHOW]);
    assert.deepEqual(guard.tonightShowIds({ now: PRESS_NIGHT + 10 * 3600e3, file: env.OPENING_NIGHT_SHOWS_FILE }), [], 'window closes 9h after the embargo');
    assert.deepEqual(guard.tonightShowIds({ now, file: path.join(dir, 'nope.json') }), [], 'unreadable shows.json = nothing tonight');

    const marker = path.join(dir, 'unk.json'); fs.writeFileSync(marker, JSON.stringify({ leases: {}, unknown: true, tonight: [SHOW] }));
    const held = guard.leaseSkipReason(SHOW, { file: marker, env, now });
    assert.equal(held.unknown, true, 'tonight\'s show waits');
    assert.match(guard.describe(held), /press night is tonight/);
    assert.equal(guard.leaseSkipReason(LATER_SHOW.id, { file: marker, env, now }), null, 'another show writes');
    assert.deepEqual(guard.partitionLeased([SHOW, LATER_SHOW.id], { file: marker, env, now }).kept, [LATER_SHOW.id]);
    assert.deepEqual(guard.writeBlockedShowIds({ file: marker, env, now }), { unknown: true, shows: [SHOW] });
    assert.deepEqual(guard.leasedShowIds({ file: marker, env }), [], 'publish view names no show (old path publishes, as lane-only-markets)');

    const old = path.join(dir, 'old.json'); fs.writeFileSync(old, JSON.stringify({ leases: {}, unknown: true }));
    assert.equal(guard.leaseSkipReason(SHOW, { file: old, env, now }).unknown, true, 'a marker without a list computes tonight from shows.json');
    assert.equal(guard.leaseSkipReason(SHOW, { file: old, env, now: PRESS_NIGHT - 2 * 86400e3 }), null, 'two days before, the same show writes');

    const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, '{not json');
    assert.equal(guard.leaseSkipReason(SHOW, { file: bad, env, now }).unknown, true, 'corrupt file = unknown: tonight waits');
    assert.equal(guard.leaseSkipReason(LATER_SHOW.id, { file: bad, env, now }), null, 'corrupt file: another show writes');
    assert.equal(guard.leaseSkipReason(SHOW, { file: bad, env: { OPENING_NIGHT_SHOWS_FILE: path.join(dir, 'nope.json') }, now }), null, 'no shows.json: nothing is tonight, so it writes');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('sync failure: marker names tonight atomically, exits 0; alert routing is a card only on a press night', () => {
  const dir = tmp();
  try {
    const lf = path.join(dir, 'leases.json');
    const r = spawnSync(process.execPath, ['scripts/opening-night-lease.js', 'sync', `--remote=${path.join(dir, 'no-such-remote.git')}`], {
      cwd: ROOT, encoding: 'utf8', timeout: 90000,
      env: { ...process.env, OPENING_NIGHT_LEASES_FILE: lf, OPENING_NIGHT_SHOWS_FILE: path.join(dir, 'nope.json') },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /sync failed after 3 tries; tonight's show\(s\) wait \[none\], every other show writes/);
    const m = JSON.parse(fs.readFileSync(lf, 'utf8'));
    assert.equal(m.unknown, true);
    assert.deepEqual(m.tonight, []);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no tmp file left behind');

    const { leaseStoreAlert } = require('../../scripts/opening-night-lease-alert.js');
    const night = leaseStoreAlert({ unknown: true, shows: [SHOW] });
    assert.match(night.description, new RegExp(SHOW));
    assert.equal(leaseStoreAlert({ unknown: true, shows: [] }), null, 'nothing tonight: warning only, no ledger write');
    assert.equal(leaseStoreAlert({ unknown: false, shows: [SHOW] }), null, 'known state: no alert');
    const src = fs.readFileSync(path.join(ROOT, 'scripts/opening-night-lease.js'), 'utf8');
    assert.doesNotMatch(src, /owner-alert-router|guard-escalation/, 'the lease CLI must not reach routeAlert (alert-ledger LINEAR_API_KEY rule)');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('unknown: the writer window covers a lane that starts late and runs long; the marker list is a union, not a freeze', () => {
  const dir = tmp();
  try {
    const sf = showsFixture(dir);
    const env = { OPENING_NIGHT_SHOWS_FILE: sf };
    const H = 3600000;
    assert.deepEqual(guard.tonightShowIds({ file: sf, now: PRESS_NIGHT + 8.5 * H }), [SHOW], '+8.5h: lane may still hold, tonight waits');
    assert.deepEqual(guard.tonightShowIds({ file: sf, now: PRESS_NIGHT - 2.9 * H }), [SHOW], '-2.9h: inside');
    assert.deepEqual(guard.tonightShowIds({ file: sf, now: PRESS_NIGHT + 9.1 * H }), [], '+9.1h: outside');
    assert.deepEqual(guard.tonightShowIds({ file: sf, now: PRESS_NIGHT - 3.1 * H }), [], '-3.1h: outside');
    const lf = path.join(dir, 'leases.json');
    fs.writeFileSync(lf, JSON.stringify({ leases: {}, unknown: true, tonight: [] }));
    assert.equal(guard.leaseSkipReason(SHOW, { file: lf, env, now: PRESS_NIGHT }).unknown, true, 'marker written earlier with [] still holds tonight at read time');
  } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('enforce under unknown holds back only tonight\'s show changes', () => {
  const dir = tmp();
  try {
    const repo = path.join(dir, 'texts'); fs.mkdirSync(repo);
    git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
    fs.mkdirSync(path.join(repo, SHOW)); fs.mkdirSync(path.join(repo, LATER_SHOW.id));
    fs.writeFileSync(path.join(repo, SHOW, 'a.json'), '1'); fs.writeFileSync(path.join(repo, LATER_SHOW.id, 'a.json'), '1');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'base');
    fs.writeFileSync(path.join(repo, SHOW, 'a.json'), '2'); fs.writeFileSync(path.join(repo, SHOW, 'new.json'), 'n');
    fs.writeFileSync(path.join(repo, LATER_SHOW.id, 'a.json'), '2'); fs.writeFileSync(path.join(repo, LATER_SHOW.id, 'new.json'), 'n');
    const lf = path.join(dir, 'leases.json'); fs.writeFileSync(lf, JSON.stringify({ leases: {}, unknown: true, tonight: [SHOW] }));
    const r = spawnSync(process.execPath, ['scripts/opening-night-lease.js', 'enforce', `--dir=${repo}`], {
      cwd: ROOT, encoding: 'utf8', timeout: 60000, env: { ...process.env, OPENING_NIGHT_LEASES_FILE: lf, OPENING_NIGHT_LANE_HOLDER: '' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /::error::.*held back 2 write\(s\) under tonight's show/);
    assert.equal(fs.readFileSync(path.join(repo, SHOW, 'a.json'), 'utf8'), '1', 'tonight: tracked edit restored');
    assert.equal(fs.existsSync(path.join(repo, SHOW, 'new.json')), false, 'tonight: new file held back');
    assert.equal(fs.readFileSync(path.join(repo, LATER_SHOW.id, 'a.json'), 'utf8'), '2', 'other show: edit kept');
    assert.equal(fs.existsSync(path.join(repo, LATER_SHOW.id, 'new.json')), true, 'other show: new file kept');
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
