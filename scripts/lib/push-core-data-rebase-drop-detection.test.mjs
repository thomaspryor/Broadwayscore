// BRO-4972 / BRO-5011: push-core-data's `git pull --rebase -X ours` resolves
// conflicting hunks to the REMOTE (rebase swaps the sides), so a job's edit on
// a line adjacent to a concurrent writer's edit is discarded, and when every
// hunk conflicts the commit is dropped as "patch contents already upstream"
// while the job reports success. These tests reproduce that with real git
// repos and run the same post-rebase sequence the action runs: real
// reconcileShowsJson, the real re-apply module, the real commit-or-amend.sh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '../..');
const MODULE = path.join(__dirname, 'push-core-data-rebase-drop-detection.js');
const COMMIT_OR_AMEND = path.join(__dirname, 'commit-or-amend.sh');
const ACTION = path.join(REPO, '.github/actions/push-core-data/action.yml');

const { diffJson, findLostChanges, reapplyLostChanges, main, MISSING } = require(MODULE);
const { reconcileShowsJson } = require('./reconcile-shows-fields.js');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const gitTry = (cwd, ...args) => spawnSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' });
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, v) => fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n');

const show = (id, extra = {}) => ({
  id, title: id, synopsis: null, images: { hero: null, thumbnail: null, poster: null }, ...extra,
});

/** Bare origin + two clones (A = the job under test, B = the concurrent writer). */
function setup(initialShows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-drop-'));
  const origin = path.join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  // Global config is nulled, so auto-maintenance must be off in the bare repo itself (BRO-4749).
  for (const [k, v] of [['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false'], ['receive.autogc', 'false']]) git(origin, 'config', k, v);
  const seed = path.join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  writeJson(path.join(seed, 'shows.json'), { _meta: { v: 1 }, shows: initialShows });
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'seed');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const a = path.join(root, 'a');
  const b = path.join(root, 'b');
  git(root, 'clone', '-q', '-b', 'main', origin, a);
  git(root, 'clone', '-q', '-b', 'main', origin, b);
  // checkout-core-data's snapshot: A's pristine copy, taken before A edits.
  const snapshot = path.join(root, 'snapshot-shows.json');
  fs.copyFileSync(path.join(a, 'shows.json'), snapshot);
  return { root, origin, a, b, snapshot };
}

function edit(dir, fn, msg) {
  const p = path.join(dir, 'shows.json');
  const doc = readJson(p);
  fn(doc);
  writeJson(p, doc);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

/**
 * The action's retry iteration for job A after its first push was rejected:
 * capture remote, real `git pull --rebase -X ours`, reconcileShowsJson, then
 * (when withFix) the drop check, then commit-or-amend.sh and push.
 */
function pushLikeAction(env, { withFix }) {
  const { a, root, snapshot } = env;
  const ours = path.join(root, 'ours-shows.json');
  fs.copyFileSync(path.join(a, 'shows.json'), ours); // job's committed intent
  const first = gitTry(a, 'push', 'origin', 'main');
  assert.notEqual(first.status, 0, 'first push must be rejected (B pushed first)');

  git(a, 'fetch', '-q', 'origin', 'main');
  const remote = JSON.parse(git(a, 'show', 'origin/main:shows.json'));
  const rebase = gitTry(a, 'pull', '--rebase', '-X', 'ours', 'origin', 'main');
  assert.equal(rebase.status, 0, rebase.stderr);
  const upstreamTip = git(a, 'rev-parse', 'FETCH_HEAD').trim();
  // Commit dropped = HEAD is the remote tip itself. Git prints "dropping
  // <sha> -- patch contents already upstream" for a patch-id match (the CI
  // log); a commit emptied by -X ours is dropped silently. Same loss either way.
  const dropped = git(a, 'rev-parse', 'HEAD').trim() === upstreamTip;

  const showsPath = path.join(a, 'shows.json');
  const local = readJson(showsPath);
  const { recovered } = reconcileShowsJson(local, remote, readJson(snapshot), undefined, []);
  if (recovered > 0) writeJson(showsPath, local);

  const logs = [];
  let exit = 0;
  if (withFix) {
    exit = main(['--file', 'shows.json', '--base', snapshot, '--ours', ours, '--current', showsPath, '--write'], {}, (l) => logs.push(l));
  }
  if (gitTry(a, 'diff', '--quiet', 'shows.json').status !== 0) {
    git(a, 'add', 'shows.json');
    execFileSync('bash', [COMMIT_OR_AMEND, upstreamTip, 'data: test'], { cwd: a, env: GIT_ENV, stdio: 'ignore' });
  }
  const second = gitTry(a, 'push', 'origin', 'main');
  assert.equal(second.status, 0, second.stderr);
  const verify = path.join(root, 'verify');
  git(root, 'clone', '-q', '-b', 'main', env.origin, verify);
  return { originShows: readJson(path.join(verify, 'shows.json')), dropped, logs, exit };
}

function backfillScenario() {
  // Newly promoted rows (the live incidents): neither images nor synopsis
  // exists yet. B (fetch-show-images) appends `images`, A (backfill-
  // historical-metadata) appends `synopsis` at the same spot in each row, so
  // every hunk conflicts.
  const env = setup([
    { id: 'alpha-west-end-2020', title: 'Alpha', status: 'closed' },
    { id: 'beta-west-end-2020', title: 'Beta', status: 'closed' },
  ]);
  edit(env.b, (d) => { for (const s of d.shows) s.images = { thumbnail: `/img/${s.id}.jpg`, hero: null }; }, 'images');
  git(env.b, 'push', '-q', 'origin', 'main');
  edit(env.a, (d) => { for (const s of d.shows) s.synopsis = `Synopsis of ${s.id}`; }, 'metadata');
  return env;
}

test('reproduces the bug: -X ours drops the job commit and its synopses (no fix)', () => {
  const env = backfillScenario();
  const { originShows, dropped } = pushLikeAction(env, { withFix: false });
  assert.ok(dropped, 'the rebase must drop the job commit entirely');
  for (const s of originShows.shows) {
    assert.equal(s.synopsis, undefined, 'without the fix the synopsis is silently lost');
    assert.equal(s.images.thumbnail, `/img/${s.id}.jpg`);
  }
});

test('BRO-4972: the dropped synopses are re-applied and pushed next to the concurrent images', () => {
  const env = backfillScenario();
  const { originShows, dropped, logs, exit } = pushLikeAction(env, { withFix: true });
  assert.ok(dropped, 'scenario must hit the real drop');
  assert.equal(exit, 0);
  for (const s of originShows.shows) {
    assert.equal(s.synopsis, `Synopsis of ${s.id}`, 'job edit survives');
    assert.equal(s.images.thumbnail, `/img/${s.id}.jpg`, 'concurrent edit survives');
  }
  assert.ok(logs.some((l) => l.startsWith('::warning::') && /dropped 2 .*re-applied/.test(l)), logs.join('\n'));
  assert.ok(!logs.some((l) => l.startsWith('::error::')));
});

test('BRO-5011: a concurrent images.thumbnail clear is not restored; the job edit on the same row survives', () => {
  const env = setup([
    show('a-dolls-house-off-west-end-2026', { images: { hero: null, thumbnail: '/t/a.jpg', poster: '/p/a.jpg' } }),
    show('greatest-play-west-end-2019', { images: { hero: null, thumbnail: '/t/g.jpg', poster: '/p/g.jpg' } }),
  ]);
  // B = execute-approved-fix: nulls the thumbnail.
  edit(env.b, (d) => { d.shows[0].images.thumbnail = null; }, 'plan nulls thumbnail');
  git(env.b, 'push', '-q', 'origin', 'main');
  // A = fetch-show-images, started earlier: sets hero on the same row (and a
  // field on the next row), never touches thumbnail.
  edit(env.a, (d) => { d.shows[0].images.hero = '/h/a.jpg'; d.shows[1].images.hero = '/h/g.jpg'; }, 'fetch images');
  const { originShows, logs } = pushLikeAction(env, { withFix: true });
  const [doll, greatest] = originShows.shows;
  assert.equal(doll.images.thumbnail, null, 'the concurrent clear stands');
  assert.equal(doll.images.hero, '/h/a.jpg', 'the job hero survives');
  assert.equal(doll.images.poster, '/p/a.jpg');
  assert.equal(greatest.images.hero, '/h/g.jpg');
  assert.equal(greatest.images.thumbnail, '/t/g.jpg');
  assert.ok(!logs.some((l) => l.startsWith('::error::')), logs.join('\n'));
});

test('both sides changed the same field: remote kept and reported as a conflict', () => {
  const base = { shows: [show('x')] };
  const ours = { shows: [show('x', { synopsis: 'ours' })] };
  const current = { shows: [show('x', { synopsis: 'theirs' })] };
  const r = reapplyLostChanges(base, ours, current);
  assert.equal(current.shows[0].synopsis, 'theirs');
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.reapplied.length, 0);
  assert.equal(r.stillLost, 0);
});

test('added and deleted records are re-applied by id', () => {
  const base = { shows: [show('keep'), show('gone')] };
  const ours = { shows: [show('keep'), show('new', { synopsis: 's' })] };
  const current = { shows: [show('keep', { title: 'remote edit' }), show('gone')] };
  const r = reapplyLostChanges(base, ours, current);
  assert.deepEqual(current.shows.map((s) => s.id), ['keep', 'new']);
  assert.equal(current.shows[0].title, 'remote edit');
  assert.equal(r.reapplied.length, 2);
  // Idempotent: a second pass finds nothing.
  const again = findLostChanges(base, ours, current);
  assert.equal(again.lost.length + again.conflicts.length, 0);
});

test('no edits, or edits already present: nothing to do', () => {
  const base = { shows: [show('x')] };
  assert.deepEqual(diffJson(base, structuredClone(base)), []);
  const ours = { shows: [show('x', { synopsis: 's' })] };
  const r = reapplyLostChanges(base, ours, structuredClone(ours));
  assert.equal(r.edits, 1);
  assert.equal(r.reapplied.length + r.conflicts.length + r.stillLost, 0);
});

test('an array with duplicate ids is never re-applied atomically; reported as lost', () => {
  const base = { shows: [show('d'), show('d')] };
  const ours = { shows: [show('d', { synopsis: 's' }), show('d')] };
  const current = structuredClone(base);
  const r = reapplyLostChanges(base, ours, current);
  assert.deepEqual(current, base, 'current untouched');
  assert.equal(r.stillLost, 1);
  assert.equal(r.unkeyable.length, 1);
  assert.equal(diffJson(base, ours)[0].base !== MISSING, true);
});

test('CLI: strict mode fails when an edit cannot be re-applied; default stays advisory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcd-cli-'));
  const p = (n) => path.join(dir, n);
  writeJson(p('base.json'), { shows: [show('d'), show('d')] });
  writeJson(p('ours.json'), { shows: [show('d', { synopsis: 's' }), show('d')] });
  writeJson(p('cur.json'), { shows: [show('d'), show('d')] });
  const args = ['--file', 'shows.json', '--base', p('base.json'), '--ours', p('ours.json'), '--current', p('cur.json'), '--write'];
  const logs = [];
  assert.equal(main(args, {}, (l) => logs.push(l)), 0);
  assert.ok(logs.some((l) => l.startsWith('::error::')));
  assert.equal(main(args, { PUSH_CORE_DATA_DROP_STRICT: '1' }, () => {}), 2);
  assert.equal(main(['--file', 'reviews.json'], {}, () => {}), 0, 'files outside FILE_SPECS are skipped');
});

test('push-core-data/action.yml runs the drop check before the shows.json amend', () => {
  const yml = fs.readFileSync(ACTION, 'utf8');
  const check = yml.indexOf('scripts/lib/push-core-data-rebase-drop-detection.js');
  assert.ok(check > 0, 'action.yml must invoke the drop check');
  // BRO-4966: the pull became a timed fetch plus a local `git rebase -X ours FETCH_HEAD`.
  const rebase = yml.indexOf('git rebase -X ours FETCH_HEAD');
  const amend = yml.indexOf('Amended commit with reconciled shows.json');
  assert.ok(rebase > 0 && amend > 0);
  assert.ok(check > rebase && check < amend, 'check must run after the rebase and before the shows.json amend');
  assert.match(yml, /\/tmp\/push-core-data-ours\/shows\.json/, 'the job intent copy must be captured');
});

test('edit to a show the remote deleted is a conflict, not stillLost (review finding)', async () => {
  const { reapplyLostChanges } = await import('./push-core-data-rebase-drop-detection.js');
  const base = { shows: [{ id: 'a', t: 1 }] };
  const ours = { shows: [{ id: 'a', t: 1, synopsis: 'x' }] };
  const current = { shows: [] };
  const r = reapplyLostChanges(base, ours, current);
  assert.equal(r.stillLost, 0);
  assert.ok(r.conflicts.length >= 1);
});
