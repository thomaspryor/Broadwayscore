// Task #649 — Discovery + IBDB date writes discarded by UNRELATED pre-existing
// validation errors. Locks the set-diff decision logic in
// scripts/lib/validation-setdiff.js that both update-show-status.yml's
// discovery gate and enrich-ibdb-dates.js's post-enrichment gate depend on:
// a run should still commit when it introduces no NEW validation error, even
// if pre-existing (unrelated) errors remain.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseErrorLines,
  computeNewErrors,
  shouldCommitDespiteValidationErrors,
  evaluateCommitDecision,
  extractCandidateTokens,
  attributeNewErrorsToShowIds,
  evaluatePerShowCommitDecision,
} from '../../scripts/lib/validation-setdiff.js';
import { computeChangedShowIds, revertOrRemoveShows } from '../../scripts/lib/shows-since-checkout-diff.js';

describe('parseErrorLines', () => {
  test('extracts ❌ ERROR: lines, ignores ✅/⚠️/ℹ️ noise', () => {
    const text = [
      'ℹ️  Checking shows...',
      '✅ No duplicate shows found',
      '❌ ERROR: Shared ibdbUrl https://ibdb.com/x on 2 shows',
      '⚠️  WARNING: some warning',
      '❌ ERROR: lottery-rush.json has an orphaned show ID',
    ].join('\n');
    assert.deepEqual(parseErrorLines(text), [
      'Shared ibdbUrl https://ibdb.com/x on 2 shows',
      'lottery-rush.json has an orphaned show ID',
    ]);
  });

  test('trims whitespace and handles empty/undefined input', () => {
    assert.deepEqual(parseErrorLines(''), []);
    assert.deepEqual(parseErrorLines(undefined), []);
    assert.deepEqual(parseErrorLines('  ❌ ERROR:   spaced out msg   \n'), ['spaced out msg']);
  });

  test('does not match a line that merely contains the marker mid-sentence', () => {
    // console.log(`\n❌ FAILED: ${errors.length} error(s) found\n`) style summary
    // lines must not be double-counted as individual errors.
    const text = '❌ FAILED: 2 error(s) found\n   1. Shared ibdbUrl on show X\n   2. Missing venue on show Y';
    assert.deepEqual(parseErrorLines(text), []);
  });
});

describe('computeNewErrors', () => {
  test('empty when post is a subset of pre (only pre-existing errors remain)', () => {
    const pre = ['lottery-rush.json orphan: xyz'];
    const post = ['lottery-rush.json orphan: xyz'];
    assert.deepEqual(computeNewErrors(pre, post), []);
  });

  test('returns errors present in post but absent from pre', () => {
    const pre = ['lottery-rush.json orphan: xyz'];
    const post = ['lottery-rush.json orphan: xyz', 'Shared ibdbUrl on show new-show-2026'];
    assert.deepEqual(computeNewErrors(pre, post), ['Shared ibdbUrl on show new-show-2026']);
  });

  test('pre-existing error disappearing is not a "new" error', () => {
    const pre = ['lottery-rush.json orphan: xyz', 'commercial.json bad field'];
    const post = ['lottery-rush.json orphan: xyz'];
    assert.deepEqual(computeNewErrors(pre, post), []);
  });

  test('both empty → no new errors', () => {
    assert.deepEqual(computeNewErrors([], []), []);
  });
});

describe('shouldCommitDespiteValidationErrors', () => {
  test('true when post errors are a subset of pre errors (pre-existing only)', () => {
    const pre = ['peripheral file X is broken'];
    const post = ['peripheral file X is broken'];
    assert.equal(shouldCommitDespiteValidationErrors(pre, post), true);
  });

  test('true when both clean', () => {
    assert.equal(shouldCommitDespiteValidationErrors([], []), true);
  });

  test('false when this run introduces any new error, even alongside pre-existing ones', () => {
    const pre = ['peripheral file X is broken'];
    const post = ['peripheral file X is broken', 'Discovered show missing required field: venue'];
    assert.equal(shouldCommitDespiteValidationErrors(pre, post), false);
  });

  test('false when a fresh error appears with no pre-existing baseline', () => {
    assert.equal(shouldCommitDespiteValidationErrors([], ['Discovered show missing required field: venue']), false);
  });

  // Card #649's suggested-approach note: gating merely on
  // pre-validation-status=='broken' would weaken the guard that stops
  // discovery writing garbage. Assert the set-diff — not "was anything ever
  // broken" — is what decides.
  test('gating on set-diff, not on whether pre had ANY errors at all', () => {
    const pre = ['error A', 'error B', 'error C'];
    const post = ['error A', 'error B', 'error C'];
    assert.equal(shouldCommitDespiteValidationErrors(pre, post), true,
      'three pre-existing errors alone must not block a run that introduced zero new ones');
  });
});

// ship-check finding (2026-07-30): a validate-data.js crash or output-format
// change can exit non-zero while printing nothing that matches "❌ ERROR:"
// (its uncaughtException handler dumps a raw Error, not the error() line
// format) — pure text-diffing alone reads that as "0 new errors" and wrongly
// commits. evaluateCommitDecision's postExitCode check closes that gap.
describe('evaluateCommitDecision', () => {
  test('clean pre-existing-only case still commits (matches shouldCommitDespiteValidationErrors)', () => {
    const preErrors = ['peripheral file X is broken'];
    const postErrors = ['peripheral file X is broken'];
    const result = evaluateCommitDecision({ preErrors, postErrors, postExitCode: 1 });
    assert.equal(result.shouldCommit, true);
    assert.deepEqual(result.newErrors, []);
  });

  test('new error still blocks even with postExitCode provided', () => {
    const preErrors = [];
    const postErrors = ['Discovered show missing required field: venue'];
    const result = evaluateCommitDecision({ preErrors, postErrors, postExitCode: 1 });
    assert.equal(result.shouldCommit, false);
    assert.deepEqual(result.newErrors, postErrors);
  });

  test('clean exit code 0 always commits regardless of stale parsed text', () => {
    const result = evaluateCommitDecision({ preErrors: [], postErrors: [], postExitCode: 0 });
    assert.equal(result.shouldCommit, true);
  });

  test('crash safety net: non-zero exit + zero parsed errors blocks the commit', () => {
    const preErrors = [];
    const postErrors = []; // e.g. an uncaught exception dumped a raw stack, no "❌ ERROR:" lines
    const result = evaluateCommitDecision({ preErrors, postErrors, postExitCode: 1 });
    assert.equal(result.shouldCommit, false,
      'a non-zero exit with no parseable error lines must not silently pass as "0 new errors"');
    assert.match(result.reason, /crash|format change/i);
  });

  test('crash safety net still fires even when pre-run also had zero parsed errors', () => {
    // Confirms the check is keyed off postExitCode + postErrors, not off any
    // asymmetry with the baseline — a baseline that was ALSO unparseable must
    // not make this look like "no change".
    const result = evaluateCommitDecision({ preErrors: [], postErrors: [], postExitCode: 1 });
    assert.equal(result.shouldCommit, false);
  });

  test('without postExitCode (legacy callers), falls back to pure set-diff', () => {
    const preErrors = ['peripheral file X is broken'];
    const postErrors = ['peripheral file X is broken'];
    const result = evaluateCommitDecision({ preErrors, postErrors });
    assert.equal(result.shouldCommit, true);
  });
});

// Card #1426 root cause: enrich-ibdb-dates.js collected valid openingDate
// values for 11 shows in one run; a stale awards.json tony.season placeholder
// on 3 of them (unrelated to the other 8) made evaluateCommitDecision's
// all-or-nothing gate discard every show's write, not just the 3 broken
// ones. evaluatePerShowCommitDecision fixes that by attributing each new
// error to the show ID it names and only holding back those shows.
describe('attributeNewErrorsToShowIds', () => {
  test('attributes an error that quotes a candidate show ID', () => {
    const errors = ['awards.json: "galileo-2026" tony.season=1969-70 but openingDate=2026-12-06 (expected 2026-27). Gap 56y — misattribution.'];
    const { blockedIds, allAttributed } = attributeNewErrorsToShowIds(errors, ['galileo-2026', 'billy-crystal-860']);
    assert.equal(allAttributed, true);
    assert.deepEqual([...blockedIds], ['galileo-2026']);
  });

  test('multiple errors attribute to multiple distinct candidates', () => {
    const errors = [
      'awards.json: "galileo-2026" tony.season=1969-70 but openingDate=2026-12-06 (expected 2026-27). Gap 56y — misattribution.',
      'awards.json: "inter-alia-2026" tony.season=1969-70 but openingDate=2026-12-01 (expected 2026-27). Gap 56y — misattribution.',
    ];
    const { blockedIds, allAttributed } = attributeNewErrorsToShowIds(errors, ['galileo-2026', 'inter-alia-2026', 'billy-crystal-860']);
    assert.equal(allAttributed, true);
    assert.deepEqual([...blockedIds].sort(), ['galileo-2026', 'inter-alia-2026']);
  });

  test('an error naming nothing in candidateIds is unattributed', () => {
    const errors = ['awards.json: "some-other-show-2026" tony.season=1969-70 but openingDate=2026-12-06 (expected 2026-27). Gap 56y.'];
    const { blockedIds, allAttributed } = attributeNewErrorsToShowIds(errors, ['galileo-2026']);
    assert.equal(allAttributed, false);
    assert.equal(blockedIds.size, 0);
  });

  test('an error with no quoted token at all is unattributed', () => {
    const errors = ['CLAUDE.md exceeds the 150-line cap'];
    const { blockedIds, allAttributed } = attributeNewErrorsToShowIds(errors, ['galileo-2026']);
    assert.equal(allAttributed, false);
    assert.equal(blockedIds.size, 0);
  });

  // Adversarial finding (task #1439 ship-check): validate-data.js's
  // duplicate-ID/duplicate-match errors name TWO shows in one line. Blocking
  // only the first-mentioned show would let the second implicated show
  // commit unblocked — both must be held back from a single error.
  test('a single error naming two candidate show IDs blocks both', () => {
    const errors = ['Show "out-in-jersey" transferOf "some-show-2026" is not reciprocated — "some-show-2026" must set transferredTo: "out-in-jersey"'];
    const { blockedIds, allAttributed } = attributeNewErrorsToShowIds(errors, ['out-in-jersey', 'some-show-2026', 'unrelated-show-2026']);
    assert.equal(allAttributed, true);
    assert.deepEqual([...blockedIds].sort(), ['out-in-jersey', 'some-show-2026']);
  });
});

describe('evaluatePerShowCommitDecision', () => {
  test('reproduces card #1426: 3 of 11 shows blocked, 8 commit', () => {
    const preErrors = [];
    const postErrors = [
      'awards.json: "galileo-2026" tony.season=1969-70 but openingDate=2026-12-06 (expected 2026-27). Gap 56y — misattribution.',
      'awards.json: "inter-alia-2026" tony.season=1969-70 but openingDate=2026-12-01 (expected 2026-27). Gap 56y — misattribution.',
      'awards.json: "paranormal-activity-2026" tony.season=1969-70 but openingDate=2026-08-25 (expected 2026-27). Gap 56y — misattribution.',
    ];
    const candidateIds = ['galileo-2026', 'inter-alia-2026', 'paranormal-activity-2026', 'dolly-an-original-musical', 'billy-crystal-860', 'evita', 'the-fantasticks', 'gloria', 'paddington-the-musical', 'purple-rain', 'school-girls-or-the-african-mean-girls-play'];
    const result = evaluatePerShowCommitDecision({ preErrors, postErrors, postExitCode: 1, candidateIds });
    assert.equal(result.shouldCommit, true, 'the 8 unaffected shows must still commit');
    assert.deepEqual([...result.blockedIds].sort(), ['galileo-2026', 'inter-alia-2026', 'paranormal-activity-2026']);
  });

  test('falls back to blocking everything when a new error cannot be attributed to any candidate', () => {
    const preErrors = [];
    const postErrors = ['CLAUDE.md exceeds the 150-line cap'];
    const candidateIds = ['galileo-2026', 'inter-alia-2026'];
    const result = evaluatePerShowCommitDecision({ preErrors, postErrors, postExitCode: 1, candidateIds });
    assert.equal(result.shouldCommit, false, 'untraceable error must fall back to the conservative all-block behavior');
    assert.equal(result.blockedIds.size, 0);
  });

  test('clean run (no new errors) commits everything, blockedIds empty', () => {
    const result = evaluatePerShowCommitDecision({ preErrors: [], postErrors: [], postExitCode: 0, candidateIds: ['galileo-2026'] });
    assert.equal(result.shouldCommit, true);
    assert.equal(result.blockedIds.size, 0);
  });

  test('all candidates blocked leaves nothing to commit', () => {
    const preErrors = [];
    const postErrors = ['awards.json: "galileo-2026" tony.season=1969-70 but openingDate=2026-12-06 (expected 2026-27). Gap 56y.'];
    const result = evaluatePerShowCommitDecision({ preErrors, postErrors, postExitCode: 1, candidateIds: ['galileo-2026'] });
    assert.equal(result.shouldCommit, false, 'nothing survives when every candidate is blocked');
    assert.deepEqual([...result.blockedIds], ['galileo-2026']);
  });
});

// Task #1439 — pre-mortem finding: most of validate-data.js's per-show
// error() calls quote the show TITLE, not the id, and put the id unquoted
// in parens right after (e.g. `Show "${show.title}" (${show.id}) has
// previewsStartDate ... — previews precede opening.`, validate-data.js
// line ~562, exactly the shape update-show-status.yml's own discovery/
// enrichment steps trigger). The original QUOTED_TOKEN_RE-only extraction
// only caught the awards.json/#1426 id-quoted shape, so this workflow's own
// errors would fall through to allAttributed=false every time — extending
// extraction to parenthesized groups fixes that.
describe('extractCandidateTokens', () => {
  test('extracts a single parenthesized id alongside the quoted title', () => {
    const err = 'Show "Boop! The Musical" (boop-the-musical-2025) has previewsStartDate (2025-11-01) implausibly far before openingDate (2025-12-09) — likely a wrong-production previews date.';
    const tokens = extractCandidateTokens(err);
    assert.ok(tokens.includes('Boop! The Musical'));
    assert.ok(tokens.includes('boop-the-musical-2025'));
  });

  test('splits a multi-value paren group and extracts each part', () => {
    const err = 'Show "Some Show" (some-show-2026, status=open) has category="broadway" but market=null — scripts/backfill-market.js can fill this.';
    const tokens = extractCandidateTokens(err);
    assert.ok(tokens.includes('some-show-2026'));
    assert.ok(tokens.includes('status=open'));
  });
});

describe('attributeNewErrorsToShowIds — title-quoted, id-in-parens shape', () => {
  test('attributes a real validate-data.js previewsStartDate-shape error to its candidate id', () => {
    const errors = ['Show "Boop! The Musical" (boop-the-musical-2025) has previewsStartDate (2025-11-01) implausibly far before openingDate (2025-12-09) — likely a wrong-production previews date.'];
    const { blockedIds, allAttributed } = attributeNewErrorsToShowIds(errors, ['boop-the-musical-2025', 'other-show-2026']);
    assert.equal(allAttributed, true);
    assert.deepEqual([...blockedIds], ['boop-the-musical-2025']);
  });
});

// Task #1439's actual discovery-gate scenario: update-show-status.yml
// touches shows via several independent scripts in one run (discover-new-
// shows.js adds new shows, update-show-status.js flips previews->open,
// enrichment scripts like enrich-todaytix-runtimes.js/enrich-wikipedia-
// synopsis.js mutate EXISTING shows that were neither newly discovered nor
// newly opened this run). One show's write introduces a real, title-quoted/
// id-in-parens validation error; the rest — including an enrichment-only
// show that isn't in the "new" or "opened" sets — must still commit.
describe('discovery gate partial-block (card #1439)', () => {
  test('one bad show among newly-discovered + opened + enrichment-only candidates still lets the rest commit', () => {
    const preErrors = [];
    const postErrors = [
      'Show "Boop! The Musical" (boop-the-musical-2025) has previewsStartDate (2025-11-01) implausibly far before openingDate (2025-12-09) — likely a wrong-production previews date.',
    ];
    // Mixed provenance: 2 newly-discovered, 1 newly-opened, 1 touched only
    // by an enrichment step (e.g. TodayTix runtime backfill) that never
    // appears in discover-new-shows.js's or update-show-status.js's own
    // outputs — the exact case a new/opened-only candidate set would miss.
    const candidateIds = ['boop-the-musical-2025', 'some-new-show-2026', 'a-show-that-just-opened-2026', 'enrichment-only-show-2024'];
    const result = evaluatePerShowCommitDecision({ preErrors, postErrors, postExitCode: 1, candidateIds });
    assert.equal(result.shouldCommit, true, 'the 3 unaffected shows must still commit');
    assert.deepEqual([...result.blockedIds], ['boop-the-musical-2025']);
  });
});

describe('computeChangedShowIds (scripts/lib/shows-since-checkout-diff.js)', () => {
  test('flags added, changed, and removed ids; leaves untouched ids out', () => {
    const baseline = [
      { id: 'unchanged-show', status: 'open' },
      { id: 'changed-show', status: 'previews' },
      { id: 'removed-show', status: 'open' },
    ];
    const current = [
      { id: 'unchanged-show', status: 'open' },
      { id: 'changed-show', status: 'open' },
      { id: 'new-show', status: 'previews' },
    ];
    const changed = computeChangedShowIds(baseline, current);
    assert.deepEqual(changed.sort(), ['changed-show', 'new-show', 'removed-show']);
  });

  test('empty diff when nothing changed', () => {
    const shows = [{ id: 'a', status: 'open' }, { id: 'b', status: 'closed' }];
    assert.deepEqual(computeChangedShowIds(shows, shows), []);
  });
});

describe('revertOrRemoveShows (scripts/lib/shows-since-checkout-diff.js)', () => {
  test('reverts a blocked existing show to its baseline object', () => {
    const baseline = [{ id: 'x', status: 'previews', previewsStartDate: '2026-01-01' }];
    const current = [{ id: 'x', status: 'open', openingDate: '2026-02-01', previewsStartDate: '2026-01-01' }];
    const next = revertOrRemoveShows(current, baseline, ['x']);
    assert.deepEqual(next, baseline);
  });

  test('removes a blocked show that has no baseline (newly discovered this run)', () => {
    const baseline = [{ id: 'kept', status: 'open' }];
    const current = [{ id: 'kept', status: 'open' }, { id: 'brand-new', status: 'previews' }];
    const next = revertOrRemoveShows(current, baseline, ['brand-new']);
    assert.deepEqual(next, [{ id: 'kept', status: 'open' }]);
  });

  test('leaves non-blocked shows untouched', () => {
    const baseline = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
    const current = [{ id: 'a', v: 2 }, { id: 'b', v: 2 }];
    const next = revertOrRemoveShows(current, baseline, ['a']);
    assert.deepEqual(next, [{ id: 'a', v: 1 }, { id: 'b', v: 2 }]);
  });
});
