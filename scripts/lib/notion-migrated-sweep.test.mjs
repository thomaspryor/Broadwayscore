import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const sweep = require('./notion-migrated-sweep.js');

const commit = (sha, subject, body = '', date = '2026-08-16T00:00:00Z') => ({ sha, date, subject, body });

test('extractNotionId reads both migration formats', () => {
  assert.equal(
    sweep.extractNotionId('[notion:3b0637c5-416f-811e-8083-d15700ead650] P2 Later'),
    '3b0637c5-416f-811e-8083-d15700ead650',
  );
  assert.equal(
    sweep.extractNotionId('*Migrated from Notion — page *`3be637c5-416f-8103-92b4-dd46c0e1b8c4` *· [open]'),
    '3be637c5-416f-8103-92b4-dd46c0e1b8c4',
  );
  assert.equal(sweep.extractNotionId('no marker here'), null);
});

test('extractPaths keeps repo paths and drops URLs and line suffixes', () => {
  const paths = sweep.extractPaths(
    'found scripts/gc-merged-worktrees.sh:540-563 and `scripts/lib/gc-worktree-liveness.js`. '
    + 'See https://app.notion.com/p/scripts/foo.js and src/app/show/[slug]/page.tsx.',
  );
  assert.deepEqual(paths, [
    'scripts/gc-merged-worktrees.sh',
    'scripts/lib/gc-worktree-liveness.js',
    'src/app/show/[slug]/page.tsx',
  ]);
});

test('extractTaskNumbers finds old task numbers but not issue numbers in URLs', () => {
  assert.deepEqual(sweep.extractTaskNumbers('Fix it (task #1709), see PR #12 and https://x/y#1234'), ['1709']);
});

test('a card id named only as an example in a commit body is not evidence', () => {
  const card = { identifier: 'BRO-2356', title: 'flag-vs-CV contradiction', description: '', createdAt: '2026-08-01T00:00:00Z' };
  const example = commit('a'.repeat(40), 'audit: guard the PASS side', 'The gate cannot pass vacuously (that is how BRO-2356 surfaced).');
  assert.equal(sweep.scoreCard(card, [example]).level, 'none');

  const ref = commit('b'.repeat(40), 'fix the gate', 'Fixes: BRO-2356');
  const subj = commit('c'.repeat(40), 'fix(BRO-2356): stop the contradiction');
  const r = sweep.scoreCard(card, [ref, subj]);
  assert.equal(r.level, 'strong');
  assert.equal(r.strong.length, 2);
});

test('BRO-23 does not match a commit naming BRO-2356', () => {
  const card = { identifier: 'BRO-23', title: 'x', description: '' };
  assert.equal(sweep.scoreCard(card, [commit('d'.repeat(40), 'fix(BRO-2356): y')]).level, 'none');
});

test('a commit naming the Notion page id is strong evidence', () => {
  const card = {
    identifier: 'BRO-9',
    title: 'something',
    description: '[notion:3b0637c5-416f-811e-8083-d15700ead650]',
  };
  const c = commit('e'.repeat(40), 'chore: close out', 'Notion 3b0637c5416f811e8083d15700ead650 done');
  assert.equal(sweep.scoreCard(card, [c]).level, 'strong');
});

// The BRO-2153 shape: fixed under old task #1709 before the card was worked.
// Its title match alone is weak; it counts because the fix changed a file the
// card names.
test('a loose title match counts when the commit changed a file the card names', () => {
  const card = {
    identifier: 'BRO-2153',
    title: "worktree-gc has no liveness guard — can remove a worktree that's still a live process's cwd",
    description: 'see scripts/gc-merged-worktrees.sh',
    createdAt: '2026-08-20T00:00:00Z',
  };
  const fix = commit('f'.repeat(40), 'fix(infra): add liveness guard to gc-merged-worktrees.sh (task #1709)');
  // The title's other words are rarer than the shared ones, as on real history.
  const idf = (w) => (['worktree', 'liveness', 'guard'].includes(w) ? 1 : 1.8);
  const ratio = sweep.titleOverlap(card.title, fix.subject, idf).ratio;
  assert.ok(ratio < 0.3 && ratio >= 0.2, `fixture should sit in the path-backed band, got ${ratio}`);

  assert.equal(sweep.scoreCard(card, [fix], { idf }).level, 'none');
  const backed = sweep.scoreCard(card, [fix], {
    idf,
    pathHistory: (p) => (p === 'scripts/gc-merged-worktrees.sh' ? [fix] : []),
  });
  assert.equal(backed.level, 'medium');
  assert.match(backed.medium[0].why, /changed scripts\/gc-merged-worktrees\.sh/);
});

test('bot commits never produce a title match', () => {
  const card = { identifier: 'BRO-5', title: 'BWW roundup yield provenance replay', description: '' };
  const bot = commit('1'.repeat(40), 'chore: Checkpoint BWW roundup yield provenance replay');
  assert.equal(sweep.scoreCard(card, [bot]).level, 'none');
  assert.equal(sweep.isAutomatedSubject('data: Fast rebuild'), true);
  assert.equal(sweep.isAutomatedSubject('fix(gc): liveness'), false);
});

test('buildIdf weights rare words above common ones', () => {
  const idf = sweep.buildIdf(['fix show page', 'fix show card', 'show liveness guard']);
  assert.ok(idf('liveness') > idf('show'));
  assert.ok(idf('neverseen') >= idf('liveness'));
});

test('weak path signals do not flag a card on their own', () => {
  const card = { identifier: 'BRO-7', title: 'q', description: 'see src/components/Gone.jsx', createdAt: '2026-08-01T00:00:00Z' };
  const r = sweep.scoreCard(card, [], { pathExists: () => false });
  assert.equal(r.level, 'weak');
  assert.equal(r.flagged, false);
  assert.equal(r.weak[0].why, 'path no longer exists');
});

test('parseGitLog reads the record format the CLI asks git for', () => {
  const raw = `${'a'.repeat(40)}\x1f2026-08-16T19:26:20-04:00\x1ffix: one\x1fbody line\n\x1e\n${'b'.repeat(40)}\x1f2026-08-17T00:00:00Z\x1ffix: two\x1f\x1e`;
  const commits = sweep.parseGitLog(raw);
  assert.equal(commits.length, 2);
  assert.equal(commits[0].subject, 'fix: one');
  assert.equal(commits[0].body, 'body line');
  assert.equal(commits[1].body, '');
});

test('buildComment carries the dedupe marker and the evidence', () => {
  const body = sweep.buildComment({
    strong: [{ sha: 'abcdef1234567', subject: 'fix(BRO-1): x', why: 'subject names BRO-1' }],
    medium: [],
    weak: [],
  });
  assert.ok(body.startsWith(sweep.COMMENT_MARKER));
  assert.match(body, /abcdef1234 fix\(BRO-1\): x/);
  assert.match(body, /Nothing was closed automatically/);
});
