import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// require() the REAL module, never a copy of its logic (CLAUDE.md rule 15).
const {
  bestVerdictByBranch,
  findStrandedReviewedBranches,
  hasUsableVerdicts,
  sweepIsTrustworthy,
  normalizeNumstatPath,
} = require('./stranded-reviewed-branches.js');

/**
 * numstat path shapes. A renamed CODE file arrives as `dir/{old.js => new.js}`,
 * which ends in `}` and so failed the anchored extension test: it was counted as
 * non-code, which left liveCodeFiles at 0, flipped the branch to DOCS ONLY and
 * DROPPED it from the outstanding-work total. A pure refactor branch would have
 * disappeared from the report. Verified against real git before writing these:
 * `git diff --numstat` on a renamed-and-edited file prints
 * `2\taa/bb/{old.js => new.js}` (0 in the delete column), and a binary prints `-\t-`.
 */
test('BRO-2878: normalizeNumstatPath resolves every numstat path shape to the current file', () => {
  // Plain paths are untouched.
  assert.equal(normalizeNumstatPath('scripts/lib/thing.js'), 'scripts/lib/thing.js');
  // Common-prefix rename: only the braced segment is rewritten.
  assert.equal(normalizeNumstatPath('aa/bb/{old.js => new.js}'), 'aa/bb/new.js');
  // Directory rename: the braced segment is a DIRECTORY, the filename follows it.
  assert.equal(normalizeNumstatPath('a/{b => c}/d.js'), 'a/c/d.js');
  // No common prefix: everything after the arrow is the destination.
  assert.equal(normalizeNumstatPath('old.js => new.js'), 'new.js');
  // Quoted, which numstat does for spaces and non-ASCII.
  assert.equal(normalizeNumstatPath('"dir/with space.js"'), 'dir/with space.js');
  // A rename INTO a quoted path.
  assert.equal(normalizeNumstatPath('"{old.js => new name.js}"'), 'new name.js');
  // A rename that empties the braced segment leaves no doubled separator.
  assert.equal(normalizeNumstatPath('a/{b => }/d.js'), 'a/d.js');
  // Junk in, empty string out, never a throw.
  assert.equal(normalizeNumstatPath(null), '');
  assert.equal(normalizeNumstatPath(undefined), '');
});

test('BRO-2878: a renamed CODE file is still recognised as code, not demoted to docs', () => {
  // This is the whole point: before the fix the rename token failed the extension
  // test, so a renamed .js counted as non-code and its branch was excluded.
  const RE = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts|sh|bash|py|yml|yaml|css|scss|sql|html|plist)$/i;
  assert.equal(RE.test('aa/bb/{old.js => new.js}'), false, 'the raw token does NOT match — that was the bug');
  assert.equal(RE.test(normalizeNumstatPath('aa/bb/{old.js => new.js}')), true, 'normalised, it does');
});

test('BRO-2878: a branch with changed FILES but no countable lines is not called already-landed', () => {
  // Binary rows print '-' for both columns and a pure rename or mode change prints
  // 0/0, so a branch that genuinely changes files can total zero lines. Claiming it
  // already landed is the same false all-clear in a new costume.
  const branches = [{
    branch: 'binary-only', ahead: 1, dirty: 0,
    liveDiffLines: 0, liveOtherLines: 0, liveCodeFiles: 0, liveFiles: 2,
    lastCommitDate: '2026-09-01',
  }];
  const verdicts = [
    { branch: 'binary-only', result: 'pass', ts: '2026-09-01T00:00:00Z', reviewer: 'ship-check', gatedLines: 40 },
  ];
  const out = findStrandedReviewedBranches(branches, verdicts);
  assert.equal(out.reviewed[0].probablyAlreadyLanded, false,
    'two changed files with zero countable lines is NOT an empty diff');
});

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

test('a LATER fail supersedes an earlier pass — rejected work is not reported as approved', () => {
  // An earlier version preferred any pass over a later fail. Adversarial review
  // showed that is backwards: pass-then-fail describes work that was approved and
  // subsequently REJECTED, so honouring the stale pass would report rejected work
  // as "finished work at risk" and train people to ignore the report.
  const verdicts = [
    { branch: 'b', result: 'pass', reviewer: 'ship-check', gatedLines: 10, ts: '2026-09-01T10:00:00Z' },
    { branch: 'b', result: 'fail', reviewer: 'ship-check', gatedLines: 10, ts: '2026-09-02T10:00:00Z' },
  ];
  assert.equal(bestVerdictByBranch(verdicts).get('b').result, 'fail');
});

test('a later pass supersedes an earlier fail — fixed-then-approved work is still reported', () => {
  const verdicts = [
    { branch: 'b', result: 'fail', reviewer: 'ship-check', gatedLines: 10, ts: '2026-09-01T10:00:00Z' },
    { branch: 'b', result: 'pass', reviewer: 'ship-check', gatedLines: 10, ts: '2026-09-02T10:00:00Z' },
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
  assert.deepEqual(out, {
    reviewed: [], unreviewed: [], landed: 0, totalGatedLines: 0, totalLiveDiffLines: 0,
  });
});

// BRO-2878: totalGatedLines is the review-TIME snapshot and drifts badly once a
// branch's code lands, because the branch keeps its old verdict. On 2026-09-05 two of
// twelve stranded branches were billed 652 and 726 gated lines while their entire
// remaining diff was a STATE.md handoff doc, overstating the reported exposure by
// about 30%. These tests pin the live-diff figure that replaced it in the headline.
test('BRO-2878: a branch whose code has landed is excluded from the live total but keeps its verdict figure', () => {
  // Fixtures use the REAL producer shape: the CLI counts code lines and non-code
  // lines separately, so a docs-only branch is liveDiffLines 0 with liveOtherLines
  // above zero. An earlier version of this test used liveDiffLines:58 with
  // liveCodeFiles:0, which the CLI can never emit, making it vacuous against the
  // real pipeline (caught by ship-check).
  const branches = [
    { branch: 'docs-only', ahead: 1, liveDiffLines: 0, liveOtherLines: 58, liveCodeFiles: 0, dirty: 0, lastCommitDate: '2026-08-26' },
    { branch: 'real-code', ahead: 2, liveDiffLines: 120, liveOtherLines: 0, liveCodeFiles: 3, dirty: 0, lastCommitDate: '2026-08-27' },
  ];
  const verdicts = [
    { branch: 'docs-only', result: 'pass', ts: '2026-08-26T00:00:00Z', reviewer: 'ship-check', gatedLines: 652 },
    { branch: 'real-code', result: 'pass', ts: '2026-08-27T00:00:00Z', reviewer: 'ship-check', gatedLines: 120 },
  ];
  const out = findStrandedReviewedBranches(branches, verdicts);

  assert.equal(out.totalGatedLines, 772, 'the review-time snapshot still sums both branches');
  assert.equal(out.totalLiveDiffLines, 120,
    'the docs-only branch contributes NOTHING to real exposure, so 652 must not be counted');
  const docs = out.reviewed.find((r) => r.branch === 'docs-only');
  assert.equal(docs.docsOnly, true, 'a live diff touching no code file must be flagged docs-only');
  assert.equal(docs.gatedLines, 652, 'the verdict figure is kept for context, not discarded');
});

test('BRO-2878: an UNMEASURED branch falls back to its verdict figure rather than reading as empty', () => {
  // The absence-of-a-signal trap: if a git failure left liveDiffLines null and null
  // were treated as zero, a measurement failure would silently SHRINK the reported
  // exposure, which is the exact false all-clear this whole check exists to prevent.
  // LITERAL null, which is what the CLI actually emits on a git failure. The first
  // version of this test OMITTED the keys instead, so undefined took a different
  // code path and the test passed while literal null was silently coerced to 0 by a
  // Number()-based guard — an unmeasured branch read as "probably already landed"
  // and contributed nothing. Ship-check caught it. Never weaken this to undefined.
  const branches = [{
    branch: 'unmeasurable',
    ahead: 4,
    liveDiffLines: null,
    liveOtherLines: null,
    liveCodeFiles: null,
    dirty: 0,
    lastCommitDate: '2026-08-20',
  }];
  const verdicts = [
    { branch: 'unmeasurable', result: 'pass', ts: '2026-08-20T00:00:00Z', reviewer: 'ship-check', gatedLines: 300 },
  ];
  const out = findStrandedReviewedBranches(branches, verdicts);

  assert.equal(out.reviewed[0].liveDiffLines, null, 'an unmeasured branch reports null, not 0');
  assert.equal(out.reviewed[0].probablyAlreadyLanded, false, 'null must never be read as "already landed"');
  assert.equal(out.totalLiveDiffLines, 300, 'it falls back to the verdict figure instead of vanishing');
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

test('a sweep that classified ZERO worktrees is not trustworthy, however clean it looks', () => {
  // The headline failure mode: every per-worktree git call fails, nothing is
  // measured, and the report says "0 branches at risk" with exit 0.
  const t = sweepIsTrustworthy({ scanned: 0, skipped: 40, fetchOk: true });
  assert.equal(t.trustworthy, false);
  assert.match(t.reason, /zero worktree branches/);
});

test('a sweep with ANY unclassified worktree is not trustworthy — stranded work may hide there', () => {
  const t = sweepIsTrustworthy({ scanned: 39, skipped: 1, fetchOk: true });
  assert.equal(t.trustworthy, false);
  assert.match(t.reason, /could not be classified/);
});

test('a sweep measured against a stale origin/main is not trustworthy', () => {
  // A failed fetch can hide stranded work outright after a remote history rewrite,
  // so it invalidates the run rather than merely adding noise.
  const t = sweepIsTrustworthy({ scanned: 40, skipped: 0, fetchOk: false });
  assert.equal(t.trustworthy, false);
  assert.match(t.reason, /origin\/main/);
});

test('a complete sweep against a fresh origin/main IS trustworthy', () => {
  const t = sweepIsTrustworthy({ scanned: 40, skipped: 0, fetchOk: true });
  assert.equal(t.trustworthy, true);
});

test('sweepIsTrustworthy treats missing or malformed input as untrustworthy, not as fine', () => {
  assert.equal(sweepIsTrustworthy(undefined).trustworthy, false);
  assert.equal(sweepIsTrustworthy({}).trustworthy, false);
});
