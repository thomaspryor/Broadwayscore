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

test('summarize: unresolved outlets are not counted as distinct reviews, and the coverage minute uses the real rule', () => {
  const { getMarketMinReviews } = require('../../scripts/lib/min-reviews');
  const min = getMarketMinReviews('broadway');
  const ids = ['nytimes', 'vulture', 'variety', 'hollywoodreporter', 'timeout', 'deadline', 'theatermania', 'nypost', 'guardian', 'washingtonpost', 'amny', 'observer', 'ew', 'ap', 'wsj', 'bloomberg'];
  const mk = (id, minute, extra = {}) => ({ url: `https://${id}.example/r`, minute, outletId: id, outlet: id, criticName: null, publishDate: '2026-11-09', pullQuote: 'q', ...extra });
  const unresolved = Array.from({ length: 30 }, (_, i) => mk(`x${i}`, i, { outletId: null, outlet: null }));
  const s0 = summarize(unresolved, { market: 'broadway' });
  assert.equal(s0.distinctOutlets, 0, 'urls with no outlet id never count toward the rule');
  assert.equal(s0.coverageMinute, null);
  assert.equal(s0.unresolvedOutlets, 30);
  assert.equal(s0.gaps.outlet, 30);
  assert.equal(s0.gaps.critic, undefined, 'critic is not replayable from a recording, so it is a note, not a counted gap');
  const found = ids.map((id, i) => mk(id, i * 3));
  const s = summarize(found, { market: 'broadway' });
  assert.equal(s.foundCount, ids.length);
  assert.equal(s.distinctOutlets, ids.length);
  assert.ok(s.coverageMinute !== null && s.coverageMinute <= (min + 2) * 3 && s.coverageMinute >= (min - 1) * 3, `coverage minute ${s.coverageMinute} for a rule of ${min}`);
  const dup = summarize([...found, mk('nytimes', 99)], { market: 'broadway' });
  assert.equal(dup.distinctOutlets, ids.length, 'a second article from the same outlet is not a new outlet');
});

test('a step under one minute is refused instead of looping forever', async () => {
  const entries = [{ t: 0, at: '2026-11-09T02:38:00.000Z', url: 'https://example.com/', status: 'ok', sha: 'a' }];
  await assert.rejects(replayDiscovery(rec(entries, { a: '<html></html>' }), { show: SHOWS['wanted-2022'], night: '2026-11-08', stepMin: 0 }), /step-min/);
});

test('a recording whose rows have no wall-clock time still replays (no NaN dates)', async () => {
  const entries = [{ t: 0, at: null, url: 'https://example.com/', status: 'ok', sha: 'a' }, { t: 120000, at: null, url: 'https://example.com/b', status: 'ok', sha: 'a' }];
  const r = await replayDiscovery(rec(entries, { a: '<html></html>' }), { show: SHOWS['wanted-2022'], night: '2026-11-08', stepMin: 2 });
  assert.ok(r.passes >= 2);
});
