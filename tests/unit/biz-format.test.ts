/**
 * Unit tests for the shared /biz currency formatter (task #158, P0-1).
 * Null capitalization used to render "~$0" (Ragtime, Dorian Gray) because
 * every component reimplemented its own formatter with an inconsistent null
 * path. formatCurrency itself is the app-wide @/lib/formatting helper
 * (re-exported here) — this only locks the /biz-specific "~" wrapper and
 * the null contract this file promises.
 *
 * BRO-4623: formatCapitalSummary (P0-6, capital totals never read "~$0") and
 * formatDataDate (P1-1, the /biz freshness line).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCurrency,
  formatEstimatedCurrency,
  formatCapitalSummary,
  formatDataDate,
  formatDevelopmentDate,
} from '../../src/lib/biz-format';

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

test('formatEstimatedCurrency: null renders bare em-dash, never "~—"', () => {
  assert.equal(formatEstimatedCurrency(null), '—');
  assert.equal(formatEstimatedCurrency(undefined), '—');
});

test('formatEstimatedCurrency: real values get a "~" provenance prefix', () => {
  assert.equal(formatEstimatedCurrency(12_500_000), '~$12.5M');
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
