import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { triageOpeningFinding: t } = require('../../scripts/lib/opening-date-triage.js');

// Real past cards: BRO-6792/7093 (860), BRO-7255 (Other Desert Cities)
test('next-day opening-night coverage is not flagged (past BRO-6792, 7093, 7255)', () => {
  assert.equal(t({ fieldType: 'opening', stored: '2026-10-21', discoveredDate: '2026-10-22', today: '2026-11-07' }).flag, false);
  assert.equal(t({ fieldType: 'opening', stored: '2026-10-18', discoveredDate: '2026-10-19', today: '2026-11-09' }).flag, false);
});
test('real drifts still flag', () => {
  // BRO-5556 Downstate previews shift
  assert.equal(t({ fieldType: 'previews-start', stored: '2026-10-17', discoveredDate: '2026-10-20', today: '2026-10-17' }).flag, true);
  assert.equal(t({ fieldType: 'opening', stored: '2026-10-21', discoveredDate: '2026-10-24', today: '2026-11-07' }).flag, true);
  assert.equal(t({ fieldType: 'opening', stored: '2026-10-21', discoveredDate: '2026-10-20', today: '2026-11-07' }).flag, true);
  assert.equal(t({ fieldType: 'opening', stored: '2026-12-01', discoveredDate: '2026-12-02', today: '2026-11-07' }).flag, true);
  assert.equal(t({ fieldType: 'opening', stored: null, discoveredDate: '2026-12-02', today: '2026-11-07' }).flag, true);
});
test('audit script routes through the triage (guard against unwiring)', () => {
  const src = fs.readFileSync(new URL('../../scripts/audit-opening-dates.js', import.meta.url), 'utf8');
  assert.match(src, /triageOpeningFinding\(/);
});
