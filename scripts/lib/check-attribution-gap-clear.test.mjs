// BRO-4215: acceptance check for provider-spend attribution-gap cards, and the
// SAFE_CHECK_FORMS entry that lets the parked-card drain run it headless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { latestPct, clearVerdict } = require('../check-attribution-gap-clear.js');
const { isSafeCheckCommand } = require('./autonomous-triage-core.js');

test('latestPct reads the latest day by date, not file order', () => {
  const lines = [
    JSON.stringify({ day: '2026-09-27', attributedPct: { scrapingbee: 0.17 } }),
    JSON.stringify({ day: '2026-09-29', attributedPct: { scrapingbee: 0.93 } }),
    JSON.stringify({ day: '2026-09-28', attributedPct: { scrapingbee: 0.4 } }),
    'not json',
  ];
  assert.deepEqual(latestPct(lines, 'scrapingbee'), { day: '2026-09-29', pct: 0.93 });
  assert.deepEqual(latestPct(lines, 'brightdata'), { day: '2026-09-29', pct: null }, 'unmeasured provider -> null');
  assert.deepEqual(latestPct([], 'scrapingbee'), { day: null, pct: null });
});

test('clearVerdict: one good day does not close the gap; the whole alert window must be clear', () => {
  const row = (day, p) => JSON.stringify({ day, attributedPct: { scrapingdog: p } });
  const opts = { min: 0.8, days: 2 };
  assert.equal(clearVerdict([row('2026-09-27', 0.43), row('2026-09-28', 0.91)], 'scrapingdog', opts).verdict, 'open', 'prior day still under');
  assert.equal(clearVerdict([row('2026-09-27', 0.85), row('2026-09-28', 0.91)], 'scrapingdog', opts).verdict, 'clear');
  assert.equal(clearVerdict([row('2026-09-26', 0.85), row('2026-09-28', 0.91)], 'scrapingdog', opts).verdict, 'unverifiable', 'non-consecutive days');
  assert.equal(clearVerdict([row('2026-09-28', 0.91)], 'scrapingdog', opts).verdict, 'unverifiable', 'too little history');
  assert.equal(clearVerdict([row('2026-09-27', null), row('2026-09-28', 0.91)], 'scrapingdog', opts).verdict, 'unverifiable', 'unmeasured day');
  assert.equal(clearVerdict([row('2026-09-28', 0.91), row('2026-09-27', 0.85)], 'scrapingdog', opts).verdict, 'clear', 'file order irrelevant');
});

test('the card VERIFY command is a safe check form; other providers or shell tails are not', () => {
  for (const p of ['scrapingbee', 'scrapingdog', 'brightdata']) {
    assert.equal(isSafeCheckCommand(`node scripts/check-attribution-gap-clear.js --provider=${p}`), true, p);
  }
  assert.equal(isSafeCheckCommand('node scripts/check-attribution-gap-clear.js --provider=browserbase'), false);
  assert.equal(isSafeCheckCommand('node scripts/check-attribution-gap-clear.js --provider=scrapingbee; rm -rf /'), false);
});
