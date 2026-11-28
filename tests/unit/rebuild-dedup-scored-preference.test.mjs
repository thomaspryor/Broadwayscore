/**
 * Regression tests for task #1406: the rebuild's same-URL dedup was picking
 * an unscored named sibling over its scored "Unknown" twin, dropping the
 * only scoreable copy of the review (how-the-other-half-loves-west-end-2026,
 * 2026-08-13 — guardian, whatsonstage, theatrecat, london-theatre all lost
 * their scored review this way).
 *
 * Covers compareFilesForDedupPriority (scripts/lib/rebuild-helpers.js) in
 * isolation, plus an end-to-end simulation of the sort + first-seen-wins
 * dedup + byline-recovery pipeline (scripts/lib/byline-recovery.js, task
 * #190/#1321) to prove exactly one entry survives carrying BOTH the score
 * and the recovered byline.
 *
 * Run: node --test tests/unit/rebuild-dedup-scored-preference.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareFilesForDedupPriority, applyScoreRelevantMigrations, getBestScore } = require('../../scripts/lib/rebuild-helpers');
const { recoverDisplayBylinesForShow } = require('../../scripts/lib/byline-recovery');

const base = (overrides) => ({
  isDupe: false,
  hasScore: false,
  isUnknown: false,
  isOutletAsCritic: false,
  isVerified: false,
  hasEnsemble: false,
  ...overrides,
});

test('compareFilesForDedupPriority: scored-Unknown sorts before unscored-named sibling', () => {
  const scoredUnknown = { file: 'guardian--unknown.json', ...base({ hasScore: true, isUnknown: true }) };
  const unscoredNamed = { file: 'guardian--mark-lawson.json', ...base({ hasScore: false, isUnknown: false }) };
  assert.ok(compareFilesForDedupPriority(scoredUnknown, unscoredNamed) < 0,
    'scored Unknown must sort before its unscored named sibling');
  assert.ok(compareFilesForDedupPriority(unscoredNamed, scoredUnknown) > 0,
    'comparator must be antisymmetric');
});

test('compareFilesForDedupPriority: duplicate flag still dominates scored-ness', () => {
  const scoredDupe = { file: 'a--unknown.json', ...base({ hasScore: true, isUnknown: true, isDupe: true }) };
  const unscoredNotDupe = { file: 'b--named-critic.json', ...base({ hasScore: false, isUnknown: false, isDupe: false }) };
  assert.ok(compareFilesForDedupPriority(scoredDupe, unscoredNotDupe) > 0,
    'a file flagged as a duplicate must still sort AFTER a non-duplicate even when scored');
});

test('compareFilesForDedupPriority: when scored-ness ties, named still beats Unknown (task #190 behavior preserved)', () => {
  const scoredUnknown = { file: 'a--unknown.json', ...base({ hasScore: true, isUnknown: true }) };
  const scoredNamed = { file: 'a--named-critic.json', ...base({ hasScore: true, isUnknown: false }) };
  assert.ok(compareFilesForDedupPriority(scoredNamed, scoredUnknown) < 0,
    'with both scored, the named file should still win over Unknown');
});

test('compareFilesForDedupPriority: when both unscored, named still beats Unknown', () => {
  const unscoredUnknown = { file: 'a--unknown.json', ...base({ hasScore: false, isUnknown: true }) };
  const unscoredNamed = { file: 'a--named-critic.json', ...base({ hasScore: false, isUnknown: false }) };
  assert.ok(compareFilesForDedupPriority(unscoredNamed, unscoredUnknown) < 0,
    'with neither scored, the named file should still win over Unknown');
});

test('same-URL dedup + byline recovery: exactly one entry survives, carrying BOTH the score and the recovered byline', () => {
  const url = 'https://www.theguardian.com/stage/2026/aug/12/how-the-other-half-loves-review-old-vic-london-alan-ayckbourn-roger-allam';
  const bylineText = 'Reviewed by Mark Lawson for the Guardian: a sharp revival that finds real laughs in Ayckbourn\'s farce.';

  // Mirrors the real corpus files: guardian--unknown.json (scored, no byline)
  // and guardian--mark-lawson.json (named, unscored) sharing one canonical URL.
  const files = [
    {
      file: 'guardian--unknown.json',
      outletId: 'guardian',
      url,
      criticName: 'Unknown',
      fullText: bylineText,
      flagged: false,
      ...base({ hasScore: true, isUnknown: true }),
    },
    {
      file: 'guardian--mark-lawson.json',
      outletId: 'guardian',
      url,
      criticName: 'Mark Lawson',
      fullText: bylineText,
      flagged: false,
      ...base({ hasScore: false, isUnknown: false }),
    },
  ];

  // Sort with the REAL comparator — mirrors rebuild-all-reviews.js's files.sort().
  const sorted = [...files].sort(compareFilesForDedupPriority);

  // Simulate the rebuild's same-URL "first-seen wins" dedup: one survivor per
  // (outlet, canonical URL) bucket, same selection rule as the production
  // seenUrlsByOutlet Map in rebuild-all-reviews.js.
  const seen = new Set();
  const survivors = [];
  for (const f of sorted) {
    const key = `${f.outletId}|${f.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    survivors.push(f);
  }

  assert.equal(survivors.length, 1, 'exactly one entry should survive the same-URL dedup');
  assert.equal(survivors[0].file, 'guardian--unknown.json',
    'the SCORED file must be the survivor, not the unscored named one (task #1406)');
  assert.equal(survivors[0].hasScore, true, 'the survivor must carry the score');

  // Byline recovery (task #190/#1321) backfills the display name from the
  // losing named sibling onto the surviving scored Unknown entry — this only
  // works because the Unknown entry survived dedup in the first place.
  const recovered = recoverDisplayBylinesForShow(
    files.map(({ file, outletId, url: u, criticName, fullText, flagged }) => ({ file, outletId, url: u, criticName, fullText, flagged }))
  );
  const recoveredName = recovered.find((r) => r.file === survivors[0].file)?.recoveredName;

  assert.equal(recoveredName, 'Mark Lawson',
    'the surviving entry should recover the named sibling\'s byline');
});

test('applyScoreRelevantMigrations: a file only scoreable via aggregator-source migration must NOT sort as unscored (adversarial ship-check finding)', () => {
  // guardian is a KNOWN_STAR_OUTLET (score-extractors.js). Pre-migration this
  // file's originalScore is tagged with an aggregator scoreSource, so
  // getBestScore correctly refuses it (aggregator stars aren't the outlet's
  // own rating) until the migration moves the value to aggregatorStars.
  const raw = {
    outletId: 'guardian',
    originalScore: '4',
    scoreSource: 'show-score-stars',
  };
  assert.equal(getBestScore({ ...raw }), null,
    'pre-migration, an aggregator-sourced originalScore must not count as a score');

  const migrated = { ...raw };
  const result = applyScoreRelevantMigrations(migrated);
  assert.equal(result.aggregatorMigrated, true);
  assert.equal(migrated.originalScore, null);
  assert.equal(migrated.aggregatorStars, '4');
  assert.notEqual(getBestScore(migrated), null,
    'post-migration, the same file must score via the aggregatorStars-known-star-outlet path — ' +
    'this is what the sortMeta prepass must see, or it under-counts hasScore for this file shape');
});

test('applyScoreRelevantMigrations: garbageFullText recovery unlocks fullText without a disk write', () => {
  const data = {
    fullText: undefined,
    garbageFullText: 'A perfectly good review buried under junk. '.repeat(10),
    garbageReason: 'trailing-newsletter-signup',
  };
  const result = applyScoreRelevantMigrations(data);
  assert.equal(result.garbageRecovered, true);
  assert.ok(data.fullText && data.fullText.length > 200);
  assert.equal(data.fullTextRecoveredFrom, 'garbageFullText');
});

test('applyScoreRelevantMigrations: 404/error-page garbage is never recovered', () => {
  const data = {
    fullText: undefined,
    garbageFullText: 'Some unrelated page content that happens to be long enough. '.repeat(10),
    garbageReason: 'Error/404 page not found',
  };
  const result = applyScoreRelevantMigrations(data);
  assert.equal(result.garbageRecovered, false);
  assert.equal(data.fullText, undefined);
});
