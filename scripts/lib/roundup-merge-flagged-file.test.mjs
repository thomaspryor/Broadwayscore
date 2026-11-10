// BRO-7293 class guard: a new review from an outlet that reviewed an EARLIER production must
// not be swallowed by that outlet's flagged file (Cititour / Brian Scott Lipton, Here There Are Blueberries).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findMatchingReviewFile, isFlaggedForRoundupMerge, uniqueReviewFilename } = require('./review-file-match.js');
const { getFoundOutletIds, getFlaggedOnlyOutletIds } = require('./found-outlet-ids.js');
const { claimsOutletCoverage, addClaimedOutletIds } = require('./outlet-coverage-claim.js');
const { shouldAutoClearDatelessRevival, bwwExcerptContradictsText } = require('./wrong-production-autoclear.js');

const SHOW = 'fixture-show-2026';
const OLD = 'cititour--brian-scott-lipton.json';
const oldText = 'Lipton writes about the intimate staging now at New York Theatre Workshop. '.repeat(12);

function makeDir() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7293-'));
  fs.mkdirSync(path.join(base, SHOW));
  fs.writeFileSync(path.join(base, SHOW, OLD), JSON.stringify({
    showId: SHOW, outletId: 'cititour', outlet: 'Cititour', criticName: 'Brian Scott Lipton',
    url: 'https://cititour.com/NYC_Broadway/Show/1232', wrongProduction: true,
    wrongProductionReason: 'dateless-revival', wrongProductionNote: 'Dateless revival guard: x', fullText: oldText,
  }));
  return base;
}

test('roundup excerpt never attaches to a flagged earlier-production file', () => {
  const base = makeDir();
  const dir = path.join(base, SHOW);
  const files = fs.readdirSync(dir);
  assert.equal(findMatchingReviewFile(files, 'cititour', 'brian-scott-lipton', (x) => x), OLD, 'unfiltered matcher finds it (the old bug)');
  const usable = files.filter((f) => !isFlaggedForRoundupMerge(path.join(dir, f)));
  assert.equal(findMatchingReviewFile(usable, 'cititour', 'brian-scott-lipton', (x) => x), null);
  assert.equal(uniqueReviewFilename(dir, OLD), 'cititour--brian-scott-lipton-2.json');
  fs.writeFileSync(path.join(dir, 'cititour--brian-scott-lipton-2.json'), JSON.stringify({ outletId: 'cititour' }));
  assert.equal(uniqueReviewFilename(dir, OLD), 'cititour--brian-scott-lipton-3.json');
  assert.equal(findMatchingReviewFile(fs.readdirSync(dir).filter((f) => !isFlaggedForRoundupMerge(path.join(dir, f))), 'cititour', 'brian-scott-lipton', (x) => x), 'cititour--brian-scott-lipton-2.json');
});

test('url-less roundup row does not close discovery for an outlet whose only file is flagged', () => {
  const base = makeDir();
  const ctx = { reviewTextsDir: base };
  assert.equal(getFoundOutletIds(SHOW, ctx).has('cititour'), false);
  const flagged = getFlaggedOnlyOutletIds(SHOW, ctx);
  assert.deepEqual([...flagged], ['cititour']);
  const row = { outletId: 'cititour', url: null, source: 'bww-roundup', bwwExcerpt: 'x' };
  assert.equal(claimsOutletCoverage(row), true, 'without the flagged-only set the row still claims (old behavior)');
  assert.equal(claimsOutletCoverage(row, flagged), false);
  const set = addClaimedOutletIds(new Set(), [row, { outletId: 'nytimes', url: null, source: 'bww-roundup' }], flagged);
  assert.deepEqual([...set], ['nytimes']);
  assert.equal(claimsOutletCoverage({ ...row, url: 'https://cititour.com/new/1411' }, flagged), true, 'a row with a url still claims');
});

test('dateless-revival hold is not released when the roundup excerpt is absent from the stored text', () => {
  const held = {
    wrongProduction: true, wrongProductionReason: 'dateless-revival', wrongProductionNote: 'Dateless revival guard: x',
    fullText: oldText, bwwExcerpt: 'A Broadway debut that now lands at Broadway\'s stage with real force and a lovely cast...',
  };
  assert.equal(bwwExcerptContradictsText(held), true);
  assert.equal(shouldAutoClearDatelessRevival(held, { hasUsableDate: true }), false);
  const genuine = { ...held, bwwExcerpt: 'the intimate staging now at New York Theatre Workshop...' };
  assert.equal(bwwExcerptContradictsText(genuine), false);
  assert.equal(shouldAutoClearDatelessRevival(genuine, { hasUsableDate: true }), true);
  const noExcerpt = { ...held, bwwExcerpt: undefined };
  assert.equal(shouldAutoClearDatelessRevival(noExcerpt, { hasUsableDate: true }), true);
});

test('outlet stays open after the roundup excerpt stub (-2) exists next to the flagged file', () => {
  const base = makeDir();
  fs.writeFileSync(path.join(base, SHOW, 'cititour--brian-scott-lipton-2.json'), JSON.stringify({
    showId: SHOW, outletId: 'cititour', outlet: 'Cititour', criticName: 'Brian Scott Lipton',
    url: null, contentTier: 'excerpt', bwwExcerpt: 'x',
  }));
  const flagged = getFlaggedOnlyOutletIds(SHOW, { reviewTextsDir: base });
  assert.deepEqual([...flagged], ['cititour']);
  // once a real, url-bearing review lands the outlet is genuinely found
  fs.writeFileSync(path.join(base, SHOW, 'cititour--unknown.json'), JSON.stringify({
    showId: SHOW, outletId: 'cititour', outlet: 'Cititour', url: 'https://cititour.com/new/1411', contentTier: 'complete',
  }));
  assert.deepEqual([...getFlaggedOnlyOutletIds(SHOW, { reviewTextsDir: base })], []);
});
