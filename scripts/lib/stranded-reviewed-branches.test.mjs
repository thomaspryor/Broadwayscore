import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// require() the REAL module, never a copy of its logic (CLAUDE.md rule 15).
const { bestVerdictByBranch, findStrandedReviewedBranches, hasUsableVerdicts } = require('./stranded-reviewed-branches.js');

test('a branch with a passing verdict and unreachable commits is reported as stranded-reviewed', () => {
  const branches = [{ branch: 'job/linear-BRO-2424', ahead: 9, dirty: 0, lastCommitDate: '2026-08-26' }];
  const verdicts = [{ branch: 'job/linear-BRO-2424', result: 'pass', reviewer: 'ship-check', gatedLines: 983, ts: '2026-08-26T10:00:00Z' }];
  const out = findStrandedReviewedBranches(branches, verdicts);
  assert.equal(out.reviewed.length, 1);
  assert.equal(out.unreviewed.length, 0);
  assert.equal(out.reviewed[0].gatedLines, 983);
  assert.equal(out.totalGatedLines, 983);
});

test('a branch whose commits are all reachable from origin/main is NOT stranded, even with a passing verdict', () => {
  // This is the case that must never alert: work that actually landed.
  const branches = [{ branch: 'worktree-landed', ahead: 0, dirty: 0, lastCommitDate: '2026-09-05' }];
  const verdicts = [{ branch: 'worktree-landed', result: 'pass', reviewer: 'ship-check', gatedLines: 100, ts: '2026-09-05T10:00:00Z' }];
  const out = findStrandedReviewedBranches(branches, verdicts);
  assert.equal(out.reviewed.length, 0);
  assert.equal(out.landed, 1);
  assert.equal(out.totalGatedLines, 0);
});

test('a stranded branch with NO verdict is separated from the reviewed set, not merged into it', () => {
  // Work-in-progress must not be reported as "finished work being lost", or the
  // signal becomes noise and stops being actioned.
  const branches = [
    { branch: 'wip-branch', ahead: 3, dirty: 5, lastCommitDate: '2026-08-14' },
    { branch: 'done-branch', ahead: 2, dirty: 0, lastCommitDate: '2026-08-31' },
  ];
  const verdicts = [{ branch: 'done-branch', result: 'pass', reviewer: 'ship-check', gatedLines: 300, ts: '2026-08-31T10:00:00Z' }];
  const out = findStrandedReviewedBranches(branches, verdicts);
  assert.deepEqual(out.reviewed.map((r) => r.branch), ['done-branch']);
  assert.deepEqual(out.unreviewed.map((r) => r.branch), ['wip-branch']);
});

test('a FAILING verdict does not qualify a stranded branch as reviewed', () => {
  const branches = [{ branch: 'failed-review', ahead: 1, dirty: 0, lastCommitDate: '2026-09-01' }];
  const verdicts = [{ branch: 'failed-review', result: 'fail', reviewer: 'second-opinion', gatedLines: 40, ts: '2026-09-01T10:00:00Z' }];
  const out = findStrandedReviewedBranches(branches, verdicts);
  assert.equal(out.reviewed.length, 0);
  assert.equal(out.unreviewed.length, 1);
});

test('a pass beats a later fail for the same branch (fixed-then-approved keeps the work visible)', () => {
  const verdicts = [
    { branch: 'b', result: 'pass', reviewer: 'ship-check', gatedLines: 10, ts: '2026-09-01T10:00:00Z' },
    { branch: 'b', result: 'fail', reviewer: 'ship-check', gatedLines: 10, ts: '2026-09-02T10:00:00Z' },
  ];
  assert.equal(bestVerdictByBranch(verdicts).get('b').result, 'pass');
});

test('the latest verdict wins among same-result entries', () => {
  const verdicts = [
    { branch: 'b', result: 'pass', reviewer: 'old', gatedLines: 1, ts: '2026-09-01T10:00:00Z' },
    { branch: 'b', result: 'pass', reviewer: 'new', gatedLines: 2, ts: '2026-09-03T10:00:00Z' },
  ];
  assert.equal(bestVerdictByBranch(verdicts).get('b').reviewer, 'new');
});

test('results are ordered oldest-first, because longest-stranded work is most at risk', () => {
  const branches = [
    { branch: 'newer', ahead: 1, lastCommitDate: '2026-09-04' },
    { branch: 'oldest', ahead: 1, lastCommitDate: '2026-08-20' },
    { branch: 'middle', ahead: 1, lastCommitDate: '2026-08-31' },
  ];
  const verdicts = branches.map((b) => ({ branch: b.branch, result: 'pass', reviewer: 'ship-check', gatedLines: 5, ts: '2026-09-01T10:00:00Z' }));
  const out = findStrandedReviewedBranches(branches, verdicts);
  assert.deepEqual(out.reviewed.map((r) => r.branch), ['oldest', 'middle', 'newer']);
});

test('ignoreBranches excludes a caller-supplied live branch from the report', () => {
  // The crown session running the sweep is itself in a worktree with unlanded
  // work; reporting itself would be a permanent false positive.
  const branches = [{ branch: 'my-own-live-branch', ahead: 1, lastCommitDate: '2026-09-05' }];
  const verdicts = [{ branch: 'my-own-live-branch', result: 'pass', reviewer: 'ship-check', gatedLines: 5, ts: '2026-09-05T10:00:00Z' }];
  const out = findStrandedReviewedBranches(branches, verdicts, { ignoreBranches: ['my-own-live-branch'] });
  assert.equal(out.reviewed.length, 0);
  assert.equal(out.unreviewed.length, 0);
});

test('a non-numeric or negative ahead count is treated as landed, not as stranded', () => {
  // Fail toward silence on malformed input rather than crying wolf: a bogus
  // count must not manufacture an alert about work that may be perfectly fine.
  const branches = [
    { branch: 'bogus', ahead: 'not-a-number', lastCommitDate: '2026-09-01' },
    { branch: 'negative', ahead: -3, lastCommitDate: '2026-09-01' },
  ];
  const verdicts = [
    { branch: 'bogus', result: 'pass', reviewer: 'ship-check', gatedLines: 5, ts: '2026-09-01T10:00:00Z' },
    { branch: 'negative', result: 'pass', reviewer: 'ship-check', gatedLines: 5, ts: '2026-09-01T10:00:00Z' },
  ];
  const out = findStrandedReviewedBranches(branches, verdicts);
  assert.equal(out.reviewed.length, 0);
  assert.equal(out.landed, 2);
});

test('verdict entries with no branch field are ignored rather than throwing', () => {
  const verdicts = [{ result: 'pass', ts: '2026-09-01T10:00:00Z' }, { branch: '', result: 'pass' }, null];
  assert.equal(bestVerdictByBranch(verdicts).size, 0);
});

test('empty inputs produce an empty report rather than throwing', () => {
  const out = findStrandedReviewedBranches([], []);
  assert.deepEqual(out, { reviewed: [], unreviewed: [], landed: 0, totalGatedLines: 0 });
});

test('hasUsableVerdicts is false for a missing, empty or branchless ledger (fail-closed input)', () => {
  // Each of these would otherwise yield "0 branches at risk", a false all-clear
  // indistinguishable from a genuinely clean repo. This is not hypothetical: it
  // happened during development, when the ledger path resolved to the worktree
  // rather than the main checkout and 13 stranded branches were reported as 0.
  assert.equal(hasUsableVerdicts(undefined), false);
  assert.equal(hasUsableVerdicts(null), false);
  assert.equal(hasUsableVerdicts([]), false);
  assert.equal(hasUsableVerdicts([null, { result: 'pass' }, { branch: '' }]), false);
});

test('hasUsableVerdicts is true as soon as one verdict names a branch', () => {
  assert.equal(hasUsableVerdicts([{ branch: 'b', result: 'fail' }]), true);
});
