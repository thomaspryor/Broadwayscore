import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { roundupIsPriorRun } = require('./gap-reference-sources');

// BRO-5705: the Dec 2025 Bridge roundup must not read as the Oct 2026 transfer's roundup.
const show = { id: 'itw-nc-2026', openingDate: '2026-10-07', previewsStartDate: '2026-09-22', market: 'west-end' };
const page = (d) => `<html><head><meta property="article:published_time" content="${d}T10:00:00Z"></head><body></body></html>`;

test('a roundup published during the earlier run is prior-run', () => {
  assert.equal(roundupIsPriorRun(page('2025-12-14'), 'https://theatre.reviews/x/', show), true);
});

test('a roundup published at this run opening is current', () => {
  assert.equal(roundupIsPriorRun(page('2026-10-08'), 'https://theatre.reviews/x/', show), false);
});

test('an undated roundup stays current (title-validated at discovery)', () => {
  assert.equal(roundupIsPriorRun('<html><body>no date</body></html>', null, show), false);
});
