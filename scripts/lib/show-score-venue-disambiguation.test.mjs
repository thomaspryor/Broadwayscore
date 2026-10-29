import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeShowScoreCandidates } = require('./show-score-venue-disambiguation.js');

test('BRO-6531: Off-Off-Broadway listings cannot become new or carried-over candidates', () => {
  const now = Date.parse('2026-10-29T00:00:00Z');
  // Tier evidence comes from the listing collection, never the URL path.
  const outside = { title: 'Outside Show', showScoreUrl: 'https://www.show-score.com/off-broadway-shows/outside', category: 'off-broadway' };
  const ob = { title: 'Off Broadway Show', showScoreUrl: 'https://www.show-score.com/off-broadway-shows/inside', category: 'off-broadway' };
  const we = { title: 'London Show', showScoreUrl: 'https://www.show-score.com/uk/london/west-end-shows/inside', category: 'west-end' };
  for (const candidates of [[outside, ob, we], [ob, we], []]) {
    const result = mergeShowScoreCandidates({
      candidates, venueRejects: [],
      existing: { candidates: [outside, ob, we].map(c => ({ ...c, discoveredAt: new Date(now).toISOString() })) },
      matchedUrls: new Set(), outOfScopeUrls: new Set([outside.showScoreUrl]), ttlDays: 90, now,
    });
    assert.deepEqual(result.data.candidates.map(c => c.title), [ob.title, we.title]);
    assert.equal(result.data._meta.totalCandidates, 2);
  }
});

test('BRO-6531: removing the only stale out-of-scope candidate still rewrites the file', () => {
  const url = 'https://www.show-score.com/listing';
  const result = mergeShowScoreCandidates({
    candidates: [], venueRejects: [],
    existing: { candidates: [{ showScoreUrl: url, discoveredAt: new Date().toISOString() }] },
    matchedUrls: new Set(), outOfScopeUrls: new Set([url]), ttlDays: 90,
  });
  assert.equal(result.write, true);
  assert.deepEqual(result.data.candidates, []);
});
