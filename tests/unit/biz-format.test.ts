/**
 * Unit tests for the shared /biz currency formatter (task #158, P0-1).
 * Null capitalization used to render "~$0" (Ragtime, Dorian Gray) because
 * every component reimplemented its own formatter with an inconsistent null
 * path. formatCurrency itself is the app-wide @/lib/formatting helper
 * (re-exported here) — this only locks the /biz-specific "~" wrapper and
 * the null contract this file promises.
 *
 * BRO-4623: formatCapitalSummary (P0-6, capital totals never read "~$0") and
 * formatDataDate (P1-1, the /biz freshness line). formatCapitalization: every
 * capitalization used to print "~" (formatEstimatedCurrency), so a cited
 * figure read as our guess; now only an isEstimate-flagged one does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCurrency,
  formatCapitalization,
  formatCapitalSummary,
  formatDataDate,
  formatDevelopmentDate,
  sortNewestFirst,
} from '../../src/lib/biz-format';
import { isEstimatedCapitalization, toPublicShowCommercial } from '../../src/lib/commercial-display';
import type { ShowCommercial } from '../../src/lib/data-types';

test('formatCurrency: null/undefined render em-dash, never $0', () => {
  assert.equal(formatCurrency(null), '—');
  assert.equal(formatCurrency(undefined), '—');
});

test('formatCurrency: zero is a real reportable value, not missing data', () => {
  assert.equal(formatCurrency(0), '$0');
});

test('formatCurrency: scales K/M/B', () => {
  assert.equal(formatCurrency(850_000), '$850K');
  assert.equal(formatCurrency(12_500_000), '$12.5M');
  assert.equal(formatCurrency(1_400_000_000), '$1.4B');
});

test('formatCapitalization: null renders bare em-dash, never "~—", flagged or not', () => {
  assert.equal(formatCapitalization(null, false), '—');
  assert.equal(formatCapitalization(undefined, false), '—');
  assert.equal(formatCapitalization(null, true), '—');
  assert.equal(formatCapitalization(undefined, true), '—');
});

test('formatCapitalization: a reported figure prints plain, no "~"', () => {
  assert.equal(formatCapitalization(12_500_000, false), '$12.5M');
  assert.equal(formatCapitalization(850_000, false), '$850K');
});

test('formatCapitalization: only an estimate-flagged figure gets the "~" mark', () => {
  assert.equal(formatCapitalization(24_000_000, true), '~$24.0M');
});

const CITED = 'The New York Times, 2024-03-12';

test('isEstimatedCapitalization: a cited figure is reported unless the record flags it', () => {
  assert.equal(isEstimatedCapitalization({ capitalizationSource: CITED }), false);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: CITED, isEstimate: {} }), false);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: CITED, isEstimate: { capitalization: false } }), false);
  // Another field's estimate flag does not mark the capitalization.
  assert.equal(isEstimatedCapitalization({ capitalizationSource: CITED, isEstimate: { weeklyRunningCost: true } }), false);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: CITED, isEstimate: { capitalization: true } }), true);
});

test('isEstimatedCapitalization: an uncited figure reads as an estimate (BRO-4666)', () => {
  // JSON records can omit the field entirely.
  assert.equal(isEstimatedCapitalization({} as { capitalizationSource: null }), true);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: null }), true);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: '   ' }), true);
  assert.equal(isEstimatedCapitalization({ capitalizationSource: null, isEstimate: { capitalization: false } }), true);
  // Source text that is only internal research wording is not a citation.
  assert.equal(isEstimatedCapitalization({ capitalizationSource: 'Deep research synthesis' }), true);
});

test('show page (public record) and /biz (raw record) agree on the "~" mark', () => {
  const records = [
    { capitalization: 24_000_000, capitalizationSource: CITED },
    { capitalization: 24_000_000, capitalizationSource: null },
    { capitalization: 24_000_000, capitalizationSource: 'Deep research synthesis' },
    { capitalization: 24_000_000, capitalizationSource: CITED, isEstimate: { capitalization: true } },
  ] as ShowCommercial[];
  for (const raw of records) {
    assert.equal(isEstimatedCapitalization(toPublicShowCommercial(raw)), isEstimatedCapitalization(raw));
  }
});

test('cited vs flagged vs uncited records end to end', () => {
  const cited = { capitalizationSource: CITED, isEstimate: { weeklyRunningCost: true } };
  const flagged = { capitalizationSource: CITED, isEstimate: { capitalization: true } };
  const uncited = { capitalizationSource: null };
  assert.equal(formatCapitalization(24_000_000, isEstimatedCapitalization(cited)), '$24.0M');
  assert.equal(formatCapitalization(24_000_000, isEstimatedCapitalization(flagged)), '~$24.0M');
  assert.equal(formatCapitalization(24_000_000, isEstimatedCapitalization(uncited)), '~$24.0M');
});

// ── BRO-4623 P0-6 ──────────────────────────────────────────────────────────

test('formatCapitalSummary: no shows counted reads "None"', () => {
  assert.deepEqual(formatCapitalSummary({ knownTotal: 0, showCount: 0, undisclosedCount: 0 }), {
    value: 'None',
    note: null,
  });
});

test('formatCapitalSummary: shows counted but no figure known reads "Undisclosed", never "~$0"', () => {
  const out = formatCapitalSummary({ knownTotal: 0, showCount: 3, undisclosedCount: 3 });
  assert.equal(out.value, 'Undisclosed');
  assert.equal(out.note, '3 shows, capitalization not public');
  assert.doesNotMatch(out.value, /\$0/);
  assert.equal(
    formatCapitalSummary({ knownTotal: 0, showCount: 1, undisclosedCount: 1 }).note,
    '1 show, capitalization not public',
  );
});

test('formatCapitalSummary: a partial total gets "+" and says how many are missing', () => {
  assert.deepEqual(formatCapitalSummary({ knownTotal: 42_000_000, showCount: 9, undisclosedCount: 3 }), {
    value: '~$42.0M+',
    note: '3 of 9 undisclosed',
  });
});

test('formatCapitalSummary: a complete total has no "+" and no note', () => {
  assert.deepEqual(formatCapitalSummary({ knownTotal: 42_000_000, showCount: 9, undisclosedCount: 0 }), {
    value: '~$42.0M',
    note: null,
  });
});

// ── BRO-4623 P1-1 ──────────────────────────────────────────────────────────

test('formatDataDate: grosses "M/D/YYYY", ISO day and ISO timestamp', () => {
  assert.equal(formatDataDate('9/13/2026'), 'Sep 13, 2026');
  assert.equal(formatDataDate('2026-09-26'), 'Sep 26, 2026');
  // Parsed by hand: a late-UTC timestamp must not slip a day in any time zone.
  assert.equal(formatDataDate('2026-10-03T23:30:00Z'), 'Oct 3, 2026');
});

test('formatDataDate: missing or unparseable is null', () => {
  assert.equal(formatDataDate(null), null);
  assert.equal(formatDataDate(undefined), null);
  assert.equal(formatDataDate(''), null);
  assert.equal(formatDataDate('last week'), null);
  assert.equal(formatDataDate('2026-13-01'), null);
});

test('formatDevelopmentDate: every Recent Developments row carries its year', () => {
  // Recoupments (month precision) and closings (day precision) read alike,
  // so "Sep 20" can never sit next to "May 2026" and read as 2020.
  assert.equal(formatDevelopmentDate('2026-05'), 'May 2026');
  assert.equal(formatDevelopmentDate('2026-09-20'), 'Sep 2026');
  assert.equal(formatDevelopmentDate('2025-12-31'), 'Dec 2025');
  // Year-only recoupment dates and anything else pass through.
  assert.equal(formatDevelopmentDate('2026'), '2026');
  assert.equal(formatDevelopmentDate('2026-13'), '2026-13');
  assert.equal(formatDevelopmentDate('Now'), 'Now');
});

test('sortNewestFirst: recoupments and closings interleave by date, newest first', () => {
  // The live /biz list printed Jun, May, May, May recoupments and then a
  // Sep closing, because rows were grouped by type.
  const rows = [
    { id: 'purpose', date: '2026-06' },
    { id: 'just-in-time', date: '2026-05' },
    { id: 'giant', date: '2026-05' },
    { id: 'titanique', date: '2026-09-14' },
    { id: 'old-year-only', date: '2025' },
  ];
  const sorted = sortNewestFirst(rows, (r) => r.date).map((r) => r.id);
  assert.deepEqual(sorted, ['titanique', 'purpose', 'just-in-time', 'giant', 'old-year-only']);
  // Equal dates keep input order, and the input is not mutated.
  assert.equal(rows[0].id, 'purpose');
  // A day-precision date in the same month sorts above the month-only one.
  assert.deepEqual(
    sortNewestFirst([{ d: '2026-06' }, { d: '2026-06-15' }], (r) => r.d).map((r) => r.d),
    ['2026-06-15', '2026-06'],
  );
  // A year-only recoupment sorts below every month of that year and above
  // the year before (the old date-based sort read "2026" as Jan 1).
  assert.deepEqual(
    sortNewestFirst([{ d: '2025-12' }, { d: '2026' }, { d: '2026-01' }], (r) => r.d).map((r) => r.d),
    ['2026-01', '2026', '2025-12'],
  );
});
