/**
 * BRO-2313: reconcile-dead-completions.js must not propose reopening a task
 * whose dispatch died but whose work landed on origin/main anyway.
 *
 * The three false positives from the card (#1834 -> scripts/lib/
 * reconcile-merged-json.js names BRO-76; #1896/#1898 -> scripts/linear-next.js
 * names both tasks) plus a missing-file control that must stay reopenable.
 *
 * Run: node --test tests/unit/reconcile-dead-completions.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  extractLandedEvidence, decideWorkLanded, checkWorkLanded, contentReferencesTask, makeGitProbe,
} = require('../../scripts/lib/dead-completion-landed-check.js');
const { partitionLandedCompletions, correctLinearIssue } = require('../../scripts/reconcile-dead-completions.js');
const { reconcileDeadCompletions } = require('../../scripts/lib/dispatch-dead-launch-guard.js');

// Fake origin/main: files + ancestor shas + merged PRs. No git, no network.
function fakeGit({ files = {}, ancestors = [], prs = {} } = {}) {
  return {
    isAncestor: (sha) => ancestors.some((a) => a.startsWith(sha) || sha.startsWith(a)),
    prMerged: (n) => prs[n] || null,
    readFile: (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : null),
  };
}

const MAIN = fakeGit({
  files: {
    'scripts/lib/reconcile-merged-json.js': "// BRO-76: derived from the canonical registry\nmodule.exports = {};\n",
    'scripts/linear-next.js': "// Mirror-staleness dispatch claim (task #1898, parity with bsc-next.js's\n// task #1896 fix)\nconst DISPATCH_CLAIM_DIR = path.join(REPO, 'data', 'audit', 'linear-dispatch-claims');\n",
  },
});

const TASKS = [
  { id: '1834', status: 'completed', subject: 'BRO-76: merge reconcile JSON via registry', description: '[notion:aaa] [linear:BRO-76] P1 · Done · Infra\nKey file: scripts/lib/reconcile-merged-json.js' },
  { id: '1896', status: 'completed', subject: 'bsc-next dispatch claim race', description: '[notion:bbb] P1 · Done · Infra\nTouches scripts/linear-next.js (linear-dispatch-claims)' },
  { id: '1898', status: 'completed', subject: 'linear-next fresh-dispatch claim parity', description: '[notion:ccc] P1 · Done · Infra\nscripts/linear-next.js' },
  { id: '1999', status: 'completed', subject: 'add a thing that never landed', description: '[notion:ddd] P1 · Done · Infra\nKey file: scripts/lib/never-landed-thing.js' },
];

test('#1834: named key file exists on origin/main and references BRO-76 => landed', () => {
  const v = checkWorkLanded({ taskId: '1834', texts: [TASKS[0].subject, TASKS[0].description] }, MAIN);
  assert.equal(v.landed, true);
  assert.match(v.reason, /reconcile-merged-json\.js/);
});

test('#1896 and #1898: scripts/linear-next.js names the task => landed', () => {
  for (const t of [TASKS[1], TASKS[2]]) {
    const v = checkWorkLanded({ taskId: t.id, texts: [t.subject, t.description] }, MAIN);
    assert.equal(v.landed, true, `#${t.id}`);
    assert.match(v.reason, /linear-next\.js/);
  }
});

test('control: named key file missing on origin/main => still reopenable', () => {
  const v = checkWorkLanded({ taskId: '1999', texts: [TASKS[3].subject, TASKS[3].description] }, MAIN);
  assert.equal(v.landed, false);
});

test('control: key file exists but never references the task => still reopenable', () => {
  const v = checkWorkLanded({ taskId: '4242', texts: ['touches scripts/linear-next.js'] }, MAIN);
  assert.equal(v.landed, false);
});

test('no evidence at all, or no git probe => still reopenable', () => {
  assert.equal(checkWorkLanded({ taskId: '7', texts: ['vague subject'] }, MAIN).landed, false);
  assert.equal(decideWorkLanded(extractLandedEvidence({ taskId: '1834', texts: [TASKS[0].subject, TASKS[0].description] }), null).landed, false);
});

test('linked commit: a landed-acked ledger sha that is an ancestor of origin/main => landed; non-ancestor => not', () => {
  const entries = [{ event: 'landed-acked', taskId: 'linear:BRO-500', sha: 'abc1234def5678' }];
  assert.equal(checkWorkLanded({ taskId: 'linear:BRO-500', entries }, fakeGit({ ancestors: ['abc1234def5678'] })).landed, true);
  assert.equal(checkWorkLanded({ taskId: 'linear:BRO-500', entries }, fakeGit()).landed, false);
  // Another task's sha row is never this task's evidence.
  assert.equal(checkWorkLanded({ taskId: 'linear:BRO-501', entries }, fakeGit({ ancestors: ['abc1234def5678'] })).landed, false);
});

test('linked PR merged on origin/main => landed', () => {
  const v = checkWorkLanded({ taskId: '12', texts: ['PR https://github.com/thomaspryor/Broadwayscore/pull/77'] }, fakeGit({ prs: { 77: 'feedface1234' } }));
  assert.equal(v.landed, true);
});

test('ref matching is exact: #18 does not match #1834, BRO-7 does not match BRO-76', () => {
  assert.equal(contentReferencesTask('task #1834', ['#18']), false);
  assert.equal(contentReferencesTask('BRO-76', ['BRO-7']), false);
  assert.equal(contentReferencesTask('see task 1896 above', ['#1896']), true);
  // A bare #N is usually a PR/issue number, never task evidence on its own.
  assert.equal(contentReferencesTask('fix flaky gate (#1896)', ['#1896']), false);
});

test('PR links from another repo are ignored (app-repo PR #77 is not web-repo (#77))', () => {
  const ev = extractLandedEvidence({ taskId: '12', texts: ['https://github.com/thomaspryor/BroadwayScorecard-app/pull/77'] });
  assert.deepEqual(ev.prNumbers, []);
});

test('local pass: the three false positives are split out; the control is reopened', () => {
  const flagged = TASKS.map((t) => ({ id: t.id, subject: t.subject, notionId: null, deadAttemptTs: 'x' }));
  const { reopen, landed } = partitionLandedCompletions(flagged, TASKS, [], MAIN);
  assert.deepEqual(landed.map((t) => t.id), ['1834', '1896', '1898']);
  assert.deepEqual(reopen.map((t) => t.id), ['1999']);
  assert.ok(landed.every((t) => typeof t.landedReason === 'string'));
});

test('local pass composes with reconcileDeadCompletions on real ledger shapes', () => {
  const entries = TASKS.flatMap((t) => [
    { ts: '2026-09-01T00:00:00Z', event: 'launch', taskId: t.id, ref: `headless:${t.id}` },
    { ts: '2026-09-01T00:01:00Z', event: 'job-failed', taskId: t.id, ref: `headless:${t.id}` },
  ]);
  const flagged = reconcileDeadCompletions(TASKS, entries);
  assert.equal(flagged.length, 4, 'pre-BRO-2313 behavior: all four look reopenable from liveness alone');
  const { reopen, landed } = partitionLandedCompletions(flagged, TASKS, entries, MAIN);
  assert.deepEqual(reopen.map((t) => t.id), ['1999']);
  assert.equal(landed.length, 3);
});

test('Linear --fix pass: a landed issue returns "landed" before any mutation', async () => {
  const entries = [
    { ts: '2026-09-01T00:00:00Z', event: 'launch', taskId: 'linear:BRO-76', ref: 'headless:1' },
    { ts: '2026-09-01T00:01:00Z', event: 'job-failed', taskId: 'linear:BRO-76', ref: 'headless:1' },
  ];
  const completedAt = '2026-09-02T00:00:00Z';
  const issue = (description) => ({
    state: { type: 'completed' }, completedAt, title: 'merge JSON', description,
    comments: { nodes: [{ body: 'DONE-GATE-BYPASS: forced', createdAt: completedAt }] },
  });
  const landedResult = await correctLinearIssue('BRO-76', 'linear:BRO-76', {
    entries, git: MAIN, dryMutation: true,
    getIssue: async () => issue('## Key Files\nscripts/lib/reconcile-merged-json.js'),
  });
  assert.equal(landedResult, 'landed');
  const controlResult = await correctLinearIssue('BRO-76', 'linear:BRO-76', {
    entries, git: MAIN, dryMutation: true,
    getIssue: async () => issue('## Key Files\nscripts/lib/never-landed-thing.js'),
  });
  assert.equal(controlResult, true, 'missing-file control stays reopenable');
});

test('retro: Linear pass with a local numeric taskId still counts the issue own BRO id', async () => {
  const entries = [
    { ts: '2026-09-01T00:00:00Z', event: 'launch', taskId: '1834', ref: 'headless:1' },
    { ts: '2026-09-01T00:01:00Z', event: 'job-failed', taskId: '1834', ref: 'headless:1' },
  ];
  const completedAt = '2026-09-02T00:00:00Z';
  const result = await correctLinearIssue('BRO-76', '1834', {
    entries, git: MAIN, dryMutation: true,
    getIssue: async () => ({
      state: { type: 'completed' }, completedAt, title: 'merge JSON',
      description: '## Key Files\nscripts/lib/reconcile-merged-json.js',
      comments: { nodes: [{ body: 'DONE-GATE-BYPASS: forced', createdAt: completedAt }] },
    }),
  });
  assert.equal(result, 'landed', 'reconcile-merged-json.js names BRO-76, the issue being checked');
});

test('makeGitProbe against a real temp repo: ancestor, key file, missing file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdc-landed-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 't');
    git('config', 'gc.auto', '0');
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'scripts', 'linear-next.js'), '// task #1898 claim\n');
    git('add', '.');
    git('commit', '-q', '-m', 'land #1898 (#77)');
    const landedSha = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', 'side');
    fs.writeFileSync(path.join(dir, 'x.txt'), 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'unlanded');
    const strandedSha = git('rev-parse', 'HEAD');

    const probe = makeGitProbe({ cwd: dir });
    assert.equal(probe.isAncestor(landedSha), true);
    assert.equal(probe.isAncestor(strandedSha), false);
    assert.equal(probe.isAncestor('deadbeefdeadbeef'), false);
    assert.match(probe.readFile('scripts/linear-next.js'), /#1898/);
    assert.equal(probe.readFile('scripts/never-landed-thing.js'), null);
    assert.equal(probe.prMerged(77), landedSha);
    assert.equal(probe.prMerged(78), null);
    assert.equal(checkWorkLanded({ taskId: '1898', texts: ['scripts/linear-next.js'] }, probe).landed, true);
    assert.equal(checkWorkLanded({ taskId: '1999', texts: ['scripts/never-landed-thing.js'] }, probe).landed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// --- Independent review of 5bb32ee4 ---

test('review #1: a job-stranded sha (job worktree HEAD, often the base commit) is never evidence', () => {
  const entries = [{ event: 'job-stranded', taskId: 'linear:BRO-500', sha: 'abc1234def5678' }];
  assert.deepEqual(extractLandedEvidence({ taskId: 'linear:BRO-500', entries }).shas, []);
  assert.equal(checkWorkLanded({ taskId: 'linear:BRO-500', entries }, fakeGit({ ancestors: ['abc1234def5678'] })).landed, false);
});

test('review #2: a sha cited as a cause is not evidence; landed/merged/fixed-in phrasing is', () => {
  const main = fakeGit({ ancestors: ['abc1234def5678'] });
  for (const text of ['Regressed by commit abc1234def5678', 'commit abc1234def5678', 'sha abc1234def5678',
    'broke in landed abc1234def5678', 'introduced by merged abc1234def5678']) {
    assert.equal(checkWorkLanded({ taskId: '5', texts: [text] }, main).landed, false, text);
  }
  for (const text of ['landed in abc1234def5678', 'merged as abc1234def5678', 'fixed in commit abc1234def5678', 'fix commit: abc1234def5678']) {
    assert.equal(checkWorkLanded({ taskId: '5', texts: [text] }, main).landed, true, text);
  }
});

test('review #3: a BRO-N merely mentioned in the text is not a ref; own id / marker / linearIdentifier is', () => {
  assert.deepEqual(extractLandedEvidence({ taskId: '1834', texts: ['follow-up to BRO-76'] }).refs, ['#1834']);
  assert.equal(checkWorkLanded({ taskId: '1834', texts: ['follow-up to BRO-76; scripts/lib/reconcile-merged-json.js'] }, MAIN).landed, false);
  assert.equal(checkWorkLanded({ taskId: '1834', texts: ['scripts/lib/reconcile-merged-json.js'], ownIds: ['BRO-76'] }, MAIN).landed, true);
  assert.ok(extractLandedEvidence({ taskId: '1834', texts: ['[linear:BRO-76] x'] }).refs.includes('BRO-76'));
});

test('review #3: this script\'s own auto-reopen notes are ignored as evidence', () => {
  const main = fakeGit({ ancestors: ['abc1234def5678'] });
  const own = 'Auto-corrected 2026-10-01 by reconcile-dead-completions: merged as abc1234def5678 scripts/linear-next.js';
  assert.equal(checkWorkLanded({ taskId: 'linear:BRO-9', texts: [own] }, main).landed, false);
  const local = '[reconcile-dead-completions 2026-10-01] reopened — landed in abc1234def5678';
  assert.equal(checkWorkLanded({ taskId: '9', texts: [local] }, main).landed, false);
});

test('review #4: a reference on a TODO / known-issue / not-yet line does not count', () => {
  for (const line of ['// TODO(task #4242): wire this up', '// known issue, task #4242', '// task #4242 not yet fixed', '// FIXME card #4242', '// task #4242 is still open']) {
    const git = fakeGit({ files: { 'scripts/x.js': `const a = 1;\n${line}\n` } });
    assert.equal(checkWorkLanded({ taskId: '4242', texts: ['scripts/x.js'] }, git).landed, false, line);
  }
  const ok = fakeGit({ files: { 'scripts/x.js': '// TODO: unrelated\n// task #4242: claim fix\n' } });
  assert.equal(checkWorkLanded({ taskId: '4242', texts: ['scripts/x.js'] }, ok).landed, true);
});

test('review #5: PR probe skips Revert commits that name the PR', () => {
  const run = (args) => (args[0] === 'log'
    ? { status: 0, stdout: 'aaaaaaa1111111\tRevert "add thing (#77)"\n' }
    : { status: 1, stdout: '' });
  assert.equal(makeGitProbe({ run }).prMerged(77), null);
  const run2 = (args) => (args[0] === 'log'
    ? { status: 0, stdout: 'aaaaaaa1111111\tRevert "add thing (#77)"\nbbbbbbb2222222\tadd thing (#77)\n' }
    : { status: 1, stdout: '' });
  // BRO-5261 retro-review: a PR reverted on main is not landed (its effect is gone).
  assert.equal(makeGitProbe({ run: run2 }).prMerged(77), null);
  const run3 = (args) => (args[0] === 'log'
    ? { status: 0, stdout: 'bbbbbbb2222222\tadd thing (#77)\n' }
    : { status: 1, stdout: '' });
  assert.equal(makeGitProbe({ run: run3 }).prMerged(77), 'bbbbbbb2222222');
});

test('retro: a revert of the revert restores the PR landing', () => {
  const run = (args) => (args[0] === 'log'
    ? { status: 0, stdout: 'eeeeeee5555555\tRevert "Revert \"add thing (#77)\""\naaaaaaa1111111\tRevert "add thing (#77)"\nbbbbbbb2222222\tadd thing (#77)\n' }
    : { status: 1, stdout: '' });
  assert.equal(makeGitProbe({ run }).prMerged(77), 'bbbbbbb2222222');
});

test('retro: PR probe ignores commits that only mention (#N) in the body', () => {
  // git log --grep matched on the body; the subject belongs to another PR.
  const run = (args) => (args[0] === 'log'
    ? { status: 0, stdout: 'ccccccc3333333\tunrelated change (#900)\n' }
    : { status: 1, stdout: '' });
  assert.equal(makeGitProbe({ run }).prMerged(640), null);
  const merge = (args) => (args[0] === 'log'
    ? { status: 0, stdout: 'ddddddd4444444\tMerge pull request #640 from o/b\n' }
    : { status: 1, stdout: '' });
  assert.equal(makeGitProbe({ run: merge }).prMerged(640), 'ddddddd4444444');
});

test('retro: a PR link named as the cause is not the task landing', () => {
  const ev = extractLandedEvidence({ taskId: '9', texts: ['Regression introduced by https://github.com/o/Broadwayscore/pull/812, fix it. Fix landed in https://github.com/o/Broadwayscore/pull/813'] });
  assert.deepEqual(ev.prNumbers, [813]);
});

test('retro: "partially fixed in" / "not yet landed in" shas are not landings', () => {
  const ev = extractLandedEvidence({ taskId: '9', texts: ['Partially fixed in 3f9e2ab; cache path still broken.', 'Not yet landed in 4a1b2c3.', 'Landed in 5d6e7f8.'] });
  assert.deepEqual(ev.shas, ['5d6e7f8']);
});

test('retro: an ack from an earlier dispatch round does not cover a later dead attempt', () => {
  const entries = [
    { event: 'launch', taskId: '50', jobId: 'jobA', ts: '2026-10-01T00:00:00Z' },
    { event: 'landed-acked', taskId: '50', jobId: 'jobA', sha: 'aaaaaaa1111111', ts: '2026-10-01T01:00:00Z' },
    { event: 'launch', taskId: '50', jobId: 'jobB', ts: '2026-10-05T00:00:00Z' },
    { event: 'job-orphaned', taskId: '50', jobId: 'jobB', ts: '2026-10-05T00:10:00Z' },
  ];
  assert.deepEqual(extractLandedEvidence({ taskId: '50', entries }).shas, []);
  const acked = [...entries, { event: 'landed-acked', taskId: '50', jobId: 'jobB', sha: 'bbbbbbb2222222', ts: '2026-10-05T01:00:00Z' }];
  assert.deepEqual(extractLandedEvidence({ taskId: '50', entries: acked }).shas, ['bbbbbbb2222222']);
});

test('retro: [linear:BRO-N] markers count as own ids only from ownTexts (description), not quoted comments', () => {
  const ev = extractLandedEvidence({ taskId: 'linear:BRO-900', texts: ['desc', 'comment quoting [linear:BRO-76] P1 Done'], ownTexts: ['desc'] });
  assert.ok(!ev.refs.includes('BRO-76'));
  assert.ok(ev.refs.includes('BRO-900'));
});

test('data-repo ack (BRO-5219): a landed-acked row with repo counts as landed without a probe of this repo', () => {
  const entries = [{ event: 'landed-acked', taskId: 'linear:BRO-5416', sha: '53e633c05fbc9969', repo: 'review-texts' }];
  const v = checkWorkLanded({ taskId: 'linear:BRO-5416', entries }, fakeGit());
  assert.equal(v.landed, true);
  assert.match(v.reason, /acked in review-texts at 53e633c05fbc/);
  const ev = extractLandedEvidence({ taskId: 'linear:BRO-5416', entries });
  assert.deepEqual(ev.shas, []);
  // Another task's data-repo ack is never this task's evidence.
  assert.equal(checkWorkLanded({ taskId: 'linear:BRO-5417', entries }, fakeGit()).landed, false);
});

test('data-repo ack from an EARLIER attempt does not cover a later dead attempt', () => {
  const entries = [
    { event: 'job-spawned', taskId: '60', jobId: 'jobA', ts: '2026-10-01T00:00:00Z' },
    { event: 'landed-acked', taskId: '60', jobId: 'jobA', sha: 'aaaaaaa1111111', repo: 'review-texts', ts: '2026-10-01T01:00:00Z' },
    { event: 'job-spawned', taskId: '60', jobId: 'jobB', ts: '2026-10-05T00:00:00Z' },
  ];
  assert.equal(checkWorkLanded({ taskId: '60', entries }, fakeGit()).landed, false);
});
