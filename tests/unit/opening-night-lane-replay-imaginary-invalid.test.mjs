// BRO-6066: replay of the 2026-10-22 shadow night for The Imaginary Invalid (run 39873028216). The lane found 11 of the
// 19 reviews the regular pipeline published. These pages are rebuilt from that night's inputs: the same URLs, the same
// page shapes that broke discovery (Playbill's sidebar <article> cards ahead of the roundup body, `/news/` review slugs,
// a Talkin' Broadway review filed under a named page no index lists, a Google News wrapper that only redirects in a
// browser, slow Talkin' Broadway indexes). Links and structure only; no article text is copied.
// BRO-5201: the night runs through the production wiring (driver.wireLaneNight: laneAdapters, inline scoring, the real
// publish path, the review-file writer) against an empty review-texts dir, over several virtual passes. Only the page
// fetch, the scorer and the push are injected.
// The night itself (pages, expected reviews, replayNight) lives in scripts/lib/lane-recorded-nights/ so the recorded
// rehearsal replays exactly what these tests pin.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const d = require('../../scripts/lib/opening-night-lane/discovery.js');
const { EXPECTED, E, DTLI_PAGE, PV_ART, replayNight } = require('../../scripts/lib/lane-recorded-nights/the-imaginary-invalid-2026.js');

test('replay of 2026-10-22: the lane discovers at least 18 of the 19 published reviews', async () => {
  const r = await replayNight();
  const { keys, errors } = r;
  const found = Object.entries(EXPECTED).filter(([, u]) => keys.has(d.canonicalUrl(u))).map(([k]) => k);
  const missed = Object.keys(EXPECTED).filter((k) => !found.includes(k));
  assert.ok(found.length >= 18, `found ${found.length}/19; missed ${missed.join(', ')}; errors ${JSON.stringify(errors)}`);
  assert.deepEqual(missed, ['singleticket'], 'only the pre-opening Substack post is out of reach');
  // The production path ran (not a dry run): every review was scored, published and written into the empty review-texts dir.
  assert.deepEqual(r.failed, [], 'nothing failed for good');
  assert.ok(r.published.length > 0, 'at least one publish batch'); assert.deepEqual(r.unpublished, [], 'nothing scored was left unpublished');
  assert.ok(r.reviewFiles.length > 0, 'the lane wrote its review files');
});

test('replay: each of the seven outlets the shadow missed comes from the source that fixes it', async () => {
  const { admitted } = await replayNight();
  const by = (u) => admitted.filter((x) => x.key === d.canonicalUrl(u)).map((x) => x.adapter || x.via);
  const via = (u) => admitted.find((x) => x.key === d.canonicalUrl(u)) || {};
  assert.equal(via(E.tribune).via, PV_ART, 'Chicago Tribune is cited only by the Playbill roundup body');
  assert.ok([DTLI_PAGE, PV_ART].includes(via(E.theatermania).via), 'TheaterMania /news/review- link admitted from an aggregator');
  assert.ok([DTLI_PAGE, PV_ART].includes(via(E.timeout).via), 'Time Out /news/broadway-review- link admitted from an aggregator');
  assert.equal(via(E.vulture).via, 'google-news', 'Vulture comes only from Google News, through the browser landing URL');
  assert.equal(via(E.talkinbroadway).via, 'talkin-broadway-named-page');
  assert.ok(by(E.deadline).length && by(E.wsj).length);
});

test('replay: the Playbill roundup sidebar cards are never admitted as reviews', async () => {
  const { keys } = await replayNight({ passes: 1 });
  assert.ok(![...keys].some((k) => k.includes('playbill.com')), [...keys].join('\n'));
});

test('replay: Vulture is unwrapped in the first pass although eight smaller outlets precede it in the feed', async () => {
  const { keys, calls } = await replayNight({ passes: 1 });
  assert.ok(keys.has(d.canonicalUrl(E.vulture)));
  assert.equal(calls.filter((u) => u.startsWith('https://news.google.com/rss/articles/')).length, 8, 'the unwrap cap still holds');
});

test('replay: slow Talkin\' Broadway indexes do not cost the named-page review, and the probe is throttled', async () => {
  const { keys, calls } = await replayNight({ passes: 4, everyMin: 2, fetchOpts: { slowTbIndexMs: 30 } });
  assert.ok(keys.has(d.canonicalUrl(E.talkinbroadway)));
  // Found in the first pass and cached, so the four candidate names are probed once, not once per pass: two misses, then
  // the hit (3 reads), plus the one read the lane makes to score the review.
  assert.equal(calls.filter((u) => u.includes('/page/world/TheImaginaryInvalid')).length, 4, 'two misses, the hit, the scoring fetch; never again');
});

test('replay graded like a press night: same-night completeness PASS (S4-T6)', async () => {
  const r = await replayNight({ site: true });
  assert.ok(r.live.length >= 18, `live rows ${r.live.length}`);
  const g = r.graded;
  assert.equal(g.sameNight.status, 'pass', `same-night: ${g.sameNight.detail}; gates ${JSON.stringify(g.gates.map((x) => [x.name, x.status, x.detail]))}`);
  assert.deepEqual(g.runProblems, []);
});
