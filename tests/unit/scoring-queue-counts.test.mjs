// Task #652: the LLM scoring cascade in .github/workflows/llm-ensemble-score.yml
// gates phases 2-4 behind `UNSCORED == 0`. Its counter was a hand-rolled inline
// predicate that counted files the scorer can never consume, so the counter
// could never reach zero and Phase 4 (emergency retry) had NEVER executed —
// 38 reviews sat flagged singleModelEmergency with retryCount 0.
//
// These tests pin the two properties that make the cascade drainable:
//   1. known-unrecoverable residue is excluded from UNSCORED (and reported)
//   2. with only that residue left, the gate reaches 0 and Phase 4 is reachable
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  UNSCORED_SKIP,
  unscoredSkipReason,
  isActionableUnscored,
  isActionableRescore,
  isActionableStale,
  isActionableEmergencyRetry,
  countScoringQueues,
} = require('../../scripts/lib/scoring-queue-counts.js');
const { selectScorableText, isCapsuleReview, DEFAULT_MIN_TEXT_LENGTH } = require('../../scripts/lib/scorable-text.js');
const { stampTerminalScoringFailure } = require('../../scripts/lib/rescore-lifecycle.js');

// Read the scorer's own floor out of index.ts rather than restating it, so the
// two can never drift apart silently (the whole point of task #652).
const SCORER_MIN_TEXT_LENGTH = Number(
  /minTextLength:\s*(\d+)/.exec(
    fs.readFileSync(new URL('../../scripts/llm-scoring/index.ts', import.meta.url), 'utf8')
  )[1]
);

// A believable review body: long enough to clear the scorer's 1000-char
// body_too_short gate and prose-like enough not to trip content-quality.
const REVIEW_BODY = (
  'The revival arrives at the Booth with a confidence that its predecessor never quite found. ' +
  'The staging is spare, the performances unhurried, and the second act lands with real force. ' +
  'What begins as a domestic comedy curdles, by degrees, into something closer to an elegy. '
).repeat(6);

// Real prose, but under the scorer's 1000-char body_too_short floor: the exact
// shape of the 45 files that failed input validation every single day.
const SHORT_BODY =
  'The revival arrives at the Booth with a confidence its predecessor never found. ' +
  'The staging is spare, the performances unhurried, and the second act lands with force. ' +
  'What begins as domestic comedy curdles, by degrees, into something closer to an elegy. ' +
  'The company plays it straight, and that restraint is the evening greatest asset.';

const scoreableFile = (over = {}) => ({
  showId: 'a-test-show-2026',
  outletId: 'nyt',
  criticName: 'A Critic',
  url: 'https://example.com/review',
  fullText: REVIEW_BODY,
  contentTier: 'complete',
  ...over,
});

describe('unscoredSkipReason — what the cascade gate may and may not count', () => {
  test('a scoreable, unscored review IS actionable work', () => {
    const f = scoreableFile();
    assert.equal(unscoredSkipReason(f, {}), null);
    assert.equal(isActionableUnscored(f, {}), true);
  });

  test('an llmScore means already-scored — matching index.ts unscoredOnly exactly', () => {
    assert.equal(unscoredSkipReason(scoreableFile({ llmScore: { score: 80 } }), {}), UNSCORED_SKIP.ALREADY_SCORED);
  });

  test('non-scoreable reviews are excluded (the 97-file class)', () => {
    const f = scoreableFile({ wrongProduction: true });
    assert.equal(unscoredSkipReason(f, {}), UNSCORED_SKIP.NOT_SCOREABLE);
  });

  test('a terminal text-gate stamp excludes the file while its text is unchanged (the 33-file class)', () => {
    const short = scoreableFile({ fullText: 'Too short to score.' });
    // Before stamping it counts as unrecoverable-for-lack-of-text, not blocked.
    assert.equal(unscoredSkipReason(short, {}), UNSCORED_SKIP.NO_SCORABLE_TEXT);

    // A file with enough raw text to be selected, but which the scorer's
    // body_too_short gate rejected, gets stamped and must then be excluded.
    const rejected = scoreableFile({ fullText: SHORT_BODY });
    assert.equal(unscoredSkipReason(rejected, {}), null, 'pre-stamp: the scorer would attempt it once');
    stampTerminalScoringFailure(rejected, 'input_validation_failed:body_too_short', '2026-08-02T05:00:00.000Z');
    assert.equal(unscoredSkipReason(rejected, {}), UNSCORED_SKIP.TERMINAL_TEXT_GATE);
    assert.equal(rejected.rescoreAttempts, 1, 'the stamp is the bounded-attempt counter');
  });

  test('a stamped file becomes actionable again the moment its text grows', () => {
    const rejected = scoreableFile({ fullText: SHORT_BODY });
    stampTerminalScoringFailure(rejected, 'input_validation_failed:body_too_short', '2026-08-02T05:00:00.000Z');
    assert.equal(unscoredSkipReason(rejected, {}), UNSCORED_SKIP.TERMINAL_TEXT_GATE);

    rejected.fullText = REVIEW_BODY; // a producer recovered the body
    assert.equal(unscoredSkipReason(rejected, {}), null, 'recovery must NOT require clearing the stamp by hand');
  });

  test('reviews with no scoreable text are excluded (the 16-file class the scorer never even attempts)', () => {
    // This is the class that pinned the counter forever: the scorer skips these
    // BEFORE any model call, so no failure is ever written to disk, so no stamp
    // can ever retire them.
    const f = scoreableFile({ fullText: 'short' });
    assert.equal(selectScorableText(f, {}), null);
    assert.equal(unscoredSkipReason(f, {}), UNSCORED_SKIP.NO_SCORABLE_TEXT);
  });

  // ── Codex adversarial-review findings, task #652 ship-check ──────────────
  // Each of these was a way the "canonical" counter still disagreed with the
  // scorer's real selection — i.e. the exact bug being fixed, one layer down.

  test('a file held in manual-clear Haiku-fallback cooldown is NOT counted', () => {
    // index.ts skips these before scoring. A counter that ignores the cooldown
    // reports UNSCORED>0, Phase 1 runs, processes zero, and 2-4 stay starved.
    const f = scoreableFile({
      manualClearFallbackFailedAt: new Date().toISOString(),
      manualClearFallbackAttempts: 1,
    });
    assert.equal(unscoredSkipReason(f, {}), UNSCORED_SKIP.FALLBACK_COOLDOWN);

    const abandoned = scoreableFile({
      manualClearFallbackFailedAt: '2020-01-01T00:00:00.000Z',
      manualClearFallbackAbandoned: true,
    });
    assert.equal(unscoredSkipReason(abandoned, {}), UNSCORED_SKIP.FALLBACK_COOLDOWN);
  });

  test('an expired fallback cooldown is countable again', () => {
    const f = scoreableFile({
      manualClearFallbackFailedAt: '2020-01-01T00:00:00.000Z',
      manualClearFallbackAttempts: 1,
    });
    assert.equal(unscoredSkipReason(f, {}), null);
  });

  test('a page-published star rating is authoritative and not counted as unscored', () => {
    const f = scoreableFile({ assignedScore: 80, scoreSource: 'manual_extracted_star_rating' });
    assert.equal(unscoredSkipReason(f, {}), UNSCORED_SKIP.STAR_RATING_AUTHORITATIVE);
  });

  test('assignedScore from a NON-star source still counts — the scorer would take it', () => {
    // The old inline counter excluded any assignedScore/humanReviewScore, which
    // UNDER-counted: index.ts's unscoredOnly filter keys on llmScore alone.
    // Under-counting can advance the cascade past real Phase 1 work.
    assert.equal(unscoredSkipReason(scoreableFile({ assignedScore: 80 }), {}), null);
    assert.equal(unscoredSkipReason(scoreableFile({ humanReviewScore: 80 }), {}), null);
  });

  test('rescore ignores the star-rating skip, matching index.ts', () => {
    // index.ts suppresses the manual_extracted_star_rating skip on
    // --needs-rescore / --outdated runs; the counter must do the same.
    const f = scoreableFile({
      needsRescore: true,
      assignedScore: 80,
      scoreSource: 'manual_extracted_star_rating',
    });
    assert.equal(isActionableRescore(f, {}), true);
    assert.equal(unscoredSkipReason(f, {}), UNSCORED_SKIP.STAR_RATING_AUTHORITATIVE);
  });

  test('emergency retry excludes files with no scoreable text', () => {
    const f = scoreableFile({
      fullText: 'short',
      llmScore: { score: 60 },
      ensembleData: { singleModelEmergency: true },
    });
    assert.equal(isActionableEmergencyRetry(f, {}), false);
  });

  test('the excerpt floor matches the scorer, so 50-99 char bundles still count', () => {
    // Codex verification pass: the shared default was 100 while
    // llm-scoring/index.ts runs with minTextLength 50. That silently excluded
    // 50-99 char excerpt bundles from BOTH the counter and the selector —
    // scoreable work abandoned, cascade advanced past it. Pin the floor.
    assert.equal(DEFAULT_MIN_TEXT_LENGTH, SCORER_MIN_TEXT_LENGTH);
    const sixtyChars = 'A sharp, unsentimental revival that earns its final hush.....'; // 61
    assert.ok(sixtyChars.length >= 50 && sixtyChars.length < 100);
    const f = scoreableFile({ fullText: null, bwwExcerpt: sixtyChars });
    assert.equal(unscoredSkipReason(f, {}), null);
  });

  test('an excerpt-only review IS actionable — excerpts bypass the body-length gate', () => {
    const f = scoreableFile({ fullText: null, bwwExcerpt: 'A sharp, unsentimental revival that earns its final silence, and a second act that finally lets the play breathe on its own terms.' });
    assert.equal(unscoredSkipReason(f, {}), null);
  });
});

describe('phase 2/3/4 predicates', () => {
  test('rescore: a re-flagged file carrying rescoreCompletedAt still counts', () => {
    // The old inline counter had `if (!r.needsRescore || r.rescoreCompletedAt) return;`
    // and so under-reported 11 files the scorer does pick up.
    const f = scoreableFile({ needsRescore: true, rescoreCompletedAt: '2026-07-01T00:00:00.000Z' });
    assert.equal(isActionableRescore(f, {}), true);
  });

  test('rescore: a terminally-blocked file does not count', () => {
    const f = scoreableFile({ needsRescore: true, fullText: SHORT_BODY });
    stampTerminalScoringFailure(f, 'input_validation_failed:body_too_short', '2026-08-02T05:00:00.000Z');
    assert.equal(isActionableRescore(f, {}), false);
  });

  test('stale: fullText + excerpt-derived score counts; a fullText-sourced score does not', () => {
    const base = scoreableFile({
      fullText: 'y'.repeat(2000),
      llmScore: { score: 74 },
      bwwExcerpt: 'A brisk, funny evening.',
    });
    assert.equal(isActionableStale(base, {}), true);
    assert.equal(
      isActionableStale({ ...base, llmMetadata: { textSource: { type: 'fullText' } } }, {}),
      false
    );
  });

  test('emergency: only un-retried singleModelEmergency files count', () => {
    const stuck = scoreableFile({ ensembleData: { singleModelEmergency: true } });
    assert.equal(isActionableEmergencyRetry(stuck, {}), true);

    const retried = scoreableFile({
      ensembleData: { singleModelEmergency: true, singleModelEmergencyRetryCount: 1 },
    });
    assert.equal(isActionableEmergencyRetry(retried, {}), false);
  });
});

describe('countScoringQueues — the cascade reaches Phase 4', () => {
  let tmpDir;
  let showDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoring-queue-'));
    showDir = path.join(tmpDir, 'a-test-show-2026');
    fs.mkdirSync(showDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const seed = (name, data) =>
    fs.writeFileSync(path.join(showDir, name), JSON.stringify(data, null, 2) + '\n');

  test('a corpus of ONLY unrecoverable residue reports UNSCORED=0 and lets Phase 4 run', () => {
    // Reproduces the live 2026-08-02 shape in miniature: every unscored file is
    // one the scorer can never consume, plus a stuck-emergency review waiting on
    // Phase 4 that the old strict gate could never reach.
    seed('nyt--a.json', scoreableFile({ wrongProduction: true }));                 // not scoreable
    seed('vulture--b.json', scoreableFile({ fullText: 'short' }));                 // no scoreable text
    const stamped = scoreableFile({ outletId: 'ew', fullText: SHORT_BODY });
    stampTerminalScoringFailure(stamped, 'input_validation_failed:body_too_short', '2026-08-02T05:00:00.000Z');
    seed('ew--c.json', stamped);                                                  // terminal text-gate block
    seed('variety--d.json', scoreableFile({
      outletId: 'variety',
      llmScore: { score: 71 },
      ensembleData: { singleModelEmergency: true },
    }));

    const counts = countScoringQueues(tmpDir);

    assert.equal(counts.unscored, 0, 'gate must reach 0 with only unrecoverable residue left');
    assert.equal(counts.rescore, 0);
    assert.equal(counts.stale, 0);
    assert.equal(counts.emergency, 1, 'Phase 4 is now reachable — this is the 38-review starvation');

    // The residue is reported, not silently dropped.
    assert.equal(counts.unscoredResidue[UNSCORED_SKIP.NOT_SCOREABLE], 1);
    assert.equal(counts.unscoredResidue[UNSCORED_SKIP.NO_SCORABLE_TEXT], 1);
    assert.equal(counts.unscoredResidue[UNSCORED_SKIP.TERMINAL_TEXT_GATE], 1);
    assert.equal(counts.unrecoverableSamples.length, 2);
  });

  test('real unscored work still pins the gate above zero', () => {
    seed('nyt--a.json', scoreableFile());
    seed('vulture--b.json', scoreableFile({ outletId: 'vulture', fullText: 'short' }));

    const counts = countScoringQueues(tmpDir);
    assert.equal(counts.unscored, 1, 'the scoreable review must keep Phase 1 running');
    assert.equal(counts.scanned, 2);
  });

  test('failed-fetches.json and malformed files never affect the counts', () => {
    seed('failed-fetches.json', { anything: true });
    fs.writeFileSync(path.join(showDir, 'broken.json'), '{not json');
    seed('nyt--a.json', scoreableFile());

    const counts = countScoringQueues(tmpDir);
    assert.equal(counts.scanned, 1);
    assert.equal(counts.unscored, 1);
  });

  test('a missing review-texts directory THROWS — the gate must fail closed', () => {
    // Returning zeros here would turn a failed checkout into "queue drained,
    // skip=true" on a green run, silently stopping the scorer forever.
    assert.throws(() => countScoringQueues(path.join(tmpDir, 'does-not-exist')));
  });

  test('malformed files are counted, not silently swallowed', () => {
    fs.writeFileSync(path.join(showDir, 'broken.json'), '{not json');
    seed('nyt--a.json', scoreableFile());
    const counts = countScoringQueues(tmpDir);
    assert.equal(counts.malformed, 1);
    assert.equal(counts.scanned, 1);
  });
});

// Theatre Record capsule predicate (2026-08-10, trainspotting daily-mail).
// TR-sourced fullText in the 100-999 char band is a complete print capsule,
// exempt from the validator's 1000-char body gate at the scorer call sites
// and un-stamped by isBlockedFromRescore(). Boundaries are load-bearing:
// <100 falls through to the excerpt path, >=1000 passes the gate anyway.
describe('isCapsuleReview', () => {
  test('true only for theatre-record fullText in [100, 1000)', () => {
    const tr = (len) => ({ source: 'theatre-record', fullText: 'x'.repeat(len) });
    assert.equal(isCapsuleReview(tr(99)), false, '99 chars: excerpt-path territory');
    assert.equal(isCapsuleReview(tr(100)), true, '100 chars: capsule floor');
    assert.equal(isCapsuleReview(tr(999)), true, '999 chars: capsule ceiling');
    assert.equal(isCapsuleReview(tr(1000)), false, '1000 chars: passes the gate normally');
  });

  test('false without the theatre-record source — partial scrapes stay gated', () => {
    assert.equal(isCapsuleReview({ fullText: 'x'.repeat(500) }), false);
    assert.equal(isCapsuleReview({ source: 'scrapingbee', fullText: 'x'.repeat(500) }), false);
    assert.equal(isCapsuleReview({ source: 'theatre-record', fullText: null }), false);
    assert.equal(isCapsuleReview(null), false);
  });
});
