// BRO-5716: two concurrent poller runs drain the same _pending stub and add
// the same new one with different metadata. Git reports rename/delete on the
// new path, every push-with-retry attempt failed (run 39292955319, 20/20), and
// the run lost all its new review files. Pure merge rules + the real replay.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { mergePendingStubs } = require('./merge-pending-stub.js');
const PUSH = fileURLToPath(new URL('./push-with-retry.sh', import.meta.url));

const stub = (over = {}) => ({
  showId: 'other-desert-cities-2026', outletId: 'latimes', outlet: 'Los Angeles Times',
  criticName: 'Unknown', url: 'https://www.latimes.com/x/2026-10-19/other-desert-cities-review',
  publishDate: null, fullText: null, isFullReview: false, source: 'playbill-verdict',
  contentTier: 'stub', pendingReason: 'no-byline', firstSeenAt: '2026-10-19T17:10:18.460Z',
  ...over,
});

test('same review: remote wins non-null, nulls filled from local, earliest firstSeenAt, longer fullText', () => {
  const local = stub({ source: 'site-search', firstSeenAt: '2026-10-19T17:05:00.000Z', publishDate: '2026-10-19', fullText: 'longer local text' });
  const remote = stub({ fullText: 'short' });
  const { merged, stats } = mergePendingStubs(local, remote);
  assert.equal(merged.source, 'playbill-verdict');
  assert.equal(merged.publishDate, '2026-10-19');
  assert.equal(merged.firstSeenAt, '2026-10-19T17:05:00.000Z');
  assert.equal(merged.fullText, 'longer local text');
  assert.deepEqual(stats.filledFromLocal, ['publishDate']);
  assert.deepEqual(stats.remoteWon, ['source']);
});

test('remote earlier firstSeenAt is kept', () => {
  const { merged } = mergePendingStubs(stub({ firstSeenAt: '2026-10-19T18:00:00Z' }), stub());
  assert.equal(merged.firstSeenAt, '2026-10-19T17:10:18.460Z');
});

test('different reviews or non-objects refuse to merge', () => {
  assert.throws(() => mergePendingStubs(stub({ url: 'https://a.example/1' }), stub()), /differ on url/);
  assert.throws(() => mergePendingStubs(stub({ showId: 'other' }), stub()), /differ on showId/);
  assert.throws(() => mergePendingStubs([], stub()), /JSON objects/);
});

const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GIT_|PUSH_|GITHUB_|CI$)/.test(k))),
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
};
const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000,
}).trim();
const put = (cwd, file, value) => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
};

const OLD = '_pending/two-girls-off-broadway-2026/theatermania--6398724e.json';
const NEW = '_pending/other-desert-cities-2026/latimes--64776dd4.json';
const REVIEW = 'other-desert-cities-2026/goldderby--ethan-alter.json';
// Close enough to the remote's NEW stub that git pairs them as a rename (the
// real pair was paired among a batch of near-identical stub files).
const oldStub = stub({ outletId: 'theatermania', url: 'https://www.theatermania.com/news/review_1857490/' });

const padded = (over) => stub({ bwwExcerpt: 'x'.repeat(4000), ...over });

function race(t, localNew) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bro5716-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const origin = path.join(tmp, 'origin.git');
  const writer = path.join(tmp, 'writer');
  const runner = path.join(tmp, 'runner');
  git(tmp, 'init', '-q', '--bare', origin);
  for (const [k, v] of [['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false'], ['receive.autogc', 'false']]) git(origin, 'config', k, v);
  git(tmp, 'init', '-q', '-b', 'main', writer);
  put(writer, OLD, oldStub);
  git(writer, 'add', '-A');
  git(writer, 'commit', '-qm', 'base');
  git(writer, 'remote', 'add', 'origin', origin);
  git(writer, 'push', '-q', 'origin', 'main');
  git(tmp, 'clone', '-q', '-b', 'main', origin, runner);

  // Our run: drains OLD, adds NEW (its own metadata) plus a real review file.
  // Our NEW carries enough extra text that git does NOT pair it with OLD on
  // our side, while the remote's NEW is a near-copy of OLD, so the replay
  // sees rename(OLD->NEW) upstream vs delete(OLD) here: the incident shape.
  fs.rmSync(path.join(runner, OLD));
  put(runner, NEW, localNew);
  put(runner, REVIEW, { showId: 'other-desert-cities-2026', fullText: 'a real review' });
  git(runner, 'add', '-A');
  git(runner, 'commit', '-qm', 'data: Opening night poller (ours)');
  // Concurrent run already landed: drained OLD, added NEW with other metadata.
  fs.rmSync(path.join(writer, OLD));
  put(writer, NEW, stub());
  git(writer, 'add', '-A');
  git(writer, 'commit', '-qm', 'data: Opening night poller (theirs)');
  git(writer, 'push', '-q', 'origin', 'main');

  const result = spawnSync('bash', [PUSH, '2', 'main'], {
    cwd: runner, encoding: 'utf8', timeout: 180_000,
    env: {
      ...ENV, PUSH_RECONCILE_MERGED_JSON: '0', PUSH_SKIP_LEDGER: '1',
      PUSH_SKIP_FAILURE_LEDGER: '1', PUSH_API_FALLBACK_DISABLE: '1', PUSH_DEADLINE_SEC: '120',
      PUSH_FAILURE_LOG: path.join(tmp, 'push-failures.jsonl'),
    },
  });
  return { result, output: `${result.stdout}\n${result.stderr}`, origin };
}

test('push-with-retry lands a run whose pending stub raced a concurrent run (rename/delete)', (t) => {
  const { result, output, origin } = race(t, padded({ source: 'site-search', firstSeenAt: '2026-10-19T17:20:00.000Z', publishDate: '2026-10-19' }));
  assert.equal(result.status, 0, output);
  assert.match(output, /CONFLICT \(rename\/delete\)/, 'fixture must reproduce the incident shape');
  assert.match(output, /Auto-resolving \(pending-stub merge\): _pending\/other-desert-cities-2026/, output);
  const pushed = JSON.parse(git(origin, 'show', `main:${NEW}`));
  assert.equal(pushed.source, 'playbill-verdict');
  assert.equal(pushed.firstSeenAt, '2026-10-19T17:10:18.460Z');
  assert.equal(pushed.publishDate, '2026-10-19');
  assert.equal(pushed.bwwExcerpt.length, 4000, 'our non-null field survives');
  assert.equal(JSON.parse(git(origin, 'show', `main:${REVIEW}`)).fullText, 'a real review');
  assert.throws(() => git(origin, 'cat-file', '-e', `main:${OLD}`));
});

test('a different review at the same pending path is still left unresolved', (t) => {
  const { result, output } = race(t, padded({ url: 'https://www.latimes.com/another-review', source: 'site-search' }));
  assert.notEqual(result.status, 0, output);
  assert.match(output, /pending-stub merge refused for _pending\/other-desert-cities-2026/, output);
});
