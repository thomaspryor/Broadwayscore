import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyCommit, decideAutoRevert, classifyReplayOutcome } = require('./auto-revert.js');
const { replay } = require('./auto-revert-replay.js');

const landing = (sha, files = ['scripts/x.js'], subject = 'BRO-1 fix x') => ({ sha, authorName: 'Claude', subject, body: '', files });
const bot = (sha, files = ['data/shows.json']) => ({ sha, authorName: 'github-actions[bot]', subject: 'data: rebuild', body: '', files });
const ENV = {};

test('classifyCommit: bots (both spellings), data-only, docs-only, reverts, landings', () => {
  assert.equal(classifyCommit(bot('a')), 'data-bot');
  assert.equal(classifyCommit({ ...bot('a'), authorName: 'GitHub Action', files: ['scripts/y.js'] }), 'bot-code');
  assert.equal(classifyCommit({ ...bot('a'), authorName: 'GitHub Action', files: ['data/shows.json'] }), 'data-bot');
  assert.equal(classifyCommit({ ...landing('a'), files: ['data/reviews.json', 'data/audit/x.jsonl'] }), 'data-bot');
  assert.equal(classifyCommit({ ...landing('a'), files: ['memory/x.md', 'CLAUDE.md'] }), 'docs-only');
  assert.equal(classifyCommit({ ...landing('a'), subject: 'Revert "BRO-1 fix x"' }), 'revert');
  assert.equal(classifyCommit({ ...landing('a'), body: 'This reverts commit 0123abcd.' }), 'revert');
  assert.equal(classifyCommit(landing('a', ['scripts/x.js', 'data/shows.json'])), 'landing');
  // A bot that edits code is not data: dependabot bumping package.json.
  assert.equal(classifyCommit({ ...bot('a'), authorName: 'dependabot[bot]', files: ['package.json'] }), 'bot-code');
  assert.equal(classifyCommit({ ...bot('a'), files: null }), 'data-bot');
});

test('decideAutoRevert: a code-editing bot beside one landing holds (never blame the person)', () => {
  const dep = { ...bot('d1'), authorName: 'dependabot[bot]', files: ['package.json'] };
  assert.equal(decideAutoRevert({ commits: [landing('L1'), dep], confirm: 'failure', env: ENV }).reason, 'bot-code-in-window');
});

test('decideAutoRevert: one landing + failed confirm reverts (shadow by default); every hold', () => {
  const w = [bot('b1'), landing('L1'), bot('b2')];
  const d = decideAutoRevert({ commits: w, confirm: 'failure', env: ENV });
  assert.deepEqual([d.revert, d.shadow, d.reason, d.sha], [true, true, 'confirmed-breaking-landing', 'L1']);
  assert.equal(decideAutoRevert({ commits: w, confirm: 'failure', env: { AUTO_REVERT_MODE: 'armed' } }).shadow, false);
  assert.equal(decideAutoRevert({ commits: w, confirm: 'failure', env: { AUTO_REVERT_DISABLED: 'true' } }).reason, 'kill-switch');
  assert.equal(decideAutoRevert({ commits: w, confirm: null, env: ENV }).reason, 'awaiting-confirm');
  assert.equal(decideAutoRevert({ commits: w, confirm: 'success', env: ENV }).reason, 'not-confirmed');
  assert.equal(decideAutoRevert({ commits: [bot('b1')], confirm: 'failure', env: ENV }).reason, 'data-only-window');
  assert.equal(decideAutoRevert({ commits: [landing('L1'), landing('L2')], confirm: 'failure', env: ENV }).reason, 'multiple-landings');
  const rev = { ...landing('R1'), subject: 'Revert "x"' };
  assert.equal(decideAutoRevert({ commits: [rev], confirm: 'failure', env: ENV }).reason, 'no-landing');
  assert.equal(decideAutoRevert({ commits: [], confirm: 'failure', env: ENV }).reason, 'no-commits');
});

test('classifyReplayOutcome: revert or same-file fix is true; bot-only clear is false; other fix apart', () => {
  const cand = landing('abcdef1234', ['scripts/x.js']);
  assert.equal(classifyReplayOutcome({ candidate: cand, fixWindow: [{ ...landing('r'), subject: 'Revert "BRO-1"', body: 'This reverts commit abcdef1234.' }] }), 'true-breakage');
  assert.equal(classifyReplayOutcome({ candidate: cand, fixWindow: [landing('f', ['scripts/x.js'])] }), 'true-breakage');
  assert.equal(classifyReplayOutcome({ candidate: cand, fixWindow: [bot('b')] }), 'false-revert');
  assert.equal(classifyReplayOutcome({ candidate: cand, fixWindow: [landing('f', ['tests/unit/y.test.mjs'])] }), 'other-fix');
  assert.equal(classifyReplayOutcome({ candidate: cand, fixWindow: [], cleared: false }), 'still-red');
});

test('replay: green->red with a re-run confirm, then a bot-only clear, is counted as a false revert', () => {
  const commits = [landing('g0'), landing('L1'), bot('b1'), bot('b2')];
  const t = (n) => `2026-11-01T0${n}:00:00Z`;
  const windowOf = (a, b) => {
    const i = commits.findIndex((c) => c.sha === a.sha);
    const j = commits.findIndex((c) => c.sha === b.sha);
    return i < 0 || j < i ? null : commits.slice(i + 1, j + 1);
  };
  const runs = [
    { sha: 'g0', time: t(1), conclusion: 'success', attempt: 1 },
    { sha: 'L1', time: t(2), conclusion: 'failure', attempt: 1 },
    { sha: 'L1', time: t(2), conclusion: 'failure', attempt: 2 },
    { sha: 'b2', time: t(4), conclusion: 'success', attempt: 1 },
  ];
  const r = replay(runs, windowOf);
  assert.equal(r.transitions, 1);
  assert.equal(r.wouldRevert, 1);
  assert.equal(r.falseReverts, 1);
  // Same history but the next run on the same code passes: a flake, not confirmed.
  const flaky = replay([runs[0], runs[1], { sha: 'b1', time: t(3), conclusion: 'success', attempt: 1 }], windowOf);
  assert.equal(flaky.rows[0].reason, 'not-confirmed');
  assert.equal(flaky.rows[0].confirmVia, 'next-run-same-code');
  // A window the API could not resolve is counted unknown, never guessed.
  const lost = replay(runs, () => null);
  assert.equal(lost.unknown, 1);
});

test('makeWindowFetcher: stops at the older sha, skips bot file reads until filled, null when not found', async () => {
  const { makeWindowFetcher } = require('./auto-revert-replay.js');
  const calls = [];
  const page = [
    { sha: 'c3', authorName: 'Claude', message: 'BRO-2 x\n\nbody' },
    { sha: 'c2', authorName: 'github-actions[bot]', message: 'data: y' },
    { sha: 'c1', authorName: 'Claude', message: 'BRO-1 z' },
  ];
  const exec = (_cmd, args) => {
    calls.push(args[1]);
    if (args[1].includes('/commits?')) return JSON.stringify(page);
    return JSON.stringify(['scripts/x.js']);
  };
  const w = makeWindowFetcher(exec)({ sha: 'c1', time: '2026-11-01T00:00:00Z' }, { sha: 'c3' });
  assert.deepEqual(w.map((c) => c.sha), ['c2', 'c3']);
  assert.equal(w[1].subject, 'BRO-2 x');
  assert.equal(calls.filter((p) => /\/commits\/c/.test(p)).length, 1, 'one file read, for the person commit only');
  // fill reads a bot's files on demand, once (cached).
  const f = makeWindowFetcher(exec);
  const w2 = f({ sha: 'c1', time: '2026-11-01T00:00:00Z' }, { sha: 'c3' });
  f.fill(w2); f.fill(w2);
  assert.deepEqual(w2[0].files, ['scripts/x.js']);
  assert.equal(makeWindowFetcher(exec)({ sha: 'zz', time: '2026-11-01T00:00:00Z' }, { sha: 'c3' }), null);
});

test('replay: an unconfirmed single-landing red reports its if-confirmed outcome (upper bound)', () => {
  // No re-run, and a person's landing sits between the red and the next green: no confirm at all.
  const commits2 = [landing('g0'), landing('L1'), landing('F1', ['scripts/x.js'])];
  const w2 = (a, b) => {
    const i = commits2.findIndex((c) => c.sha === a.sha);
    const j = commits2.findIndex((c) => c.sha === b.sha);
    return i < 0 || j < i ? null : commits2.slice(i + 1, j + 1);
  };
  const r = replay([
    { sha: 'g0', time: '2026-11-01T01:00:00Z', conclusion: 'success', attempt: 1 },
    { sha: 'L1', time: '2026-11-01T02:00:00Z', conclusion: 'failure', attempt: 1 },
    { sha: 'F1', time: '2026-11-01T03:00:00Z', conclusion: 'success', attempt: 1 },
  ], w2);
  assert.equal(r.rows[0].reason, 'awaiting-confirm');
  assert.equal(r.rows[0].ifConfirmed, 'true-breakage');
  assert.deepEqual(r.ifConfirmed, { 'true-breakage': 1 });
  assert.equal(r.falseReverts, 0);
});

test('ghRunsForDay: a re-run run also yields its attempt-1 verdict (the list shows only the latest attempt)', () => {
  const { ghRunsForDay } = require('./auto-revert-replay.js');
  const exec = (_cmd, args) => {
    if (args[1].includes('/attempts/1')) return JSON.stringify({ conclusion: 'failure' });
    return JSON.stringify({ total: 2, runs: [
      { id: 7, sha: 'L1', time: '2026-11-01T02:00:00Z', conclusion: 'success', attempt: 2 },
      { id: 6, sha: 'g0', time: '2026-11-01T01:00:00Z', conclusion: 'success', attempt: 1 },
    ] });
  };
  const runs = ghRunsForDay('2026-11-01', exec);
  assert.deepEqual(runs.filter((r) => r.sha === 'L1').map((r) => [r.attempt, r.conclusion]).sort(), [[1, 'failure'], [2, 'success']]);
  // Fed to replay, that is a red whose confirm re-run passed: a flake, never a revert.
  const r = replay(runs, (a, b) => (a.sha === 'g0' && b.sha === 'L1' ? [landing('L1')] : []));
  assert.equal(r.transitions, 1);
  assert.equal(r.rows[0].reason, 'not-confirmed');
  assert.equal(r.rows[0].confirmVia, 'rerun-attempt-2');
});

test('retry: a dropped connection is retried, a lasting failure still throws', () => {
  const { retry } = require('./auto-revert-replay.js');
  let n = 0;
  const waits = [];
  assert.equal(retry(() => { if (++n < 3) throw new Error('reset'); return 'ok'; }, 3, (ms) => waits.push(ms)), 'ok');
  assert.deepEqual(waits, [2000, 4000]);
  assert.throws(() => retry(() => { throw new Error('down'); }, 2, () => {}), /down/);
});

test('replay findings (30-day run): bot status file, bot images and merge commits are not bot code', () => {
  // a44d2b105: a reviews.json rebuild that also rewrote public/opening-night-status.json.
  assert.equal(classifyCommit({ ...bot('a'), files: ['data/reviews.json', 'public/opening-night-status.json'] }), 'data-bot');
  // c321b887f: "chore: Auto-fetch and archive show images".
  assert.equal(classifyCommit({ ...bot('a'), files: ['public/images/shows/x/poster.webp'] }), 'data-bot');
  // 9db61b71f: a bot "Merge remote-tracking branch 'origin/main'" whose diff lists workflows.
  const merge = { ...bot('m'), subject: "Merge remote-tracking branch 'origin/main'", parents: 2, files: ['.github/workflows/land.yml'] };
  assert.equal(classifyCommit(merge), 'merge');
  // A merge can carry its own conflict resolution: a merge beside a landing holds.
  const d = decideAutoRevert({ commits: [landing('L1'), merge, bot('b1')], confirm: 'failure', env: ENV });
  assert.equal(d.reason, 'merge-in-window');
  assert.equal(d.revert, false);
  // A merge is never a fixer: a red cleared only by a merge plus bots is a false revert.
  assert.equal(classifyReplayOutcome({ candidate: landing('abcdef1234'), fixWindow: [merge, bot('b')] }), 'false-revert');
  // A bot editing real code still holds.
  assert.equal(classifyCommit({ ...bot('a'), files: ['public/sw.js'] }), 'bot-code');
});

test('makeWindowFetcher cache: a second fetcher on the same cache file makes no API calls', async () => {
  const { makeWindowFetcher } = require('./auto-revert-replay.js');
  const os = require('os'); const path = require('path'); const fs = require('fs');
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arr-')), 'c.json');
  const page = [{ sha: 'c2', authorName: 'Claude', message: 'BRO-2 x', parents: 1 }, { sha: 'c1', authorName: 'Claude', message: 'BRO-1 z', parents: 1 }];
  let calls = 0;
  const exec = (_c, args) => { calls++; return JSON.stringify(args[1].includes('/commits?') ? page : ['scripts/x.js']); };
  const f1 = makeWindowFetcher(exec, 25, { cachePath });
  f1({ sha: 'c1', time: '2026-11-01T00:00:00Z' }, { sha: 'c2' });
  f1.save();
  const before = calls;
  const w = makeWindowFetcher(exec, 25, { cachePath })({ sha: 'c1', time: '2026-11-01T00:00:00Z' }, { sha: 'c2' });
  assert.equal(calls, before);
  assert.deepEqual(w[0].files, ['scripts/x.js']);
});

test('makeWindowFetcher cache: the same window read twice in one run keeps its subjects', () => {
  const { makeWindowFetcher } = require('./auto-revert-replay.js');
  const os = require('os'); const path = require('path'); const fs = require('fs');
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'arr-')), 'c.json');
  const page = [{ sha: 'c2', authorName: 'Claude', message: 'BRO-2 x\n\nbody', parents: 1 }, { sha: 'c1', authorName: 'Claude', message: 'BRO-1 z', parents: 1 }];
  const exec = (_c, args) => JSON.stringify(args[1].includes('/commits?') ? page : ['scripts/x.js']);
  const f = makeWindowFetcher(exec, 25, { cachePath });
  f({ sha: 'c1', time: '2026-11-01T00:00:00Z' }, { sha: 'c2' });
  const again = f({ sha: 'c1', time: '2026-11-01T00:00:00Z' }, { sha: 'c2' });
  assert.equal(again[0].subject, 'BRO-2 x');
});
