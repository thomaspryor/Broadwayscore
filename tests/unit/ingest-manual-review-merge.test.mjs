/**
 * ST-1: ingest-manual-review merge-path 8-field fix.
 *
 * buildManualReviewFields() (scripts/lib/manual-review-fields.js) has always
 * emitted the 8 protection fields correctly (tests/unit/ingest-manual-review-
 * fields.test.mjs pins that). But createOrMergeReviewFile's merge path
 * (_mergeIntoExisting in scripts/lib/review-file-writer.js) only wrote a field
 * when the EXISTING value was falsy — `if (val != null && !existing[key])`.
 * Ingesting a manual review onto a file that already carried
 * wrongProduction:true left the stale flag in place, because
 * `!existing.wrongProduction` was false. The review stayed excluded from
 * rebuild despite the operator's explicit override — proven live-broken on
 * Grace Pervades (Notion 3a4637c5). This test exercises the real merge path
 * end to end (not just field construction) and pins that a manual-entry merge
 * always wins.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer.js');
const { buildManualReviewFields } = require('../../scripts/lib/manual-review-fields.js');

function writeFixture(dir, showId, filename, data) {
  const showDir = path.join(dir, showId);
  fs.mkdirSync(showDir, { recursive: true });
  fs.writeFileSync(path.join(showDir, filename), JSON.stringify(data, null, 2));
  return path.join(showDir, filename);
}

describe('manual-entry merge onto a flagged existing file', () => {
  test('merge onto wrongProduction:true file yields wrongProduction:false + all 8 protection fields', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-merge-'));
    const showId = 'grace-pervades-west-end-2026';
    const filepath = writeFixture(dir, showId, 'variety--naveen-kumar.json', {
      showId, outletId: 'variety', criticName: 'Naveen Kumar',
      url: 'https://variety.com/2023/legit/reviews/stale-production-review',
      publishDate: '2023-05-01',
      wrongProduction: true,
      contentVerification: { wrongProduction: true, wrongArticle: false },
      humanReviewedWrongProduction: false,
      wrongShow: false,
      allowEarlyDate: false,
      manualContentTier: 'stub',
    });

    const fields = buildManualReviewFields({
      humanScore: 84,
      fullText: 'A genuinely current-production review with real critical detail. '.repeat(10),
    });

    const result = createOrMergeReviewFile(showId, {
      outletId: 'variety', outlet: 'Variety', criticName: 'Naveen Kumar',
      url: 'https://variety.com/2026/legit/reviews/grace-pervades-current-review',
      source: 'manual-entry',
      fields,
    }, { reviewTextsDir: dir });

    assert.equal(result.action, 'updated');
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));

    assert.equal(data.wrongProduction, false, 'wrongProduction must flip to false on merge');
    assert.equal(data.wrongProductionManualClear, true);
    assert.equal(data.allowEarlyDate, true);
    assert.equal(data.wrongShow, false);
    assert.ok(data.contentVerification, 'contentVerification must be present');
    assert.equal(data.contentVerification.wrongProduction, false, 'nested contentVerification.wrongProduction must flip to false');
    assert.equal(data.contentVerification.wrongArticle, false);
    assert.equal(data.manualContentTier, 'complete', 'manualContentTier must overwrite the stale "stub" value');
    assert.equal(data.humanReviewedWrongProduction, false);
    assert.equal(data.humanReviewScore, 84);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('merge onto wrongShow:true + isNonReview:true file clears both', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-merge-wrongshow-'));
    const showId = 'some-off-broadway-show-2026';
    const filepath = writeFixture(dir, showId, 'nytimes--jesse-green.json', {
      showId, outletId: 'nytimes', criticName: 'Jesse Green',
      url: 'https://nytimes.com/2025/other-show-review',
      wrongShow: true,
      isNonReview: true,
    });

    const fields = buildManualReviewFields({ humanScore: 70, fullText: 'x'.repeat(500) });
    const result = createOrMergeReviewFile(showId, {
      outletId: 'nytimes', outlet: 'The New York Times', criticName: 'Jesse Green',
      url: 'https://nytimes.com/2026/correct-show-review',
      source: 'manual-entry',
      fields,
    }, { reviewTextsDir: dir });

    assert.equal(result.action, 'updated');
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    assert.equal(data.wrongShow, false);
    assert.equal(data.isNonReview, false);
    assert.equal(data.wrongShowManualClear, true);
    assert.equal(data.nonReviewManualClear, true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('non-manual-entry merge (scraper source) still respects the falsy-only guard (no regression)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ingest-merge-scraper-'));
    const showId = 'scraper-guard-show-2026';
    const filepath = writeFixture(dir, showId, 'variety--jane-doe.json', {
      showId, outletId: 'variety', criticName: 'Jane Doe',
      url: 'https://variety.com/2023/stale',
      wrongProduction: true,
    });

    const result = createOrMergeReviewFile(showId, {
      outletId: 'variety', outlet: 'Variety', criticName: 'Jane Doe',
      url: 'https://variety.com/2023/stale',
      source: 'bww-roundup',
      fields: { wrongProduction: false, showScoreExcerpt: 'unrelated scraper field' },
    }, { reviewTextsDir: dir });

    assert.ok(['updated', 'skipped'].includes(result.action));
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    assert.equal(data.wrongProduction, true, 'a scraper write must NOT clear an existing wrongProduction flag');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
