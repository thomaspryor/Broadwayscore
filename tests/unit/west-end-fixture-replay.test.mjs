// BRO-5956: the West End opening-night fixture (The Lives of Others, Adelphi Theatre, opened 2026-10-29) replayed
// through the lane's West End adapters: WestEndTheatre.com, theatre.reviews, Stagedoor, The Stage and London Box Office.
// The committed fixture is SYNTHETIC (invented pages in the real sites' markup; see
// scripts/lib/lane-recorded-nights/west-end-lives-of-others-2026.js). The real recorded pages are private; their replay
// runs when a recording is present (LANE_RECORDINGS_DIR, data/lane-recordings, or the review-texts clone) and is
// skipped otherwise.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const night = require('../../scripts/lib/lane-recorded-nights/west-end-lives-of-others-2026.js');
const we = require('../../scripts/lib/opening-night-lane/west-end-adapters.js');
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const { laneAdapters } = require('../../scripts/lib/opening-night-lane/adapters.js');
const { findLboRoundupInSitemap } = require('../../scripts/lib/lbo-roundup-discover.js');

const WE_NAMES = ['wet-roundup', 'theatre-reviews', 'stagedoor', 'thestage-roundup', 'lbo-roundup'];
const canon = (u) => d.canonicalUrl(u);
const keys = (r) => new Set(r.admitted.map((a) => a.key));

test('synthetic night, press night before any round-up: nothing admitted, nothing broken, every fetch was recorded', async () => {
  const r = await night.replayWestEndNight(night.syntheticRecording(), { at: 3600e3 });
  assert.deepEqual(r.admitted, []);
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
  assert.deepEqual(r.unrecorded, []);
});

test('synthetic night, all round-ups published: every review the five round-ups cite is admitted and valid', async () => {
  const r = await night.replayWestEndNight(night.syntheticRecording(), { at: night.SYNTHETIC_END_MS });
  const want = new Set(Object.values(night.SYNTHETIC_EXPECTED).flat().map(canon));
  assert.deepEqual([...keys(r)].sort(), [...want].sort());
  assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
  assert.deepEqual(r.problems, [], JSON.stringify(r.problems));
  assert.deepEqual(r.unrecorded, [], 'the replay read only recorded pages');
  for (const a of r.admitted) {
    assert.equal(a.source, 'aggregator');
    assert.equal(we.westEndCandidateProblem(a), null, a.key);
  }
  // Each adapter read its source; the review The Stage cites on its own host is kept.
  for (const host of ['westendtheatre.com', 'theatre.reviews', 'stagedoor.com', 'thestage.co.uk', 'londonboxoffice.co.uk']) {
    assert.ok(r.asked.some((u) => u.includes(host)), `${host} was read`);
  }
  assert.ok(keys(r).has(canon(night.R.thestage)));
  // The interview a round-up cites is refused, for good.
  for (const u of night.SYNTHETIC_REFUSED) {
    const rej = r.rejected.find((x) => x.url === canon(u));
    assert.ok(rej && rej.reason === 'non-review-path', JSON.stringify(r.rejected));
  }
});

test('each round-up, replayed alone, yields exactly its cited reviews, and LBO quotes ride along as lboRoundupExcerpt', async () => {
  const rec = night.syntheticRecording();
  for (const [name, urls] of Object.entries(night.SYNTHETIC_EXPECTED)) {
    const adapter = we.westEndAdapters({ fetchGated: null }).find((a) => a.name === name);
    const r = await night.replayWestEndNight(rec, { adapters: [adapter] });
    assert.deepEqual([...keys(r)].sort(), urls.map(canon).sort(), name);
    assert.deepEqual(r.errors, [], name);
    if (name === 'lbo-roundup') for (const a of r.admitted) assert.ok((a.excerpts || {}).lboRoundupExcerpt.length >= 50, a.key);
  }
});

test('The Stage serving its registration gate is a named error, not "no reviews"; the other sources still land', async () => {
  const r = await night.replayWestEndNight(night.syntheticRecording({ theStageGated: true }));
  const e = r.errors.find((x) => x.adapter === 'thestage-roundup');
  assert.ok(e && /registration gate/.test(e.error), JSON.stringify(r.errors));
  assert.ok(!keys(r).has(canon(night.R.standard)));
  assert.ok(keys(r).has(canon(night.R.ft)) && keys(r).has(canon(night.R.telegraph)));
});

test('a Broadway night: the West End adapters make no fetch at all', async () => {
  const show = { id: 'x-2026', title: 'The Lives of Others', openingDate: '2026-10-29', category: 'broadway', market: 'broadway' };
  for (const a of we.westEndAdapters({ fetchGated: null })) {
    assert.deepEqual(await a.discover({ show, night: '2026-10-29', fetchText: async (u) => { throw new Error(`fetched ${u}`); } }), [], a.name);
  }
});

test('production wiring: laneAdapters ends with the five West End adapters, after every Broadway one', () => {
  const names = laneAdapters({ search: async () => [] }).map((a) => a.name);
  assert.deepEqual(names.slice(-5), WE_NAMES);
  assert.ok(names.indexOf('bww-roundup') < names.indexOf('wet-roundup'));
});

test('throttle: a clean run is not repeated within 10 minutes; a run that threw is retried on the next pass', async () => {
  let clock = 0;
  let calls = 0;
  let fail = true;
  const inner = { name: 'probe', discover: async () => { calls++; if (fail) throw new Error('down'); return []; } };
  const a = we.westEndOnly(inner, { now: () => clock });
  const args = { show: night.SHOW, night: night.NIGHT, fetchText: async () => '' };
  await assert.rejects(a.discover(args));
  fail = false;
  clock += 60e3; await a.discover(args); // retried at once after the failure
  clock += 60e3; await a.discover(args); // clean run 1 min ago: skipped
  clock += we.DEFAULT_EVERY_MS; await a.discover(args);
  assert.equal(calls, 3);
});

test('Stagedoor: the 2026 redirect stands the adapter down for the night; a live Stagedoor is reported', async () => {
  const gone = night.syntheticPages().find((p) => p.url === 'https://stagedoor.com/').body;
  assert.equal(we.stagedoorRetired({ content: gone }), true);
  assert.equal(we.stagedoorRetired({ content: '<title>Stagedoor</title>', finalUrl: 'https://www.londontheatredirect.com/' }), true);
  assert.equal(we.stagedoorRetired({ content: '<title>Stagedoor: London theatre</title><link rel="canonical" href="https://stagedoor.com/">' }), false);
  let fetches = 0;
  const a = we.stagedoorAdapter();
  const fetchText = async () => { fetches++; return { content: gone, finalUrl: null }; };
  assert.deepEqual(await a.discover({ fetchText }), []);
  assert.deepEqual(await a.discover({ fetchText }), []);
  assert.equal(fetches, 1, 'probed once');
  const live = we.stagedoorAdapter();
  await assert.rejects(live.discover({ fetchText: async () => ({ content: '<title>Stagedoor</title>' }) }), /answers as Stagedoor again/);
});

test('a round-up from another production (dated years before this opening) is not this night\'s', async () => {
  const pages = night.syntheticPages().map((p) => (p.body && /reviews-roundup\/the-lives-of-others-adelphi/.test(p.url)
    ? { ...p, body: p.body.replace('2026-10-31T09:00:00+00:00', '2019-03-01T09:00:00+00:00') } : p));
  const adapter = we.westEndAdapters({ fetchGated: null }).find((a) => a.name === 'theatre-reviews');
  const r = await night.replayWestEndNight(night.recordingFromPages(pages), { adapters: [adapter] });
  assert.deepEqual(r.admitted, []);
});

test('shared helpers: the LBO sitemap matcher and the JSON body reader', () => {
  const xml = night.syntheticPages().filter((p) => p.url.endsWith('news-sitemap.xml')).pop().body;
  assert.equal(findLboRoundupInSitemap(xml, night.SHOW), 'https://www.londonboxoffice.co.uk/news/post/review-roundup-the-lives-of-others-adelphi-theatre');
  assert.equal(findLboRoundupInSitemap(xml.replace(/the-lives-of-others/g, 'an-unrelated-show'), night.SHOW), null);
  assert.deepEqual(we.parseJsonBody('<html><body><pre>[{&quot;id&quot;:1}]</pre></body></html>', 'u'), [{ id: 1 }]);
  assert.throws(() => we.parseJsonBody('<html>gate</html>', 'u'), /not JSON/);
});

const realDir = night.realFixtureDir();
test('REAL recorded fixture (private): every review the captured round-ups cite passes validation', { skip: realDir ? false : 'no private recording of this night here (LANE_RECORDINGS_DIR, data/lane-recordings or the review-texts clone)' }, async () => {
  const rec = night.loadRecording(realDir);
  const meta = JSON.parse(fs.readFileSync(path.join(realDir, 'meta.json'), 'utf8'));
  assert.ok(rec.entries.length > 0 && rec.entries.every((e) => e.at), 'every fetch is timestamped');
  assert.ok(meta.capturedAt || meta.importedAt, 'the capture is dated');
  const r = await night.replayWestEndNight(rec);
  assert.deepEqual(r.unrecorded, [], 'the adapters read only what was captured');
  assert.ok(r.admitted.length > 0, `no review admitted; errors ${JSON.stringify(r.errors)}`);
  assert.deepEqual(r.problems, [], JSON.stringify(r.problems));
  // A source that failed live (The Stage's gate without a login, a blocked fetch) is reported per adapter, never a crash.
  for (const e of r.errors) assert.ok(WE_NAMES.includes(e.adapter), JSON.stringify(e));
});
