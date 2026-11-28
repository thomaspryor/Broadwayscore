/**
 * BRO-4272: audit-show-review-gap.js now files an 'auto' card when a Broadway /
 * off-Broadway show in its first 3 days still has roundup-cited reviews missing
 * after auto-ingest, and looks up the Playbill Verdict article for shows in the
 * category page's 30-day window. require()s the real functions (CLAUDE.md §15).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planRoundupGapAlerts, isInVerdictWindow } = require('../../scripts/audit-show-review-gap.js');

const NOW = Date.parse('2026-09-29T06:40:00Z');

function result(over = {}) {
  return {
    showId: 'school-girls-or-the-african-mean-girls-play-2026',
    title: 'School Girls; Or, The African Mean Girls Play',
    category: 'broadway',
    openingDate: '2026-09-28',
    missing: [],
    flaggedMisses: [],
    ingestResults: [],
    ...over,
  };
}

test('School Girls night: failed ingests after auto-ingest → alert, prior-run rows left out of the card', () => {
  const r = result({
    missing: [
      { url: 'https://culturesauce.com/school-girls-african-mean-girls-play-broadway-review/', host: 'culturesauce.com', knownOutletId: 'culturesauce' },
      { url: 'http://www.vulture.com/2017/11/theater-school-girls.html', host: 'vulture.com', knownOutletId: 'vulture', priorRun: true },
    ],
    ingestResults: [{ url: 'https://culturesauce.com/school-girls-african-mean-girls-play-broadway-review/', ok: false, reason: 'crossShowUrl' }],
  });
  const plan = planRoundupGapAlerts([r], true, NOW);
  assert.equal(plan.alert.length, 1);
  assert.equal(plan.alert[0].counts.residual, 1);
  assert.deepEqual(plan.alert[0].missing.map((m) => m.knownOutletId), ['culturesauce']);
  assert.deepEqual(plan.resolve, []);
});

test('no residual after ingest, roundups found → resolve, no alert', () => {
  const r = result({
    aggregatorArticles: ['https://playbill.com/article/reviews-are-out-for-school-girls-or-the-african-mean-girls-play-on-broadway'],
    missing: [{ url: 'https://x.com/a', host: 'x.com' }],
    ingestResults: [{ url: 'https://x.com/a', ok: true }],
  });
  const plan = planRoundupGapAlerts([r], true, NOW);
  assert.deepEqual(plan.alert, []);
  assert.deepEqual(plan.resolve, [r.showId]);
});

test('no roundup found this run (discovery miss) → neither alert nor resolve', () => {
  const plan = planRoundupGapAlerts([result({ aggregatorArticles: [] })], true, NOW);
  assert.deepEqual(plan, { alert: [], resolve: [] });
});

test('without --ingest-missing, uningested current-run URLs count as residual', () => {
  const r = result({ missing: [{ url: 'https://x.com/a', host: 'x.com' }] });
  assert.equal(planRoundupGapAlerts([r], false, NOW).alert.length, 1);
});

test('out of scope: West End, older than 3 days, not yet opened, no opening date', () => {
  const gap = { missing: [{ url: 'https://x.com/a', host: 'x.com' }] };
  const plan = planRoundupGapAlerts([
    result({ ...gap, category: 'west-end' }),
    result({ ...gap, openingDate: '2026-09-20' }),
    result({ ...gap, openingDate: '2026-10-05' }),
    result({ ...gap, openingDate: null }),
  ], false, NOW);
  assert.deepEqual(plan, { alert: [], resolve: [] });
});

test('off-Broadway in window is in scope (audit alert covers OB even though the SERP sweep does not)', () => {
  const plan = planRoundupGapAlerts([result({ category: 'off-broadway', missing: [{ url: 'https://x.com/a', host: 'x.com' }] })], false, NOW);
  assert.equal(plan.alert.length, 1);
});

test('Verdict lookup window: opened within 30 days (or opening tomorrow)', () => {
  assert.equal(isInVerdictWindow({ openingDate: '2026-09-28' }, NOW), true);
  assert.equal(isInVerdictWindow({ openingDate: '2026-09-30' }, NOW), true);
  assert.equal(isInVerdictWindow({ openingDate: '2026-08-15' }, NOW), false);
  assert.equal(isInVerdictWindow({ openingDate: '2026-10-10' }, NOW), false);
  assert.equal(isInVerdictWindow({}, NOW), false);
});
