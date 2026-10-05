// BRO-989: Schmigadoon 2026 opening-night postmortem regressions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { applyTemporalOverrides, hasForeignRoundupUrlSignal } = require('./review-guards.js');

const show = { id: 'schmigadoon-2026', title: 'Schmigadoon!', openingDate: '2026-04-20' };
const ebt = 'https://www.broadwayworld.com/review-roundups/Every-Brilliant-Thing-Review-Roundup-1';

test('Bug #3: EBT roundup URL beats the 1d-of-opening override with no LLM marker text', () => {
  const r = applyTemporalOverrides(true, false, 'high', '2026-04-20', '2026-04-21', {
    issues: [], reasoning: 'content mismatch', show,
    url: 'https://theatrely.com/every-brilliant-thing-review', bwwRoundupUrl: ebt,
  });
  assert.equal(r.bypassedForStrongSignal, true);
  assert.equal(r.wpConfidence, 'high');
});

test('Bug #3: matching roundup slug still gets the opening-week override', () => {
  const ok = 'https://www.broadwayworld.com/review-roundups/Schmigadoon-Review-Roundup-1';
  assert.equal(hasForeignRoundupUrlSignal(ok, show), false);
  const r = applyTemporalOverrides(true, false, 'high', '2026-04-20', '2026-04-21', { issues: [], reasoning: '', show, bwwRoundupUrl: ok });
  assert.equal(r.wpConfidence, 'low');
});

test('Bug #3: non-roundup URLs are never judged by slug', () => {
  assert.equal(hasForeignRoundupUrlSignal('https://nytimes.com/2026/04/20/theater/x.html', show), false);
});

test('Bug #6: orchestrator dispatches Guardian outside the west-end gate', () => {
  const y = fs.readFileSync(new URL('../../.github/workflows/opening-night-orchestrator.yml', import.meta.url), 'utf8');
  const g = y.indexOf('dispatch "fetch-guardian-reviews"');
  assert.ok(g > 0);
  assert.ok(y.lastIndexOf('if [ "$MARKET" = "west-end"', g) < y.lastIndexOf('Dispatching audience scrapers', g));
});

test('Bug #6: validate-data rejects non-numeric assignedScore', () => {
  const v = fs.readFileSync(new URL('../validate-data.js', import.meta.url), 'utf8');
  assert.match(v, /typeof r\.assignedScore !== 'number'/);
});
