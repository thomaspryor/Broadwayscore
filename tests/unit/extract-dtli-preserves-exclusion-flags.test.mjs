// Task #653 — reviews.json corpus non-determinism.
//
// findExistingReviewFile() deliberately refuses to return wrongProduction /
// duplicateOf files ("never a merge target"). extract-dtli-reviews.js's
// saveReview() therefore saw `existingFile === null` for every already-flagged
// DTLI file and, before the fix, raw-wrote the canonical path with a clean
// 12-field object — silently dropping wrongProduction / wrongProductionNote /
// contentTier. The next bare rebuild re-included ~155 historical DTLI excerpts
// across 92 shows; push-review-texts' PROTECTED_FIELDS restore then put the
// flags back, so the rebuild after that dropped them again. That ping-pong is
// the ±150 daily corpus flap (19361 → 19510 → 19358 on 2026-08-02).
//
// This test requires the REAL saveReview (CLAUDE.md §15 — never re-implement
// the logic in the test) and asserts exclusion state survives a re-extraction.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { saveReview } = require('../../scripts/extract-dtli-reviews.js');

const SHOW_ID = '33-variations-2009';

// Shape copied from the live corpus file that actually flapped:
// broadway-review-texts/33-variations-2009/ap--unknown.json
function flaggedOnDisk() {
  return {
    showId: SHOW_ID,
    outletId: 'ap',
    outlet: 'Associated Press',
    criticName: null,
    url: 'http://www.canadaeast.com/entertainment/article/597632',
    publishDate: 'April 22, 2014',
    dtliExcerpt: 'Moises Kaufman’s earnest, plot-heavy "33 Variations"...',
    fullText: 'x'.repeat(3164),
    isFullReview: false,
    originalScore: null,
    assignedScore: 60,
    dtliThumb: 'Meh',
    source: 'dtli',
    contentTier: 'invalid',
    contentTierReason: 'Wrong production',
    incompleteReason: 'wrong_content',
    wrongProduction: true,
    wrongProductionNote:
      'Date guard: review April 22, 2014 is 1790d after 2009-05-21 (close+7d) — likely different production',
  };
}

// What extractReviewsFromDTLI() hands saveReview() on a re-extraction: the
// aggregator page carries no exclusion state, only the DTLI-visible fields.
function freshFromDtliPage() {
  return {
    showId: SHOW_ID,
    outletId: 'ap',
    outlet: 'Associated Press',
    criticName: null,
    url: 'http://www.canadaeast.com/entertainment/article/597632',
    publishDate: 'April 22, 2014',
    dtliExcerpt: 'Moises Kaufman’s earnest, plot-heavy "33 Variations"...',
    fullText: null,
    isFullReview: false,
    originalScore: null,
    assignedScore: null,
    dtliThumb: 'Meh',
    source: 'dtli',
  };
}

function withTempCorpus(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtli-flags-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('re-extracting DTLI does not resurrect a wrongProduction-flagged review', () => {
  withTempCorpus((dir) => {
    const showDir = path.join(dir, SHOW_ID);
    fs.mkdirSync(showDir, { recursive: true });
    const filePath = path.join(showDir, 'ap--unknown.json');
    fs.writeFileSync(filePath, JSON.stringify(flaggedOnDisk(), null, 2));

    saveReview(freshFromDtliPage(), false, dir);

    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(
      after.wrongProduction,
      true,
      'wrongProduction was dropped — the flagged review will re-enter reviews.json on the next rebuild',
    );
    assert.equal(after.contentTier, 'invalid', 'contentTier was downgraded away from its excluded state');
    assert.match(String(after.wrongProductionNote || ''), /Date guard/);
  });
});

test('re-extraction still refreshes DTLI-owned fields on a clean review', () => {
  withTempCorpus((dir) => {
    const showDir = path.join(dir, SHOW_ID);
    fs.mkdirSync(showDir, { recursive: true });
    const filePath = path.join(showDir, 'ap--unknown.json');
    const clean = flaggedOnDisk();
    delete clean.wrongProduction;
    delete clean.wrongProductionNote;
    delete clean.incompleteReason;
    clean.contentTier = 'excerpt';
    clean.contentTierReason = 'DTLI excerpt';
    clean.dtliThumb = null;
    fs.writeFileSync(filePath, JSON.stringify(clean, null, 2));

    saveReview(freshFromDtliPage(), false, dir);

    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.dtliThumb, 'Meh', 'DTLI thumb should still be refreshed from the aggregator page');
    assert.equal(after.wrongProduction, undefined);
  });
});

// Ship-check finding: safeWriteReview preserves PROTECTED_FIELDS, but a canonical
// URL change first runs applyUrlChangeInvariant, which clears wrongProduction,
// contentTier AND publishDate as "old-URL-derived". With publishDate gone,
// flag-wrong-production-by-date can never re-derive the Date guard, so the review
// re-enters reviews.json permanently. DTLI's link is the aggregator's, not
// necessarily the article's current URL — keep the flagged file's own.
test('DTLI supplying a different URL does not strip a flagged review of its exclusion', () => {
  withTempCorpus((dir) => {
    const showDir = path.join(dir, SHOW_ID);
    fs.mkdirSync(showDir, { recursive: true });
    const filePath = path.join(showDir, 'ap--unknown.json');
    fs.writeFileSync(filePath, JSON.stringify(flaggedOnDisk(), null, 2));

    const moved = freshFromDtliPage();
    moved.url = 'https://www.canadaeast.com/entertainment/article/597632-syndicated-copy';
    saveReview(moved, false, dir);

    const after = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.equal(after.wrongProduction, true, 'url-change invariant stripped the exclusion flag');
    assert.equal(after.contentTier, 'invalid');
    assert.ok(after.publishDate, 'publishDate must survive — the Date guard needs it to re-derive');
    assert.equal(
      after.url,
      flaggedOnDisk().url,
      "the flagged file's own URL wins over the aggregator's link",
    );
  });
});

test('a brand-new DTLI review still gets written', () => {
  withTempCorpus((dir) => {
    const written = saveReview(freshFromDtliPage(), false, dir);
    assert.ok(written, 'saveReview should return the written path for a new file');
    const after = JSON.parse(fs.readFileSync(written, 'utf-8'));
    assert.equal(after.outletId, 'ap');
    assert.equal(after.dtliThumb, 'Meh');
  });
});
