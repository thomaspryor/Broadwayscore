/**
 * Unit tests for the shared /biz currency formatter (task #158, P0-1).
 * Null capitalization used to render "~$0" (Ragtime, Dorian Gray) because
 * every component reimplemented its own formatter with an inconsistent null
 * path. formatCurrency itself is the app-wide @/lib/formatting helper
 * (re-exported here) — this only locks the /biz-specific "~" wrapper and
 * the null contract this file promises.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCurrency, formatEstimatedCurrency } from '../../src/lib/biz-format';

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
