// BRO-8259: settleRunDates must hold a season row whose own production page prints the same run in a
// different year (a past production the season-page LLM re-dated), and keep its old behaviour otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('./city-season.js');

const row = (start, end) => ({ title: 'Life & Times of Michael K', theatre: 'ArtsEmerson', start, end, source: 'theatre-season-page' });

test('page prints the same run two years earlier: held (Michael K, ArtsEmerson "Past Event")', () => {
  const text = 'Past Event Jan 31—Feb 09, 2025 Life & Times of Michael K Get Tickets ... Dates Jan 31, 2025 - Feb 09, 2025';
  const r = row('2027-01-31', '2027-02-09');
  const range = S.runRangeFromShowPage(text, { year: 2027 });
  assert.equal(range.first, '2025-01-31');
  assert.equal(range.end, '2025-02-09');
  const out = S.settleRunDates(r, range, 'https://artsemerson.org/events/life-times-of-michael-k/');
  assert.match(out.held, /in 2025/);
  assert.equal(out.row.start, '2027-01-31');
});

test('page prints this run in the same year: page dates win, nothing held', () => {
  const text = 'GRIM Extended! Oct 27 – Dec 13, 2026';
  const r = { ...row('2026-11-27', '2026-12-13'), title: 'GRIM' };
  const range = S.runRangeFromShowPage(text, { year: 2026 });
  const out = S.settleRunDates(r, range, 'https://lajollaplayhouse.org/show/grim/');
  assert.equal(out.held, null);
  assert.equal(out.row.end, '2026-12-13');
  assert.equal(out.row.source, 'theatre-show-page');
});

test('sidebar for another show (different days, same year): range dropped, row kept as is', () => {
  const r = { ...row('2027-01-06', '2027-01-31'), title: 'Vineland Place' };
  const range = { first: '2027-12-16', end: '2027-12-27', opening: '2027-12-16', snippet: 'Dec 16 - 27' };
  const out = S.settleRunDates(r, range, 'https://northcoastrep.org/production/vineland-place/');
  assert.equal(out.held, null);
  assert.equal(out.row.start, '2027-01-06');
  assert.equal(out.row.source, 'theatre-season-page');
});

test('a different run of the same title in another year (different days) is not held', () => {
  const r = row('2027-03-04', '2027-03-28');
  const range = { first: '2025-01-31', end: '2025-02-09', opening: '2025-01-31', snippet: 'Jan 31 - Feb 9, 2025' };
  const out = S.settleRunDates(r, range, 'https://example.org/x');
  assert.equal(out.held, null);
});
