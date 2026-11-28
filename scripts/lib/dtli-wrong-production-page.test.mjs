// BRO-8266: galileo-2026 (Broadway revival, previews 2026-11-10) was mapped to
// the DTLI page of the 2012 Classic Stage Company production. Every assertion
// require()s the production code (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dtliPageWrongProduction } = require('./dtli-page-year-gate.js');
const { findWrongYearMappings, isLiveWindowShow } = require('./dtli-slug-revalidate.js');
const { otherProductionSignal, INGEST_SIGNALS, INGEST_DATE_GAP_DAYS } = require('./other-production-signal.js');

const GALILEO = { id: 'galileo-2026', title: 'Galileo', category: 'broadway', status: 'previews', previewsStartDate: '2026-11-10', openingDate: '2026-12-06' };
const page = (...dates) => `<h1>Galileo</h1>` + dates.map(d => `<div class="review-item"><div class="review-item-date">${d}</div></div>`).join('');

test('page gate rejects a page whose dated reviews are all from 2012', () => {
  const g = dtliPageWrongProduction(page('February 24, 2012', 'February 23, 2012'), GALILEO);
  assert.equal(g.wrong, true);
  assert.equal(g.showYear, 2026);
});

test('page gate keeps current, mixed and empty pages', () => {
  assert.equal(dtliPageWrongProduction(page('December 7, 2026'), GALILEO).wrong, false);
  assert.equal(dtliPageWrongProduction(page('February 24, 2012', 'December 7, 2026'), GALILEO).wrong, false);
  assert.equal(dtliPageWrongProduction('<h1>Galileo</h1>', GALILEO).wrong, false);
});

test('revalidation finds the wrong mapping, skips closed shows and unprobed pages', async () => {
  const shows = new Map([
    ['galileo-2026', GALILEO],
    ['old-2012', { id: 'old-2012', status: 'closed', openingDate: '2012-03-01' }],
    ['flaky-2026', { id: 'flaky-2026', status: 'open', openingDate: '2026-05-01' }],
    ['good-2026', { id: 'good-2026', status: 'open', openingDate: '2026-05-01' }],
  ]);
  const pages = { galileo: page('February 24, 2012'), 'old-slug': page('2000'), good: page('May 2, 2026') };
  const probed = [];
  const res = await findWrongYearMappings(
    { 'galileo-2026': 'galileo', 'old-2012': 'old-slug', 'flaky-2026': 'flaky', 'good-2026': 'shows/good' },
    shows,
    async (slug) => { probed.push(slug); return pages[slug] ? { ok: true, body: pages[slug] } : null; },
    { include: isLiveWindowShow },
  );
  assert.deepEqual(res.wrong.map(w => w.showId), ['galileo-2026']);
  assert.deepEqual(res.unprobed, ['flaky-2026']);
  assert.ok(!probed.includes('old-slug'), 'closed show is not probed');
  assert.ok(probed.includes('good'), 'shows/ prefix is stripped');
});

test('ingest gate drops a yearless-URL review dated 14 years before previews', () => {
  const opts = { only: INGEST_SIGNALS, minDateGapDays: INGEST_DATE_GAP_DAYS };
  const timeout = { outletId: 'timeout', url: 'http://newyork.timeout.com/arts-culture/theater/2705235/review-galileo', publishDate: '2012-02-24' };
  assert.equal(otherProductionSignal(timeout, GALILEO, opts)?.signal, 'date-before-production');
  // a date months early (aggregator error) is not dropped at ingest
  assert.equal(otherProductionSignal({ ...timeout, publishDate: '2026-02-01' }, GALILEO, opts), null);
  // a declared prior run still covers older dates
  const withPrior = { ...GALILEO, priorRuns: [{ openingDate: '2012-02-01', closingDate: '2012-04-01' }] };
  assert.equal(otherProductionSignal(timeout, withPrior, opts), null);
});
