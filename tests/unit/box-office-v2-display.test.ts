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
  costStatusCell,
  coverTiles,
  formatMillions,
  multipleTicks,
  nearNote,
  outletAndMonth,
  statusCounts,
  shortSource,
  streakText,
  toBoxOfficeV2Card,
  trendText,
} from '../../src/lib/box-office-v2-display';
import { getRunningBoxOfficeV2, getBoxOfficeCostCoverage } from '../../src/lib/data-commercial';
import { pinBoxOfficeClockToData } from '../helpers/box-office-data-clock';
import { formatShare } from '../../src/lib/box-office-v2-display';
import CostCoverageCard from '../../src/components/box-office/CostCoverageCard';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// tsx compiles JSX with the classic runtime, which needs React in scope.
(globalThis as unknown as { React: typeof React }).React = React;

// Real-data tests check card shape, not wall-clock freshness (BRO-5202).
pinBoxOfficeClockToData();

test('costPill: bands and special states', () => {
  assert.deepEqual(costPill({ availability: 'ok', band: 'below', closingDate: null }), { label: 'Below Break-even', tone: 'below' });
  assert.deepEqual(costPill({ availability: 'ok', band: 'well-above', closingDate: null }), { label: 'Well Above Break-even', tone: 'above' });
  assert.deepEqual(costPill({ availability: 'ok', band: 'near', closingDate: null }), { label: 'Near Break-even', tone: 'near' });
  assert.equal(costPill({ availability: 'nocost', band: null, closingDate: null }).label, 'No cost estimate yet');
  assert.equal(costPill({ availability: 'early', band: null, closingDate: '2027-01-17' }).label, 'Too early');
  assert.equal(costPill({ availability: 'closed', band: null, closingDate: '2026-09-20' }).label, 'Closed Sep 20');
  assert.equal(costPill({ availability: 'closing', band: 'below', closingDate: '2026-10-25' }).label, 'Closing Oct 25');
});

test('basisLine: reported names its source, an estimate never does', () => {
  assert.equal(basisLine({ costBasis: 'reported', breakEven: 1_083_717, costSourceText: 'Variety' }), 'Break-even $1,084K/week (Variety)');
  assert.equal(basisLine({ costBasis: 'estimate', breakEven: 820_976, costSourceText: null }), 'Est. break-even $821K/week', 'model-only estimates stay uncited');
  // A floor quote is an estimate from a named outlet: outlet and month, never the quote.
  assert.equal(
    basisLine({ costBasis: 'estimate', breakEven: 1_083_717, costSourceText: 'Broadway Journal (Nov 17, 2023): weekly costs exceeding $1 million' }),
    'Est. break-even $1,084K/week · based on Broadway Journal (Nov 2023)',
  );
  assert.equal(outletAndMonth('Variety (2025-06-09): running costs top $900,000'), 'Variety (Jun 2025)');
  assert.equal(outletAndMonth('Variety'), 'Variety');
  assert.equal(basisLine({ costBasis: null, breakEven: null, costSourceText: null }), null);
  // The quote's figure is an expense line, not the break-even: print outlet and date only.
  assert.equal(
    basisLine({ costBasis: 'reported', breakEven: 718_000, costSourceText: 'Broadway Journal (Apr 25, 2018): fixed expenses averaged $643,000 a week' }),
    'Break-even $718K/week (Broadway Journal, Apr 25, 2018)',
  );
  assert.equal(shortSource('Forbes (Nov 17, 2025): fixed weekly operating costs of $480,577'), 'Forbes, Nov 17, 2025');
});

test('nearNote: explains a Near that comes only from the range crossing 1x', () => {
  const n = (lo: number, mid: number, hi: number, band = 'near') => nearNote({ availability: 'ok', band: band as 'near', multiple: { lo, mid, hi } });
  assert.match(n(0.71, 0.86, 1.07)!, /rather than Below/);
  assert.match(n(0.9, 1.12, 1.3)!, /rather than Above/);
  assert.equal(n(0.9, 1.0, 1.1), null, 'a multiple near 1x needs no explaining');
  assert.equal(n(1.4, 1.6, 1.8), null, 'an at-risk demotion is not a range straddle');
  assert.equal(n(0.6, 0.8, 1.1, 'below'), null);
});

test('streak, trend and chart mode text', () => {
  assert.equal(streakText({ side: 'below', weeks: 19, atLeast: false }), '19 straight weeks below break-even');
  assert.equal(streakText({ side: 'above', weeks: 52, atLeast: true }), 'at least 52 straight weeks above break-even');
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

test('coverTiles: only when short of break-even', () => {
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
    // An estimate cites a source only for a floor quote from a named outlet.
    if (card.costBasis === 'estimate' && card.costSourceText) {
      assert.match(basisLine(card) ?? '', /· based on [A-Z]/, `${r.slug}: estimate citation format`);
    }
    // A printed source never carries a second dollar figure next to the break-even.
    const basis = basisLine(card) ?? '';
    assert.ok((basis.match(/\$/g) ?? []).length <= 1, `${r.slug}: two dollar figures in "${basis}"`);
  }
});

// ---- /box-office (Phase 3) ----

type Card = NonNullable<Parameters<typeof costStatusCell>[0]>;
const card = (over: Partial<Record<keyof Card, unknown>>): Card => ({
  availability: 'ok', band: 'near', closingDate: null, multiple: { lo: 0.82, mid: 0.86, hi: 0.9 },
  trend: 'declining', nonprofit: false, title: 'X', slug: 'x', ...over,
}) as Card;

test('formatMillions: one decimal', () => {
  assert.equal(formatMillions(2_704_000), '$2.7M');
});

test('costStatusCell: rated rows get multiple, range and trend; others a dash', () => {
  assert.deepEqual(costStatusCell(card({})), { label: 'Near Break-even', tone: 'near', arrow: '↓', multiple: '0.86×', range: '0.82–0.90', sortValue: 0.86, statusSort: 20.086 });
  assert.equal(costStatusCell(card({ trend: 'unknown' })).arrow, null);
  assert.deepEqual(costStatusCell(undefined), { label: 'No estimate yet', tone: 'pending', arrow: null, multiple: null, range: null, sortValue: null, statusSort: 1 });
  assert.equal(costStatusCell(card({ availability: 'nocost', band: null, multiple: null, nonprofit: true })).label, 'Nonprofit · no estimate');
  const early = costStatusCell(card({ availability: 'early', band: null }));
  assert.equal(early.label, 'Too early');
  assert.equal(early.multiple, null, 'no multiple without a status');
});

test('Status sorts by band first: a demoted at-risk show stays with Near Break-even whatever its multiple', () => {
  const s = (over: Partial<Record<keyof Card, unknown>>) => costStatusCell(card(over)).statusSort;
  const demoted = s({ band: 'near', multiple: { lo: 1.4, mid: 1.6, hi: 1.8 } });
  assert.ok(s({ band: 'above', multiple: { lo: 1.05, mid: 1.1, hi: 1.2 } }) > demoted);
  assert.ok(demoted > s({ band: 'near', multiple: { lo: 0.7, mid: 0.86, hi: 1.07 } }), 'multiple breaks ties inside a band');
  assert.ok(s({ band: 'below', multiple: { lo: 0.5, mid: 0.6, hi: 0.7 } }) > s({ availability: 'early', band: null }));
  assert.ok(s({ band: 'well-above', multiple: { lo: 9, mid: 12, hi: 15 } }) < 50, 'a huge multiple cannot jump a band');
});

test('statusCounts: four bands in order, unrated grouped by reason', () => {
  const c = statusCounts([
    card({ title: 'Ham', band: 'well-above' }), card({ title: 'MHE' }), card({ title: 'ST', band: 'below' }),
    card({ title: 'TLK', availability: 'nocost', band: null }), card({ title: 'RH', availability: 'nocost', band: null, nonprofit: true }),
    card({ title: 'ODC', availability: 'early', band: null }), card({ title: 'Fin', availability: 'closing', band: null }),
  ]);
  assert.deepEqual(c.groups.map((g) => [g.label, g.titles]), [['Well Above Break-even', ['Ham']], ['Above Break-even', []], ['Near Break-even', ['MHE']], ['Below Break-even', ['ST']]]);
  assert.equal(c.rated, 3);
  assert.deepEqual([c.noEstimate, c.nonprofitNoEstimate, c.early, c.closing], [['TLK'], ['RH'], ['ODC'], ['Fin']]);
  // Shows with no commercial record at all still get named under "Not rated".
  const u = statusCounts([card({ title: 'Ham', band: 'well-above' })], [{ title: 'AFGM', inPreviews: true }, { title: 'Open', inPreviews: false }]);
  assert.deepEqual([u.rated, u.early, u.noEstimate], [1, ['AFGM'], ['Open']]);
});

test('real data: cost coverage puts every running Broadway show in exactly one bucket', () => {
  const cov = getBoxOfficeCostCoverage();
  assert.ok(cov, 'coverage is null (stale inputs?)');
  const c = cov.counts;
  const all = [...c.groups.flatMap((g) => g.titles), ...c.noEstimate, ...c.nonprofitNoEstimate, ...c.early, ...c.closing];
  assert.equal(new Set(all).size, all.length, 'a show sits in two buckets');
  assert.ok(c.rated >= 5, `only ${c.rated} rated`);
  for (const g of c.groups) for (const t of g.titles) assert.ok(cov.shares[t] > 0, `${t} is rated but has no share of break-even`);
  // The card prints shares of break-even, never multiples.
  const html = renderToStaticMarkup(React.createElement(CostCoverageCard, { counts: c, shares: cov.shares }));
  assert.match(html, /100%\s+means just covering its costs/);
  assert.doesNotMatch(html, /\d×/);
  const first = c.groups.find((g) => g.titles.length)!.titles[0];
  assert.ok(html.includes(`>${formatShare(cov.shares[first])}<`), `${first} shows its share`);
});
