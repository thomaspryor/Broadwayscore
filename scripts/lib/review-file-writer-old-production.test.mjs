// LIVE-DATA-LANE: writer tests read data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7210: a review dated over a year before the row's first date is another production's;
// refused at the writer chokepoint on NEW files, with human overrides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { oldProductionReviewReason } = require('./review-guards.js');
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const SHOW = { id: 'x', status: 'announced', previewsStartDate: '2027-03-01', openingDate: '2027-03-20' };

test('pure: 2022 review on a 2027 row is flagged; same-year review is not', () => {
  assert.equal(oldProductionReviewReason({ publishDate: '2022-05-01' }, SHOW), 'oldProductionReview');
  assert.equal(oldProductionReviewReason({ publishDate: '2026-12-01' }, SHOW), null);
  assert.equal(oldProductionReviewReason({ publishDate: '2026-03-02' }, SHOW), null, 'just inside 1y');
});

test('pure: overrides, priorRuns, missing data are silent', () => {
  for (const flag of ['allowEarlyDate', 'humanReviewedEarlyPublish', 'wrongProductionManualClear', 'allowCrossMarket']) {
    assert.equal(oldProductionReviewReason({ publishDate: '2022-05-01', [flag]: true }, SHOW), null, flag);
  }
  const withPrior = { ...SHOW, priorRuns: [{ openingDate: '2022-04-01' }] };
  assert.equal(oldProductionReviewReason({ publishDate: '2022-05-01' }, withPrior), null);
  assert.equal(oldProductionReviewReason({ publishDate: 'garbage' }, SHOW), null);
  assert.equal(oldProductionReviewReason({ publishDate: '2022-05-01' }, { id: 'y' }), null);
  assert.equal(oldProductionReviewReason({ publishDate: '2022-05-01' }, null), null);
});

const LIVE = 'mamma-mia-2025'; // previews 2025-08-02 in data/shows.json
const write = (dir, publishDate, extra = {}, source = 'submit-review-form') => createOrMergeReviewFile(LIVE, {
  outletId: 'forbes', outlet: 'Forbes', criticName: 'Scott Mendelson',
  url: 'https://www.forbes.com/sites/scottmendelson/2018/07/17/mamma-mia-here-we-go-again-review/', source,
  fields: { publishDate, fullText: 'Review body. '.repeat(60), ...extra },
}, { reviewTextsDir: dir });
const withDir = (fn) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oldprod-')); try { fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); } };

test('writer refuses a NEW 2018 review on the 2025 row; nothing written', () => withDir((dir) => {
  const r = write(dir, '2018-07-17');
  assert.equal(r.guardRefused, true);
  assert.equal(r.reason, 'oldProductionReview');
  assert.equal(fs.existsSync(path.join(dir, LIVE)), false);
}));

test('writer accepts a current review and a human-overridden old one', () => {
  withDir((dir) => assert.equal(write(dir, '2025-08-20').action, 'new'));
  // allowEarlyDate lifts THIS guard; the independent date guard may still quarantine it.
  withDir((dir) => assert.notEqual(write(dir, '2018-07-17', { allowEarlyDate: true }).reason, 'oldProductionReview'));
});
