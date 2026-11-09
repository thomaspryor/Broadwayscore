// BRO-7167 step 3: the offline replay of a recorded night runs on a recording, serves only recorded pages, and summarizes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { replayDiscovery, summarize, SHOWS } = require('../../scripts/wanted-method-check.js');

const rec = (entries, bodies = {}) => ({ entries, page: (sha) => (sha in bodies ? bodies[sha] : null), spanMs: entries.reduce((m, e) => Math.max(m, e.t), 0) });

test('an empty recording replays to nothing without throwing', async () => {
  const r = await replayDiscovery(rec([]), { show: SHOWS['wanted-2022'], night: '2026-11-08' });
  assert.deepEqual(r.found, []);
  assert.equal(r.passes, 0);
});

test('a recording with one blank aggregator page runs every pass, finds nothing, and marks unrecorded urls', async () => {
  const entries = [{ t: 0, at: '2026-11-09T02:38:00.000Z', url: 'https://www.show-score.com/broadway-shows/wanted-broadway', status: 'ok', sha: 'a' }, { t: 4 * 60000, at: '2026-11-09T02:42:00.000Z', url: 'https://playbill.com/x', status: 'ok', sha: 'a' }];
  const r = await replayDiscovery(rec(entries, { a: '<html><body></body></html>' }), { show: SHOWS['wanted-2022'], night: '2026-11-08', stepMin: 2 });
  assert.ok(r.passes >= 3, `passes ${r.passes}`);
  assert.deepEqual(r.found, []);
  assert.ok(r.unrecorded.length > 0, 'adapters asked for pages the recording never had; they replay as 404');
});

test('summarize counts card gaps and finds the minute the coverage rule is met', () => {
  const mk = (i, minute, extra = {}) => ({ url: `https://o${i}.example/r`, minute, outletId: `o${i}`, outlet: `O${i}`, criticName: 'C', publishDate: '2026-11-09', pullQuote: 'q', ...extra });
  const found = Array.from({ length: 12 }, (_, i) => mk(i, i * 3));
  found[4] = mk(4, 12, { criticName: null });
  const s = summarize(found, { market: 'broadway' });
  assert.equal(s.foundCount, 12);
  assert.equal(s.gaps.critic, 1);
  assert.equal(s.gaps.outlet, 0);
  assert.equal(typeof s.minReviewsRule, 'number');
  assert.equal(s.coverageMinute, s.minReviewsRule <= 12 ? (s.minReviewsRule - 1) * 3 : null);
});
