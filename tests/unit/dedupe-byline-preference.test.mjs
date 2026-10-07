/**
 * BRO-69 — Rebuild same-URL dedup: prefer a real criticName over "Unknown".
 *
 * When a canonical URL has multiple review-file records and one carries a
 * plausible, real criticName while another (often outlet--unknown.json) is
 * "Unknown", the rebuild's dedup must surface the real name in the emitted
 * reviews.json record instead of "Unknown" — this is the byline
 * derivation-gap that card #27/#190 traced to a flagged same-URL twin
 * holding the byline the scored file lacks.
 *
 * These tests exercise the REAL production functions (CLAUDE.md rule 15 —
 * never re-implement the logic under test):
 *   - compareFilesForDedupPriority (scripts/lib/rebuild-helpers.js): decides
 *     which same-URL file the rebuild's dedup pass keeps as the scored
 *     "winner" when it walks a show's files in priority order.
 *   - recoverDisplayBylinesForShow + resolveCriticName
 *     (scripts/lib/byline-recovery.js): the display-only recovery path
 *     rebuild-all-reviews.js calls to substitute a same-URL sibling's real
 *     name into the winner's IN-MEMORY reviews.json record.
 *
 * CRITICAL constraint (2026-07-14 incident, card #27): recovery must NEVER
 * rewrite the winning outlet--unknown.json file's criticName on disk — doing
 * so turns it into a same-name/same-URL duplicate of the flagged sibling and
 * lets the rebuild's own dedup drop the scored review entirely. Covered
 * below by asserting the source record object is untouched.
 *
 * Run: node --test tests/unit/dedupe-byline-preference.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareFilesForDedupPriority } = require('../../scripts/lib/rebuild-helpers.js');
const { recoverDisplayBylinesForShow, resolveCriticName } = require('../../scripts/lib/byline-recovery.js');

test('compareFilesForDedupPriority: a scored Unknown file still wins the same-URL dedup over an unscored named sibling', () => {
  // task #1406 — a scored review must never lose to an unscored named twin,
  // even though the named twin will supply the byline via recovery below.
  const scoredUnknown = { file: 'nytimes--unknown.json', hasScore: true, isUnknown: true };
  const unscoredNamed = { file: 'nytimes--ben-brantley.json', hasScore: false, isUnknown: false };
  const files = [unscoredNamed, scoredUnknown].sort(compareFilesForDedupPriority);
  assert.equal(files[0].file, 'nytimes--unknown.json', 'the scored file sorts first regardless of byline');
});

test('compareFilesForDedupPriority: among equally-scored files, the named critic wins over Unknown', () => {
  const scoredUnknown = { file: 'nytimes--unknown.json', hasScore: true, isUnknown: true };
  const scoredNamed = { file: 'nytimes--ben-brantley.json', hasScore: true, isUnknown: false };
  const files = [scoredUnknown, scoredNamed].sort(compareFilesForDedupPriority);
  assert.equal(files[0].file, 'nytimes--ben-brantley.json', 'the named file wins when scores are tied');
});

/**
 * End-to-end shape of the rebuild's emission step: the dedup winner is the
 * scored "Unknown" file (giant-2026/wsj pattern), its same-URL sibling holds
 * the real name but is flagged wrongProduction/invalid and therefore
 * excluded from scoring. resolveCriticName + recoverDisplayBylinesForShow
 * must still surface the real name for the emitted record.
 */
function emittedCriticNameForWinner(winnerFile, showRecords) {
  const recoveredByFile = new Map(
    recoverDisplayBylinesForShow([...showRecords].sort((a, b) => a.file.localeCompare(b.file)))
      .map((r) => [r.file, r.recoveredName])
  );
  const winner = showRecords.find((r) => r.file === winnerFile);
  return resolveCriticName(winner.criticName, recoveredByFile.get(winnerFile));
}

test('dedup winner scored "Unknown" + flagged named sibling → emitted record prefers the real criticName', () => {
  const showRecords = [
    {
      file: 'wsj--unknown.json',
      outletId: 'wsj',
      url: 'https://www.wsj.com/articles/giant-review-42d226b9?gaa_at=x',
      criticName: 'Unknown',
      fullText: 'A fine production. By Charles Isherwood.',
      flagged: false, // this is the scored, includable file
    },
    {
      file: 'wsj--charles-isherwood.json',
      outletId: 'wsj',
      url: 'https://www.wsj.com/articles/giant-review-42d226b9',
      criticName: 'Charles Isherwood',
      fullText: 'A fine production. By Charles Isherwood.',
      flagged: true, // wrongProduction/invalid — excluded from scoring
    },
  ];

  const resolved = emittedCriticNameForWinner('wsj--unknown.json', showRecords);
  assert.deepEqual(resolved, { name: 'Charles Isherwood', recovered: true });

  // CRITICAL constraint (card #27): the winning source record's own
  // criticName field must be untouched — recovery is display-only, never
  // written back onto the outlet--unknown.json record.
  const winnerSource = showRecords.find((r) => r.file === 'wsj--unknown.json');
  assert.equal(winnerSource.criticName, 'Unknown', 'source record is never mutated by recovery');
});

test('dedup winner already has a real criticName → recovery never overrides it', () => {
  const showRecords = [
    {
      file: 'nytimes--ben-brantley.json',
      outletId: 'nytimes',
      url: 'https://www.nytimes.com/review.html',
      criticName: 'Ben Brantley',
      fullText: 'By Ben Brantley.',
      flagged: false,
    },
    {
      file: 'nytimes--unknown.json',
      outletId: 'nytimes',
      url: 'https://www.nytimes.com/review.html?smid=x',
      criticName: 'Unknown',
      fullText: 'By Ben Brantley.',
      flagged: true,
    },
  ];

  const resolved = emittedCriticNameForWinner('nytimes--ben-brantley.json', showRecords);
  assert.deepEqual(resolved, { name: 'Ben Brantley', recovered: false });
});

test('no plausible sibling name at the same URL → winner stays "Unknown" (no false recovery)', () => {
  const showRecords = [
    { file: 'ap--unknown.json', outletId: 'ap', url: 'https://ap.com/a', criticName: 'Unknown', fullText: 'Staff review.', flagged: false },
  ];
  const resolved = emittedCriticNameForWinner('ap--unknown.json', showRecords);
  assert.deepEqual(resolved, { name: 'Unknown', recovered: false });
});
