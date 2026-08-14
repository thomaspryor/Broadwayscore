import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isUrlSwapRegression } = require('./url-downgrade-guard.js');
const { mergeReviews } = require('./review-normalization.js');

const EQUUS_2026 = {
  id: 'equus-west-end-2026',
  title: 'Equus',
  category: 'west-end',
  market: 'west-end',
  openingDate: '2026-05-19',
  previewsStartDate: '2026-05-08',
};

test('flags a candidate url dated years before the show window (Equus 2026 -> 2019 Stratford East regression)', () => {
  const verdict = isUrlSwapRegression({
    newUrl: 'https://www.theguardian.com/stage/2019/feb/25/equus-review-peter-shaffer-horse-blinding-theatre-royal-stratford-east-london-ned-bennett',
    show: EQUUS_2026,
    outletId: 'guardian',
  });
  assert.equal(verdict.regression, true);
  assert.equal(verdict.urlDate, '2019-02-25');
  assert.equal(verdict.issue, 'before_preview');
});

test('allows a candidate url dated inside the show window', () => {
  const verdict = isUrlSwapRegression({
    newUrl: 'https://www.theguardian.com/stage/2026/may/19/equus-peter-shaffer-menier-chocolate-factory-london',
    show: EQUUS_2026,
    outletId: 'guardian',
  });
  assert.equal(verdict.regression, false);
});

test('allows a candidate url dated shortly after closing (grace window)', () => {
  const verdict = isUrlSwapRegression({
    newUrl: 'https://www.theguardian.com/stage/2026/aug/20/some-review',
    show: { ...EQUUS_2026, closingDate: '2026-08-15' },
    outletId: 'guardian',
  });
  assert.equal(verdict.regression, false);
});

test('flags a candidate url dated long after closing', () => {
  const verdict = isUrlSwapRegression({
    newUrl: 'https://www.theguardian.com/stage/2027/mar/01/some-review',
    show: { ...EQUUS_2026, closingDate: '2026-08-15' },
    outletId: 'guardian',
  });
  assert.equal(verdict.regression, true);
  assert.equal(verdict.issue, 'after_close');
});

test('fails open when the candidate url has no extractable date', () => {
  const verdict = isUrlSwapRegression({
    newUrl: 'https://www.show-score.com/uk/london/west-end-shows/equus-london',
    show: EQUUS_2026,
    outletId: 'show-score',
  });
  assert.equal(verdict.regression, false);
});

test('fails open when there is no show record', () => {
  const verdict = isUrlSwapRegression({
    newUrl: 'https://www.theguardian.com/stage/2019/feb/25/equus-review',
    show: null,
    outletId: 'guardian',
  });
  assert.equal(verdict.regression, false);
});

test('fails open when the show has no window (no opening/preview dates)', () => {
  const verdict = isUrlSwapRegression({
    newUrl: 'https://www.theguardian.com/stage/2019/feb/25/equus-review',
    show: { id: 'equus-west-end-2026', title: 'Equus' },
    outletId: 'guardian',
  });
  assert.equal(verdict.regression, false);
});

test('allows a candidate url dated inside a declared priorRun window', () => {
  const show = {
    ...EQUUS_2026,
    priorRuns: [{ openingDate: '2019-02-01', closingDate: '2019-04-01' }],
  };
  const verdict = isUrlSwapRegression({
    newUrl: 'https://www.theguardian.com/stage/2019/feb/25/equus-review-peter-shaffer-horse-blinding-theatre-royal-stratford-east-london-ned-bennett',
    show,
    outletId: 'guardian',
  });
  assert.equal(verdict.regression, false);
});

test('romeo-and-juliet-class regression: 2026 west end swapped to 2023 Almeida', () => {
  const show = {
    id: 'romeo-and-juliet-west-end-2026',
    title: 'Romeo and Juliet',
    category: 'west-end',
    market: 'west-end',
    openingDate: '2026-05-01',
  };
  const verdict = isUrlSwapRegression({
    newUrl: 'https://www.theguardian.com/stage/2023/feb/22/romeo-and-juliet-review-almeida-theatre-london',
    show,
    outletId: 'guardian',
  });
  assert.equal(verdict.regression, true);
});

// ─── mergeReviews() URL-swap regression guard (#1478) ──────────────────────

test('mergeReviews refuses a urlChanged swap onto a prior-production url when show is supplied', () => {
  const existing = {
    outletId: 'guardian',
    criticName: 'Arifa Akbar',
    url: 'https://www.theguardian.com/stage/2026/may/19/equus-peter-shaffer-menier-chocolate-factory-london',
    fullText: 'Existing current-run review text.',
  };
  const incoming = {
    outletId: 'guardian',
    criticName: 'Arifa Akbar',
    url: 'https://www.theguardian.com/stage/2019/feb/25/equus-review-peter-shaffer-horse-blinding-theatre-royal-stratford-east-london-ned-bennett',
    fullText: 'Wrong-production 2019 Stratford East text.',
  };
  const merged = mergeReviews(existing, incoming, {}, { show: EQUUS_2026, showId: 'equus-west-end-2026' });
  assert.equal(merged.url, existing.url, 'url must NOT swap to the prior-production candidate');
  assert.equal(merged.fullText, existing.fullText, 'existing content must survive the refused swap');
});

test('mergeReviews allows a urlChanged swap onto a candidate inside the show window', () => {
  const existing = {
    outletId: 'guardian',
    criticName: 'Arifa Akbar',
    url: 'https://www.theguardian.com/stage/2026/may/01/equus-preview-stub',
    fullText: null,
  };
  const incoming = {
    outletId: 'guardian',
    criticName: 'Arifa Akbar',
    url: 'https://www.theguardian.com/stage/2026/may/19/equus-peter-shaffer-menier-chocolate-factory-london',
    fullText: 'Real current-run review text.',
  };
  const merged = mergeReviews(existing, incoming, {}, { show: EQUUS_2026, showId: 'equus-west-end-2026' });
  assert.equal(merged.url, incoming.url);
  assert.equal(merged.fullText, incoming.fullText);
});

test('mergeReviews still swaps urlChanged when no show record is supplied (fails open, unchanged pre-#1478 behavior)', () => {
  const existing = {
    outletId: 'guardian',
    criticName: 'Arifa Akbar',
    url: 'https://www.theguardian.com/stage/2026/may/19/equus-peter-shaffer-menier-chocolate-factory-london',
    fullText: 'Existing text.',
  };
  const incoming = {
    outletId: 'guardian',
    criticName: 'Arifa Akbar',
    url: 'https://www.theguardian.com/stage/2019/feb/25/equus-review-peter-shaffer-horse-blinding-theatre-royal-stratford-east-london-ned-bennett',
    fullText: 'No show context supplied — swap proceeds.',
  };
  const merged = mergeReviews(existing, incoming, {}, { showId: 'equus-west-end-2026' });
  assert.equal(merged.url, incoming.url);
});
