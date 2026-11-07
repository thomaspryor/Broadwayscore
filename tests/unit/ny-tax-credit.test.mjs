// NY tax credit amounts the recoupment models count (BRO-5517): a published
// ESD award wins over the formula, and the formula is the one refitted to
// those awards. Tests the real modules via require().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

const {
  nyTaxCredit, formulaCredit, taxCreditNoteConflicts, RECEIVED, ALLOCATED, LISTS_AS_OF, TAX_CREDIT_MAX, QUALIFYING_WEEKS,
} = require('../../scripts/lib/ny-tax-credit');
const { calculateRecoupment, calculateLifetimeRecoupment } = require('../../scripts/lib/recoupment-model');

const formulaArgs = { notesCredit: null, eligible: true, capitalization: 4_000_000, qualifyingRunningCosts: 6_000_000 };

test('an ESD payment wins over notes, an allocation and the formula', () => {
  assert.deepEqual(nyTaxCredit({ ...formulaArgs, slug: 'appropriate', notesCredit: 0 }), { amount: 1_720_089, basis: 'received', received: true });
});

test('notes beat an allocation; an allocation beats the formula', () => {
  assert.deepEqual(nyTaxCredit({ ...formulaArgs, slug: 'stereophonic', notesCredit: 0 }), { amount: 0, basis: 'notes', received: false });
  assert.deepEqual(nyTaxCredit({ ...formulaArgs, slug: 'stereophonic' }), { amount: 1_772_703, basis: 'allocated', received: false });
  assert.deepEqual(nyTaxCredit({ ...formulaArgs, slug: 'no-such-show' }), { amount: 1_300_000, basis: 'formula', received: false });
});

test('nothing outside the program, even for a show that was paid later (a backtest replayed before 2021)', () => {
  assert.deepEqual(nyTaxCredit({ ...formulaArgs, slug: 'no-such-show', eligible: false }), { amount: 0, basis: 'ineligible', received: false });
  assert.deepEqual(nyTaxCredit({ ...formulaArgs, slug: 'dear-evan-hansen-2016', eligible: false }), { amount: 0, basis: 'ineligible', received: false });
});

test('a payment counts as received only from its payout date; before it, as an allocation', () => {
  // The Outsiders: $3M paid May 22 2025.
  const at = (iso) => nyTaxCredit({ ...formulaArgs, slug: 'the-outsiders', now: Date.parse(iso) });
  assert.deepEqual(at('2025-01-01'), { amount: 3_000_000, basis: 'allocated', received: false });
  assert.deepEqual(at('2025-05-22'), { amount: 3_000_000, basis: 'received', received: true });
  // Glengarry Glen Ross: paid "$2.7 million" by Jun 2 2026 (Bloomberg Tax).
  // Before that date the same amount counts, as an allocation.
  const glengarry = (iso) => nyTaxCredit({ ...formulaArgs, slug: 'glengarry-glen-ross-2025', now: Date.parse(iso) });
  assert.deepEqual(glengarry('2026-06-01'), { amount: 2_700_000, basis: 'allocated', received: false });
  assert.deepEqual(glengarry('2026-06-02'), { amount: 2_700_000, basis: 'received', received: true });
});

test('a payout with its earlier allocation (BRO-6218): the allocation before the payout date, the payout from it', () => {
  const at = (slug, iso) => nyTaxCredit({ ...formulaArgs, slug, now: Date.parse(iso) });
  assert.deepEqual(at('tammy-faye-2024', '2025-09-01'), { amount: 3_000_000, basis: 'allocated', received: false });
  assert.deepEqual(at('tammy-faye-2024', '2026-03-19'), { amount: 2_500_000, basis: 'received', received: true });
  assert.deepEqual(at('lempicka', '2025-09-01'), { amount: 3_000_000, basis: 'allocated', received: false });
  assert.deepEqual(at('lempicka', '2026-10-25'), { amount: 2_600_000, basis: 'received', received: true });
});

test('the refit formula: 13% of the cap plus qualifying running costs, capped at $3M', () => {
  assert.equal(formulaCredit(4_000_000, 6_000_000), 1_300_000);
  assert.equal(formulaCredit(20_000_000, 30_000_000), 3_000_000);
  assert.equal(formulaCredit(4_000_000, -1), 520_000);
  assert.equal(formulaCredit(null, null), 0);
  assert.equal(QUALIFYING_WEEKS, 39);
});

test('notes conflicts: an amount next to "tax credit" more than 10% off the award, or a bound the award breaks', () => {
  const c = (slug, notes) => taxCreditNoteConflicts(slug, notes).map(({ bound, noted, counted }) => [bound, noted, counted]);
  // Glengarry Glen Ross: $2.7M counted.
  assert.deepEqual(c('glengarry-glen-ross-2025', 'Expected ~$1.9M NY state tax credit (25% of costs).'), [['', 1_900_000, 2_700_000]]);
  assert.deepEqual(c('glengarry-glen-ross-2025', 'Received $2.6M NY tax credit.'), []);
  assert.deepEqual(c('glengarry-glen-ross-2025', 'Paid a tax credit of $2.7 million.'), []);
  assert.deepEqual(c('glengarry-glen-ross-2025', 'tax credit: $800K'), [['', 800_000, 2_700_000]]);
  assert.deepEqual(c('glengarry-glen-ross-2025', 'tax credit: $1,900,000'), [['', 1_900_000, 2_700_000]]);
  assert.deepEqual(c('glengarry-glen-ross-2025', '$1,900,000 in NYC tax credit receipts'), [['', 1_900_000, 2_700_000]]);
  // No unit and under 1,000 reads as millions, as parseTaxCreditFromNotes does.
  assert.deepEqual(c('glengarry-glen-ross-2025', 'a $2 tax credit'), [['', 2_000_000, 2_700_000]]);
  // One amount written twice reports once.
  assert.deepEqual(c('glengarry-glen-ross-2025', 'Expected ~$1.9MM tax credit; tax credit of $1.9 mil.'), [['', 1_900_000, 2_700_000]]);
  // Bounds against a $3M allocation (Dead Outlaw; Romeo + Juliet) and a payout (Tammy Faye, $2.5M).
  assert.deepEqual(c('dead-outlaw-2025', 'Paid more than $2 million in NY tax credit by Jun 2026.'), []);
  assert.deepEqual(c('dead-outlaw-2025', 'Paid more than $3.5M NY tax credit.'), [['more than', 3_500_000, 3_000_000]]);
  assert.deepEqual(c('tammy-faye-2024', 'Paid more than $2 million in NY tax credit by Jun 2026.'), []);
  assert.deepEqual(c('tammy-faye-2024', 'Expected a $3M tax credit.'), [['', 3_000_000, 2_500_000]]);
  assert.deepEqual(c('romeo-juliet-2024', 'Eligible for up to $1.75M tax credit.'), [['up to', 1_750_000, 3_000_000]]);
  assert.deepEqual(c('romeo-juliet-2024', 'Eligible for up to $3M tax credit.'), []);
  // An amount that is not the credit; a show with no award; no notes.
  assert.deepEqual(c('purpose-2025', 'Recouped its $5.25M capitalization, helped by the revived NY State Broadway tax credit.'), []);
  assert.deepEqual(c('no-such-show', 'Expected ~$1.9M tax credit.'), []);
  assert.deepEqual(c('glengarry-glen-ross-2025', null), []);
  assert.match(taxCreditNoteConflicts('romeo-juliet-2024', 'Eligible for up to $1.75M tax credit.')[0].message,
    /^notes give a tax credit of up to \$1\.75M, but the award counted is \$3\.00M /);
});

test('award tables: whole dollars up to the $3M cap, dated payouts, no show on both lists', () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [slug, [amt, paid, allocated]] of Object.entries(RECEIVED)) {
    assert.ok(Number.isInteger(amt) && amt > 0 && amt <= TAX_CREDIT_MAX, `${slug}: ${amt}`);
    assert.ok(allocated === undefined || (Number.isInteger(allocated) && allocated > 0 && allocated <= TAX_CREDIT_MAX), `${slug}: allocated ${allocated}`);
    // ESD's first payout was Aug 4 2022; a payment cannot be dated after today.
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(paid) && paid >= '2022-08-04' && paid <= today, `${slug}: ${paid}`);
  }
  for (const [slug, amt] of Object.entries(ALLOCATED)) assert.ok(Number.isInteger(amt) && amt > 0 && amt <= TAX_CREDIT_MAX, `${slug}: ${amt}`);
  assert.deepEqual(Object.keys(RECEIVED).filter((k) => k in ALLOCATED), []);
});

// The models look these tables up by show.slug || show.id. search-shows.json is
// committed, so this runs in CI; data/commercial.json is checked when present.
// Each key must name the production that was paid: it opened before the payout
// (or, for an allocation, before the lists' date), so a bare slug that later
// passes to a new revival (death-of-a-salesman is now the 2026 production)
// fails here instead of moving the award.
test('every award key names the production that was paid', () => {
  const shows = JSON.parse(fs.readFileSync(new URL('../../public/data/search-shows.json', import.meta.url), 'utf8'));
  const byKey = new Map();
  for (const s of Array.isArray(shows) ? shows : shows.shows) byKey.set(s.slug || s.id, s);
  const late = [];
  for (const [k, [, paid]] of Object.entries(RECEIVED)) { const s = byKey.get(k); if (!s) late.push(`${k}: no show`); else if (!s.od || s.od > paid) late.push(`${k}: opened ${s.od}, paid ${paid}`); }
  for (const k of Object.keys(ALLOCATED)) { const s = byKey.get(k); if (!s) late.push(`${k}: no show`); else if (!s.od || s.od > LISTS_AS_OF) late.push(`${k}: opened ${s.od}, allocated by ${LISTS_AS_OF}`); }
  assert.deepEqual(late, []);
  const commercialPath = new URL('../../data/commercial.json', import.meta.url);
  if (fs.existsSync(commercialPath)) {
    const records = JSON.parse(fs.readFileSync(commercialPath, 'utf8')).shows;
    assert.deepEqual([...Object.keys(RECEIVED), ...Object.keys(ALLOCATED)].filter((k) => !records[k]), [], 'no commercial.json record');
  }
});

function weeklyGrosses(weeks, gross, start = '2024-04-07') {
  const out = {};
  const t0 = Date.parse(start);
  for (let i = 0; i < weeks; i++) out[new Date(t0 + i * 7 * 86400000).toISOString().slice(0, 10)] = { gross };
  return out;
}

test('weekly model: a closed show counts its ESD allocation, not the $3M formula', () => {
  const show = { slug: 'stereophonic', title: 'Stereophonic', type: 'play', venue: 'John Golden Theatre', previewsStartDate: '2024-04-02', openingDate: '2024-04-19', closingDate: '2025-01-12' };
  const r = calculateRecoupment(show, { capitalization: 4_800_000, weeklyRunningCost: 530_000 }, null, weeklyGrosses(40, 1_100_000));
  assert.equal(r.taxCreditAmount, 1_772_703);
});

test('weekly model: a show with no award gets the refit formula', () => {
  // A 15-week run window (previews Apr 2 to closing Jul 14): 13% x ($4M + 15 x $400K).
  const show = { slug: 'unlisted-play', title: 'Unlisted Play', type: 'play', venue: 'John Golden Theatre', previewsStartDate: '2024-04-02', openingDate: '2024-04-19', closingDate: '2024-07-14' };
  const r = calculateRecoupment(show, { capitalization: 4_000_000, weeklyRunningCost: 400_000 }, null, weeklyGrosses(15, 700_000));
  assert.equal(r.taxCreditAmount, 1_300_000);
});

test('weekly model replayed before the program counts no credit for a show paid later', () => {
  const deh = { slug: 'dear-evan-hansen-2016', title: 'Dear Evan Hansen', type: 'musical', venue: 'Music Box Theatre', previewsStartDate: '2016-11-14', openingDate: '2016-12-04', closingDate: '2022-09-18' };
  const r = calculateRecoupment(deh, { capitalization: 10_000_000, weeklyRunningCost: 650_000 }, null, weeklyGrosses(30, 1_200_000, '2016-11-20'), { asOf: '2017-07-01' });
  assert.equal(r.taxCreditAmount, 0);
});

test('"% returned so far" run: an ESD payment counts as cited for a running show; an allocation does not', () => {
  const running = (slug) => ({ slug, title: slug, type: 'musical', venue: 'Broadhurst Theatre', previewsStartDate: '2024-03-16', openingDate: '2024-04-11' });
  const opts = { taxCreditCitedOnly: true };
  const paid = calculateRecoupment(running('the-outsiders'), { capitalization: 22_000_000, weeklyRunningCost: 800_000 }, null, weeklyGrosses(100, 1_400_000), opts);
  assert.equal(paid.taxCreditExcluded, 0);
  const allocated = calculateRecoupment(running('operation-mincemeat'), { capitalization: 22_000_000, weeklyRunningCost: 800_000 }, null, weeklyGrosses(100, 1_400_000), opts);
  assert.equal(allocated.taxCreditExcluded, 3_000_000);
});

test('lifetime model: an ESD payment replaces the formula', () => {
  const r = calculateLifetimeRecoupment({ slug: 'jagged-little-pill-2019', title: 'Jagged Little Pill', type: 'musical', openingDate: '2019-12-05', closingDate: '2021-12-17' }, { capitalization: 14_000_000, weeklyRunningCost: 650_000 }, { gross: 60_000_000 });
  assert.equal(r.taxCreditAmount, 2_161_741);
});
