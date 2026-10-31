// BRO-5509: per-issue merge for data/newsletter-state.json. require()s the real
// merge (CLAUDE.md rule 15) and checks it is wired into the registry, the
// conflict helper's dispatch, and push-with-retry.sh's case arms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const { mergeNewsletterState, keyOf, MAX_ISSUES } = require('./merge-newsletter-state.js');
const { findEntry } = require('./core-data-merge-registry.js');
const { mergerFor, apiFallbackMergerFor } = require('./reconcile-merged-json.js');

const issue = (weekStart, edition, featured = [], extra = {}) => ({
  weekStart,
  ...(edition ? { edition } : {}),
  moverShowIds: [],
  announcedClosingShowIds: [],
  featuredShowIds: featured,
  ...extra,
});
const keys = (doc) => doc.issues.map(keyOf);

test('both sides added a different edition for the same week: both survive', () => {
  const base = { issues: [issue('2026-10-05', 'broadway', ['a']), issue('2026-10-05', 'west-end', ['b'])] };
  const ours = { issues: [...base.issues, issue('2026-10-12', 'broadway', ['c'])] };
  const remote = { issues: [...base.issues, issue('2026-10-12', 'west-end', ['d'])] };
  const { merged, stats } = mergeNewsletterState(ours, remote, base);
  assert.deepEqual(keys(merged), [
    '2026-10-05|broadway', '2026-10-05|west-end', '2026-10-12|broadway', '2026-10-12|west-end',
  ]);
  assert.equal(stats.addedFromRemote, 1);
  // Without a base (add/add conflict) the union still keeps both.
  assert.equal(mergeNewsletterState(ours, remote).merged.issues.length, 4);
});

test('both sides changed the same issue: ours wins; remote-only change to an issue we left alone is kept', () => {
  const base = { issues: [issue('2026-10-05', 'broadway', ['a']), issue('2026-10-05', 'west-end', ['b'])] };
  const ours = { issues: [issue('2026-10-05', 'broadway', ['a', 'ours']), issue('2026-10-05', 'west-end', ['b'])] };
  const remote = { issues: [issue('2026-10-05', 'broadway', ['a', 'remote']), issue('2026-10-05', 'west-end', ['b', 'healed'])] };
  const { merged, stats } = mergeNewsletterState(ours, remote, base);
  assert.deepEqual(merged.issues[0].featuredShowIds, ['a', 'ours']);
  assert.deepEqual(merged.issues[1].featuredShowIds, ['b', 'healed']);
  assert.equal(stats.takenFromRemote, 1);
});

test('legacy entries without edition key as broadway, like generate.mjs _issueEdition()', () => {
  assert.equal(keyOf(issue('2026-07-27', null)), '2026-07-27|broadway');
  const ours = { issues: [issue('2026-07-27', null, ['x'])] };
  const remote = { issues: [issue('2026-07-27', 'broadway', ['y'])] };
  assert.equal(mergeNewsletterState(ours, remote).merged.issues.length, 1);
});

test('deletions are honoured on either side when the other side left the entry unchanged', () => {
  const old = issue('2026-08-03', 'broadway', ['old']);
  const base = { issues: [old, issue('2026-10-05', 'broadway', ['a'])] };
  // We pruned the oldest entry; remote added one and kept the old one untouched.
  const ours = { issues: [issue('2026-10-05', 'broadway', ['a'])] };
  const remote = { issues: [old, issue('2026-10-05', 'broadway', ['a']), issue('2026-10-05', 'west-end', ['w'])] };
  let r = mergeNewsletterState(ours, remote, base);
  assert.deepEqual(keys(r.merged), ['2026-10-05|broadway', '2026-10-05|west-end']);
  assert.equal(r.stats.deletesHonored, 1);
  // Remote (the reconciler) dropped a phantom entry we did not touch.
  r = mergeNewsletterState(remote, ours, base);
  assert.deepEqual(keys(r.merged), ['2026-10-05|broadway', '2026-10-05|west-end']);
  // A side that CHANGED the entry the other deleted keeps it.
  const changed = { issues: [issue('2026-08-03', 'broadway', ['old', 'new']), issue('2026-10-05', 'broadway', ['a'])] };
  r = mergeNewsletterState(changed, ours, base);
  assert.deepEqual(keys(r.merged), ['2026-08-03|broadway', '2026-10-05|broadway']);
});

test('API-fallback shape (remote == base) keeps our own replace and prune, no resurrection', () => {
  const base = { issues: [issue('2026-08-03', 'broadway', ['old']), issue('2026-10-12', 'broadway', ['v1'])] };
  const ours = { issues: [issue('2026-10-12', 'broadway', ['v2'])] };
  const { merged } = mergeNewsletterState(ours, base, base);
  assert.deepEqual(merged, ours);
});

test('idempotent: merging a side with itself, or re-merging the result, changes nothing', () => {
  const base = { issues: [issue('2026-10-05', 'broadway', ['a'])] };
  const ours = { issues: [...base.issues, issue('2026-10-12', 'broadway', ['c'])] };
  const remote = { issues: [...base.issues, issue('2026-10-12', 'west-end', ['d'])] };
  const once = mergeNewsletterState(ours, remote, base).merged;
  assert.deepEqual(mergeNewsletterState(once, once, once).merged, once);
  assert.deepEqual(mergeNewsletterState(once, remote, base).merged, once);
  assert.deepEqual(mergeNewsletterState(once, once).merged, once);
  assert.deepEqual(mergeNewsletterState(ours, ours, base).merged, ours);
});

test('result is sorted by weekStart and capped at the writer limit, oldest dropped', () => {
  const mk = (n, ed) => issue(`2026-${String(1 + Math.floor(n / 4)).padStart(2, '0')}-${String(1 + (n % 4) * 7).padStart(2, '0')}`, ed);
  const ours = { issues: Array.from({ length: MAX_ISSUES }, (_, n) => mk(n + 1, 'broadway')) };
  const remote = { issues: [mk(0, 'west-end'), mk(30, 'west-end')] };
  const { merged, stats } = mergeNewsletterState(ours, remote);
  assert.equal(merged.issues.length, MAX_ISSUES);
  assert.equal(stats.droppedOld, 2);
  const ws = merged.issues.map((i) => i.weekStart);
  assert.deepEqual(ws, [...ws].sort());
  assert.ok(merged.issues.some((i) => keyOf(i) === keyOf(mk(30, 'west-end'))));
  assert.ok(!merged.issues.some((i) => keyOf(i) === keyOf(mk(0, 'west-end'))));
});

test('wired: registry entry, conflict-helper dispatch, reconcile pass and API fallback all use it', () => {
  const entry = findEntry('data/newsletter-state.json', 'public-repo');
  assert.ok(entry, 'registry entry for newsletter-state.json');
  assert.equal(entry.merge, mergeNewsletterState);
  assert.equal(entry.status, 'active');
  assert.equal(mergerFor('data/newsletter-state.json').merge, mergeNewsletterState);
  assert.equal(apiFallbackMergerFor('data/newsletter-state.json').merge, mergeNewsletterState);
  const sh = readFileSync(join(root, 'scripts/lib/push-with-retry.sh'), 'utf8');
  const arm = sh.match(/\n\s+data\/newsletter-state\.json\)\n([\s\S]*?);;/);
  assert.ok(arm, 'push-with-retry.sh has a data/newsletter-state.json case arm');
  assert.match(arm[1], /merge-commercial-conflict\.js/);
  // The arm must come before the generic catch-all arm.
  assert.ok(sh.indexOf('data/newsletter-state.json)') < sh.indexOf('\n      *)\n        # Other data files'));
});

test('end to end: merge-commercial-conflict.js resolves a real two-edition git conflict', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nl-state-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (doc) => writeFileSync(join(dir, 'data/newsletter-state.json'), JSON.stringify(doc, null, 2) + '\n');
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
    execFileSync('mkdir', ['-p', join(dir, 'data')]);
    const base = { issues: [issue('2026-10-05', 'broadway', ['a'])] };
    write(base); git('add', '.'); git('commit', '-qm', 'base');
    git('checkout', '-qb', 'remote');
    write({ issues: [...base.issues, issue('2026-10-12', 'west-end', ['w'])] }); git('commit', '-qam', 'we');
    git('checkout', '-q', 'main');
    write({ issues: [...base.issues, issue('2026-10-12', 'broadway', ['b'])] }); git('commit', '-qam', 'bw');
    let conflicted = false;
    try { git('rebase', 'remote'); } catch { conflicted = true; }
    assert.ok(conflicted, 'fixture must produce a real rebase conflict');
    // In rebase mode push-with-retry passes keep_local=--theirs, keep_remote=--ours.
    execFileSync('node', [join(root, 'scripts/lib/merge-commercial-conflict.js'), 'data/newsletter-state.json', '--theirs', '--ours'], { cwd: dir, stdio: 'pipe' });
    const out = JSON.parse(readFileSync(join(dir, 'data/newsletter-state.json'), 'utf8'));
    assert.deepEqual(keys(out), ['2026-10-05|broadway', '2026-10-12|broadway', '2026-10-12|west-end']);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// Review follow-up: the common race is NOT a git conflict. Two editions append
// an issue for the same week from the same base; `git rebase -X theirs` resolves
// the overlapping hunk cleanly in favour of ours, so resolve_conflicts() never
// runs and only reconcile_merged_json (PUSH_RECONCILE_MERGED_JSON=1, base from
// PUSH_RECONCILE_BASE=SCRIPT_ENTRY_BASE) puts the other edition back. Drives the
// real push-with-retry.sh against a local bare origin.
test('end to end: push-with-retry.sh with PUSH_RECONCILE_MERGED_JSON=1 keeps both editions after a clean -X theirs rebase', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nl-state-push-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
    PUSH_FAILURE_LOG: '/dev/null',
  };
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const file = 'data/newsletter-state.json';
  const write = (cwd, doc) => writeFileSync(join(cwd, file), JSON.stringify(doc, null, 2) + '\n'); // test-data-write-guard-allow: temp git repo fixture, not the real data dir
  const base = { issues: [issue('2026-10-05', 'broadway', ['a']), issue('2026-10-05', 'west-end', ['b'])] };
  const bw = issue('2026-10-12', 'broadway', ['bw-new']);
  const we = issue('2026-10-12', 'west-end', ['we-new']);
  try {
    const origin = join(dir, 'origin.git');
    git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
    for (const name of ['we', 'runner']) {
      git(dir, 'clone', '-q', origin, name);
    }
    const weDir = join(dir, 'we');
    const runner = join(dir, 'runner');
    execFileSync('mkdir', ['-p', join(weDir, 'data'), join(runner, 'data')]);
    write(weDir, base); git(weDir, 'add', '-A'); git(weDir, 'commit', '-qm', 'base');
    git(weDir, 'push', '-q', 'origin', 'HEAD:main');
    git(runner, 'pull', '-q', 'origin', 'main');

    // West End run lands first; the Broadway runner still sits on the base.
    write(weDir, { issues: [...base.issues, we] }); git(weDir, 'commit', '-qam', 'west-end issue');
    git(weDir, 'push', '-q', 'origin', 'HEAD:main');
    write(runner, { issues: [...base.issues, bw] }); git(runner, 'commit', '-qam', 'broadway issue');

    // Precondition (scratch branch, then discarded): the rebase is clean and drops the WE entry.
    git(runner, 'fetch', '-q', 'origin');
    git(runner, 'checkout', '-qb', 'probe');
    git(runner, 'rebase', '-q', '-X', 'theirs', 'origin/main');
    const probe = JSON.parse(readFileSync(join(runner, file), 'utf8'));
    assert.deepEqual(keys(probe), ['2026-10-05|broadway', '2026-10-05|west-end', '2026-10-12|broadway'],
      'precondition: clean -X theirs rebase silently drops the other edition');
    git(runner, 'checkout', '-q', 'main');
    git(runner, 'branch', '-qD', 'probe');

    const r = spawnSync('bash', [join(root, 'scripts/lib/push-with-retry.sh'), '3', 'main'], {
      cwd: runner, env: { ...env, PUSH_RECONCILE_MERGED_JSON: '1' }, encoding: 'utf8', timeout: 240000,
    });
    assert.equal(r.status, 0, `push-with-retry.sh failed:\n${r.stdout}\n${r.stderr}`);
    const landed = JSON.parse(git(dir, '--git-dir', origin, 'show', `main:${file}`));
    assert.deepEqual(keys(landed), ['2026-10-05|broadway', '2026-10-05|west-end', '2026-10-12|broadway', '2026-10-12|west-end']);
    assert.deepEqual(landed.issues.find((i) => keyOf(i) === '2026-10-12|west-end').featuredShowIds, ['we-new']);
    assert.deepEqual(landed.issues.find((i) => keyOf(i) === '2026-10-12|broadway').featuredShowIds, ['bw-new']);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
