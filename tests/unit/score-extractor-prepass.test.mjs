/**
 * Regression tests for the score-extractor pre-pass (Gap 2).
 *
 * Runs the same gate that scripts/collect-review-texts.js applies to
 * orchestrator-discovered files with fullText but no score, mirroring
 * src/app/api/admin/ingest-review/route.ts's /ingest pre-pass.
 *
 * Lost Boys 2026-04-26 #8 (memory/lost-boys-2026-opening-night-postmortem.md):
 * BWW Review Roundup + Playbill Verdict + DTLI scrapers wrote fullText
 * stubs for amNY Matt Windman + Exeunt Loren Noveck without triggering
 * LLM ensemble. The reviews never rendered on the live page.
 *
 * Fixtures: 4 positive cases (extractor must fire) + 1 negative case
 * (plain prose review, extractor must NOT fire). Same 5 outlets in the
 * task spec: NYSR star body, TimeOut star body, EW letter grade,
 * NY Post letter grade, plain-prose review.
 *
 * Run: node --test tests/unit/score-extractor-prepass.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runScoreExtractorPrePass, isTrustedExtractorSource } = require(
  '../../scripts/lib/score-extractor-prepass.js'
);

// ─── Fixture 1: NYSR star body (★★★/5) — Roma Torre case ─────────────────
test('NYSR ★★★☆☆ in body fires unicode-stars (3/5) → 60', () => {
  const data = {};
  // Roma Torre Lost Boys 2026-04-26 case from postmortem: NYSR publishes
  // "★★★☆☆" (3 filled + 2 empty) at the head of each review. The text-only
  // pre-pass passes html='', so the NYSR extractor's text-only fallback
  // anchors on this sequence. Filled=3, total=length=5 → 60.
  const fullText = `★★★☆☆

The Lost Boys: The Musical kicks off at the Palace Theatre with a vampire-pop spectacle that draws blood and laughs in roughly equal measure. Roma Torre dispatches act one with brio, but the show's sophomore half struggles to maintain its nocturnal edge.`.padEnd(800, ' ');
  const result = runScoreExtractorPrePass(data, { fullText, outletId: 'nysr' });
  assert.ok(result, 'expected extraction to succeed');
  assert.equal(result.originalScoreNormalized, 60);
  assert.equal(result.humanReviewScore, 60);
  assert.match(result.originalScore, /3\/5/);
  // NYSR has its own outlet extractor (extractNYSRScore) — source is unicode-stars.
  assert.ok(
    isTrustedExtractorSource(result.originalScoreSource),
    `expected trusted source, got "${result.originalScoreSource}"`
  );
});

// ─── Fixture 2: TimeOut "X out of 5 stars" body ─────────────────────────
test('TimeOut "4 out of 5 stars" in body fires word-stars → 80', () => {
  const data = {};
  const fullText = `4 out of 5 stars

Adam Feldman writes: The Lost Boys arrives on Broadway as a brash, funny, very loud vampire musical, with a soundtrack that lands harder than the bites. The book wobbles in act two but the cast holds the line.`.padEnd(800, ' ');
  const result = runScoreExtractorPrePass(data, { fullText, outletId: 'timeout' });
  assert.ok(result, 'expected extraction to succeed');
  assert.equal(result.originalScoreNormalized, 80);
  assert.equal(result.humanReviewScore, 80);
  // Source can be word-stars / unicode-stars / star-rating / etc — must be trusted.
  assert.ok(
    isTrustedExtractorSource(result.originalScoreSource),
    `expected trusted source, got "${result.originalScoreSource}"`
  );
});

// ─── Fixture 3: EW letter grade body ────────────────────────────────────
test('EW "Grade: B+" body fires letter-grade → 80', () => {
  const data = {};
  const fullText = `Grade: B+

Dalton Ross says The Lost Boys may not reinvent the vampire genre, but it pumps fresh blood into the Broadway musical. The performances are spirited, the score is contagious, and the staging feels appropriately sinister.`.padEnd(800, ' ');
  const result = runScoreExtractorPrePass(data, { fullText, outletId: 'ew' });
  assert.ok(result, 'expected extraction to succeed');
  assert.equal(result.originalScoreNormalized, 80);
  assert.equal(result.humanReviewScore, 80);
  assert.equal(result.originalScoreSource, 'letter-grade');
});

// ─── Fixture 4: NY Post numeric stars body ──────────────────────────────
test('NY Post "★★★½" body fires unicode-stars-fallthrough', () => {
  const data = {};
  const fullText = `★★★★

Johnny Oleksinski raves: This is the most fun I've had at a Broadway musical in years. The Lost Boys leans into its absurd premise — vampire teens! beach! synth! — and rides that energy until curtain.`.padEnd(800, ' ');
  const result = runScoreExtractorPrePass(data, { fullText, outletId: 'nypost' });
  assert.ok(result, 'expected extraction to succeed');
  assert.equal(result.originalScoreNormalized, 80);
  assert.equal(result.humanReviewScore, 80);
  assert.ok(isTrustedExtractorSource(result.originalScoreSource));
});

// ─── Fixture 5: Plain prose, no rating — extractor must NOT fire ────────
test('plain-prose review with no rating returns null', () => {
  const data = {};
  const fullText = `The Lost Boys, the new Broadway musical at the Palace Theatre, opens with a sound design that swallows the orchestra and a lighting cue that signals serious mood. The cast bites in. Some scenes work; others don't. By the end, I was reasonably certain I had seen a play.`.padEnd(800, ' ');
  const result = runScoreExtractorPrePass(data, { fullText, outletId: 'amny' });
  assert.equal(result, null, 'extractor should not fire on plain prose');
});

// ─── Gate behavior: existing humanReviewScore blocks pre-pass ───────────
test('existing humanReviewScore blocks pre-pass (no clobber)', () => {
  const data = { humanReviewScore: 75 };
  const fullText = `★★★ Roma Torre says it's solid — three stars.`.padEnd(800, ' ');
  const result = runScoreExtractorPrePass(data, { fullText, outletId: 'nysr' });
  assert.equal(result, null, 'should respect existing humanReviewScore');
});

// ─── Gate behavior: existing originalScore blocks pre-pass ──────────────
test('existing originalScore blocks pre-pass (no clobber)', () => {
  const data = { originalScore: '4/5 stars' };
  const fullText = `★★★ Roma Torre says it's solid — three stars.`.padEnd(800, ' ');
  const result = runScoreExtractorPrePass(data, { fullText, outletId: 'nysr' });
  assert.equal(result, null, 'should respect existing originalScore');
});

// ─── Gate behavior: text below minTextLength returns null ───────────────
test('fullText shorter than minTextLength returns null', () => {
  const data = {};
  const result = runScoreExtractorPrePass(data, {
    fullText: '★★★ short',
    outletId: 'nysr',
  });
  assert.equal(result, null);
});

// ─── isTrustedExtractorSource gate ──────────────────────────────────────
test('isTrustedExtractorSource accepts OUTLET_VERIFIED_SOURCES + unicode-stars-fallthrough only', () => {
  // Trusted entries (subset)
  assert.equal(isTrustedExtractorSource('letter-grade'), true);
  assert.equal(isTrustedExtractorSource('unicode-stars'), true);
  assert.equal(isTrustedExtractorSource('json-ld'), true);
  assert.equal(isTrustedExtractorSource('unicode-stars-fallthrough'), true);
  // Distrusted: generic text-based fallthroughs that have no positional anchor
  // when html='' — caught quoted critic mentions and chrome at /ingest pre-fix.
  assert.equal(isTrustedExtractorSource('og-description'), false);
  assert.equal(isTrustedExtractorSource('wp-api-title'), false);
  // Empty/null
  assert.equal(isTrustedExtractorSource(''), false);
  assert.equal(isTrustedExtractorSource(null), false);
  assert.equal(isTrustedExtractorSource(undefined), false);
});
