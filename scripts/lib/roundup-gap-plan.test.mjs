import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { planRoundupGapAlerts } = createRequire(import.meta.url)('./roundup-gap-plan.js');

test('opening-window alerts count and list only actual unresolved citations', () => {
  const urls = [
    'https://bachtrack.com/jenufa-metropolitan-opera-16-november-2026',
    'https://sydneyartsguide.com.au/the-fantasticks-at-hayes-theatre',
    'https://flixrec.tv/movies/details/the-good-thief-6016',
  ];
  const cited = 'https://example.org/current-review';
  const r = { showId: 'example', category: 'off-broadway', openingDate: '2026-11-20',
    missing: [...urls.map(url => ({ url, serpCensus: true })), { url: cited }],
    ingestResults: [...urls.map(url => ({ url, ok: false })), { url: cited, ok: false }],
    flaggedMisses: [{ url: 'https://example.org/held', reverify: true }],
  };
  const [alert] = planRoundupGapAlerts([r], true, Date.parse('2026-11-21')).alert;
  assert.equal(alert.counts.residual, 2);
  assert.deepEqual(alert.missing.map(x => x.url), [cited, 'https://example.org/held']);
});
