// Submission-form junk guard: a NEW file from submit-review-form on a curated
// non-review page (ticket reseller, venue listing, press release) is refused;
// real reviews on hosts the broad classifier would wrongly reject
// (blogcritics.org, wbur.org /news/) still write; merges are never blocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const SHOW = 'the-gin-game-2026';
const submit = (dir, outletId, url, extra = {}) => createOrMergeReviewFile(SHOW, {
  outletId, outlet: outletId, criticName: 'Unknown', url, source: 'submit-review-form',
  fields: { fullText: 'A review. '.repeat(80), ...extra },
}, { reviewTextsDir: dir });

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'submit-guard-')); }

test('refuses a NEW submission on a ticket reseller or curated listing page', () => {
  const dir = tmp();
  try {
    for (const [outlet, url] of [
      ['stuborder', 'https://www.stuborder.com/the-gin-game-august-2-2026-tickets/8129315'],
      ['eventticketscenter', 'https://www.eventticketscenter.com/the-gin-game-new-york-07-30-2026/8129312/t'],
      ['spincyclenyc', 'https://www.spincyclenyc.com/index.php/theater/823-bathroom-attendant'],
    ]) {
      const r = submit(dir, outlet, url);
      assert.equal(r.guardRefused, true, url);
      assert.match(r.reason, /^submitted-non-review-url: /, url);
    }
    assert.equal(fs.existsSync(path.join(dir, SHOW)), false, 'nothing written');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('does not refuse real reviews the broad classifier would have rejected', () => {
  const dir = tmp();
  try {
    for (const [outlet, url] of [
      ['blogcritics', 'https://blogcritics.org/theater-review-nyc-the-real-ivanov-by-anton-chekhov/'],
      ['wbur', 'https://www.wbur.org/news/2026/08/25/american-repertory-theater-rhinoceros-review'],
      ['vocal', 'https://vocal.media/critique/bathroom-attendant'],
      ['new-york-city-theatre', 'https://www.newyorkcitytheatre.com/reviews/22099'],
      ['new-york-city-theatre', 'https://www.newyorkcitytheatre.com/news/reviews/494799'],
    ]) {
      const r = submit(dir, outlet, url);
      assert.doesNotMatch(String(r.reason || ''), /submitted-non-review-url/, url);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('escape hatch and non-submission sources are unaffected', () => {
  const dir = tmp();
  try {
    const url = 'https://www.stuborder.com/the-gin-game-august-2-2026-tickets/8129315';
    const r = submit(dir, 'stuborder', url, { allowNonReviewUrl: true });
    assert.doesNotMatch(String(r.reason || ''), /submitted-non-review-url/);
    const r2 = createOrMergeReviewFile(SHOW, {
      outletId: 'stuborder', outlet: 'stuborder', criticName: 'Unknown', url, source: 'manual-entry',
      fields: { fullText: 'x '.repeat(200) },
    }, { reviewTextsDir: dir });
    assert.doesNotMatch(String(r2.reason || ''), /submitted-non-review-url/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
