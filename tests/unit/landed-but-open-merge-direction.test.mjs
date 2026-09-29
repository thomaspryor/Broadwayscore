// A card is "landed" only when its job branch was the merge SOURCE.
// `Merge remote-tracking branch 'origin/main' into job/linear-BRO-N-...` has
// the job branch as the merge TARGET — a worker syncing main into its own
// branch mid-flight, i.e. proof the card is ACTIVELY BEING WORKED. Both
// subject shapes contain "linear-BRO-N-", so matching the branch name alone
// cannot tell them apart, and treating a sync as a landing offers a live
// worker's card up for closing.
//
// Measured on origin/main 2026-08-31: 46 target-side commits across 31 cards,
// 11 of which have no other linear- commit at all.
//
// Requires the REAL implementation (CLAUDE.md rule 15) — no copies — and
// exercises buildMergeCommitIndex itself, not just the helper, so that
// removing the direction rule from the indexing loop fails a test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeKeyForSubject, buildMergeCommitIndex } = require('../../scripts/reconcile-landed-but-open.js');

// Subjects taken verbatim from `git log origin/main --oneline --grep=linear-`.
const TARGET_ONLY = [
  "Merge remote-tracking branch 'origin/main' into job/linear-BRO-75-mt1vuvn1",
  "Merge remote-tracking branch 'origin/main' into job/linear-BRO-517-mtac4iw6",
  "Merge remote-tracking branch 'origin/main' into job/linear-BRO-2280-mtallktu",
];

const SOURCE_SIDE = [
  ["Merge branch 'job/linear-BRO-406-msxc1v2h'", 'BRO-406'],
  ["Merge remote-tracking branch 'origin/job/linear-BRO-2558-xyz789'", 'BRO-2558'],
  ['fix: something real (linear-BRO-1234-deadbeef)', 'BRO-1234'],
];

test('a sync into a job branch is evidence for NOBODY', () => {
  for (const subject of TARGET_ONLY) {
    assert.equal(mergeKeyForSubject(subject), null, `must not be read as landed: ${subject}`);
  }
});

test('a real landing still resolves to its own card', () => {
  for (const [subject, expected] of SOURCE_SIDE) {
    assert.equal(mergeKeyForSubject(subject), expected, `landing must survive: ${subject}`);
  }
});

test('both-sides merge is evidence for the SOURCE only — the target must not inherit it', () => {
  // Real commit on origin/main: 0a250f8b883. Striking the target clause rather
  // than skipping the whole line is what preserves BRO-787 here; an earlier cut
  // of this fix skipped the line and silently lost it.
  const subject = "Merge branch 'job/linear-BRO-787-mt2lmgu8' into job/linear-BRO-2267-mt2nixlc";
  assert.equal(mergeKeyForSubject(subject), 'BRO-787');
});

test('the rule does not depend on the merge verb', () => {
  // git never writes these, but a human or a future drain script might, and the
  // failure mode is a silently reintroduced false positive.
  assert.equal(mergeKeyForSubject("Merged branch 'main' into job/linear-BRO-99-aaa"), null);
  assert.equal(mergeKeyForSubject("Merging main into job/linear-BRO-99-aaa"), null);
});

test('an ordinary subject that merely says "into" is untouched', () => {
  const subject = 'refactor: fold the parser into the loader (linear-BRO-5-abc123)';
  assert.equal(mergeKeyForSubject(subject), 'BRO-5');
});

test('buildMergeCommitIndex applies the direction rule at its call site', () => {
  // THIS is the test that fails if the rule is removed from the loop. Lines are
  // newest-first, as git log emits them.
  const lines = [
    "aaaaaaa Merge remote-tracking branch 'origin/main' into job/linear-BRO-810-sync2",
    "bbbbbbb Merge remote-tracking branch 'origin/main' into job/linear-BRO-810-sync1",
    "ccccccc Merge branch 'job/linear-BRO-406-msxc1v2h'",
  ];
  // landingRows=[] isolates from the real dispatch/landings ledger on disk —
  // without it this reads whatever land/** rows actually exist right now and
  // the size assertion below flakes against live state.
  const index = buildMergeCommitIndex(lines, []);
  assert.equal(index.has('BRO-810'), false, 'a card with only syncs must NOT look landed');
  assert.equal(index.get('BRO-406'), 'ccccccc', 'a real landing must still be indexed');
  assert.equal(index.size, 1);
});

test('a newer sync must not displace an older real landing', () => {
  // Newest-first: the sync is seen BEFORE the landing. Because first-match-wins,
  // keying the sync would pin the wrong sha for the rest of the sweep.
  const lines = [
    "aaaaaaa Merge remote-tracking branch 'origin/main' into job/linear-BRO-2558-sync",
    "ddddddd feat: add report-only reconciler (linear-BRO-2558-real)",
  ];
  const index = buildMergeCommitIndex(lines, []);
  assert.equal(index.get('BRO-2558'), 'ddddddd');
});

test('malformed lines are skipped without throwing', () => {
  const index = buildMergeCommitIndex(['', 'nospaceonthisline', "eeeeeee Merge branch 'job/linear-BRO-7-x'"], []);
  assert.equal(index.get('BRO-7'), 'eeeeeee');
  assert.equal(index.size, 1);
});

// BRO-3873 step 4: a land.yml landing is a rebase + fast-forward — no merge
// commit for the git-log index — so the landings.jsonl rows land.yml writes
// are folded in by the land/** branch name (same `linear-BRO-N-` key).
test('buildMergeCommitIndex folds landings.jsonl rows in by land/** branch name; git-log evidence wins when both exist', () => {
  const lines = ["ccccccc Merge branch 'job/linear-BRO-100-abc'"];
  const rows = [
    { branch: 'land/job/linear-BRO-200-def', sha: '9'.repeat(40), tip: 'e'.repeat(40) },   // older landing of BRO-200
    { branch: 'land/job/linear-BRO-200-def', sha: 'd'.repeat(40), tip: 'e'.repeat(40) },   // newer landing of BRO-200
    { branch: 'land/job/linear-BRO-100-abc', sha: 'f'.repeat(40) },
    { branch: 'land/worktree-no-card', sha: '1'.repeat(40) },
    { branch: null, sha: '2'.repeat(40) },
  ];
  const index = buildMergeCommitIndex(lines, rows);
  assert.equal(index.get('BRO-200'), 'd'.repeat(40), 'the NEWEST ledger row wins (rows are appended oldest-first)');
  assert.equal(index.get('BRO-100'), 'f'.repeat(40), 'ledger rows are folded first; a later git-log line does not displace them');
  assert.equal(index.size, 2);
});

// BRO-4071: a git-log failure (no origin/main locally, ENOBUFS overflow,
// git missing) must not read as "ran, found nothing" — that is the same bug
// class fixed in ack-landed.js's namingCandidates for BRO-4068. Pointing at a
// nonexistent path forces the real execFileSync call to fail, exercising the
// actual failure branch rather than a copy of it (same technique BRO-4068's
// own fix test used: "pins the lookup at a nonexistent base").
test('buildMergeCommitIndex marks the index unreliable when git log cannot run, instead of reading as "found nothing"', () => {
  const index = buildMergeCommitIndex(null, [], { cwd: '/nonexistent/path/for/bro-4071-test' });
  assert.equal(index.gitLogFailed, true, 'a failed lookup must be flagged, not silently treated as an empty result');
  assert.ok(index.gitLogError && index.gitLogError.length, 'the failure reason must be captured for the report');
  assert.equal(index.size, 0);
});

test('buildMergeCommitIndex leaves gitLogFailed unset when the git-log pass ran (even with zero matches)', () => {
  const index = buildMergeCommitIndex(['', 'nospaceonthisline'], []);
  assert.equal(index.gitLogFailed, undefined, 'a lookup that ran and found nothing must read differently from one that never ran');
  assert.equal(index.size, 0);
});
