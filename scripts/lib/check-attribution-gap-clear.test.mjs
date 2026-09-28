// BRO-4215: acceptance check for provider-spend attribution-gap cards, and the
// SAFE_CHECK_FORMS entry that lets the parked-card drain run it headless.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { latestPct } = require('../check-attribution-gap-clear.js');
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

test('the card VERIFY command is a safe check form; other providers or shell tails are not', () => {
  for (const p of ['scrapingbee', 'scrapingdog', 'brightdata']) {
    assert.equal(isSafeCheckCommand(`node scripts/check-attribution-gap-clear.js --provider=${p}`), true, p);
  }
  assert.equal(isSafeCheckCommand('node scripts/check-attribution-gap-clear.js --provider=browserbase'), false);
  assert.equal(isSafeCheckCommand('node scripts/check-attribution-gap-clear.js --provider=scrapingbee; rm -rf /'), false);
});
