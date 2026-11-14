/**
 * Regression tests for the 2026-08-02 Car Man tour-leg rejection bug.
 *
 * Background: The Car Man declared priorRuns (2025-26 UK tour) in shows.json,
 * but the ensemble's scoreability gate rejected all 5 tour-venue reviews as
 * wrong_production ("review is of Lowry/Plymouth, show is at Sadler's Wells")
 * because the scoring context only named the current venue.
 *
 * Fix: priorRuns is threaded shows.json → loadShowPriority → reviewFile →
 * prepareScoringInput → buildScoringInput, which emits a NOTE that declared
 * tour legs ARE this production (venue AND date-range scoped, so the note
 * does not whitelist earlier stagings by the same company).
 *
 * The prepareScoringInput parity test exists because this is the THIRD
 * allowlist-omission in that method (category/venue 2026-04-23, type
 * 2026-05-17): index.ts attached the field, prepareScoringInput dropped it,
 * and the fix was a silent no-op in production until reviewed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScoringInput } from '../../scripts/llm-scoring/input-builder';
import { EnsembleReviewScorer } from '../../scripts/llm-scoring/ensemble-scorer';

const TOUR_REVIEW_TEXT =
  "Matthew Bourne's The Car Man at the Lowry is slick, super stylish and utterly gripping. " +
  'The company dance with ferocious energy, and the Salford audience roared its approval at the curtain. ' +
  'Bizet’s score, reworked by Terry Davies, drives the drama through the sweltering garage of Harmony. ' +
  'Luca’s arrival upends the town: the choreography for the duets is carnal and precise, all grease and heat. ' +
  'Lez Brotherston’s design remains a marvel, a diner and garage that spin into ever more claustrophobic shapes. ' +
  'There are longueurs in the second act, and the melodrama occasionally tips into silent-movie broadness, ' +
  'but the storytelling is so clear you could follow it from the back row with your eyes half shut. ' +
  'The ensemble numbers explode across the stage; the murder sequence is genuinely shocking even if you know it is coming. ' +
  'This revival earns its reputation as one of Bourne’s boldest works, and this cast may be the finest to dance it. ' +
  'The band, under Brett Morris, punches out the reorchestrated numbers with real muscle, and the sound design keeps every gasp audible. ' +
  'As Lana, the leading dancer smoulders and snaps through the seductions with total command of the idiom. ' +
  'Angelo’s transformation from bullied innocent to broken man is the evening’s emotional spine, danced with heartbreaking restraint. ' +
  'By the final tableau the audience was on its feet, and deservedly so: this is dance theatre with the grip of a thriller. ' +
  'If you missed the earlier legs of the tour, the message is simple: do not miss it now.';

const PRIOR_RUNS = [
  {
    openingDate: '2025-11-01',
    closingDate: '2026-07-27',
    venue: 'UK Tour (Mayflower Southampton, The Lowry Salford, Theatre Royal Plymouth, Lyceum Sheffield)',
  },
];

test('priorRuns emits a venue-and-date-scoped tour-leg note into the scoring context', () => {
  const built = buildScoringInput({
    showTitle: 'The Car Man',
    category: 'off-west-end',
    venue: "Sadler's Wells",
    publishDate: '2026-06-24',
    fullText: TOUR_REVIEW_TEXT,
    priorRuns: PRIOR_RUNS,
  });

  assert.match(built.context, /declared earlier runs\/tour legs/i, 'tour-leg note must be present');
  assert.match(built.context, /Lowry Salford/, 'note must name the declared legs');
  assert.match(built.context, /matches a listed venue AND falls within/i, 'note must require venue AND date match');
  assert.match(built.context, /same company, even at the same venue in a different year/i, 'note must exclude earlier same-company stagings');
  assert.match(built.context, /Review published: 2026-06-24/, 'publish date must be surfaced so the date clause is checkable');
});

test('no priorRuns → no tour-leg note (back-catalog shows unaffected)', () => {
  const built = buildScoringInput({
    showTitle: 'The Car Man',
    category: 'off-west-end',
    venue: "Sadler's Wells",
    fullText: TOUR_REVIEW_TEXT,
  });
  assert.doesNotMatch(built.context, /tour legs/i, 'no note without declared priorRuns');
});

test('malformed priorRuns entries are filtered, never throw', () => {
  const built = buildScoringInput({
    showTitle: 'The Car Man',
    category: 'off-west-end',
    venue: "Sadler's Wells",
    fullText: TOUR_REVIEW_TEXT,
    priorRuns: [null, 'garbage', PRIOR_RUNS[0]] as any,
  });
  assert.match(built.context, /Lowry Salford/, 'valid entry still renders after filtering junk');
});

test('prepareScoringInput threads priorRuns through to the context (allowlist parity)', () => {
  const scorer = Object.create(EnsembleReviewScorer.prototype) as EnsembleReviewScorer;
  const result = scorer.prepareScoringInput({
    showId: 'the-car-man-west-end-2026',
    showTitle: 'The Car Man',
    outletId: 'jadar',
    outlet: 'JADAR',
    criticName: 'Jay Darcy',
    url: 'https://jadar.uk/2026/06/24/review-matthew-bournes-the-car-man/',
    publishDate: '2026-06-24',
    fullText: TOUR_REVIEW_TEXT,
    bwwThumb: null,
    originalScore: null,
    category: 'off-west-end',
    venue: "Sadler's Wells",
    priorRuns: PRIOR_RUNS,
  } as any);

  const prepared = result as unknown as { ok: boolean; prep?: { scoringInput: { context: string } } };
  assert.ok(prepared.ok && prepared.prep, 'scoring input should be prepared');
  assert.match(
    prepared.prep!.scoringInput.context,
    /declared earlier runs\/tour legs/i,
    'prepareScoringInput must forward priorRuns to buildScoringInput — a miss here is the silent-no-op allowlist bug'
  );
});
