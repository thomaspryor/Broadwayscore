import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { inOpeningWindow } = require('../../scripts/lib/opening-date-window.js');

const DAY = 86400000;
const today = Date.parse('2026-10-04');

test('opera window: dated show in window', () => {
  assert.equal(inOpeningWindow({ openingDate: '2026-09-20' }, today, 60 * DAY), true);
});
test('opera window: null openingDate falls back to previewsStartDate (the blind spot)', () => {
  assert.equal(inOpeningWindow({ openingDate: null, previewsStartDate: '2026-09-25' }, today, 60 * DAY), true);
});
test('opera window: no dates at all is out of window, no throw', () => {
  assert.equal(inOpeningWindow({ openingDate: null }, today, 60 * DAY), false);
  assert.equal(inOpeningWindow({ openingDate: 'garbage' }, today, 60 * DAY), false);
});
test('opera window: outside window excluded', () => {
  assert.equal(inOpeningWindow({ openingDate: '2025-01-01' }, today, 60 * DAY), false);
});

test('opera audit uses the shared helper, not a bare guard', () => {
  const src = fs.readFileSync(new URL('../../scripts/audit-opera-discovery-gap.js', import.meta.url), 'utf8');
  assert.match(src, /inOpeningWindow\(s, today, windowMs\)/);
  assert.doesNotMatch(src, /if \(!s\.openingDate\) return false/);
});

// Every remaining bare !openingDate guard must be documented as intentional,
// so the next grep sweep does not re-flag it.
for (const f of ['audit-duplicate-shows.js', 'audit-tony-attribution.js']) {
  test(`${f}: bare openingDate guard is documented intentional`, () => {
    const src = fs.readFileSync(new URL(`../../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /openingDate-guard: intentional \(BRO-2033\)/);
  });
}

test('cv-flag sweep falls back to previewsStartDate instead of a bare openingDate guard', () => {
  const src = fs.readFileSync(new URL('../../scripts/audit-cv-flag-contradiction.js', import.meta.url), 'utf8');
  assert.match(src, /sweepDateKey\(s\)/);
  assert.match(src, /status === 'upcoming'/);
  assert.doesNotMatch(src, /if \(!s\.openingDate\) return false/);
});

test('tony audit reports undated shows instead of silently skipping them', () => {
  const src = fs.readFileSync(new URL('../../scripts/audit-tony-attribution.js', import.meta.url), 'utf8');
  assert.match(src, /unverifiableUndated\.push\(showId\)/);
  assert.match(src, /could not be checked/);
});
