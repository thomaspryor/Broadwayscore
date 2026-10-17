import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isUrlSwapRegression } = require('./url-downgrade-guard.js');

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

// 2026-10-11: the-whos-tommy-tour-2026's Deadline stub was swapped to a
// /2024/03/ review of the 2024 Broadway production. /YYYY/MM/ paths give only a
// year, which _urlPathDate ignored, so the guard never fired.
test('year-only url path before the show window is refused; prior run / tour leg / same year are not', () => {
  const show = { openingDate: '2026-10-20', previewsStartDate: '2026-10-01', category: 'tour' };
  const old = 'https://deadline.com/2024/03/the-whos-tommy-broadway-review-1235869837/';
  const r = isUrlSwapRegression({ newUrl: old, show, outletId: 'deadline' });
  assert.equal(r.regression, true);
  assert.equal(r.issue, 'year-before-window');
  assert.equal(isUrlSwapRegression({ newUrl: old, show: { ...show, priorRuns: [{ openingDate: '2024-03-01', closingDate: '2024-08-31' }] }, outletId: 'deadline' }).regression, false);
  assert.equal(isUrlSwapRegression({ newUrl: old, show: { ...show, tourLegs: [{ startDate: '2024-01-10', endDate: '2024-06-01' }] }, outletId: 'deadline' }).regression, false);
  assert.equal(isUrlSwapRegression({ newUrl: 'https://deadline.com/2026/10/x-review-1/', show, outletId: 'deadline' }).regression, false);
  assert.equal(isUrlSwapRegression({ newUrl: old, show: {}, outletId: 'deadline' }).regression, false);
});

test('a Talkin\' Broadway forum announcement thread is never an upgrade target', () => {
  const r = isUrlSwapRegression({ newUrl: 'https://www.talkinbroadway.com/allthatchat_new/d.php?id=2654485', show: {}, outletId: 'talkinbroadway' });
  assert.equal(r.regression, true);
  assert.equal(r.issue, 'forum-thread-url');
  // the real review page shape is fine
  assert.equal(isUrlSwapRegression({ newUrl: 'https://www.talkinbroadway.com/page/ob/10_09_26.html', show: {}, outletId: 'talkinbroadway' }).regression, false);
});
