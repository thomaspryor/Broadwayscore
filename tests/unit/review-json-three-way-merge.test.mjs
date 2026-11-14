/**
 * BRO-5211: push-review-texts let a stale rebuild write clobber a fresh
 * collector write (broadway-review-texts eaaae9beb -> b04b66762). The
 * autostash pop conflicted and `git checkout --theirs -- .` took the stale
 * stash's whole file. scripts/lib/review-json-three-way-merge.js merges per
 * field against the common base instead. Rule 15: require() the real function.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(__dirname, '..', '..');
const LIB = path.join(repoRoot, 'scripts/lib/review-json-three-way-merge.js');
const { mergeReviewJson, TEXT_STATE_GROUP } = require(LIB);

const TEXT = 'A synthetic review body standing in for the collected article. '.repeat(40);

// Shape of the real incident file (amelie-a-new-musical-2017/vulture--jesse-green.json),
// review text replaced with synthetic text.
const base = () => ({
  showId: 'amelie-a-new-musical-2017', outletId: 'vulture', criticName: 'Jesse Green',
  url: 'https://www.vulture.com/2017/04/theater-review-amlie-and-the-limits-of-whimsy.html',
  fetchDiscoveryAbandoned: true,
  needsRefetch: true,
  _urlChangedClear: { cleared: ['contentTier', 'fullText', 'publishDate'] },
});
const collector = () => ({
  ...base(),
  needsRefetch: false,
  fullText: TEXT, isFullReview: true, textWordCount: 1093,
  archivePath: 'data/archives/reviews/amelie-a-new-musical-2017/vulture--jesse-green_2026-10-12.html',
  textFetchedAt: '2026-10-12T22:36:37.869Z', publishDate: '2017-04-03',
  fetchMethod: 'brightdata', fetchAttempts: null, fetchTier: 3, textQuality: 'full',
  truncationSignals: [], textStatus: 'complete', sourceMethod: 'brightdata',
  contentVerification: { isValid: true, confidence: 'high' },
  contentTier: 'complete', wordCount: 1093, tierReason: 'Full review text', contentTierReason: 'Full review text',
});
const rebuild = () => ({
  ...base(),
  contentTier: 'stub', contentTierReason: 'No text content', wordCount: 0,
  incompleteReason: 'url_dead', incompleteDetail: 'url_dead_404 (4 attempts)',
});

test('incident replay: fresh collector fields survive a stale rebuild write', () => {
  const { merged, winner } = mergeReviewJson(base(), collector(), rebuild(), { tie: 'workflow' });
  assert.equal(winner, 'upstream');
  assert.equal(merged.publishDate, '2017-04-03');
  assert.equal(merged.needsRefetch, false);
  assert.equal(merged.fullText, TEXT);
  assert.equal(merged.contentTier, 'complete');
  assert.equal(merged.wordCount, 1093);
  assert.equal(merged.fetchMethod, 'brightdata');
  assert.equal(merged.archivePath, collector().archivePath);
  assert.equal(merged.textQuality, 'full');
  assert.ok(!('incompleteReason' in merged), 'stale url_dead must not sit next to the fresh text');
  assert.ok(!('incompleteDetail' in merged));
  assert.deepEqual(merged, collector());
});

test('disjoint edits: both sides keep their own fields (no group conflict)', () => {
  const up = { ...collector(), publishDate: '2017-04-04' };
  const wf = { ...collector(), needsReview: true, needsReviewReason: 'rebuild flag', incompleteReason: undefined };
  delete wf.incompleteReason;
  const { merged, conflicts, groupFrom } = mergeReviewJson(collector(), up, wf);
  assert.equal(merged.publishDate, '2017-04-04');
  assert.equal(merged.needsReview, true);
  assert.equal(merged.needsReviewReason, 'rebuild flag');
  assert.deepEqual(conflicts, []);
  assert.equal(groupFrom, null);
});

test('workflow-only text-state clear is honored (rebuild clearing incompleteReason)', () => {
  const b = { ...collector(), incompleteReason: 'partial_text', incompleteDetail: 'x' };
  const up = { ...b, publishDate: '2017-04-05' };
  const wf = { ...b };
  delete wf.incompleteReason; delete wf.incompleteDetail;
  const { merged } = mergeReviewJson(b, up, wf);
  assert.ok(!('incompleteReason' in merged));
  assert.ok(!('incompleteDetail' in merged));
  assert.equal(merged.publishDate, '2017-04-05');
});

test('workflow with the richer text wins the text group and conflicts; upstream-only fields kept', () => {
  const b = { ...rebuild() };
  const up = { ...rebuild(), contentTierReason: 'still nothing', serpRetryCount: 3 };
  const wf = collector();
  const { merged, winner } = mergeReviewJson(b, up, wf, { tie: 'upstream' });
  assert.equal(winner, 'workflow');
  assert.equal(merged.contentTier, 'complete');
  assert.equal(merged.contentTierReason, 'Full review text');
  assert.equal(merged.serpRetryCount, 3);
  assert.ok(!('incompleteReason' in merged));
});

test('tie on fullText length follows the tie option for a true conflict', () => {
  const b = { ...collector(), dateSource: 'a' };
  const up = { ...b, dateSource: 'up' };
  const wf = { ...b, dateSource: 'wf' };
  assert.equal(mergeReviewJson(b, up, wf, { tie: 'workflow' }).merged.dateSource, 'wf');
  assert.equal(mergeReviewJson(b, up, wf, { tie: 'upstream' }).merged.dateSource, 'up');
  assert.deepEqual(mergeReviewJson(b, up, wf).conflicts, ['dateSource']);
});

test('null base (added on both sides) still merges', () => {
  const { merged } = mergeReviewJson(null, collector(), rebuild());
  assert.equal(merged.publishDate, '2017-04-03');
  assert.equal(merged.contentTier, 'complete');
});

test('group lists the fields the incident lost', () => {
  for (const f of ['needsRefetch', 'contentTier', 'incompleteReason', 'wordCount', 'fetchMethod', 'archivePath', 'textQuality']) {
    assert.ok(TEXT_STATE_GROUP.includes(f), f);
  }
});

// ---- CLI against a real git conflict (the action's autostash + rebase paths) ----

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const write = (dir, rel, obj) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify(obj, null, 2) + '\n');
};
const read = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8'));
const F = 'amelie-a-new-musical-2017/vulture--jesse-green.json';

function setup() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5211-'));
  const remote = path.join(tmp, 'remote.git');
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  const clone = (name) => {
    const d = path.join(tmp, name);
    git(tmp, 'clone', '-q', remote, d);
    git(d, 'config', 'user.email', 't@t'); git(d, 'config', 'user.name', 't');
    git(d, 'config', 'pull.rebase', 'true');
    return d;
  };
  const seed = clone('seed');
  write(seed, F, base());
  write(seed, 'other-show/outlet--critic.json', { showId: 'other-show', fullText: 'x', contentTier: 'excerpt' });
  git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', 'base'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  const coll = clone('collector');
  const rb = clone('rebuild'); // checked out before the collector's push
  write(coll, F, collector());
  git(coll, 'add', '-A'); git(coll, 'commit', '-q', '-m', 'collector'); git(coll, 'push', '-q', 'origin', 'HEAD:main');
  return { tmp, rb };
}
const runCli = (cwd, tie) => execFileSync('node', [LIB, `--tie=${tie}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('CLI: autostash-pop conflict (the incident path) merges field-wise and survives checkout --theirs', () => {
  const { tmp, rb } = setup();
  try {
    write(rb, F, rebuild());
    write(rb, 'other-show/outlet--critic.json', { showId: 'other-show', fullText: 'x', contentTier: 'stub' });
    try { git(rb, 'pull', '--rebase', '--autostash', '-q', 'origin', 'main'); } catch { /* exit code varies by git version */ }
    assert.ok(git(rb, 'ls-files', '-u').includes(F), 'precondition: the stash pop conflicted on the review file');
    // The CLI's stage mapping: 2 = upstream, 3 = this workflow (the stash).
    assert.equal(JSON.parse(git(rb, 'show', `:2:${F}`)).publishDate, '2017-04-03');
    assert.equal(JSON.parse(git(rb, 'show', `:3:${F}`)).incompleteReason, 'url_dead');
    const out = runCli(rb, 'workflow');
    assert.equal(out.trim(), F);
    // The action's fallback still runs for anything left unmerged; it must not undo the merge.
    try { git(rb, 'checkout', '--theirs', '--', '.'); } catch { /* nothing unmerged left */ }
    git(rb, 'add', '-A');
    assert.equal(git(rb, 'ls-files', '-u'), '');
    const merged = read(rb, F);
    assert.equal(merged.publishDate, '2017-04-03');
    assert.equal(merged.needsRefetch, false);
    assert.equal(merged.contentTier, 'complete');
    assert.ok(!('incompleteReason' in merged));
    // The non-conflicting file keeps this workflow's write.
    assert.equal(read(rb, 'other-show/outlet--critic.json').contentTier, 'stub');
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('CLI: rebase conflict in the push loop merges field-wise (stage 3 = replayed commit)', () => {
  const { tmp, rb } = setup();
  try {
    write(rb, F, rebuild());
    git(rb, 'add', '-A'); git(rb, 'commit', '-q', '-m', 'rebuild');
    try { git(rb, 'pull', '--rebase', '-q', 'origin', 'main'); } catch { /* conflict expected */ }
    assert.ok(git(rb, 'ls-files', '-u').includes(F), 'precondition: rebase conflicted');
    assert.equal(JSON.parse(git(rb, 'show', `:2:${F}`)).publishDate, '2017-04-03');
    assert.equal(JSON.parse(git(rb, 'show', `:3:${F}`)).incompleteReason, 'url_dead');
    assert.equal(runCli(rb, 'upstream').trim(), F);
    assert.equal(git(rb, 'ls-files', '-u'), '');
    const merged = read(rb, F);
    assert.equal(merged.publishDate, '2017-04-03');
    assert.equal(merged.needsRefetch, false);
    assert.ok(!('incompleteReason' in merged));
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test('CLI: delete/modify and non-JSON conflicts are left for the caller', () => {
  const { tmp, rb } = setup();
  try {
    fs.rmSync(path.join(rb, F));
    git(rb, 'add', '-A'); git(rb, 'commit', '-q', '-m', 'delete');
    try { git(rb, 'pull', '--rebase', '-q', 'origin', 'main'); } catch { /* conflict expected */ }
    assert.ok(git(rb, 'ls-files', '-u').includes(F));
    assert.equal(runCli(rb, 'upstream').trim(), '');
    assert.ok(git(rb, 'ls-files', '-u').includes(F), 'still unmerged for the action fallback');
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

// BRO-5656: Pride Independent (2026-10-14). The fresh refetch (3963 chars) lost
// to the stale 2021 body (4027 chars) because longer-wins decided the group.
test('BRO-5656: newer shorter refetch beats an older longer body', () => {
  const OLD = 'The stale body from another production. '.repeat(100);
  const NEW = 'The corrected article. '.repeat(100);
  assert.ok(OLD.length > NEW.length);
  const b = { showId: 's', outletId: 'o', criticName: 'c', needsRefetch: true };
  const stale = { ...b, fullText: OLD, wordCount: 629, needsRefetch: false, textFetchedAt: '2026-10-01T00:00:00.000Z', fetchMethod: 'old' };
  const fresh = { ...b, fullText: NEW, wordCount: 450, needsRefetch: false, textFetchedAt: '2026-10-14T00:52:00.000Z', fetchMethod: 'playwright' };
  for (const [up, wf, winner] of [[stale, fresh, 'workflow'], [fresh, stale, 'upstream']]) {
    const r = mergeReviewJson(b, up, wf, { tie: 'workflow' });
    assert.equal(r.winner, winner);
    assert.equal(r.merged.fullText, NEW);
    assert.equal(r.merged.wordCount, 450);
    assert.equal(r.merged.fetchMethod, 'playwright');
  }
});

test('BRO-5656: a text-less side never wins on recency; missing stamp falls back to length', () => {
  const b = { showId: 's', needsRefetch: true };
  const withText = { ...b, fullText: TEXT, textFetchedAt: '2026-10-01T00:00:00.000Z', contentTier: 'complete' };
  const failed = { ...b, textFetchedAt: '2026-10-14T00:00:00.000Z', contentTier: 'stub', incompleteReason: 'url_dead' };
  assert.equal(mergeReviewJson(b, withText, failed).winner, 'upstream');
  const noStamp = { ...b, fullText: TEXT + 'more', contentTier: 'complete' };
  assert.equal(mergeReviewJson(b, noStamp, withText).winner, 'upstream');
});

const { fresherTextWins } = require(LIB);
const { reconcileProtectedFields } = require(path.join(repoRoot, 'scripts/lib/restore-protected-fields.js'));

test('BRO-5656: a newer truncated/paywall text does not displace an older complete one', () => {
  const b = { showId: 's' };
  const complete = { ...b, fullText: TEXT, contentTier: 'complete', textFetchedAt: '2026-10-01T00:00:00.000Z' };
  const teaser = { ...b, fullText: 'Subscribe to read.', contentTier: 'truncated', textFetchedAt: '2026-10-14T00:00:00.000Z' };
  assert.equal(fresherTextWins(teaser, complete), null);
  assert.equal(mergeReviewJson(b, complete, teaser).winner, 'upstream');
  assert.equal(mergeReviewJson(b, teaser, complete).winner, 'workflow');
});

test('BRO-5656: equal, garbage or missing stamps fall back to length then the tie option', () => {
  const mk = (t, at) => ({ fullText: t, contentTier: 'complete', textFetchedAt: at });
  const same = '2026-10-01T00:00:00.000Z';
  assert.equal(fresherTextWins(mk('aa', same), mk('a', same)), null);
  assert.equal(fresherTextWins(mk('aa', 'garbage'), mk('a', same)), null);
  assert.equal(fresherTextWins(mk('aa', undefined), mk('a', same)), null);
  assert.equal(mergeReviewJson({}, mk('abc', same), mk('abc', same), { tie: 'upstream' }).winner, 'upstream');
  assert.equal(mergeReviewJson({}, mk('abc', same), mk('abc', same), { tie: 'workflow' }).winner, 'workflow');
});

test('BRO-5656: stale-checkout restore does not put the older longer body back over a newer refetch', () => {
  const OLD = 'Old wrong-production body. '.repeat(100);
  const NEW = 'The corrected article. '.repeat(100);
  const mk = (t, at) => ({ fullText: t, contentTier: 'complete', textFetchedAt: at, textWordCount: t.length });
  const remote = mk(OLD, '2026-10-01T00:00:00.000Z');
  const local = mk(NEW, '2026-10-14T00:52:00.000Z');
  reconcileProtectedFields(local, remote, { ...local }, { staleCheckoutGuard: true });
  assert.equal(local.fullText, NEW);
  // a genuinely stale checkout (older stamp, shorter text) is still restored
  const stale = mk('short stub text', '2026-09-01T00:00:00.000Z');
  reconcileProtectedFields(stale, mk(OLD, '2026-10-01T00:00:00.000Z'), { ...stale }, { staleCheckoutGuard: true });
  assert.equal(stale.fullText, OLD);
});

test('BRO-5656: ORIG_HEAD restore does not bring back a stale older longer body over a newer refetch', () => {
  const OLD = 'Old wrong-production body. '.repeat(100);
  const NEW = 'The corrected article. '.repeat(100);
  const mk = (t, at) => ({ fullText: t, contentTier: 'complete', textFetchedAt: at, textWordCount: t.length });
  const fresh = mk(NEW, '2026-10-14T00:52:00.000Z');
  const local = { ...fresh };
  reconcileProtectedFields(local, { ...fresh }, mk(OLD, '2026-10-01T00:00:00.000Z'), { staleCheckoutGuard: true });
  assert.equal(local.fullText, NEW);
  assert.equal(local.textFetchedAt, fresh.textFetchedAt);
});
