/**
 * Box Office Scorecard v2 (BRO-5007): the card's words. Pure helpers plus a
 * real-data sweep so no running show prints a banned source word.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  basisLine,
  chartMode,
  costPill,
  coverTiles,
  multipleTicks,
  shortSource,
  streakText,
  toBoxOfficeV2Card,
  trendText,
} from '../../src/lib/box-office-v2-display';
import { getRunningBoxOfficeV2 } from '../../src/lib/data-commercial';

test('costPill: bands and special states', () => {
  assert.deepEqual(costPill({ availability: 'ok', band: 'below', closingDate: null }), { label: 'Below Cost', tone: 'below' });
  assert.deepEqual(costPill({ availability: 'ok', band: 'well-above', closingDate: null }), { label: 'Well Above Cost', tone: 'above' });
  assert.deepEqual(costPill({ availability: 'ok', band: 'near', closingDate: null }), { label: 'Near Cost', tone: 'near' });
  assert.equal(costPill({ availability: 'nocost', band: null, closingDate: null }).label, 'No cost estimate yet');
  assert.equal(costPill({ availability: 'early', band: null, closingDate: '2027-01-17' }).label, 'Too early');
  assert.equal(costPill({ availability: 'closed', band: null, closingDate: '2026-09-20' }).label, 'Closed Sep 20');
  assert.equal(costPill({ availability: 'closing', band: 'below', closingDate: '2026-10-25' }).label, 'Closing Oct 25');
});

test('basisLine: reported names its source, an estimate never does', () => {
  assert.equal(basisLine({ costBasis: 'reported', breakEven: 1_083_717, costSourceText: 'Variety' }), 'Break-even $1,084K/week (Variety)');
  assert.equal(basisLine({ costBasis: 'estimate', breakEven: 820_976, costSourceText: 'Variety' }), 'Est. break-even $821K/week');
  assert.equal(basisLine({ costBasis: null, breakEven: null, costSourceText: null }), null);
  // The quote's figure is an expense line, not the break-even: print outlet and date only.
  assert.equal(
    basisLine({ costBasis: 'reported', breakEven: 718_000, costSourceText: 'Broadway Journal (Apr 25, 2018): fixed expenses averaged $643,000 a week' }),
    'Break-even $718K/week (Broadway Journal, Apr 25, 2018)',
  );
  assert.equal(shortSource('Forbes (Nov 17, 2025): fixed weekly operating costs of $480,577'), 'Forbes, Nov 17, 2025');
});

test('streak, trend and chart mode text', () => {
  assert.equal(streakText({ side: 'below', weeks: 19, atLeast: false }), '19 straight weeks below cost');
  assert.equal(streakText({ side: 'above', weeks: 52, atLeast: true }), 'at least 52 straight weeks above cost');
  assert.equal(streakText({ side: 'above', weeks: 1, atLeast: false }), null, 'one week is not a streak');
  assert.equal(trendText('steady'), '→ steady');
  assert.equal(trendText('unknown'), null);
  assert.equal(chartMode([{ week: '2026-10-04', gross: 1, multiple: null, market: null }]), 'gross');
  assert.equal(chartMode([{ week: '2026-10-04', gross: 1, multiple: 1.2, market: 1.1 }]), 'multiple');
  assert.equal(chartMode([]), 'none');
});

test('multipleTicks: evenly spaced for every chart max, 1x labeled', () => {
  assert.deepEqual(multipleTicks(8), [0, 1, 2, 3, 4, 5, 6, 7, 8], 'Hamilton: no skipped 7');
  assert.deepEqual(multipleTicks(2.5), [0, 0.5, 1, 1.5, 2, 2.5]);
  assert.deepEqual(multipleTicks(12), [0, 2, 4, 6, 8, 10, 12]);
  for (const max of [1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12]) {
    const t = multipleTicks(max);
    const gaps = new Set(t.slice(1).map((v, i) => Math.round((v - t[i]) * 10) / 10));
    assert.equal(gaps.size, 1, `max ${max}: uneven ticks ${t.join(',')}`);
    assert.equal(t[t.length - 1], max, `max ${max}: top tick is the axis max`);
    if (max <= 8) assert.ok(t.includes(1), `max ${max}: 1x unlabeled`);
  }
});

test('coverTiles: only when short of cost', () => {
  const base = { avgGross: 703_074, breakEven: 820_976, shortBy: 117_902, ticketNeeded: 125.97, ticketNow: 107.9, capacityNeeded: 97.8, capacityNow: 83.7 };
  const t = coverTiles(base);
  assert.deepEqual(t.map((x) => x.value), ['$118K', '$126 avg ticket', '98% full']);
  assert.deepEqual(coverTiles({ ...base, shortBy: 0 }), []);
  assert.equal(coverTiles({ ...base, capacityNeeded: 131 })[2].value, 'more than a full house');
  // The 'now' figures are 4-week averages, so they never read as this week's tiles.
  assert.deepEqual(t.map((x) => x.detail).slice(1), ['4-wk avg $108', '4-wk avg 84%']);
  assert.ok(t.every((x) => !/\bnow\b/i.test(x.detail + x.phoneDetail)), 'no tile says now');
  assert.deepEqual(coverTiles(null), []);
});

test('real data: no card prints a banned source word, and the client card drops report-only fields', () => {
  const rows = getRunningBoxOfficeV2();
  assert.ok(rows.length >= 10);
  for (const r of rows) {
    const card = toBoxOfficeV2Card(r);
    assert.ok(!('noCostReason' in card) && !('quality' in card), `${r.slug}: report-only fields reached the client`);
    const printed = [basisLine(card), card.story, costPill(card).label].filter(Boolean).join(' ').toLowerCase();
    assert.ok(!/reddit|industry estimate|industry-estimate|deep-research/.test(printed), `${r.slug}: "${printed}"`);
    // The story is built before the basis is known; the label and badge carry
    // reported vs estimate, so the story must not name either (Hamilton bug).
    assert.ok(!/estimated|reported/i.test(card.story ?? ''), `${r.slug}: story names a basis: "${card.story}"`);
    // A printed source never carries a second dollar figure next to the break-even.
    const basis = basisLine(card) ?? '';
    assert.ok((basis.match(/\$/g) ?? []).length <= 1, `${r.slug}: two dollar figures in "${basis}"`);
  }
});
