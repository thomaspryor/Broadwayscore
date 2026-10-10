/**
 * extract-dtli-reviews.js cross-market routing guard — scope and behaviour.
 *
 * The guard itself landed as BRO-363 (commits eb7bfca8025 + 33b919468a2) with no
 * tests. These are those tests, plus regression guards for the two scope gaps
 * found afterwards by an adversarial review.
 *
 * WHY THE GUARD EXISTS (2026-08-15 main-red, test.yml run 31880306250, step
 * "Audit sibling-title misroute (strict)"): DTLI archives are keyed by show id,
 * so every review on the aggregator page for a title is written under that id.
 * "Two Strangers (Carry a Cake Across New York)" has an A.R.T. regional tryout
 * AND a Broadway transfer, so the five Broadway opening-day reviews (NYT, NY
 * Daily News, NYSR x2, TheWrap — all publishDate 2025-11-20) were written as
 * empty excerpt stubs under the REGIONAL id. They were hand-deleted on
 * 2026-08-14 (data-repo 8d26d63ddba) and the next daily review-refresh.yml run
 * re-created them (5852442e75f), which is what reddened main. saveReview writes
 * via safeWriteReview, which preserves PROTECTED_FIELDS but does NOT re-route.
 *
 * WHY THE SCOPE MATTERS: measured against the real corpus 2026-08-15,
 * classifyMarketRouting returns `reroute` for 297 existing source:'dtli' records
 * across 49 sibling pairs — but 296 are ALREADY wrongProduction/wrongShow-flagged
 * and exactly 1 is not. A guard that ignored existing adjudication would
 * physically relocate those 296 on the next unattended 09:00 UTC refresh. A
 * further 107 dtli records carry allowCrossMarket or a human-clear marker.
 *
 * CLAUDE.md §15: this require()s the real saveReview and the real
 * buildSiblingIndex, and replays REAL records (verbatim from the data-repo
 * commit that caused the red, and from live corpus files) against the REAL
 * data/shows.json — not hand-built fixture pairs, which is the "fixtures are not
 * evidence" trap that lets a guard pass its tests and miss the live case.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { saveReview } = require(path.join(REPO, 'scripts/extract-dtli-reviews.js'));

const REGIONAL = 'two-strangers-carry-a-cake-across-new-york-at-art-regional-2025';
const BROADWAY = 'two-strangers-bway-2025';

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(REPO, 'data/shows.json'), 'utf8'));
  return raw.shows || raw;
}

// The record verbatim as data-repo commit 5852442e75f wrote it.
const REAL_MISROUTED_RECORD = {
  showId: REGIONAL,
  outletId: 'nytimes',
  outlet: 'The New York Times',
  criticName: 'Laura Collins-Hughes',
  url: 'https://www.nytimes.com/2025/11/20/theater/two-strangers-carry-cake-review.html',
  publishDate: 'November 20, 2025',
  dtliExcerpt: 'The effervescent new musical comedy opened on Thursday at the Longacre Theater',
  fullText: null,
  isFullReview: false,
  originalScore: null,
  assignedScore: null,
  dtliThumb: 'Up',
  source: 'dtli',
  contentTier: 'excerpt',
  wordCount: 0,
};

test('reroutes a Broadway-dated review off the same-title regional tryout', () => {
  const shows = loadShows();
  const found = shows.filter(s => s.id === REGIONAL || s.id === BROADWAY);
  assert.equal(found.length, 2,
    `expected both Two Strangers productions in shows.json, found ${found.map(s => s.id).join(', ') || 'none'} — ` +
    'if a production was renamed, re-point this test at the current ids rather than deleting it');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtli-reroute-'));
  try {
    const written = saveReview(REAL_MISROUTED_RECORD, false, tmp);
    assert.ok(written, 'saveReview returned no path — the review was dropped entirely, which is not the fix');

    assert.deepEqual(fs.readdirSync(tmp), [BROADWAY],
      `review landed under ${fs.readdirSync(tmp).join(', ')} instead of ${BROADWAY}`);
    // The misroute that reddened main was the mere EXISTENCE of a stub under the
    // tryout id, so the regional directory must not even be created.
    assert.equal(fs.existsSync(path.join(tmp, REGIONAL)), false,
      'the regional tryout directory was created — audit-sibling-title-misroute --strict would flag this file');
    assert.equal(JSON.parse(fs.readFileSync(written, 'utf8')).showId, BROADWAY,
      'the written record still carries the regional showId');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('does NOT relocate a record that is already wrongProduction-flagged', () => {
  // Scope must match audit-sibling-title-misroute.js's isAlreadyFlagged. 296 of
  // the 297 reroute-shaped dtli records are already flagged; relocating them
  // unattended is a bulk migration, not a guard.
  //
  // Real record: data/review-texts/operation-mincemeat-west-end-2024/
  // broadwaynews--brittani-samuel.json — wrongProduction: true, and
  // classifyMarketRouting wants it in operation-mincemeat-2025
  // ("sibling opening 1d from publishDate vs current 682d").
  const SRC = 'operation-mincemeat-west-end-2024';
  const flagged = {
    showId: SRC,
    outletId: 'broadwaynews',
    outlet: 'Broadway News',
    criticName: 'Brittani Samuel',
    url: 'https://www.broadwaynews.com/the-broadway-review-operation-mincemeat-is-a-gleeful-mi5-inspired-romp/',
    publishDate: 'March 21, 2025',
    source: 'dtli',
    contentTier: 'invalid',
    wrongProduction: true,
    fullText: null,
    isFullReview: false,
    wordCount: 0,
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtli-flagged-'));
  try {
    // Seed it on disk first — the guard reads the CURRENT file's adjudication,
    // exactly as the daily refresh would encounter it.
    fs.mkdirSync(path.join(tmp, SRC), { recursive: true });
    fs.writeFileSync(path.join(tmp, SRC, 'broadwaynews--brittani-samuel.json'),
      JSON.stringify(flagged, null, 2) + '\n');

    saveReview(flagged, false, tmp);

    assert.deepEqual(fs.readdirSync(tmp).sort(), [SRC],
      'an already-flagged record was migrated to its sibling — the guard has exceeded ' +
      "audit-sibling-title-misroute.js's isAlreadyFlagged scope and is doing a bulk data migration");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('does not relocate a review a human ruled cross-market-OK', () => {
  // classifyMarketRouting short-circuits on allowCrossMarket and the audit skips
  // human-cleared records via isHumanCleared. 107 real dtli records carry such a
  // marker; relocating them silently overrides a human decision.
  const cleared = { ...REAL_MISROUTED_RECORD, wrongProduction: false, wrongProductionManualClear: true };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtli-humanruled-'));
  try {
    fs.mkdirSync(path.join(tmp, REGIONAL), { recursive: true });
    fs.writeFileSync(path.join(tmp, REGIONAL, 'nytimes--laura-collins-hughes.json'),
      JSON.stringify(cleared, null, 2) + '\n');

    saveReview(REAL_MISROUTED_RECORD, false, tmp);

    assert.deepEqual(fs.readdirSync(tmp).sort(), [REGIONAL],
      'a human-cleared review was relocated to its sibling — the guard is overriding a manual decision');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('refuses a cross-market reject instead of writing it anyway', () => {
  // Real case: the NYT Broadway review of Back to the Future (URL ends
  // -review-broadway.html) arriving under the WEST END production. 30 real dtli
  // records classify as reject.
  const crossMarket = {
    showId: 'back-to-the-future-west-end-2021',
    outletId: 'nytimes',
    outlet: 'The New York Times',
    criticName: 'Jesse Green',
    url: 'https://www.nytimes.com/2023/08/03/theater/back-to-the-future-review-broadway.html',
    publishDate: 'August 3, 2023',
    source: 'dtli',
    contentTier: 'excerpt',
    fullText: null,
    isFullReview: false,
    wordCount: 0,
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtli-reject-'));
  try {
    assert.equal(saveReview(crossMarket, false, tmp), null,
      'a cross-market reject was written instead of refused');
    assert.deepEqual(fs.readdirSync(tmp), [],
      'a rejected cross-market review created a show directory — nothing should be written');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('leaves a genuinely regional review on the regional production', () => {
  // Boston Globe reviewing the A.R.T. run, dated to the regional opening — this
  // one belongs where it is, and a guard that moved it would be worse than the
  // bug it fixes.
  const regionalReview = {
    showId: REGIONAL,
    outletId: 'boston-globe',
    outlet: 'The Boston Globe',
    criticName: 'Terry Byrne',
    url: 'https://www.bostonglobe.com/2025/05/30/arts/two-strangers-carry-cake-across-new-york-art-review/',
    publishDate: 'May 30, 2025',
    fullText: null,
    isFullReview: false,
    source: 'dtli',
    contentTier: 'excerpt',
    wordCount: 0,
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtli-regional-'));
  try {
    assert.ok(saveReview(regionalReview, false, tmp), 'saveReview dropped a legitimate regional review');
    assert.deepEqual(fs.readdirSync(tmp), [REGIONAL],
      'a regional-dated review was moved off the regional production — the guard is over-reaching');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
